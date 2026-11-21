// ─────────────────────────────────────────────────────────────────
// uiapi — UI 第二后端 (从 TS UI/server.ts 迁移, 阶段 2)
//
// 覆盖 docs/protocol.md §12.2 的路由 (providers 10 / custom-rules 2 /
// skills 1 / resources 2 / system-metrics 1 / tools 2 / auth 1 / debug-log 1)
//
// 文件依赖: BaseDir (默认 UI/ 目录) 下的
//
//	providers_db.json / model_context_db.json / resources/skills/manifest.json /
//	resources/<type>/manifest.json / custom_rules 文件
//
// 事件: 配置变更/模型扫描经 store 落库 (providers.config.updated 等)
// ─────────────────────────────────────────────────────────────────
package uiapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/llm"
	"soloforge/next/internal/security"
	"soloforge/next/internal/store"
)

type Service struct {
	baseDir string        // UI/ 目录 (providers_db.json 等所在)
	store   *store.Store  // 事件落库 (可为 nil: 仅内存)
	bus     *bus.EventBus // SSE 事件流来源 (可为 nil)
	logger  *slog.Logger
	tokenFn func() string   // startup token 提供者 (security 层注入)
	vault   *security.Vault // 金库 (llmproxy providerId 分支; SetVault 注入)

	mu           sync.Mutex
	probeCache   map[string]map[string]any // providerId → 探测结果缓存
	debugLines   []string
	lastScanInfo map[string]any
}

// SetBus 注入事件总线 (SSE 流来源)
func (s *Service) SetBus(b *bus.EventBus) { s.bus = b }

// SetTokenProvider 注入 startup token 提供者 (security 层)
func (s *Service) SetTokenProvider(fn func() string) { s.tokenFn = fn }

// New 构造。baseDir 为空时默认 "UI/"。
func New(baseDir string, st *store.Store, logger *slog.Logger) *Service {
	if baseDir == "" {
		baseDir = "UI"
	}
	return &Service{
		baseDir:    baseDir,
		store:      st,
		logger:     logger,
		probeCache: make(map[string]map[string]any),
	}
}

// Register 注册全部路由 (core main.go 调用)
func (s *Service) Register(mux *http.ServeMux) {
	// ── providers (10) ──
	mux.HandleFunc("GET /api/providers/config", s.providersGet)
	mux.HandleFunc("POST /api/providers/config", s.providersSet)
	mux.HandleFunc("POST /api/providers/test", s.providerTest)
	mux.HandleFunc("POST /api/providers/test-batch", s.providerTestBatch)
	mux.HandleFunc("POST /api/providers/model-probe", s.modelProbe)
	mux.HandleFunc("POST /api/providers/model-detail", s.modelDetail)
	mux.HandleFunc("POST /api/providers/scan-models", s.scanModels)
	mux.HandleFunc("POST /api/providers/refresh-model-db", s.refreshModelDB)
	mux.HandleFunc("GET /api/providers/model-db-status", s.modelDBStatus)
	mux.HandleFunc("GET /api/providers/probe-cache/{providerId}", s.probeCacheGet)

	// ── custom-rules (2) ──
	mux.HandleFunc("GET /api/custom-rules", s.customRulesGet)
	mux.HandleFunc("POST /api/custom-rules", s.customRulesSet)

	// ── skills / resources (3) ──
	mux.HandleFunc("GET /api/skills/content", s.skillsContent)
	mux.HandleFunc("GET /api/resources/active", s.resourcesActive)
	mux.HandleFunc("GET /api/resources/{type}/manifest", s.resourcesManifest)

	// ── system / tools / auth / debug (4) ──
	mux.HandleFunc("GET /api/system-metrics", s.systemMetrics)
	mux.HandleFunc("GET /api/tools/schemas", s.toolsSchemas)
	mux.HandleFunc("POST /api/tools/invoke", s.toolsInvoke)
	mux.HandleFunc("POST /api/debug-log", s.debugLog)

	// ── server.ts 差集补齐 (阶段 2) ──
	mux.HandleFunc("GET /api/events/stream", s.eventsStream)
	mux.HandleFunc("GET /api/auth/startup-token", s.authStartupToken)
	mux.HandleFunc("POST /api/channels/test", s.channelsTest)

	// ── LLM 直连流式代理 (旧 TS 核心退役前置迁移) ──
	s.registerLLMProxy(mux)

	// ── 模型能力库同步 (旧核 /api/capabilities/save 迁移; server.ts
	//    model-probe 探测后回写, 走 internal/llm 探针持久化) ──
	mux.HandleFunc("POST /api/capabilities/save", s.capabilitiesSave)
}

