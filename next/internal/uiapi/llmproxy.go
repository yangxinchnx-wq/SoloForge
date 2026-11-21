// ─────────────────────────────────────────────────────────────────
// llmproxy.go — /api/llm/stream LLM 直连流式代理
// (从 TS src/llm/llmProxyHandler.ts + openaiStreamClient.ts 迁移,
// 旧 TS 核心退役的前置迁移 — 前端 BackendProxyProvider 直连此端点)
//
// 协议:
//
//	POST /api/llm/stream
//	Headers: Content-Type: application/json, X-SoloForge-Token: <token> (可选)
//	Body: {providerId?, systemPrompt?, userGoal, history?, model?,
//	       temperature?, maxTokens?, jsonMode?, baseUrl?, apiKey?}
//	Response: text/event-stream
//	  data: {"delta":"hello","done":false}\n\n
//	  data: {"delta":"","done":true}\n\n        (done 帧合并 usage)
//	  (or) data: {"error":"...","done":true}\n\n
//
// 凭据三路优先级 (对齐 TS 2026-06-27):
//  1. providerId → 金库取 baseUrl + apiKey (前端不持明文 key)
//  2. 顶层 baseUrl + apiKey (兼容老路径)
//  3. 环境变量 SOLOFORGE_LLM_* (internal/llm 配置)
//
// GET /api/llm/config  — 脱敏配置 (前端判断走哪个 provider)
// GET /api/llm/health  — 1-token 补全探活 (故意不缓存)
// ─────────────────────────────────────────────────────────────────
package uiapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"soloforge/next/internal/llm"
	"soloforge/next/internal/security"
)

// SetVault 注入金库 (providerId 分支取 key; main.go 装配)
func (s *Service) SetVault(v *security.Vault) { s.vault = v }

// HTTPClient LLM 上游请求客户端 (超时 60s 对齐 TS DEFAULT_TIMEOUT_MS;
// 流式请求的超时由 upCtx 按配置另行控制)
func (s *Service) HTTPClient() *http.Client {
	return &http.Client{Timeout: 60 * time.Second}
}

