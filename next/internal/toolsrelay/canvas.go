// ─────────────────────────────────────────────────────────────────
// canvas.go — 画布工具 (从 TS tool-definitions.ts 画布分支迁移)
//
// 语义对齐 TS: 画布工具经 HTTP 转发到 UI 进程 (跨进程), UI 端再路由到
// SessionStore / Flutter 画布。UI 基址取环境变量 SOLOFORGE_UI_BASE_URL,
// 默认 http://localhost:3000 (对齐 TS UI_BASE_URL):
//
//	canvas_push_ui → POST {UI}/api/canvas/relay/push-ui (直接推 Universal AST,
//	                  链路: Agent tool_call → relay push-ui → Flutter /render)
//	solo_canvas_*  → POST {UI}/api/canvas/tools/invoke
//	                 (带 X-Requester-Chat-Session-Id 头, 用于 ACL)
//
// 与 TS 一样"友好错误, 不抛异常": 失败一律返回内联消息字符串
// ("Error: ..." 或 "OK"), 不作为 Go error 抛出。
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// uiBaseURL UI 进程基址 (对齐 TS: process.env.SOLOFORGE_UI_BASE_URL || localhost:3000)
func uiBaseURL() string {
	if v := os.Getenv("SOLOFORGE_UI_BASE_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "http://localhost:3000"
}

// numOrUndefined 数值字段格式化: 缺失时输出 "undefined"
// (对齐 TS 模板字符串引用缺失字段的行为)
func numOrUndefined(m map[string]any, key string) string {
	if v, ok := m[key].(float64); ok {
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return "undefined"
}

// postUIJSON 向 UI 进程 POST JSON 并解析响应, 返回 HTTP 状态码。
// err 仅表示构造请求/传输失败 (对齐 TS fetch 抛错); 响应非 JSON 时按空
// 对象处理 (对齐 TS res.json().catch(() => ({}))), 不视为传输失败。
func postUIJSON(ctx context.Context, url string, body any, out any, extraHeaders http.Header) (int, error) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, &buf)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, vs := range extraHeaders {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	resp, err := defaultHTTPClient().Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_ = json.NewDecoder(resp.Body).Decode(out) // 非 JSON → out 保持零值, 对齐 TS
	return resp.StatusCode, nil
}

// ─── canvas_push_ui ──────────────────────────────────────────────

// toolCanvasPushUI 直接推送 Universal AST UI 树到 Flutter 画布
// (对齐 TS canvas_push_ui: 断路修复 — 不依赖前端从文本提取代码块)
func toolCanvasPushUI(ctx context.Context, req ToolRequest) (any, error) {
	a := argsObject(req.Arguments)
	sessionID := argStr(a, "sessionId")
	if sessionID == "" {
		return toolResult(req.Name, false, "",
			`Error: canvas_push_ui requires "sessionId" argument`), nil
	}
	dsl, ok := a["dsl"].(map[string]any)
	if !ok || dsl == nil {
		return toolResult(req.Name, false, "",
			`Error: canvas_push_ui requires "dsl" argument (Universal AST object)`), nil
	}
	language := argStr(a, "language")
	if language == "" {
		language = "typescript"
	}

	url := uiBaseURL() + "/api/canvas/relay/push-ui"
	var data map[string]any
	status, err := postUIJSON(ctx, url,
		map[string]any{"sessionId": sessionID, "dsl": dsl, "language": language},
		&data, nil)
	if err != nil {
		return toolResult(req.Name, false, "", fmt.Sprintf(
			"Error: failed to reach canvas relay (%s): %v", uiBaseURL(), err)), nil
	}
	success, _ := data["success"].(bool)
	if status < 200 || status >= 300 || !success {
		msg, _ := data["error"].(string)
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", status) // 对齐 TS: error || HTTP status
		}
		return toolResult(req.Name, false, "",
			"Error: canvas relay push-ui failed: "+msg), nil
	}
	output := fmt.Sprintf(
		"Successfully pushed UI to canvas (sessionId=%s, port=%s, dslBytes=%s). The UI has been rendered on the Flutter canvas.",
		sessionID, numOrUndefined(data, "port"), numOrUndefined(data, "dslBytes"))
	return toolResult(req.Name, true, output, ""), nil
}

// ─── solo_canvas_* ───────────────────────────────────────────────

// soloCanvasTools 画布管理工具名清单
// (对齐 TS AGENT_TOOLS 中 solo_canvas_* 的 8 个工具, Schema 来自 UI 端
// UI/src/server/routes/canvasTools.ts)
var soloCanvasTools = []string{
	"solo_canvas_list",
	"solo_canvas_get",
	"solo_canvas_create",
	"solo_canvas_add_device",
	"solo_canvas_update_device",
	"solo_canvas_remove_device",
	"solo_canvas_rename",
	"solo_canvas_delete",
}

// invokeCanvasToolViaUI 画布管理工具经 UI 进程转发
// (对齐 TS invokeCanvasToolViaUI: 后端 Agent → UI 进程 HTTP → SessionStore)
func invokeCanvasToolViaUI(ctx context.Context, toolName string, args map[string]any) string {
	requester, _ := args["requesterChatSessionId"].(string)
	if requester == "" {
		return fmt.Sprintf("Error: %s requires 'requesterChatSessionId' arg", toolName)
	}
	url := uiBaseURL() + "/api/canvas/tools/invoke"
	headers := http.Header{}
	headers.Set("X-Requester-Chat-Session-Id", requester) // ACL 校验头
	var data struct {
		Success bool            `json:"success"`
		Payload json.RawMessage `json:"payload"`
		Error   string          `json:"error"`
	}
	status, err := postUIJSON(ctx, url,
		map[string]any{"name": toolName, "arguments": args}, &data, headers)
	if err != nil {
		return fmt.Sprintf("Error: failed to call UI canvas endpoint (%s): %v",
			uiBaseURL(), err)
	}
	if status < 200 || status >= 300 || !data.Success {
		msg := data.Error
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", status)
		}
		return "Error: " + msg
	}
	if len(data.Payload) == 0 || string(data.Payload) == "null" {
		return "OK" // 对齐 TS: payload 为 undefined/null 时返回 'OK'
	}
	var s string
	if err := json.Unmarshal(data.Payload, &s); err == nil {
		return s // payload 为字符串时原样返回 (对齐 TS)
	}
	indented, err := json.MarshalIndent(json.RawMessage(data.Payload), "", "  ")
	if err != nil {
		return string(data.Payload)
	}
	return string(indented) // 对齐 TS: JSON.stringify(payload, null, 2)
}

// registerCanvasTools 注册画布工具到注册表
func registerCanvasTools(rg *Registry) {
	rg.Register("canvas_push_ui", toolCanvasPushUI)
	for _, name := range soloCanvasTools {
		rg.Register(name, func(ctx context.Context, req ToolRequest) (any, error) {
			// 对齐 TS default 分支: 转发结果 (含 "Error: ..." 内联消息) 直接
			// 作为 output 返回, 不抛 Go error
			output := invokeCanvasToolViaUI(ctx, req.Name, argsObject(req.Arguments))
			return toolResult(req.Name, true, output, ""), nil
		})
	}
}