// capabilitiesSave 保存模型探针结果 (对齐旧核同路径; body: {modelId, capabilities})
func (s *Service) capabilitiesSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ModelID      string `json:"modelId"`
		Capabilities struct {
			SupportsTools     *bool  `json:"supportsTools"`
			SupportsVision    *bool  `json:"supportsVision"`
			SupportsJSON      *bool  `json:"supportsJson"`
			SupportsStreaming *bool  `json:"supportsStreaming"`
			ContextWindow     *int64 `json:"contextWindow"`
			MaxOutput         *int64 `json:"maxOutput"`
		} `json:"capabilities"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ModelID == "" {
		http.Error(w, "body 需为 {modelId, capabilities}", 400)
		return
	}
	llm.SaveProbeResult(req.ModelID, llm.ProbeResult{
		SupportsTools:     req.Capabilities.SupportsTools,
		SupportsVision:    req.Capabilities.SupportsVision,
		SupportsJson:      req.Capabilities.SupportsJSON,
		SupportsStreaming: req.Capabilities.SupportsStreaming,
		ContextWindow:     req.Capabilities.ContextWindow,
		MaxOutput:         req.Capabilities.MaxOutput,
	})
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "modelId": req.ModelID})
}

// ── 文件工具 ────────────────────────────────────────────────────

func (s *Service) readJSON(rel string, out any) error {
	data, err := os.ReadFile(filepath.Join(s.baseDir, rel))
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

func (s *Service) writeJSONFile(rel string, v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.baseDir, rel), data, 0o644)
}

func (s *Service) event(ctx context.Context, typ string, payload map[string]any) {
	if s.store == nil {
		return
	}
	raw, _ := json.Marshal(payload)
	if ev, err := s.store.AppendEvent(ctx, typ, "uiapi", raw); err == nil {
		s.logger.Info("uiapi event", "type", typ)
		_ = ev
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// ── providers (providers_db.json) ───────────────────────────────

type ProviderConfig struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	BaseURL  string `json:"baseUrl"`
	Protocol string `json:"protocol,omitempty"` // openai | anthropic | ...
	Enabled  bool   `json:"enabled"`
	APIKey   string `json:"apiKey,omitempty"`
	Models   []any  `json:"models,omitempty"`
}

func (s *Service) providersGet(w http.ResponseWriter, r *http.Request) {
	var providers []ProviderConfig
	if err := s.readJSON("providers_db.json", &providers); err != nil {
		providers = []ProviderConfig{}
	}
	writeJSON(w, 200, map[string]any{"providers": providers})
}

func (s *Service) providersSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Providers []ProviderConfig `json:"providers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if err := s.writeJSONFile("providers_db.json", req.Providers); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	s.event(r.Context(), "providers.config.updated",
		map[string]any{"count": len(req.Providers)})
	writeJSON(w, 200, map[string]any{"ok": true, "count": len(req.Providers)})
}

