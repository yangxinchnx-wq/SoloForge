// ─────────────────────────────────────────────────────────────────
// canvasrelay.go — 画布中转服务端 (从 TS src/server/routes-canvas.ts 迁移,
// 旧 TS 核心退役的前置迁移)
//
// 设计背景 (对齐 TS 2026-07-09):
//   - Flutter canvas 端口由 Electron 主进程动态分配 (startCanvas)
//   - Java Agent (8770) 和 Go 核心 (7300) 都不能直接知道端口
//   - Electron 主进程在 startCanvas 成功后, 主动 HTTP POST 注册端口
//   - Agent 调 canvas_push_ui → 查端口表 → 转发到 Flutter /render
//
// 端口注册表: Map<sessionId, {port, pid, hwnd, registeredAt}>
//
//	存活期: Electron 主进程在画布停止时调 unregister-port
//	容错: 进程重启后表清空, 下次 Electron 心跳重新注册;
//	      push 时清理 60s 未心跳的过期条目 (Electron 心跳约 30s)
//
// 协议转换: {sessionId, dsl(AST), language} → Flutter 期望的
//
//	{type: "render", ui: AST, platform: "material", language}
//	(Flutter main.dart _handleMessage 解析 ui 字段)
//
// HTTP 路由 (uiapi.Register 委托挂载):
//
//	GET  /api/canvas/relay/ports           查询注册表 (调试)
//	POST /api/canvas/relay/register-port   Electron 注册
//	POST /api/canvas/relay/unregister-port Electron 注销
//	POST /api/canvas/relay/push-ui         Agent 推 DSL
//
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// canvasRelayStaleMs 过期阈值 (TS STALE_THRESHOLD_MS = 60_000)
const canvasRelayStaleMs = 60_000

// CanvasPortInfo 画布端口注册条目 (对齐 TS CanvasPortInfo)
type CanvasPortInfo struct {
	SessionID    string `json:"sessionId"`
	Port         int    `json:"port"`
	PID          int    `json:"pid"`
	HWND         int    `json:"hwnd,omitempty"`
	RegisteredAt int64  `json:"registeredAt"`
}

// canvasRelay 进程级端口注册表 (对齐 TS canvasPortRegistry)
type canvasRelay struct {
	mu    sync.RWMutex
	ports map[string]*CanvasPortInfo
}

var defaultCanvasRelay = &canvasRelay{ports: make(map[string]*CanvasPortInfo)}

// ── 注册/注销/查询 ──────────────────────────────────────────────

// RelayPortList 查询所有已注册画布端口 (调试用)。
// 返回 (count, ports, ok)。
func RelayPortList() (int, []CanvasPortInfo) {
	defaultCanvasRelay.mu.RLock()
	defer defaultCanvasRelay.mu.RUnlock()
	out := make([]CanvasPortInfo, 0, len(defaultCanvasRelay.ports))
	for _, info := range defaultCanvasRelay.ports {
		out = append(out, *info)
	}
	return len(out), out
}

// RelayPortRegister Electron 主进程注册画布端口。
// body: {sessionId, port, pid, hwnd?}。startCanvas 成功后调用;
// 画布看门狗心跳时也可调用 (刷新 registeredAt)。
func RelayPortRegister(body map[string]any) (int, map[string]any) {
	sessionID := strArg(body, "sessionId")
	port := 0
	if v, ok := body["port"].(float64); ok {
		port = int(v)
	}
	pid := 0
	if v, ok := body["pid"].(float64); ok {
		pid = int(v)
	}
	if sessionID == "" || port == 0 || pid == 0 {
		return 400, map[string]any{"success": false, "error": "missing required fields: sessionId, port, pid"}
	}
	hwnd := 0
	if v, ok := body["hwnd"].(float64); ok {
		hwnd = int(v)
	}

	defaultCanvasRelay.mu.Lock()
	defaultCanvasRelay.ports[sessionID] = &CanvasPortInfo{
		SessionID: sessionID, Port: port, PID: pid, HWND: hwnd,
		RegisteredAt: time.Now().UnixMilli(),
	}
	total := len(defaultCanvasRelay.ports)
	defaultCanvasRelay.mu.Unlock()

	slog.Info("canvas-relay 端口已注册", "port", port, "sessionId", sessionID, "pid", pid)
	return 200, map[string]any{"success": true, "sessionId": sessionID, "port": port, "totalRegistered": total}
}

// RelayPortUnregister Electron 主进程注销画布端口。body: {sessionId}
func RelayPortUnregister(body map[string]any) (int, map[string]any) {
	sessionID := strArg(body, "sessionId")
	if sessionID == "" {
		return 400, map[string]any{"success": false, "error": "missing sessionId"}
	}
	defaultCanvasRelay.mu.Lock()
	_, existed := defaultCanvasRelay.ports[sessionID]
	delete(defaultCanvasRelay.ports, sessionID)
	remaining := len(defaultCanvasRelay.ports)
	defaultCanvasRelay.mu.Unlock()

	slog.Info("canvas-relay 端口已注销", "sessionId", sessionID, "existed", existed)
	return 200, map[string]any{"success": true, "sessionId": sessionID, "wasRegistered": existed, "remaining": remaining}
}

// ── push-ui (核心转发) ──────────────────────────────────────────

