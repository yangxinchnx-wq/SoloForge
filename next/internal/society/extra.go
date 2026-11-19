// ─────────────────────────────────────────────────────────────────
// extra — 联盟 / 角色演化 / 治理 / 超参漂移 的方法实现
// ─────────────────────────────────────────────────────────────────
package society

import (
	"context"
	"encoding/json"
	"soloforge/next/internal/bus"

	"strings"
	"time"
)

// ── 联盟 (FORM_COALITION / ALLOCATE_COALITION_PAYOUT) ───────────

// FormCoalition 组建联盟 (对齐 TS formCoalition: 成员去重, 资源池初始)
func (s *Service) FormCoalition(ctx context.Context, traceID, name string,
	members []string, resources float64) (*Coalition, error) {
	if name == "" || len(members) == 0 {
		return nil, errNotFound("coalitionName 与 initialMembers 必填")
	}
	s.mu.Lock()
	// 成员唯一归属: 已在其它联盟的成员先移出 (对齐 TS 单联盟语义)
	for _, m := range members {
		if prev, ok := s.agentToCoalition[m]; ok && prev != "" {
			if prevC, ok2 := s.coalitions[prev]; ok2 {
				trimmed := make([]string, 0, len(prevC.Members))
				for _, mm := range prevC.Members {
					if mm != m {
						trimmed = append(trimmed, mm)
					}
				}
				prevC.Members = trimmed
			}
		}
		s.agentToCoalition[m] = ""
	}
	c := &Coalition{
		ID:        s.newID("coalition"),
		Name:      name,
		Members:   append([]string{}, members...),
		Resources: resources,
		Status:    "active",
		CreatedAt: time.Now().UnixMilli(),
	}
	s.coalitions[c.ID] = c
	for _, m := range members {
		s.agentToCoalition[m] = c.ID
	}
	s.mu.Unlock()
	s.emit(ctx, "society.coalition.formed", map[string]any{
		"coalitionId": c.ID, "name": c.Name, "members": c.Members, "traceId": traceID,
	})
	return c, nil
}

// AllocateCoalitionPayout 联盟分账: 按成员信誉占比分配 → 逐成员级联
// DISTRIBUTE_ROLE_ALLOCATION_REWARD (对齐 TS coalition.ts:209)
func (s *Service) AllocateCoalitionPayout(ctx context.Context, traceID, coalitionID string,
	totalPool float64, reputationSnapshot map[string]float64) (map[string]any, error) {
	s.mu.Lock()
	c, ok := s.coalitions[coalitionID]
	if !ok {
		s.mu.Unlock()
		return nil, errNotFound("联盟不存在: " + coalitionID)
	}
	members := append([]string{}, c.Members...)
	s.mu.Unlock()

	if len(members) == 0 {
		return nil, errNotFound("联盟无成员")
	}

	// 权重 = 信誉快照值 (缺省 50); 比例分账
	weights := make(map[string]float64, len(members))
	totalWeight := 0.0
	for _, m := range members {
		w := reputationSnapshot[m]
		if w <= 0 {
			w = 50
		}
		weights[m] = w
		totalWeight += w
	}
	shares := make(map[string]float64, len(members))
	var cascade []map[string]any
	for _, m := range members {
		share := totalPool * weights[m] / totalWeight
		shares[m] = roundTo(share, 4)
		// 级联: 报酬 → 信誉增量 (rewardScale 折算, 对齐旧 Economy→信誉 决策)
		if s.target != nil && s.rewardScale > 0 {
			s.target.AdjustReputation(m, share/s.rewardScale)
		}
		cascade = append(cascade, map[string]any{
			"agentId": m, "targetRole": "coalition_member",
			"allocationBonusFactor": roundTo(share, 2),
		})
	}

	// 台账
	s.mu.Lock()
	if cc, ok2 := s.coalitions[coalitionID]; ok2 {
		cc.PayoutHistory = append(cc.PayoutHistory, PayoutRecord{
			TraceID: traceID, TotalPool: totalPool, Shares: shares, At: time.Now().UnixMilli(),
		})
		cc.Resources += totalPool
	}
	s.mu.Unlock()

	s.emit(ctx, "society.coalition.payout.allocated", map[string]any{
		"coalitionId": coalitionID, "totalPool": totalPool, "shares": shares, "traceId": traceID,
	})
	return map[string]any{
		"coalitionId": coalitionID, "shares": shares, "cascade": cascade,
	}, nil
}

// ── 角色演化 (EXECUTE_ROLE_EVOLUTION) ───────────────────────────