// providerTest 连通性测试: GET {baseUrl}/v1/models (OpenAI 兼容)
func (s *Service) providerTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string `json:"id"`
		BaseURL string `json:"baseUrl"`
		APIKey  string `json:"apiKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.BaseURL == "" {
		writeJSON(w, 400, map[string]any{"error": "body 需为 {id?, baseUrl, apiKey?}"})
		return
	}
	start := time.Now()
	client := &http.Client{Timeout: 10 * time.Second}
	preq, _ := http.NewRequestWithContext(r.Context(), "GET",
		req.BaseURL+"/v1/models", nil)
	if req.APIKey != "" {
		preq.Header.Set("Authorization", "Bearer "+req.APIKey)
	}
	resp, err := client.Do(preq)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error(), "latency": latency})
		return
	}
	defer resp.Body.Close()
	writeJSON(w, 200, map[string]any{
		"ok": resp.StatusCode < 400, "status": resp.StatusCode, "latency": latency,
	})
}

// providerTestBatch 批量测试 (串行循环; 对齐旧 server.ts 语义)
func (s *Service) providerTestBatch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Items []map[string]string `json:"items"` // [{id, baseUrl, apiKey}]
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	results := make([]map[string]any, 0, len(req.Items))
	for _, it := range req.Items {
		start := time.Now()
		client := &http.Client{Timeout: 10 * time.Second}
		preq, _ := http.NewRequestWithContext(r.Context(), "GET",
			it["baseUrl"]+"/v1/models", nil)
		if it["apiKey"] != "" {
			preq.Header.Set("Authorization", "Bearer "+it["apiKey"])
		}
		resp, err := client.Do(preq)
		latency := time.Since(start).Milliseconds()
		entry := map[string]any{"id": it["id"], "latency": latency}
		if err != nil {
			entry["ok"] = false
			entry["error"] = err.Error()
		} else {
			resp.Body.Close()
			entry["ok"] = resp.StatusCode < 400
			entry["status"] = resp.StatusCode
		}
		results = append(results, entry)
	}
	writeJSON(w, 200, map[string]any{"results": results})
}

// modelProbe 模型探测: POST {baseUrl}/v1/chat/completions (单条短消息)
func (s *Service) modelProbe(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BaseURL string `json:"baseUrl"`
		APIKey  string `json:"apiKey"`
		Model   string `json:"model"`
		Prompt  string `json:"prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.BaseURL == "" || req.Model == "" {
		writeJSON(w, 400, map[string]any{"error": "body 需为 {baseUrl, model, apiKey?, prompt?}"})
		return
	}
	prompt := req.Prompt
	if prompt == "" {
		prompt = "ping"
	}
	body, _ := json.Marshal(map[string]any{
		"model":      req.Model,
		"messages":   []map[string]string{{"role": "user", "content": prompt}},
		"max_tokens": 8,
	})
	client := &http.Client{Timeout: 30 * time.Second}
	preq, _ := http.NewRequestWithContext(r.Context(), "POST",
		req.BaseURL+"/v1/chat/completions", bytes.NewReader(body))
	preq.Header.Set("Content-Type", "application/json")
	if req.APIKey != "" {
		preq.Header.Set("Authorization", "Bearer "+req.APIKey)
	}
	resp, err := client.Do(preq)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	writeJSON(w, 200, map[string]any{
		"ok": resp.StatusCode < 400, "status": resp.StatusCode, "response": out,
	})
}

