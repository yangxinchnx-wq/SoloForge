// ─────────────────────────────────────────────────────────────────
// routes — Agent HTTP 路由 (语义对齐旧 routes-agent.ts)
//
//	GET  /api/agents/snapshot    全量快照
//	POST /api/agents/dispatch    派发任务 (走编排器管线)
//	POST /api/agents/dispute     提交争议 (记录 + 信誉调整)
//	POST /api/agents/bindSubTask 绑定子任务 (骨架: 记录事件)
//
// 深度语义扩展:
//
//	GET  /api/agents/reputation        信誉快照 (引擎组件 + 聚合分)
//	GET  /api/agents/reputation/ledger 信誉台账流水 (?agentId=&limit=)
//	POST /api/agents/reputation/adjust 信誉惩罚/奖励 (delta 正=奖励 负=惩罚)
//	GET  /api/agents/tasks             任务台账列表
//	GET  /api/agents/tasks/{id}        单任务台账
//	GET  /api/agents/acl/agents        ACL 已注册 agent
//	POST /api/agents/acl/send          发送 FIPA-ACL 消息
//	POST /api/agents/acl/gossip        发送 GOSSIP 间接声誉消息
//	GET  /api/agents/acl/poll          轮询收件箱 (?agentId=)
//
// ─────────────────────────────────────────────────────────────────
package agents

import (
	"encoding/json"
	"net/http"
	"strconv"
)

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func RegisterRoutes(mux *http.ServeMux, pool *Pool, orch *Orchestrator) {
	mux.HandleFunc("GET /api/agents/snapshot", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"agents": pool.Snapshot(),
			"count":  pool.Count(),
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
			AgentID   string  `json:"agentId"`
			AgainstID string  `json:"againstId,omitempty"`
			Reason    string  `json:"reason"`
			Penalty   float64 `json:"penalty,omitempty"`
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

	// ── 信誉引擎 (reputation.go) ────────────────────────────────

	// GET /api/agents/reputation — 全量信誉快照
	mux.HandleFunc("GET /api/agents/reputation", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"states": orch.Reputation().Snapshot(),
			"count":  len(orch.Reputation().Snapshot()),
		})
	})

	// GET /api/agents/reputation/ledger?agentId=&limit= — 台账流水 (倒序)
	mux.HandleFunc("GET /api/agents/reputation/ledger", func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		writeJSON(w, 200, map[string]any{
			"entries": orch.Reputation().Ledger(r.URL.Query().Get("agentId"), limit),
		})
	})

	// POST /api/agents/reputation/adjust — {agentId, delta, reason}
	// delta > 0 → 奖励 (Reward), delta < 0 → 惩罚 (Penalty); 广播 agent.reputation.updated
	mux.HandleFunc("POST /api/agents/reputation/adjust", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			AgentID string  `json:"agentId"`
			Delta   float64 `json:"delta"`
			Reason  string  `json:"reason"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AgentID == "" || req.Delta == 0 {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {agentId, delta, reason?}"})
			return
		}
		if _, ok := orch.Reputation().Get(req.AgentID); !ok {
			writeJSON(w, 404, map[string]any{"error": "agent 未注册信誉: " + req.AgentID})
			return
		}
		if req.Delta > 0 {
			orch.Reputation().Reward(r.Context(), req.AgentID, req.Delta, reasonOr(req.Reason, "manual_reward"))
		} else {
			orch.Reputation().Penalize(r.Context(), req.AgentID, -req.Delta, reasonOr(req.Reason, "manual_penalty"))
		}
		st, _ := orch.Reputation().Get(req.AgentID)
		writeJSON(w, 200, map[string]any{"ok": true, "state": st})
	})

	// ── 任务台账 (task.go) ──────────────────────────────────────

	// GET /api/agents/tasks?limit= — 任务台账列表 (倒序)
	mux.HandleFunc("GET /api/agents/tasks", func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		writeJSON(w, 200, map[string]any{
			"tasks":       orch.Tasks().List(limit),
			"activeCount": orch.Tasks().ActiveCount(),
		})
	})

	// GET /api/agents/tasks/{id} — 单任务台账
	mux.HandleFunc("GET /api/agents/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		t, ok := orch.Tasks().Get(r.PathValue("id"))
		if !ok {
			writeJSON(w, 404, map[string]any{"error": "任务不存在"})
			return
		}
		writeJSON(w, 200, t)
	})

	// ── FIPA-ACL 通信总线 (acl.go) ──────────────────────────────

	// GET /api/agents/acl/agents — 已注册 agent 列表
	mux.HandleFunc("GET /api/agents/acl/agents", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"agents": orch.ACL().RegisteredAgents()})
	})

	// POST /api/agents/acl/send — 发送 FIPA-ACL 消息
	// {sender, receiver, performative, content, ontology?, protocol?, replyWith?}
	mux.HandleFunc("POST /api/agents/acl/send", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ACLMessage
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, 400, map[string]any{"error": "body 需为 FIPA-ACL 消息字段"})
			return
		}
		if req.Sender == "" || req.Receiver == "" || req.Performative == "" {
			writeJSON(w, 400, map[string]any{"error": "sender/receiver/performative 必填"})
			return
		}
		if !validPerformative(req.Performative) {
			writeJSON(w, 400, map[string]any{"error": "performative 须为 INFORM/REQUEST/PROPOSE/ACCEPT/REJECT/QUERY/DELEGATE/CHALLENGE/GOSSIP"})
			return
		}
		msg := orch.ACL().Send(r.Context(), req.ACLMessage)
		writeJSON(w, 200, msg)
	})

	// POST /api/agents/acl/gossip — {sender, aboutAgentId, evaluation, receivers[]}
	mux.HandleFunc("POST /api/agents/acl/gossip", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Sender       string   `json:"sender"`
			AboutAgentID string   `json:"aboutAgentId"`
			Evaluation   any      `json:"evaluation"`
			Receivers    []string `json:"receivers"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Sender == "" || req.AboutAgentID == "" {
			writeJSON(w, 400, map[string]any{"error": "body 需为 {sender, aboutAgentId, evaluation, receivers}"})
			return
		}
		orch.ACL().Gossip(r.Context(), req.Sender, req.AboutAgentID, req.Evaluation, req.Receivers)
		writeJSON(w, 200, map[string]any{"ok": true})
	})

	// GET /api/agents/acl/poll?agentId= — 轮询收件箱 (取空 + TTL 30s 过滤)
	mux.HandleFunc("GET /api/agents/acl/poll", func(w http.ResponseWriter, r *http.Request) {
		agentID := r.URL.Query().Get("agentId")
		if agentID == "" {
			writeJSON(w, 400, map[string]any{"error": "缺少 agentId"})
			return
		}
		writeJSON(w, 200, map[string]any{"messages": orch.ACL().Poll(agentID)})
	})
}

// reasonOr 空原因兜底
func reasonOr(reason, fallback string) string {
	if reason == "" {
		return fallback
	}
	return reason
}

// validPerformative 校验 9 种述行语
func validPerformative(p ACLPerformative) bool {
	switch p {
	case PerfInform, PerfRequest, PerfPropose, PerfAccept, PerfReject,
		PerfQuery, PerfDelegate, PerfChallenge, PerfGossip:
		return true
	}
	return false
}
