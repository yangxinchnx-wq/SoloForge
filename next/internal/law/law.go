// ─────────────────────────────────────────────────────────────────
// law — 法律引擎骨架 (从 TS src/core/law/law-engine.ts 迁移)
//
// 命令语义对齐 CommandBus:
//   RECORD_VIOLATION_FACT      记录违法事实
//   EXECUTE_VIOLATION_PENALTY  执行处罚 (级联信誉调整, 对齐 TS 级联 DISTRIBUTE_ROLE_ALLOCATION_REWARD)
//   LODGE_LAW_APPEAL           法律申诉 (核准后恢复信誉)
//
// ReputationTarget 由 agents.Pool 实现 — law 包不依赖 agents 包 (依赖倒置)
// 存储为进程内 map (无 SQLite, 重启清零 — 用户决策)
// ─────────────────────────────────────────────────────────────────
package law

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// ReputationTarget 信誉调整的目标接口 (由 agents.Pool 实现, 避免包依赖)
type ReputationTarget interface {
	AdjustReputation(agentID string, delta float64) error
}

// Violation 违法记录
type Violation struct {
	ID          string `json:"id"`
	TraceID     string `json:"traceId"`
	EntityID    string `json:"entityId"`
	LawID       string `json:"lawId"`
	Description string `json:"description"`
	Status      string `json:"status"` // active | penalized | appealed | restored
	CreatedAt   int64  `json:"createdAt"`
	ResolvedAt  int64  `json:"resolvedAt,omitempty"`
}

type Service struct {
	store      *store.Store
	bus        *bus.EventBus
	target     ReputationTarget
	mu         sync.Mutex
	violations map[string]*Violation
}

func New(st *store.Store, b *bus.EventBus, target ReputationTarget) *Service {
	return &Service{
		store: st, bus: b, target: target,
		violations: make(map[string]*Violation),
	}
}

// emit 先落"库"后广播 (与 core/agents/court 相同纪律)
func (s *Service) emit(ctx context.Context, typ string, payload map[string]any) {
	raw, _ := json.Marshal(payload)
	if ev, err := s.store.AppendEvent(ctx, typ, "law", raw); err == nil {
		s.bus.Publish(ev)
	}
}

// RecordViolation 记录违法事实 (级联: 信誉扣减)
func (s *Service) RecordViolation(ctx context.Context, traceID, entityID, lawID, description string, penalty float64) (*Violation, error) {
	if entityID == "" {
		return nil, fmt.Errorf("entityId 必填")
	}
	v := &Violation{
		ID:          fmt.Sprintf("violation_%d", time.Now().UnixMilli()),
		TraceID:     traceID,
		EntityID:    entityID,
		LawID:       lawID,
		Description: description,
		Status:      "active",
		CreatedAt:   time.Now().UnixMilli(),
	}
	s.mu.Lock()
	s.violations[v.ID] = v
	s.mu.Unlock()
	if s.target != nil && penalty != 0 {
		s.target.AdjustReputation(entityID, -penalty)
	}
	s.emit(ctx, "law.violation.recorded", map[string]any{
		"id": v.ID, "entityId": v.EntityID, "lawId": v.LawID, "penalty": -penalty,
	})
	return v, nil
}

// ExecutePenalty 执行既有违法的处罚
func (s *Service) ExecutePenalty(ctx context.Context, violationID, executor string, penalty float64) (*Violation, error) {
	s.mu.Lock()
	v, ok := s.violations[violationID]
	if !ok {
		s.mu.Unlock()
		return nil, fmt.Errorf("violation 不存在: %s", violationID)
	}
	if s.target != nil && penalty != 0 {
		s.target.AdjustReputation(v.EntityID, -penalty)
	}
	v.Status = "penalized"
	v.ResolvedAt = time.Now().UnixMilli()
	s.mu.Unlock()
	s.emit(ctx, "law.penalty.executed", map[string]any{
		"id": v.ID, "entityId": v.EntityID, "executor": executor, "penalty": -penalty,
	})
	return v, nil
}

// LodgeAppeal 法律申诉 (核准后信誉返还)
func (s *Service) LodgeAppeal(ctx context.Context, violationID, appellant, reason string, restore float64) (*Violation, error) {
	s.mu.Lock()
	v, ok := s.violations[violationID]
	if !ok {
		s.mu.Unlock()
		return nil, fmt.Errorf("violation 不存在: %s", violationID)
	}
	if s.target != nil && restore != 0 {
		s.target.AdjustReputation(v.EntityID, restore) // 申诉核准 → 信誉返还
	}
	v.Status = "appealed"
	v.ResolvedAt = time.Now().UnixMilli()
	s.mu.Unlock()
	s.emit(ctx, "law.appeal.lodged", map[string]any{
		"id": v.ID, "entityId": v.EntityID, "appellant": appellant,
		"reason": reason, "restore": restore,
	})
	return v, nil
}

// Violations 查询 (按创建时间倒序, 最多 100 条)
func (s *Service) Violations() []Violation {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Violation, 0, len(s.violations))
	for _, v := range s.violations {
		out = append(out, *v)
	}
	// 简单倒序插入排序 (数量小)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].CreatedAt > out[j-1].CreatedAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	if len(out) > 100 {
		out = out[:100]
	}
	return out
}