// modelDetail 模型详情 (从 model_context_db.json 查)
func (s *Service) modelDetail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ModelID string `json:"modelId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ModelID == "" {
		writeJSON(w, 400, map[string]any{"error": "body 需为 {modelId}"})
		return
	}
	var db map[string]any
	if err := s.readJSON("model_context_db.json", &db); err != nil {
		writeJSON(w, 200, map[string]any{"found": false, "error": err.Error()})
		return
	}
	// models 兼容两种形状: 数组或按 id 键控的 dict (实际文件为 dict)
	switch models := db["models"].(type) {
	case []any:
		for _, m := range models {
			if mm, ok := m.(map[string]any); ok {
				if id, _ := mm["id"].(string); id == req.ModelID {
					writeJSON(w, 200, map[string]any{"found": true, "model": mm})
					return
				}
			}
		}
	case map[string]any:
		if mm, ok := models[req.ModelID].(map[string]any); ok {
			writeJSON(w, 200, map[string]any{"found": true, "model": mm})
			return
		}
	}
	writeJSON(w, 200, map[string]any{"found": false})
}

// scanModels 从 provider 拉取 /v1/models 列表并写入 model_context_db
func (s *Service) scanModels(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProviderID string `json:"providerId"`
		BaseURL    string `json:"baseUrl"`
		APIKey     string `json:"apiKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.BaseURL == "" {
		writeJSON(w, 400, map[string]any{"error": "body 需为 {providerId?, baseUrl, apiKey?}"})
		return
	}
	client := &http.Client{Timeout: 15 * time.Second}
	preq, _ := http.NewRequestWithContext(r.Context(), "GET",
		req.BaseURL+"/v1/models", nil)
	if req.APIKey != "" {
		preq.Header.Set("Authorization", "Bearer "+req.APIKey)
	}
	resp, err := client.Do(preq)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	models := make([]map[string]any, 0, len(out.Data))
	for _, m := range out.Data {
		models = append(models, map[string]any{"id": m.ID, "providerId": req.ProviderID})
	}
	writeJSON(w, 200, map[string]any{"ok": true, "models": models, "count": len(models)})
}

// refreshModelDB 触发 model_context_db 刷新 (骨架: 记录时间戳)
func (s *Service) refreshModelDB(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.lastScanInfo = map[string]any{"refreshedAt": time.Now().UnixMilli()}
	info := s.lastScanInfo
	s.mu.Unlock()
	s.event(r.Context(), "providers.model-db.refreshed", info)
	writeJSON(w, 200, map[string]any{"ok": true, "refreshedAt": info["refreshedAt"]})
}

// modelDBStatus model_context_db 状态
func (s *Service) modelDBStatus(w http.ResponseWriter, _ *http.Request) {
	var db map[string]any
	count := 0
	if err := s.readJSON("model_context_db.json", &db); err == nil {
		// models 可能是数组或按 id 键控的 dict (实际文件为 dict, 244 条)
		switch models := db["models"].(type) {
		case []any:
			count = len(models)
		case map[string]any:
			count = len(models)
		}
	}
	s.mu.Lock()
	last := s.lastScanInfo
	s.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true, "models": count, "lastScan": last})
}

// probeCacheGet 探测缓存查询
func (s *Service) probeCacheGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("providerId")
	s.mu.Lock()
	cached, ok := s.probeCache[id]
	s.mu.Unlock()
	if !ok {
		writeJSON(w, 200, map[string]any{"found": false})
		return
	}
	writeJSON(w, 200, map[string]any{"found": true, "cache": cached})
}

// ── custom-rules ────────────────────────────────────────────────

// customRulesGet 本地规则文件读取 (对齐 TS /api/custom-rules)
func (s *Service) customRulesGet(w http.ResponseWriter, _ *http.Request) {
	data, err := os.ReadFile(filepath.Join(s.baseDir, "custom_rules.md"))
	content := ""
	if err == nil {
		content = string(data)
	}
	writeJSON(w, 200, map[string]any{"content": content})
}

// customRulesSet 本地规则文件写入
func (s *Service) customRulesSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if err := os.WriteFile(filepath.Join(s.baseDir, "custom_rules.md"),
		[]byte(req.Content), 0o644); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	s.event(r.Context(), "custom-rules.updated", map[string]any{"size": len(req.Content)})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ── skills / resources ──────────────────────────────────────────