// RelayPushUI 推送 DSL 到 Flutter 画布 (canvas_push_ui 工具的进程内直调入口)。
// body: {sessionId, dsl(AST 对象), language?}。
// 返回 (httpStatus, 响应体) — 对齐 TS handleCanvasRelayPushUi 的 ApiResponse 语义:
//
//	400 参数缺失 / 503 无画布注册 (retryable) / 502 Flutter 不可达 (清注册表)
//	200 成功 {success, sessionId, port, dslBytes, flutterResponse}
func RelayPushUI(ctx context.Context, body map[string]any) (int, map[string]any) {
	sessionID := strArg(body, "sessionId")
	dsl, dslOK := body["dsl"].(map[string]any)
	language := strArg(body, "language")
	if language == "" {
		language = "typescript"
	}
	if sessionID == "" {
		return 400, map[string]any{"success": false, "error": "missing sessionId"}
	}
	if !dslOK || dsl == nil {
		return 400, map[string]any{"success": false, "error": "missing or invalid dsl (expected object)"}
	}

	// 1. 清理过期端口 (60s 未心跳) + 精确匹配 → 单画布降级取任意注册项
	defaultCanvasRelay.mu.Lock()
	now := time.Now().UnixMilli()
	for key, info := range defaultCanvasRelay.ports {
		if now-info.RegisteredAt > canvasRelayStaleMs {
			delete(defaultCanvasRelay.ports, key)
			slog.Info("canvas-relay 清理过期端口", "sessionId", key, "port", info.Port, "ageMs", now-info.RegisteredAt)
		}
	}
	portInfo, ok := defaultCanvasRelay.ports[sessionID]
	if !ok && len(defaultCanvasRelay.ports) > 0 {
		// 降级: 取任意一个已注册画布 (单画布场景)
		for _, info := range defaultCanvasRelay.ports {
			portInfo = info
			slog.Warn("canvas-relay sessionId 不在注册表, 降级使用已注册端口",
				"requested", sessionID, "fallbackSession", info.SessionID, "port", info.Port)
			break
		}
	}
	if portInfo == nil {
		defaultCanvasRelay.mu.Unlock()
		slog.Warn("canvas-relay 无画布注册, 无法推送", "sessionId", sessionID)
		return 503, map[string]any{
			"success":   false,
			"error":     "no canvas process registered. Start a canvas in the Electron UI first.",
			"hint":      "Electron 主进程需要在画布启动时调 POST /api/canvas/relay/register-port 注册端口",
			"retryable": true,
		}
	}
	port := portInfo.Port
	regSession := portInfo.SessionID
	defaultCanvasRelay.mu.Unlock()

	// 2. 协议转换 — {dsl} → {type:"render", ui, platform:"material", language}
	flutterPayload := map[string]any{
		"type":     "render",
		"ui":       dsl,
		"platform": "material",
		"language": language,
	}
	raw, err := json.Marshal(flutterPayload)
	if err != nil {
		return 400, map[string]any{"success": false, "error": "dsl 序列化失败: " + err.Error()}
	}

	// 3. HTTP POST 到 Flutter /render
	flutterURL := fmt.Sprintf("http://127.0.0.1:%d/render", port)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, flutterURL, bytes.NewReader(raw))
	if err != nil {
		return 502, map[string]any{"success": false, "error": "构造 Flutter 请求失败: " + err.Error(), "port": port}
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := defaultHTTPClient().Do(req)
	if err != nil {
		slog.Error("canvas-relay Flutter 不可达", "port", port, "err", err)
		// 画布可能已挂: 清理注册表 (Electron 看门狗会重启并重新注册)
		defaultCanvasRelay.mu.Lock()
		delete(defaultCanvasRelay.ports, regSession)
		defaultCanvasRelay.mu.Unlock()
		return 502, map[string]any{
			"success": false,
			"error":   fmt.Sprintf("failed to reach Flutter canvas: %v", err),
			"port":    port,
			"hint":    "画布进程可能已退出, 请在 Electron UI 重新启动画布",
		}
	}
	defer resp.Body.Close()
	flutterBody := readBodyString(resp)

	if resp.StatusCode >= 400 {
		slog.Warn("canvas-relay Flutter /render 失败", "status", resp.StatusCode, "body", truncate(flutterBody, 150))
		return 502, map[string]any{
			"success": false, "error": fmt.Sprintf("Flutter /render failed: HTTP %d", resp.StatusCode),
			"flutterResponse": flutterBody, "port": port,
		}
	}

	slog.Info("canvas-relay UI 已推送", "sessionId", sessionID, "port", port, "dslBytes", len(raw))
	return 200, map[string]any{
		"success": true, "sessionId": sessionID, "port": port,
		"dslBytes":        len(raw),
		"flutterResponse": firstNonEmptyStr(flutterBody, `{"ok":true}`),
	}
}

// ── HTTP handlers (uiapi.Register 委托挂载) ─────────────────────

// RelayHandlePorts GET /api/canvas/relay/ports
func RelayHandlePorts(w http.ResponseWriter, _ *http.Request) {
	count, ports := RelayPortList()
	writeRelayJSON(w, 200, map[string]any{"success": true, "count": count, "ports": ports})
}

// RelayHandleRegister POST /api/canvas/relay/register-port
func RelayHandleRegister(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeRelayJSON(w, 400, map[string]any{"success": false, "error": "invalid body"})
		return
	}
	status, resp := RelayPortRegister(body)
	writeRelayJSON(w, status, resp)
}

// RelayHandleUnregister POST /api/canvas/relay/unregister-port
func RelayHandleUnregister(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeRelayJSON(w, 400, map[string]any{"success": false, "error": "invalid body"})
		return
	}
	status, resp := RelayPortUnregister(body)
	writeRelayJSON(w, status, resp)
}

// RelayHandlePushUI POST /api/canvas/relay/push-ui
func RelayHandlePushUI(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeRelayJSON(w, 400, map[string]any{"success": false, "error": "invalid body"})
		return
	}
	status, resp := RelayPushUI(r.Context(), body)
	writeRelayJSON(w, status, resp)
}

func writeRelayJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func firstNonEmptyStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
