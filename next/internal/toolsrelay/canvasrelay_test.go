// ─────────────────────────────────────────────────────────────────
// retirement_test.go — 旧核退役前置迁移自测
//
// 覆盖: canvas relay (注册/注销/push-ui 端口表转发)、LLM 流式代理
// (假上游 SSE → 下游帧/usage 合并/凭据三路优先级)、browser-use 带参
// 路由 (state/pause/resume/cancel + SSE 步进)。
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ─── canvas relay ────────────────────────────────────────────────

func TestCanvasRelayRegisterAndPush(t *testing.T) {
	// 假 Flutter /render 服务
	var gotPayload map[string]any
	flutter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotPayload)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer flutter.Close()

	// 注册端口 (指向假 Flutter)
	status, resp := RelayPortRegister(map[string]any{
		"sessionId": "s1", "port": float64(portOf(flutter.URL)), "pid": float64(123),
	})
	if status != 200 || resp["success"] != true {
		t.Fatalf("注册失败: %d %v", status, resp)
	}

	// push-ui: 端口表查到 → 转发 Flutter
	status, resp = RelayPushUI(context.Background(), map[string]any{
		"sessionId": "s1",
		"dsl":       map[string]any{"type": "column", "children": []any{}},
	})
	if status != 200 || resp["success"] != true {
		t.Fatalf("push 失败: %d %v", status, resp)
	}
	if gotPayload["type"] != "render" || gotPayload["platform"] != "material" {
		t.Fatalf("协议转换错误: %+v", gotPayload)
	}
	if _, ok := gotPayload["ui"]; !ok {
		t.Fatalf("ui 字段缺失: %+v", gotPayload)
	}

	// 降级: 未注册 sessionId → 取任意注册项
	status, resp = RelayPushUI(context.Background(), map[string]any{
		"sessionId": "other", "dsl": map[string]any{"type": "text"},
	})
	if status != 200 {
		t.Fatalf("单画布降级应成功: %d %v", status, resp)
	}

	// 无画布: 注销后 → 503 retryable
	RelayPortUnregister(map[string]any{"sessionId": "s1"})
	status, resp = RelayPushUI(context.Background(), map[string]any{
		"sessionId": "s1", "dsl": map[string]any{"type": "text"},
	})
	if status != 503 || resp["retryable"] != true {
		t.Fatalf("无注册应 503 retryable: %d %v", status, resp)
	}

	// 参数校验: 缺 dsl → 400
	RelayPortRegister(map[string]any{"sessionId": "s1", "port": float64(1), "pid": float64(1)})
	status, _ = RelayPushUI(context.Background(), map[string]any{"sessionId": "s1"})
	if status != 400 {
		t.Fatalf("缺 dsl 应 400: %d", status)
	}
	RelayPortUnregister(map[string]any{"sessionId": "s1"})
}

func portOf(url string) int {
	// httptest URL 形如 http://127.0.0.1:PORT
	parts := strings.Split(url, ":")
	n := 0
	fmt.Sscanf(parts[len(parts)-1], "%d", &n)
	return n
}

// ─── LLM 流式代理 (经 uiapi? 包边界: uiapi 在此测不了, 见 uiapi 包测试) ──

// (LLM 代理测试在 internal/uiapi/llmproxy_test.go)

// ─── browser-use 路由 (compat 包测试见 internal/compat) ──────────
