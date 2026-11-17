// ─────────────────────────────────────────────────────────────────
// decision — RACER 决策引擎骨架 (从 TS src/core/decision 迁移)
//
// 事件语义对齐 DecisionEvent:
//   decision:route_requested → decision:vote_triggered → decision:route_completed
//   (confidence_calculated / adaptive_penalty_applied / marl_policy_injected 预留)
//
// MARL 策略注入点: PolicyFunc 由外部注入 (marl worker 的 POLICY_QUERY 语义),
// 未注入时使用能力/成本启发式评分。
// ─────────────────────────────────────────────────────────────────
package decision

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// Candidate 路由候选 (执行 agent/worker/模型)
type Candidate struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind"` // agent | worker | model
	Capability float64 `json:"capability"` // 0..1 能力评分
	Cost       float64 `json:"cost"`       // 相对成本 (越高越靠后)
}

// RouteRequest 路由请求
type RouteRequest struct {
	TraceID    string      `json:"traceId"`
	Task       string      `json:"task"`
	Candidates []Candidate `json:"candidates"`
}

// RouteResult 路由结果
type RouteResult struct {
	RouteID   string    `json:"routeId"`
	TraceID   string    `json:"traceId"`
	Selected  string    `json:"selected"`
	Confidence float64  `json:"confidence"`
	Reason    string    `json:"reason"`
	DecidedAt int64     `json:"decidedAt"`
}

// PolicyFunc MARL 策略注入点 (返回 0..1 的偏好加成)
type PolicyFunc func(ctx context.Context, obs []float64) (float64, error)

type Service struct {
	store  *store.Store
	bus    *bus.EventBus
	policy PolicyFunc
	mu     sync.Mutex
}

func New(st *store.Store, b *bus.EventBus) *Service {
	return &Service{store: st, bus: b}
}

// SetPolicy 注入 MARL 策略 (marl worker 就绪后调用)
func (s *Service) SetPolicy(p PolicyFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.policy = p
}

func (s *Service) emit(ctx context.Context, typ string, payload map[string]any) {
	raw, _ := json.Marshal(payload)
	if ev, err := s.store.AppendEvent(ctx, typ, "decision", raw); err == nil {
		s.bus.Publish(ev.Type, ev.Source, ev.Payload)
	}
}

// Route 决策路由: 候选评分 → 平票触发投票事件 → 选出执行者
func (s *Service) Route(ctx context.Context, req RouteRequest) (*RouteResult, error) {
	if len(req.Candidates) == 0 {
		return nil, fmt.Errorf("无候选")
	}
	s.emit(ctx, "decision:route_requested", map[string]any{
		"traceId": req.TraceID, "task": req.Task, "candidates": len(req.Candidates),
	})

	type scored struct {
		c    Candidate
		val  float64
		marl bool
	}
	var list []scored
	var marlBonus float64
	var marlErr error
	if s.policy != nil {
		obs := []float64{float64(len(req.Candidates)), float64(len(req.Task))}
		marlBonus, marlErr = s.policy(ctx, obs) // 策略注入点: MARL 偏好加成
	}
	for _, c := range req.Candidates {
		val := c.Capability / (1 + c.Cost)
		if marlErr == nil && marlBonus > 0 {
			val *= 1 + marlBonus*0.2 // MARL 偏好至多 +20%
		}
		list = append(list, scored{c: c, val: val, marl: marlErr == nil && marlBonus > 0})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].val > list[j].val })

	// 平票 → 投票事件 (语义对齐 decision:vote_triggered)
	if len(list) > 1 && list[0].val-list[1].val < 0.01 {
		s.emit(ctx, "decision:vote_triggered", map[string]any{
			"traceId": req.TraceID, "tie": []string{list[0].c.ID, list[1].c.ID},
		})
	}

	if list[0].marl {
		s.emit(ctx, "decision:marl_policy_injected", map[string]any{
			"traceId": req.TraceID, "bonus": marlBonus,
		})
	}

	confidence := list[0].val / (1 + list[0].val)
	res := &RouteResult{
		RouteID:    fmt.Sprintf("route_%d", time.Now().UnixMilli()),
		TraceID:    req.TraceID,
		Selected:   list[0].c.ID,
		Confidence: confidence,
		Reason:     fmt.Sprintf("能力/成本最优 (%.3f)", list[0].val),
		DecidedAt:  time.Now().UnixMilli(),
	}
	s.emit(ctx, "decision:route_completed", map[string]any{
		"traceId": req.TraceID, "selected": res.Selected, "confidence": confidence,
	})
	return res, nil
}

// Routes 查询最近路由决策 (从进程内事件日志按类型取)
func (s *Service) Routes(limit int) []map[string]any {
	events := s.store.EventsByType("decision:route_completed", limit)
	out := make([]map[string]any, 0, len(events))
	for _, ev := range events {
		m := map[string]any{"seq": ev.Seq, "ts": ev.TS}
		json.Unmarshal(ev.Payload, &m)
		out = append(out, m)
	}
	return out
}
