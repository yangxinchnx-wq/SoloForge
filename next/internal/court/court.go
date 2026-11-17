// ─────────────────────────────────────────────────────────────────
// court — 共识仲裁庭 (从 TS src/core/court/consensagent.ts 迁移)
//
// 语义对齐:
//   - LegalEvidenceNode / AdjudicationArgumentClaim / JudicialVerdictEnvelope
//     三结构字段级一致
//   - 死锁检测: winner-runnerUp < deadlockDeltaBar(默认 0.1) → CONSERVATIVE_DEADLOCK_TRIGGER
//   - 安全熔断: claim 含 IRREVERSIBLE_DESTRUCTION_OPERATION → ESCAPE_ROUTING_TO_LLM
//   - 事件名: court:claim_submitted / evidence_evaluated / arbitration_decided /
//     deadlock_detected / escalation_triggered
//
// 存储为进程内 map (无 SQLite, 重启清零 — 用户决策)
// ─────────────────────────────────────────────────────────────────
package court

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// ── 结构 (对齐 TS) ──────────────────────────────────────────────

// EvidenceNode 法律证据节点 (对齐 TS LegalEvidenceNode)
type EvidenceNode struct {
	ID                   string  `json:"id"`
	CredibilityIndex     float64 `json:"credibilityIndex"`
	RelevanceWeight      float64 `json:"relevanceWeight"`
	TemporalRecencyValue float64 `json:"temporalRecencyValue"`
	RawContent           string  `json:"rawContent"`
}

// ArgumentClaim 裁定论点 (对齐 TS AdjudicationArgumentClaim)
type ArgumentClaim struct {
	OriginatingAgentID     string         `json:"originatingAgentId"`
	DisputedClaimStatement string         `json:"disputedClaimStatement"`
	LinkedEvidenceRegistry []EvidenceNode `json:"linkedEvidenceRegistry"`
}

// VerdictEnvelope 裁决信封 (字段对齐 TS JudicialVerdictEnvelope)
type VerdictEnvelope struct {
	VerdictID               string  `json:"verdictId"`
	VerdictResolutionStatus string  `json:"verdictResolutionStatus"` // DECIDED_LEGITIMATE | CONSERVATIVE_DEADLOCK_TRIGGER | ESCAPE_ROUTING_TO_LLM
	WinningAgentSignature   *string `json:"winningAgentSignature"`   // null = 无获胜者
	AdjudicatedMetricScore  float64 `json:"adjudicatedMetricScore"`
	KernelVersionSeal       int64   `json:"kernelVersionSeal"`
	Timestamp               int64   `json:"timestamp"`
}

// Case 仲裁案例 (含生命周期状态)
type Case struct {
	CaseID    string           `json:"caseId"`
	TraceID   string           `json:"traceId"`
	Claim     string           `json:"claim"`
	Status    string           `json:"status"` // submitted → decided/deadlocked/escalated
	Verdict   *VerdictEnvelope `json:"verdict,omitempty"`
	CreatedAt int64            `json:"createdAt"`
	DecidedAt int64            `json:"decidedAt,omitempty"`
}

// Judge 升级裁判接口 (ESCAPE_ROUTING_TO_LLM 时由 LLM worker 实现)
type Judge interface {
	Arbitrate(ctx context.Context, c *Case, args []ArgumentClaim) (winner string, reasoning string, err error)
}

const (
	StatusSubmitted  = "submitted"
	StatusDecided    = "decided"
	StatusDeadlocked = "deadlocked"
	StatusEscalated  = "escalated"

	StatusDecidedLegitimate = "DECIDED_LEGITIMATE"
	StatusDeadlockTrigger   = "CONSERVATIVE_DEADLOCK_TRIGGER"
	StatusEscapeToLLM       = "ESCAPE_ROUTING_TO_LLM"

	// 熔断关键词 (对齐 TS: 高危不可逆操作强制升级 LLM)
	DestroyMarker = "IRREVERSIBLE_DESTRUCTION_OPERATION"
)

// ── 服务 ────────────────────────────────────────────────────────

type Service struct {
	store      *store.Store
	bus        *bus.EventBus
	judge      Judge   // 可空: 无 LLM 裁判时死锁案例挂起等待
	deltaBar   float64 // 死锁阈值 (对齐 society.court.deadlock_delta_bar)
	mu         sync.Mutex
	cases      map[string]*Case
	deadlocked map[string]bool
}

func New(st *store.Store, b *bus.EventBus, judge Judge) *Service {
	return &Service{
		store: st, bus: b, judge: judge, deltaBar: 0.1,
		cases:      make(map[string]*Case),
		deadlocked: make(map[string]bool),
	}
}

// SubmitClaim 提交仲裁案例 → court:claim_submitted
func (s *Service) SubmitClaim(ctx context.Context, traceID, claim string) (*Case, error) {
	c := &Case{
		CaseID:    fmt.Sprintf("case_%d", time.Now().UnixMilli()),
		TraceID:   traceID,
		Claim:     claim,
		Status:    StatusSubmitted,
		CreatedAt: time.Now().UnixMilli(),
	}
	s.mu.Lock()
	s.cases[c.CaseID] = c
	s.mu.Unlock()
	s.emit(ctx, "court:claim_submitted", map[string]any{
		"caseId": c.CaseID, "traceId": c.TraceID, "claim": c.Claim,
	})
	return c, nil
}