// ExecuteRoleEvolution 角色演化状态机 (信誉 → 角色阶梯):
//
//	rep ≥ 95 → governor; rep ≥ 70 → validator; 其余 → worker
//	角色提升 → 级联 DISTRIBUTE_ROLE_ALLOCATION_REWARD (对齐 TS :115)
func (s *Service) ExecuteRoleEvolution(ctx context.Context, traceID, agentID string,
	currentReputation float64, previousRole string, tickID int64) (map[string]any, error) {
	newRole := RoleWorker
	if currentReputation >= RoleValidatorThreshold {
		newRole = RoleValidator
	}
	if currentReputation >= RoleGovernorThreshold {
		newRole = RoleGovernor
	}
	s.mu.Lock()
	prev := previousRole
	if prev == "" {
		prev = s.roles[agentID]
	}
	promoted := newRole != prev && roleRank(newRole) > roleRank(prev)
	s.roles[agentID] = newRole
	s.mu.Unlock()

	// 级联报酬 (提升才发; 对齐 TS 级联 DISTRIBUTE_ROLE_ALLOCATION_REWARD)
	var reward map[string]any
	if promoted {
		bonus := roundTo(currentReputation/10, 2)
		cascade := map[string]any{
			"traceId": traceID, "agentId": agentID, "targetRole": newRole,
			"allocationBonusFactor": bonus, "tickId": tickID,
		}
		if s.cb != nil {
			raw, _ := json.Marshal(cascade)
			ctxTimeout, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			_, _ = s.cb.Dispatch(ctxTimeout, jsonCommand("DISTRIBUTE_ROLE_ALLOCATION_REWARD", raw))
		} else if s.target != nil {
			s.target.AdjustReputation(agentID, bonus)
		}
		reward = cascade
	}
	s.emit(ctx, "society.agent.role.evolved", map[string]any{
		"agentId": agentID, "previousRole": prev, "newRole": newRole,
		"reputation": currentReputation, "promoted": promoted, "traceId": traceID,
	})
	return map[string]any{
		"agentId": agentID, "role": newRole, "promoted": promoted, "reward": reward,
	}, nil
}

// roleRank 角色阶梯排名 (worker=0 < validator=1 < governor=2)
func roleRank(role string) int {
	switch role {
	case RoleValidator:
		return 1
	case RoleGovernor:
		return 2
	}
	return 0
}

// DistributeRoleAllocationReward 角色报酬 (级联终点; 旧 Economy 域折算为信誉增量)
func (s *Service) DistributeRoleAllocationReward(ctx context.Context, traceID, agentID,
	targetRole string, allocationBonusFactor float64, tickID int64) map[string]any {
	delta := allocationBonusFactor / s.rewardScale
	if s.target != nil && delta != 0 {
		s.target.AdjustReputation(agentID, delta)
	}
	s.mu.Lock()
	s.rewards[agentID] += allocationBonusFactor
	s.mu.Unlock()
	out := map[string]any{
		"agentId": agentID, "targetRole": targetRole,
		"reward": allocationBonusFactor, "reputationDelta": roundTo(delta, 4), "traceId": traceID,
	}
	s.emit(ctx, "society.role.reward.distributed", out)
	return out
}

// ── 治理 (ASSESS/TRIGGER_GOVERNANCE_*) ──────────────────────────

// AssessGovernanceTarget 治理评估 (有效性 < 0.6 或违规多 → intervene)
func (s *Service) AssessGovernanceTarget(ctx context.Context, traceID, targetID,
	targetType string, effectiveness float64, violations int64, notes string) (*GovernanceAssessment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := &GovernanceAssessment{
		ID:            s.newID("assessment"),
		TraceID:       traceID,
		TargetID:      targetID,
		TargetType:    defaultStr(targetType, "agent_cluster"),
		Effectiveness: roundTo(effectiveness, 4),
		Violations:    violations,
		Notes:         notes,
		CreatedAt:     time.Now().UnixMilli(),
	}
	switch {
	case effectiveness < 0.4 || violations > PRIVILEGED_AGENT_THRESHOLD:
		a.Verdict = "intervene"
	case effectiveness < 0.7 || violations > 0:
		a.Verdict = "watch"
	default:
		a.Verdict = "healthy"
	}
	s.assessments[a.ID] = a
	s.globalEffectiveness = s.globalEffectiveness*0.9 + effectiveness*0.1 // EMA
	s.emit(ctx, "society.governance.assessed", map[string]any{
		"assessmentId": a.ID, "targetId": targetID, "verdict": a.Verdict, "traceId": traceID,
	})
	return a, nil
}

