// ─────────────────────────────────────────────────────────────────
// compat — 旧 UI/server.ts 路径的兼容层 (旧 TS 核心退役迁移)
//
// 本包在 Go 核心 (7300) 承接旧链路径, 让 UI 前端无感切换:
//
//	/api/canvas/relay/*  → 画布中转服务端 (canvasrelay.go, Electron
//	                        注册端口 / Agent push-ui; 旧实现根 src/)
//	/api/browser-use/*   → BUOrchestrator (MCP 会话 + 任务镜像 + 步进
//	                        SSE, 对齐旧 server.ts orchestrator)
//	/api/agents/experience/feedback → agent 反馈 (事件落库+信誉)
//	/api/names/update    → 自定义命名 (kv)
//	/api/training/fetch-url → URL 抓取
//	/api/test            → 测试端点
//
// 注: /api/llm/stream 的 501 桩已移除 — uiapi 提供真实流式代理
// (llmproxy.go); 同路径重复注册会使 http.ServeMux panic。
// ─────────────────────────────────────────────────────────────────
package compat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
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
	// Orch browser-use MCP 编排器 (nil 时用默认单例装配)
	Orch *toolsrelay.BUOrchestrator
}

// Register 注册全部兼容路由
func Register(mux *http.ServeMux, d Deps) {
	// ── canvas relay 服务端 (旧 src/server/routes-canvas.ts 迁移) ──
	mux.HandleFunc("GET /api/canvas/relay/ports", toolsrelay.RelayHandlePorts)
	mux.HandleFunc("POST /api/canvas/relay/register-port", toolsrelay.RelayHandleRegister)
	mux.HandleFunc("POST /api/canvas/relay/unregister-port", toolsrelay.RelayHandleUnregister)
	mux.HandleFunc("POST /api/canvas/relay/push-ui", toolsrelay.RelayHandlePushUI)

	// ── browser-use 全路由 (orchestrator 语义对齐 TS) ──
	registerBrowserUseRoutes(mux, d)

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

	// ── 训练数据 URL 抓取 ──
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

	// ── 测试端点 ──
	mux.HandleFunc("GET /api/test", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "service": "soloforge-core", "time": time.Now().UnixMilli()})
	})
}

// ── browser-use 全路由 (对齐 TS orchestrator.ts) ────────────────