// Arbitrate 证据仲裁 (对齐 TS 流程: 评分 → 死锁检测 → 熔断 → 裁决信封)
func (s *Service) Arbitrate(ctx context.Context, caseID string, args []ArgumentClaim) (*VerdictEnvelope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cases[caseID]
	if c == nil {
		return nil, fmt.Errorf("case 不存在: %s", caseID)
	}

	// 评分: 每个论点的证据可信度×0.5 + 相关度×0.3 + 时效×0.2 求和
	type scored struct {
		arg   ArgumentClaim
		score float64
	}
	var scoredList []scored
	for _, a := range args {
		var score float64
		for _, evd := range a.LinkedEvidenceRegistry {
			score += evd.CredibilityIndex*0.5 + evd.RelevanceWeight*0.3 + evd.TemporalRecencyValue*0.2
		}
		scoredList = append(scoredList, scored{arg: a, score: score})
	}
	sort.Slice(scoredList, func(i, j int) bool { return scoredList[i].score > scoredList[j].score })

	verdict := &VerdictEnvelope{
		VerdictID:         fmt.Sprintf("verdict_%d", time.Now().UnixMilli()),
		KernelVersionSeal: 1,
		Timestamp:         time.Now().UnixMilli(),
	}

	// TS 步骤 3 — 安全熔断: 不可逆破坏性操作强制升级 LLM (先查长度再索引)
	if len(args) > 0 && strings.Contains(strings.ToUpper(args[0].DisputedClaimStatement), DestroyMarker) {
		verdict.VerdictResolutionStatus = StatusEscapeToLLM
		c.Status = StatusEscalated
		s.emit(ctx, "court:escalation_triggered", map[string]any{
			"caseId": caseID, "target": args[0].OriginatingAgentID,
		})
		return s.finish(c, verdict), nil
	}

	// TS 步骤 4 — 结构性死锁: 分差小于阈值 → 保守死锁
	if len(scoredList) == 0 {
		verdict.VerdictResolutionStatus = StatusDeadlockTrigger
		c.Status = StatusDeadlocked
		s.emit(ctx, "court:deadlock_detected", map[string]any{"caseId": caseID, "winner": 0.0, "runnerUp": 0.0})
		return s.finish(c, verdict), nil
	}

	winner := scoredList[0]
	verdict.WinningAgentSignature = &winner.arg.OriginatingAgentID
	verdict.AdjudicatedMetricScore = winner.score

	if len(scoredList) > 1 && winner.score-scoredList[1].score < s.deltaBar {
		verdict.VerdictResolutionStatus = StatusDeadlockTrigger
		c.Status = StatusDeadlocked
		s.emit(ctx, "court:deadlock_detected", map[string]any{
			"caseId": caseID, "winner": winner.score, "runnerUp": scoredList[1].score,
		})
		return s.finish(c, verdict), nil
	}

	verdict.VerdictResolutionStatus = StatusDecidedLegitimate
	c.Status = StatusDecided
	s.emit(ctx, "court:arbitration_decided", map[string]any{
		"caseId": caseID, "winner": winner.arg.OriginatingAgentID, "score": winner.score,
	})
	return s.finish(c, verdict), nil
}

// Escalate LLM 升级仲裁 (死锁/熔断案例由注入的 Judge 收尾)
func (s *Service) Escalate(ctx context.Context, caseID string, args []ArgumentClaim) (*VerdictEnvelope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.judge == nil {
		return nil, fmt.Errorf("无可用 LLM 裁判 (死锁挂起, case=%s)", caseID)
	}
	c := s.cases[caseID]
	if c == nil {
		return nil, fmt.Errorf("case 不存在: %s", caseID)
	}
	winner, _, err := s.judge.Arbitrate(ctx, c, args)
	if err != nil {
		return nil, err
	}
	verdict := &VerdictEnvelope{
		VerdictID:               fmt.Sprintf("verdict_%d", time.Now().UnixMilli()),
		VerdictResolutionStatus: StatusDecidedLegitimate,
		WinningAgentSignature:   &winner,
		AdjudicatedMetricScore:  1.0,
		KernelVersionSeal:       1,
		Timestamp:               time.Now().UnixMilli(),
	}
	c.Status = StatusDecided
	c.Verdict = verdict
	c.DecidedAt = verdict.Timestamp
	s.emit(ctx, "court:arbitration_decided", map[string]any{
		"caseId": caseID, "winner": winner, "escalated": true,
	})
	return verdict, nil
}

// Cases 查询案例列表 (按创建时间倒序, 最多 100 条)
func (s *Service) Cases() []Case {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Case, 0, len(s.cases))
	for _, c := range s.cases {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	if len(out) > 100 {
		out = out[:100]
	}
	return out
}

// ── 内部 ────────────────────────────────────────────────────────

// finish 裁决落状态 (c 为 map 中的指针, 直接改写)
func (s *Service) finish(c *Case, v *VerdictEnvelope) *VerdictEnvelope {
	c.Verdict = v
	c.DecidedAt = v.Timestamp
	return v
}

func (s *Service) emit(ctx context.Context, typ string, payload map[string]any) {
	raw, _ := json.Marshal(payload)
	if ev, err := s.store.AppendEvent(ctx, typ, "court", raw); err == nil {
		s.bus.Publish(ev)
	}
}