// TriggerGovernanceAction 触发治理动作 → governance.intervention.applied
func (s *Service) TriggerGovernanceAction(ctx context.Context, traceID, policyID,
	triggerType, targetID string) (map[string]any, error) {
	s.mu.Lock()
	policy, ok := s.policies[policyID]
	if !ok {
		s.mu.Unlock()
		return nil, errNotFound("策略不存在: " + policyID)
	}
	intervention := &InterventionParams{
		PolicyID: policy.PolicyID, TargetID: targetID,
		Action: firstAction(policy), TriggerType: triggerType, AppliedAt: time.Now().UnixMilli(),
	}
	s.interventions[s.newID("intervention")] = intervention
	s.mu.Unlock()
	out := map[string]any{
		"policyId": policy.PolicyID, "targetId": targetID,
		"action": intervention.Action, "traceId": traceID,
	}
	s.emit(ctx, "governance.intervention.applied", out)
	return out, nil
}

// firstAction 取策略第一个动作类型
func firstAction(p *GovernancePolicy) string {
	if p != nil && len(p.Actions) > 0 {
		return p.Actions[0].Type
	}
	return "audit"
}

// seedDefaultPolicies 种子治理策略 (对齐 TS initializeDefaultSystemPolicies:
// policy_sec_control / security_control / owner SecurityPatchAgent)
func (s *Service) seedDefaultPolicies() {
	p := &GovernancePolicy{
		ID:          s.newID("policy"),
		PolicyID:    "security_control",
		Owner:       "SecurityPatchAgent",
		Description: "安全补丁治理: 越权尝试超过阈值时自动施加限制",
		Actions: []GovernanceAction{
			{Type: "restrict", Threshold: PRIVILEGED_AGENT_THRESHOLD},
			{Type: "patch_apply", Threshold: 0},
		},
		Priority:  10,
		CreatedAt: time.Now().UnixMilli(),
	}
	s.policies[p.ID] = p
}

// ── 超参漂移 (DRIFT_EXPERIMENT_START/STEP/SUMMARY) ──────────────

// StartDriftExperiment 启动漂移实验 (对齐 TS: momentum 默认, 基线=当前性能)
func (s *Service) StartDriftExperiment(ctx context.Context, traceID, driftType string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	dt := defaultStr(driftType, "momentum")
	s.drift = driftState{
		active: true, driftType: dt, baseline: 0.5, current: 0.5,
		startedAt: time.Now().UnixMilli(),
	}
	s.emit(ctx, "drift.experiment.started", map[string]any{
		"driftType": dt, "traceId": traceID,
	})
	return map[string]any{"active": true, "driftType": dt}
}

// DriftStep 漂移步进: current += (performance-0.5)*0.1, 治理信号回拉
// (对齐 TS momentum 语义: 性能正反馈 + 治理负反馈)
func (s *Service) DriftStep(ctx context.Context, traceID string, performance float64,
	governanceSignal bool, driftType string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.drift.active {
		s.emit(ctx, "drift.governance_intervention", map[string]any{
			"reason": "no active drift experiment", "traceId": traceID,
		})
		return map[string]any{"active": false}
	}
	delta := (performance - 0.5) * 0.1
	if governanceSignal {
		s.drift.signals++
		delta = -0.05 // 治理信号: 回拉漂移
	}
	s.drift.current = clamp11(s.drift.current + delta)
	s.drift.steps++
	s.drift.lastResult = map[string]any{
		"step": s.drift.steps, "performance": performance,
		"current": roundTo(s.drift.current, 4), "governanceSignal": governanceSignal,
	}
	s.emit(ctx, "drift.step.completed", s.drift.lastResult)
	return s.drift.lastResult
}

// DriftSummary 漂移摘要 (DRIFT_GET_SUMMARY 响应)
func (s *Service) DriftSummary() DriftSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	return DriftSummary{
		Active: s.drift.active, DriftType: s.drift.driftType,
		Steps: s.drift.steps, Signals: s.drift.signals,
		Baseline: s.drift.baseline, Current: roundTo(s.drift.current, 4),
		Last: s.drift.lastResult,
	}
}

// jsonCommand 构造 CommandBus 派发的命令 (级联用)
func jsonCommand(typ string, payload json.RawMessage) busCommand {
	return busCommand{Type: typ, Payload: payload}
}

// busCommand 对齐 bus.Command 的最小别名 (避免直接引用 bus 包结构构造)
type busCommand = bus.Command

// containsStr 引用 (society.go 定义; 此处防重复声明注释掉)
// 注: containsStr 在 society.go 已定义
var _ = containsStr
var _ = strings.TrimSpace