// llmProxyRequest /api/llm/stream 请求体 (对齐 TS LLMProxyRequest)
type llmProxyRequest struct {
	ProviderID   string `json:"providerId"`
	SystemPrompt string `json:"systemPrompt"`
	UserGoal     string `json:"userGoal"`
	History      []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"history"`
	Model       string   `json:"model"`
	Temperature *float64 `json:"temperature"`
	MaxTokens   *int     `json:"maxTokens"`
	JSONMode    bool     `json:"jsonMode"`
	BaseURL     string   `json:"baseUrl"`
	APIKey      string   `json:"apiKey"`
}

// resolveLLMCredentials 三路优先级解析 (对齐 TS)。
// 返回 (baseUrl, apiKey, provider 标签, model 缺省, 错误响应体或 nil)
func (s *Service) resolveLLMCredentials(providerID, inlineBase, inlineKey string) (string, string, string, string, map[string]any) {
	cfg := llm.GetConfig()
	if providerID != "" {
		if s.vault == nil {
			return "", "", "", "", map[string]any{
				"error": fmt.Sprintf("provider '%s' has no key in vault (金库未就绪)", providerID), "providerId": providerID,
			}
		}
		apiKey, baseURL, source, ok := s.vault.Resolve(providerID)
		if !ok {
			return "", "", "", "", map[string]any{
				"error": fmt.Sprintf("provider '%s' has no key in vault. 请在「设置 → 模型」中配置此 provider 的 API Key, 或设置环境变量 %s_API_KEY 后再试。",
					providerID, strings.ToUpper(strings.ReplaceAll(providerID, "-", "_"))),
				"providerId": providerID,
			}
		}
		if baseURL == "" {
			return "", "", "", "", map[string]any{"error": fmt.Sprintf("provider '%s' has no baseUrl in vault", providerID)}
		}
		return baseURL, apiKey, source + ":" + providerID, "", nil
	}
	if inlineBase != "" && inlineKey != "" {
		return inlineBase, inlineKey, "inline", "", nil
	}
	if cfg.APIKey != "" && cfg.BaseURL != "" && cfg.DefaultModel != "" {
		return cfg.BaseURL, cfg.APIKey, "env:" + cfg.Provider, cfg.DefaultModel, nil
	}
	return "", "", "", "", map[string]any{
		"error":  "LLM proxy not configured. Either provide {providerId} (recommended, uses vault), or {baseUrl+apiKey} inline, or set SOLOFORGE_LLM_API_KEY env var.",
		"config": llm.DescribeConfig(),
	}
}

// HandleLLMStream POST /api/llm/stream — SSE 流式代理
func (s *Service) HandleLLMStream(w http.ResponseWriter, r *http.Request) {
	cfg := llm.GetConfig()

	// 简易 token 校验 (优先, 即使 provider 未配置也要校验; env 配了才校验)
	if cfg.APIToken != "" {
		if r.Header.Get("X-SoloForge-Token") != cfg.APIToken {
			writeJSONErr(w, 401, "Invalid X-SoloForge-Token")
			return
		}
	}

	var req llmProxyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONErr(w, 400, "Body must be a JSON object")
		return
	}
	if req.UserGoal == "" {
		writeJSONErr(w, 400, "userGoal is required (string)")
		return
	}

	baseURL, apiKey, provider, defaultModel, errBody := s.resolveLLMCredentials(req.ProviderID, req.BaseURL, req.APIKey)
	if errBody != nil {
		writeJSONErr(w, httpStatusForErrBody(errBody), mustJSON(errBody))
		return
	}
	model := req.Model
	if model == "" {
		model = defaultModel
	}
	if model == "" {
		writeJSONErr(w, 400, "model is empty (provider 无缺省模型且请求未携带 model)")
		return
	}

	// 组装 messages (system → history → user)
	type chatMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	var messages []chatMsg
	if req.SystemPrompt != "" {
		messages = append(messages, chatMsg{Role: "system", Content: req.SystemPrompt})
	}
	for _, m := range req.History {
		if m.Role == "user" || m.Role == "assistant" || m.Role == "system" {
			messages = append(messages, chatMsg{Role: m.Role, Content: m.Content})
		}
	}
	messages = append(messages, chatMsg{Role: "user", Content: req.UserGoal})

	// 上游请求 (OpenAI 兼容流式; stream_options.include_usage 末帧带 usage)
	maxTokens := 4096
	if req.MaxTokens != nil {
		maxTokens = *req.MaxTokens
	}
	temperature := 0.7
	if req.Temperature != nil {
		temperature = *req.Temperature
	}
	upstreamBody := map[string]any{
		"model":          model,
		"messages":       messages,
		"stream":         true,
		"temperature":    temperature,
		"max_tokens":     maxTokens,
		"stream_options": map[string]any{"include_usage": true},
	}
	if req.JSONMode {
		upstreamBody["response_format"] = map[string]any{"type": "json_object"}
	}
	raw, _ := json.Marshal(upstreamBody)

	upURL := strings.TrimRight(baseURL, "/") + "/chat/completions"
	timeout := time.Duration(cfg.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	upCtx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	upReq, err := http.NewRequestWithContext(upCtx, http.MethodPost, upURL, bytes.NewReader(raw))
	if err != nil {
		writeJSONErr(w, 502, "构造上游请求失败: "+err.Error())
		return
	}
	upReq.Header.Set("Content-Type", "application/json")
	upReq.Header.Set("Authorization", "Bearer "+apiKey)

	upResp, err := s.HTTPClient().Do(upReq)
	if err != nil {
		writeJSONErr(w, 502, "openaiStreamClient: "+err.Error())
		return
	}
	defer upResp.Body.Close()
	if upResp.StatusCode >= 400 {
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(upResp.Body)
		writeJSONErr(w, 502, fmt.Sprintf("openaiStreamClient: HTTP %d %s", upResp.StatusCode, truncateStr(buf.String(), 200)))
		return
	}

	// SSE 接管
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONErr(w, 500, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, ": SoloForge LLM proxy ok (%s)\n\n", provider)
	flusher.Flush()

	writeFrame := func(v map[string]any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}

	// 逐行解析上游 SSE (对齐 TS openaiStreamClient):
	//   data: {"choices":[{"delta":{"content":"..."}}]}
	//   data: {..., usage:{...}}            (末帧 usage, 合并到 done 帧)
	//   data: [DONE]
	chunkCount := 0
	totalChars := 0
	var lastUsage map[string]any
	sc := bufio.NewScanner(upResp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	t0 := time.Now()
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(line[5:])
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Usage *map[string]any `json:"usage"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue // 忽略单行解析失败
		}
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			chunkCount++
			totalChars += len(chunk.Choices[0].Delta.Content)
			writeFrame(map[string]any{"delta": chunk.Choices[0].Delta.Content, "done": false})
		}
		if chunk.Usage != nil {
			// 缓存命中字段兼容: OpenAI prompt_tokens_details.cached_tokens /
			// DeepSeek prompt_cache_hit_tokens / Anthropic cache_read_input_tokens
			u := *chunk.Usage
			cached := numField(u, "prompt_cache_hit_tokens") + numField(u, "cache_read_input_tokens")
			if det, ok := u["prompt_tokens_details"].(map[string]any); ok {
				cached = numField(det, "cached_tokens")
			}
			usage := map[string]any{
				"promptTokens":     numField(u, "prompt_tokens"),
				"completionTokens": numField(u, "completion_tokens"),
				"totalTokens":      numField(u, "total_tokens"),
			}
			if cached > 0 {
				usage["cachedTokens"] = cached
			}
			lastUsage = usage
		}
	}

	if err := sc.Err(); err != nil {
		writeFrame(map[string]any{"error": "stream interrupted: " + err.Error(), "done": true})
		return
	}
	doneFrame := map[string]any{"delta": "", "done": true}
	if lastUsage != nil {
		doneFrame["usage"] = lastUsage
	}
	writeFrame(doneFrame)
	fmt.Fprintf(w, ": done %d chunks, %d chars in %dms\n\n", chunkCount, totalChars, time.Since(t0).Milliseconds())
	flusher.Flush()
	slog.Info("LLMProxy 流完成", "provider", provider, "chunks", chunkCount, "chars", totalChars, "ms", time.Since(t0).Milliseconds())
}

