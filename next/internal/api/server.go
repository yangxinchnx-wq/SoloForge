// ─────────────────────────────────────────────────────────────────
// api — 对外唯一入口: HTTP + WebSocket (端口 7300)
//
// 路由 (Go 1.22 ServeMux 方法模式):
//   GET  /health              健康探针 (supervisor 判定 READY 的依据)
//   GET  /api/kernel/status   内核状态 (uptime/事件总数/订阅者/丢帧)
//   GET  /api/events/list     事件重放 (after 游标 + limit)
//   POST /api/commands        命令派发 (CommandBus)
//   GET  /metrics             简易文本指标
//   GET  /ws                  WebSocket: 下行事件流 + 上行命令
// ─────────────────────────────────────────────────────────────────
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

type Server struct {
	Store    *store.Store
	Bus      *bus.EventBus
	Commands *bus.CommandBus
	mux      *http.ServeMux
	start    time.Time
	logger   *slog.Logger
}

func New(st *store.Store, b *bus.EventBus, cb *bus.CommandBus, logger *slog.Logger) *Server {
	s := &Server{Store: st, Bus: b, Commands: cb, mux: http.NewServeMux(), start: time.Now(), logger: logger}
	s.routes()
	return s
}

// Mux 暴露原始路由表, 供 main 在 Handler() 包装前挂载额外路由 (如 gitsvc)
func (s *Server) Mux() *http.ServeMux { return s.mux }

// Handler 返回带日志中间件的最终处理器
func (s *Server) Handler() http.Handler {
	return s.logMiddleware(s.mux)
}

func (s *Server) routes() {
	mux := s.mux
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /api/kernel/status", s.handleStatus)
	mux.HandleFunc("GET /api/events/list", s.handleEventsList)
	mux.HandleFunc("POST /api/commands", s.handleCommands)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("GET /ws", s.handleWS)
}

// ── 处理器 ──────────────────────────────────────────────────────

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"uptime":  time.Since(s.start).Round(time.Second).String(),
		"seq":     s.lastSeqSafe(),
		"clients": s.Bus.Subscribers(),
	})
}

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	count, err := s.Store.EventCount(context.Background())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      "ready",
		"started_at":  s.start.Format(time.RFC3339),
		"uptime":      time.Since(s.start).Round(time.Second).String(),
		"events":      count,
		"subscribers": s.Bus.Subscribers(),
		"dropped":     s.Bus.Dropped(),
	})
}

func (s *Server) handleEventsList(w http.ResponseWriter, r *http.Request) {
	var after, limit int64
	fmt.Sscanf(r.URL.Query().Get("after"), "%d", &after)
	fmt.Sscanf(r.URL.Query().Get("limit"), "%d", &limit)
	events, err := s.Store.EventsAfter(r.Context(), after, int(limit))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if events == nil {
		events = make([]store.Event, 0)
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

func (s *Server) handleCommands(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type    string          `json:"type"`
		Source  string          `json:"source"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Type == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "body 需为 {type, payload?, source?}"})
		return
	}
	if req.Source == "" {
		req.Source = "http"
	}
	result, err := s.Commands.Dispatch(r.Context(), bus.Command{Type: req.Type, Payload: req.Payload})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	// 命令即事实: 派发成功后落一条 command.executed 事件 (先写后发的对偶)
	payload, _ := json.Marshal(map[string]any{"command": req.Type, "result": result})
	ev, err := s.Store.AppendEvent(r.Context(), "command.executed", req.Source, payload)
	if err == nil {
		s.Bus.Publish(ev)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": result, "seq": ev.Seq})
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	count, _ := s.Store.EventCount(context.Background())
	fmt.Fprintf(w, "# TYPE soloforge_events_total counter\nsoloforge_events_total %d\n", count)
	fmt.Fprintf(w, "# TYPE soloforge_ws_clients gauge\nsoloforge_ws_clients %d\n", s.Bus.Subscribers())
	fmt.Fprintf(w, "# TYPE soloforge_ws_dropped_total counter\nsoloforge_ws_dropped_total %d\n", s.Bus.Dropped())
	fmt.Fprintf(w, "# TYPE soloforge_uptime_seconds gauge\nsoloforge_uptime_seconds %d\n", int64(time.Since(s.start).Seconds()))
}

// ── WebSocket ───────────────────────────────────────────────────

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	subID, events := s.Bus.Subscribe()
	defer s.Bus.Unsubscribe(subID)
	defer conn.Close()

	lastSeq := s.lastSeqSafe()
	s.writeWS(conn, map[string]any{"type": "hello", "seq": lastSeq, "clients": s.Bus.Subscribers()})
	s.logger.Info("ws client connected", "remote", r.RemoteAddr, "sub", subID)

	done := make(chan struct{})
	var once sync.Once
	closeOnce := func() { once.Do(func() { close(done) }) }

	// 写协程: 总线事件 → 客户端
	go func() {
		for {
			select {
			case ev := <-events:
				if err := s.writeWS(conn, ev); err != nil {
					closeOnce()
					return
				}
			case <-done:
				return
			}
		}
	}()

	// 读协程: 客户端命令 (ping / command)
	defer closeOnce()
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg struct {
			Type    string          `json:"type"`
			Command *bus.Command    `json:"command"`
		}
		if err := json.Unmarshal(raw, &msg); err != nil {
			s.writeWS(conn, map[string]any{"type": "error", "error": "bad json"})
			continue
		}
		switch msg.Type {
		case "ping":
			s.writeWS(conn, map[string]any{"type": "pong", "ts": time.Now().UnixMilli()})
		case "command":
			if msg.Command == nil {
				s.writeWS(conn, map[string]any{"type": "error", "error": "missing command"})
				continue
			}
			result, err := s.Commands.Dispatch(r.Context(), *msg.Command)
			resp := map[string]any{"type": "command_result", "command": msg.Command.Type}
			if err != nil {
				resp["error"] = err.Error()
			} else {
				resp["result"] = result
				payload, _ := json.Marshal(map[string]any{"command": msg.Command.Type})
				if ev, err := s.Store.AppendEvent(r.Context(), "command.executed", "ws", payload); err == nil {
					s.Bus.Publish(ev)
				}
			}
			if err := s.writeWS(conn, resp); err != nil {
				return
			}
		default:
			s.writeWS(conn, map[string]any{"type": "error", "error": "unknown type, 期望 ping|command"})
		}
	}
}

func (s *Server) writeWS(conn *wsConn, v any) error {
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return conn.WriteJSON(v)
}

// ── 工具 ────────────────────────────────────────────────────────

func (s *Server) lastSeqSafe() int64 {
	count, err := s.Store.EventCount(context.Background())
	if err != nil {
		return 0
	}
	return count // 骨架阶段: AUTOINCREMENT 与 count 一致 (无删除)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func (s *Server) logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if r.URL.Path != "/health" { // 探针高频, 不刷日志
			s.logger.Info("http", "method", r.Method, "path", r.URL.Path, "dur", time.Since(start).Round(time.Millisecond).String())
		}
	})
}
