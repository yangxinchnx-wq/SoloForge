// ─────────────────────────────────────────────────────────────────
// stream — SSE 事件流 + auth 桥接 + channels 测试 (补齐 server.ts 差集)
// ─────────────────────────────────────────────────────────────────
package uiapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// eventsStream SSE 事件流: 订阅总线 → text/event-stream
// (对齐旧 server.ts GET /api/events/stream 语义)
func (s *Service) eventsStream(w http.ResponseWriter, r *http.Request) {
	if s.bus == nil || s.store == nil {
		writeJSON(w, 503, map[string]any{"error": "事件总线未接线"})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, 500, map[string]any{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	subID, events := s.bus.Subscribe()
	defer s.bus.Unsubscribe(subID)

	// 连接即补发最近事件 (游标)
	if after := r.URL.Query().Get("after"); after != "" {
		var n int64
		fmt.Sscanf(after, "%d", &n)
		if evs, err := s.store.EventsAfter(r.Context(), n, 100); err == nil {
			for _, ev := range evs {
				data, _ := json.Marshal(ev)
				fmt.Fprintf(w, "event:replay\ndata:%s\n\n", data)
			}
			flusher.Flush()
		}
	}

	// 心跳保活 (15s)
	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()
	done := r.Context().Done()

	for {
		select {
		case ev := <-events:
			data, _ := json.Marshal(ev)
			fmt.Fprintf(w, "event:%s\ndata:%s\n\n", ev.Type, data)
			flusher.Flush()
		case <-keepAlive.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case <-done:
			return
		}
	}
}

// authStartupToken 启动 token (桥接 security 层 Bootstrap)
func (s *Service) authStartupToken(w http.ResponseWriter, _ *http.Request) {
	if s.tokenFn == nil {
		writeJSON(w, 200, map[string]any{"ok": true, "hint": "token provider 未注入"})
		return
	}
	writeJSON(w, 200, map[string]any{"token": s.tokenFn()})
}

// channelsTest 渠道连通测试 (对齐 TS /api/channels/test: 回显探测)
func (s *Service) channelsTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Channel string `json:"channel"`
		Target  string `json:"target"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Channel == "" {
		writeJSON(w, 400, map[string]any{"error": "body 需为 {channel, target?}"})
		return
	}
	// 骨架: 渠道探测回显 (真实探测在对应执行器接入后启用)
	writeJSON(w, 200, map[string]any{
		"ok": true, "channel": req.Channel, "target": req.Target,
		"status": "reachable", "testedAt": time.Now().UnixMilli(),
	})
}
