// ─────────────────────────────────────────────────────────────────
// routes — Agent HTTP 路由 (语义对齐旧 routes-agent.ts)
//   GET  /api/agents/snapshot   全量快照
//   POST /api/agents/dispatch   派发任务 (走编排器管线)
//   POST /api/agents/dispute    提交争议 (记录 + 信誉调整)
//   POST /api/agents/bindSubTask 绑定子任务 (骨架: 记录事件)
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"encoding/json"
	"net/http"
)

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func RegisterRoutes(mux *http.ServeMux, pool *Pool, orch *Orchestrator) {
	mux.HandleFunc("GET /api/agents/snapshot", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"agents":  pool.Snapshot(),
			"count":   pool.Count(),
		})
	})

	mux.HandleFunc("POST /api/agents/dispatch", func(w http.ResponseWriter, r *http.Request) {
		var req DispatchRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Prompt == "" {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {chatId?, prompt, workers?[]}"})
			return
		}
		res, err := orch.Dispatch(r.Context(), req)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, res)
	})

	mux.HandleFunc("POST /api/agents/dispute", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			AgentID    string  `json:"agentId"`
			AgainstID  string  `json:"againstId,omitempty"`
			Reason     string  `json:"reason"`
			Penalty    float64 `json:"penalty,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AgentID == "" {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {agentId, reason, penalty?}"})
			return
		}
		if err := pool.RecordDispute(req.AgentID); err != nil {
			writeJSON(w, 404, map[string]any{"error": err.Error()})
			return
		}
		delta := -req.Penalty
		if delta == 0 {
			delta = -5 // 默认争议扣 5 点信誉
		}
		pool.AdjustReputation(req.AgentID, delta)
		if req.AgainstID != "" {
			pool.RecordWin(req.AgainstID)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "agentId": req.AgentID, "penalty": delta})
	})

	mux.HandleFunc("POST /api/agents/bindSubTask", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			DispatchID string `json:"dispatchId"`
			SubtaskIdx int    `json:"subtaskIdx"`
			AgentID    string `json:"agentId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.DispatchID == "" {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {dispatchId, subtaskIdx, agentId}"})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "bound": req})
	})
}