// HandleLLMConfig GET /api/llm/config — 脱敏配置 (不含 key)
func (s *Service) HandleLLMConfig(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(llm.DescribeConfig())
}

// HandleLLMHealth GET /api/llm/health — 1-token 补全探活 (故意不缓存)
func (s *Service) HandleLLMHealth(w http.ResponseWriter, r *http.Request) {
	cfg := llm.GetConfig()
	if cfg.APIToken != "" && r.Header.Get("X-SoloForge-Token") != cfg.APIToken {
		writeJSONErr(w, 401, "Invalid X-SoloForge-Token")
		return
	}
	providerID := r.Header.Get("X-SoloForge-Provider-Id")
	baseURL, apiKey, provider, defaultModel, errBody := s.resolveLLMCredentials(providerID, "", "")
	if errBody != nil {
		writeJSONErr(w, 503, mustJSON(errBody))
		return
	}
	model := defaultModel
	if model == "" {
		writeJSONErr(w, 400, mustJSON(map[string]any{"ok": false, "error": "model is empty (provider 无缺省模型)"}))
		return
	}

	body, _ := json.Marshal(map[string]any{
		"model":      model,
		"messages":   []map[string]string{{"role": "user", "content": "ping"}},
		"max_tokens": 1,
	})
	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
		strings.TrimRight(baseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		writeJSONErr(w, 502, mustJSON(map[string]any{"ok": false, "error": err.Error(), "provider": provider}))
		return
	}
	upReq.Header.Set("Content-Type", "application/json")
	upReq.Header.Set("Authorization", "Bearer "+apiKey)
	t0 := time.Now()
	resp, err := s.HTTPClient().Do(upReq)
	if err != nil {
		writeJSONErr(w, 502, mustJSON(map[string]any{"ok": false, "error": err.Error(), "provider": provider}))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(resp.Body)
		writeJSONErr(w, 502, mustJSON(map[string]any{
			"ok": false, "error": fmt.Sprintf("HTTP %d: %s", resp.StatusCode, truncateStr(buf.String(), 200)), "provider": provider,
		}))
		return
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Model string         `json:"model"`
		Usage map[string]any `json:"usage"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": true, "provider": provider, "model": out.Model,
		"content": out.Choices[0].Message.Content, "usage": out.Usage,
		"latencyMs": time.Since(t0).Milliseconds(),
	})
}

// RegisterLLMProxy 注册 LLM 代理路由 (Register 内调用)
func (s *Service) registerLLMProxy(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/llm/stream", s.HandleLLMStream)
	mux.HandleFunc("GET /api/llm/config", s.HandleLLMConfig)
	mux.HandleFunc("GET /api/llm/health", s.HandleLLMHealth)
}

// ── 小工具 ──────────────────────────────────────────────────────

func writeJSONErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": msg})
}

// httpStatusForErrBody 按 error 内容挑状态码 (对齐 TS: vault 缺 key=404 /
// 无 baseUrl=400 / 未配置=503 / 其余 400)
func httpStatusForErrBody(body map[string]any) int {
	msg, _ := body["error"].(string)
	switch {
	case strings.Contains(msg, "has no key in vault"), strings.Contains(msg, "not in vault"):
		return 404
	case strings.Contains(msg, "no baseUrl in vault"):
		return 400
	case strings.Contains(msg, "LLM proxy not configured"):
		return 503
	default:
		return 400
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// numField 取 JSON 数值字段 (缺失为 0)
func numField(m map[string]any, key string) float64 {
	v, _ := m[key].(float64)
	return v
}

func truncateStr(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}