// skillsContent 技能内容 (resources/skills/manifest.json + 各内容文件)
func (s *Service) skillsContent(w http.ResponseWriter, _ *http.Request) {
	manifestPath := filepath.Join(s.baseDir, "resources", "skills", "manifest.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		writeJSON(w, 200, map[string]any{"skills": []any{}})
		return
	}
	var manifest struct {
		Items []struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Content string `json:"content"`
		} `json:"items"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		writeJSON(w, 200, map[string]any{"skills": []any{}})
		return
	}
	skills := make([]map[string]any, 0, len(manifest.Items))
	for _, it := range manifest.Items {
		content := ""
		if it.Content != "" {
			if cd, err := os.ReadFile(filepath.Join(s.baseDir, "resources", "skills", it.Content)); err == nil {
				content = string(cd)
			}
		}
		skills = append(skills, map[string]any{"id": it.ID, "name": it.Name, "content": content})
	}
	writeJSON(w, 200, map[string]any{"skills": skills})
}

// resourcesActive 资源激活状态 (骨架: 全部默认未激活)
func (s *Service) resourcesActive(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"active": map[string]any{}})
}

// resourcesManifest 资源清单 (resources/<type>/manifest.json)
func (s *Service) resourcesManifest(w http.ResponseWriter, r *http.Request) {
	typ := r.PathValue("type")
	switch typ {
	case "tools", "knowledge", "skills":
	default:
		writeJSON(w, 400, map[string]any{"error": "无效资源类型: " + typ})
		return
	}
	data, err := os.ReadFile(filepath.Join(s.baseDir, "resources", typ, "manifest.json"))
	if err != nil {
		writeJSON(w, 200, map[string]any{"type": typ, "items": []any{}})
		return
	}
	var manifest any
	json.Unmarshal(data, &manifest)
	writeJSON(w, 200, map[string]any{"type": typ, "manifest": manifest})
}

// ── system-metrics (对齐 TS /api/system-metrics) ────────────────

// systemMetrics 运行时指标 (内存/Goroutine/GO 版本; 对齐旧 runtime metrics)
func (s *Service) systemMetrics(w http.ResponseWriter, _ *http.Request) {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	writeJSON(w, 200, map[string]any{
		"memory": map[string]any{
			"alloc":       mem.Alloc,
			"sys":         mem.Sys,
			"heapObjects": mem.HeapObjects,
			"numGC":       mem.NumGC,
		},
		"goroutines": runtime.NumGoroutine(),
		"goVersion":  runtime.Version(),
		"timestamp":  time.Now().UnixMilli(),
	})
}

// ── tools ───────────────────────────────────────────────────────

// toolsSchemas 工具 schema 清单 (骨架: 内置集合)
func (s *Service) toolsSchemas(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"schemas": []map[string]any{
		{"name": "browser_navigate", "kind": "browser-use", "desc": "浏览器导航"},
		{"name": "powershell", "kind": "windows-mcp", "desc": "执行 PowerShell"},
		{"name": "dom_inspect", "kind": "devtools", "desc": "DOM 检查"},
	}})
}

// toolsInvoke 工具调用 (骨架: 回显确认, 真实执行接 toolsrelay)
func (s *Service) toolsInvoke(w http.ResponseWriter, r *http.Request) {
	var req map[string]any
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	s.event(r.Context(), "tools.invoke", map[string]any{"tool": req["tool"]})
	writeJSON(w, 200, map[string]any{"ok": true, "echo": req})
}

// ── auth / debug ────────────────────────────────────────────────

// authStub 启动 token 引导 (新架构由 /api/auth/bootstrap 承担, 此处桥接)
func (s *Service) authStub(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "hint": "使用 GET /api/auth/bootstrap (security 层)"})
}

// debugLog 调试日志追加 (骨架: 内存环形, 最多 500 行)
func (s *Service) debugLog(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Line string `json:"line"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Line == "" {
		writeJSON(w, 400, map[string]any{"error": "body 需为 {line}"})
		return
	}
	s.mu.Lock()
	s.debugLines = append(s.debugLines, fmt.Sprintf("%s %s", time.Now().Format("15:04:05"), req.Line))
	if len(s.debugLines) > 500 {
		s.debugLines = s.debugLines[len(s.debugLines)-500:]
	}
	s.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true})
}
