// ─────────────────────────────────────────────────────────────────
// compat — 旧 UI/server.ts 代理路径的兼容层 (断裂路径修复)
//
// 背景: 旧 TS RACER (3001) 退役后, server.ts 代理到 3001 的路径全部
// ECONNREFUSED (curl 000)。本包在 Go 核心 (7300) 提供这些路径的骨架
// 响应, 让 UI 功能不再静默断裂:
//
//	/api/browser-use/*   → toolsrelay 分发 (占位执行器)
//	/api/agents/experience/feedback → agent 反馈 (事件落库+信誉)
//	/api/names/update    → 自定义命名 (kv)
//	/api/training/fetch-url → URL 抓取 (骨架)
//	/api/llm/stream      → 501 (本地 LLM 走 Electron IPC, 非 HTTP)
//	/api/test            → 测试端点
//
// ─────────────────────────────────────────────────────────────────
package compat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"soloforge/next/internal/agents"
	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
	"soloforge/next/internal/toolsrelay"
)

// Deps 兼容层依赖
type Deps struct {
	Pool  *agents.Pool
	Relay *toolsrelay.Relay
	Store *store.Store
	Bus   *bus.EventBus
}

// Register 注册全部兼容路由
func Register(mux *http.ServeMux, d Deps) {
	// ── browser-use (9 路径 → toolsrelay) ──
	mux.HandleFunc("GET /api/browser-use/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"ok": true, "service": "browser-use",
			"note": "执行器占位 (Tauri 阶段接入真实 Browser-Use)",
		})
	})
	mux.HandleFunc("POST /api/browser-use/run", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Task string          `json:"task"`
			Tool string          `json:"tool"`
			Args json.RawMessage `json:"args"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Task == "" {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {task, tool?, args?}"})
			return
		}
		tool := req.Tool
		if tool == "" {
			tool = "browser-use.run"
		}
		result, err := d.Relay.Dispatch(r.Context(), tool, req.Args)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "task": req.Task, "result": result})
	})
	mux.HandleFunc("GET /api/browser-use/tasks", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"tasks": []any{}})
	})
	// 其余 browser-use 子路径: 状态机骨架 (统一响应)
	for _, sub := range []string{"cancel", "pause", "resume", "state", "stream"} {
		path := "/api/browser-use/" + sub
		mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, map[string]any{"ok": true, "status": "骨架响应 (占位执行器)"})
		})
		mux.HandleFunc("POST "+path, func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, map[string]any{"ok": true, "status": "骨架响应 (占位执行器)"})
		})
	}

	// ── agent 经验反馈 ──
	mux.HandleFunc("POST /api/agents/experience/feedback", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			AgentID  string  `json:"agentId"`
			Feedback string  `json:"feedback"`
			Positive bool    `json:"positive"`
			Rating   float64 `json:"rating"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AgentID == "" {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {agentId, feedback, positive?}"})
			return
		}
		delta := 1.0
		if !req.Positive {
			delta = -2.0
		}
		if req.Rating != 0 {
			delta = req.Rating
		}
		if d.Pool != nil {
			d.Pool.AdjustReputation(req.AgentID, delta)
		}
		raw, _ := json.Marshal(req)
		if ev, err := d.Store.AppendEvent(r.Context(), "agent.experience.feedback", "ui", raw); err == nil && d.Bus != nil {
			d.Bus.Publish(ev)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "agentId": req.AgentID, "delta": delta})
	})

	// ── 自定义命名 ──
	mux.HandleFunc("POST /api/names/update", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Kind string `json:"kind"`
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == "" {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {kind, id, name}"})
			return
		}
		key := fmt.Sprintf("name.%s.%s", req.Kind, req.ID)
		if d.Store != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			d.Store.KVSet(ctx, key, req.Name)
		}
		raw, _ := json.Marshal(req)
		if ev, err := d.Store.AppendEvent(r.Context(), "names.updated", "ui", raw); err == nil && d.Bus != nil {
			d.Bus.Publish(ev)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "key": key, "name": req.Name})
	})

	// ── 训练数据 URL 抓取 (骨架) ──
	mux.HandleFunc("POST /api/training/fetch-url", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			URL string `json:"url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {url}"})
			return
		}
		client := &http.Client{Timeout: 15 * time.Second}
		resp, err := client.Get(req.URL)
		if err != nil {
			writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		defer resp.Body.Close()
		buf := make([]byte, 64*1024)
		n, _ := io.ReadFull(resp.Body, buf)
		writeJSON(w, 200, map[string]any{
			"ok": true, "url": req.URL, "status": resp.StatusCode,
			"contentLength": n, "content": string(buf[:n]),
		})
	})

	// ── 本地 LLM 流式 (Electron IPC 域, 非 HTTP — 明确 501) ──
	mux.HandleFunc("POST /api/llm/stream", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotImplemented, map[string]any{
			"error": "本地 LLM 流式走 Electron IPC (local-llm:chat), 不经 HTTP",
		})
	})

	// ── 测试端点 ──
	mux.HandleFunc("GET /api/test", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "service": "soloforge-core", "time": time.Now().UnixMilli()})
	})
}

// writeJSON
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

var _ = fmt.Sprintf // fmt 引用占位 (browser-use 路径未来扩展)
var _ = io.Discard  // io 引用占位