func registerBrowserUseRoutes(mux *http.ServeMux, d Deps) {
	orch := d.Orch
	if orch == nil {
		orch = toolsrelay.NewBUOrchestrator(
			toolsrelay.DefaultBUMcpSession,
			toolsrelay.DefaultBUTaskStore,
			toolsrelay.DefaultBUStepBus)
	}

	// GET /api/browser-use/health — MCP 就绪探活 (对齐 TS ensureReady)
	mux.HandleFunc("GET /api/browser-use/health", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		if _, err := orch.Session.ListTools(ctx); err != nil {
			writeJSON(w, 200, map[string]any{"success": false, "ready": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"success": true, "ready": true})
	})

	// POST /api/browser-use/run — 提交任务 (对齐 TS runTask)
	mux.HandleFunc("POST /api/browser-use/run", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Task string `json:"task"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Task) == "" {
			writeJSON(w, 400, map[string]any{"success": false, "error": "task is required"})
			return
		}
		rec, err := orch.RunTask(r.Context(), req.Task)
		if err != nil {
			writeJSON(w, 500, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"success": true, "task": rec})
	})

	// GET /api/browser-use/state/{id} — 终态回缓存, 未终态拉 MCP
	mux.HandleFunc("GET /api/browser-use/state/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		task, ok := orch.GetTaskState(r.Context(), id)
		if !ok {
			writeJSON(w, 404, map[string]any{"success": false, "error": "task not found"})
			return
		}
		writeJSON(w, 200, map[string]any{"success": true, "task": task})
	})

	// POST /api/browser-use/{cancel,pause,resume}/{id}
	mux.HandleFunc("POST /api/browser-use/cancel/{id}", func(w http.ResponseWriter, r *http.Request) {
		ok := orch.CancelTask(r.Context(), r.PathValue("id"))
		writeJSON(w, 200, map[string]any{"success": true, "cancelled": ok})
	})
	mux.HandleFunc("POST /api/browser-use/pause/{id}", func(w http.ResponseWriter, r *http.Request) {
		ok := orch.PauseTask(r.Context(), r.PathValue("id"))
		writeJSON(w, 200, map[string]any{"success": true, "paused": ok})
	})
	mux.HandleFunc("POST /api/browser-use/resume/{id}", func(w http.ResponseWriter, r *http.Request) {
		ok := orch.ResumeTask(r.Context(), r.PathValue("id"))
		writeJSON(w, 200, map[string]any{"success": true, "resumed": ok})
	})

	// GET /api/browser-use/stream/{id} — SSE 步进流
	// (对齐 TS streamTask: 首发缓存 state → 订阅步进 → final/error 结算 → 心跳保活 15s)
	// 并发纪律: 步进回调 (MCP 通知 goroutine) 与心跳 goroutine 都会写 w,
	// 用 writeMu 串行化, 防止交错写破坏 SSE 帧边界
	mux.HandleFunc("GET /api/browser-use/stream/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, 500, map[string]any{"error": "streaming unsupported"})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)

		var writeMu sync.Mutex
		closed := false
		sendSSE := func(event string, data any) {
			writeMu.Lock()
			defer writeMu.Unlock()
			if closed {
				return
			}
			b, _ := json.Marshal(data)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
			flusher.Flush()
		}

		// 缓存状态首发 (对齐 TS: if cached → sseSend('state', cached))
		if cached, ok := orch.Tasks.GetTask(id); ok {
			sendSSE("state", cached)
		}

		// 步进订阅: final/error → 结算并推 state; 全部步进推 step
		unsub := orch.Steps.SubscribeTask(id, func(step toolsrelay.ReactStep) {
			switch step.Kind {
			case "final":
				orch.Tasks.PatchTask(id, toolsrelay.TaskRecord{Status: toolsrelay.TaskSuccess, Result: step.Content})
				if t, ok := orch.Tasks.GetTask(id); ok {
					sendSSE("state", t)
				}
			case "error":
				orch.Tasks.PatchTask(id, toolsrelay.TaskRecord{Status: toolsrelay.TaskError, Error: step.Content})
				if t, ok := orch.Tasks.GetTask(id); ok {
					sendSSE("state", t)
				}
			}
			if cur, ok := orch.Tasks.GetTask(id); ok && step.StepIndex > cur.CurrentStep {
				orch.Tasks.PatchTask(id, toolsrelay.TaskRecord{CurrentStep: step.StepIndex})
			}
			sendSSE("step", step)
		})

		// 心跳保活 + 客户端断开清理 (对齐 TS req.on('close') → cleanup)
		heartbeat := time.NewTicker(15 * time.Second)
		done := make(chan struct{})
		go func() {
			defer heartbeat.Stop()
			for {
				select {
				case <-done:
					return
				case <-r.Context().Done():
					unsub()
					writeMu.Lock()
					closed = true
					writeMu.Unlock()
					close(done)
					return
				case <-heartbeat.C:
					writeMu.Lock()
					if !closed {
						fmt.Fprint(w, ":heartbeat\n\n")
						flusher.Flush()
					}
					writeMu.Unlock()
				}
			}
		}()
		<-r.Context().Done() // 连接关闭即返回
		unsub()
	})

	// GET /api/browser-use/tasks — 任务镜像列表 (对齐 TS listLocalTasks)
	mux.HandleFunc("GET /api/browser-use/tasks", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"success": true, "tasks": orch.Tasks.ListTasks()})
	})
}

// writeJSON
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
