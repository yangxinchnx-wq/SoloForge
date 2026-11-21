// ─────────────────────────────────────────────────────────────────
// llmproxy_test.go — LLM 流式代理自测 (旧核退役前置迁移)
//
// 覆盖: 假上游 SSE → 下游 delta 帧 / usage 合并到 done 帧 /
// userGoal 校验 / 凭据三路优先级 (inline → env) / token 校验。
// ─────────────────────────────────────────────────────────────────
package uiapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/llm"
	"soloforge/next/internal/store"
)

// fakeUpstream 假 OpenAI 兼容流式上游
func fakeUpstream(t *testing.T, hits *int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*hits++
		var body struct {
			Stream        bool `json:"stream"`
			MaxTokens     int  `json:"max_tokens"`
			StreamOptions *struct {
				IncludeUsage bool `json:"include_usage"`
			} `json:"stream_options"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		f := w.(http.Flusher)
		frame := func(s string) {
			w.Write([]byte("data: " + s + "\n\n"))
			f.Flush()
		}
		frame(`{"choices":[{"delta":{"content":"hel"}}]}`)
		frame(`{"choices":[{"delta":{"content":"lo"}}]}`)
		frame(`{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}`)
		frame(`[DONE]`)
	}))
}

func TestLLMStreamProxy(t *testing.T) {
	hits := 0
	up := fakeUpstream(t, &hits)
	defer up.Close()

	svc := New("", store.New(), nil)
	svc.SetBus(bus.NewEventBus())

	// inline 凭据
	body := `{"userGoal":"hi","baseUrl":"` + up.URL + `","apiKey":"k","model":"m1"}`
	req := httptest.NewRequest("POST", "/api/llm/stream", strings.NewReader(body))
	rec := httptest.NewRecorder()
	svc.HandleLLMStream(rec, req)

	out := rec.Body.String()
	if !strings.Contains(out, `"delta":"hel"`) || !strings.Contains(out, `"delta":"lo"`) {
		t.Fatalf("下游应收到 delta 帧: %s", out)
	}
	if !strings.Contains(out, `"done":true`) {
		t.Fatalf("应收到 done 帧: %s", out)
	}
	if !strings.Contains(out, `"promptTokens":7`) || !strings.Contains(out, `"totalTokens":9`) {
		t.Fatalf("done 帧应合并 usage: %s", out)
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("应为 SSE: %s", rec.Header().Get("Content-Type"))
	}

	// 校验: 缺 userGoal → 400
	req2 := httptest.NewRequest("POST", "/api/llm/stream", strings.NewReader(`{"systemPrompt":"x"}`))
	rec2 := httptest.NewRecorder()
	svc.HandleLLMStream(rec2, req2)
	if rec2.Code != 400 {
		t.Fatalf("缺 userGoal 应 400: %d", rec2.Code)
	}

	// env 凭据: 未配置 → 503
	llm.ResetConfig()
	req3 := httptest.NewRequest("POST", "/api/llm/stream", strings.NewReader(`{"userGoal":"hi"}`))
	rec3 := httptest.NewRecorder()
	svc.HandleLLMStream(rec3, req3)
	if rec3.Code != 503 {
		t.Fatalf("未配置应 503: %d %s", rec3.Code, rec3.Body.String())
	}
}

func TestLLMConfigAndHealthRoutes(t *testing.T) {
	svc := New("", store.New(), nil)

	// /api/llm/config — 脱敏 (无 key 字段)
	req := httptest.NewRequest("GET", "/api/llm/config", nil)
	rec := httptest.NewRecorder()
	svc.HandleLLMConfig(rec, req)
	var cfg map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &cfg)
	if _, has := cfg["apiKey"]; has {
		t.Fatalf("脱敏配置不应含 key: %v", cfg)
	}
	if _, has := cfg["ready"]; !has {
		t.Fatalf("应含 ready 字段: %v", cfg)
	}
}
