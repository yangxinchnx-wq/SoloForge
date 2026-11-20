// ─────────────────────────────────────────────────────────────────
// runtime_events.go — 内核运行时事件目录 + 逻辑时钟
//
// 事件生命周期细则 (对齐 TS src/core/events/*.ts 三枚举 + index.ts
// EventBus emit 语义; 先落库后广播纪律对齐 court.go/emit 约定):
//  1. 载荷增强: TS EventBus.emit 统一注入 {timestamp, traceId} —
//     Go 侧经 store.AppendEvent 落库时带 ts/seq, EmitTraceContext 提供
//     无 store 环境的载荷增强入口 (timestamp + traceId 兜底)
//  2. 分发: 订阅者缓冲 256, 慢消费者丢帧计数 (bus.Dropped)
//  3. 重放: 消费者可从 store 重放存量事件重建投影 (data.Registry)
//  4. 目录完整性: RuntimeEvent (TS runtime-events.ts) + CourtEvent
//     (court-events.ts) + DecisionEvent (decision-events.ts) 全量收录,
//     供各域以常量引用, 禁止字面量拼接 (TS 附录 B 纪律)。
//     kernel.go/transaction.go 已定义的条目不在此重复声明。
//
// Tick 为中央多路复用时钟驱动的逻辑时钟序列戳
// (TS kernel.currentTick; 编排器每 tick +1, 见 orchestrator.go)。
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"context"
	"time"
)

// ── RuntimeEvent 补充条目 (kernel.go/transaction.go 已定义的不重复) ──

const (
	// Heartbeat & Timing (TS: Heartbeat='sys.heartbeat', Tick='sys.tick')
	EventHeartbeat = "sys.heartbeat" // 核心系统心跳 (链路状态/分裂脑告警)
	EventSysTick   = "sys.tick"      // 时钟 tick

	// System Events
	EventSystemLog     = "system.log"     // 系统日志事件
	EventTelemetryMarl = "telemetry.marl" // MARL 遥测

	// Domain Events
	EventAIRuntimeTick        = "ai.runtime.tick"
	EventCourtPhase1Completed = "court.phase1.completed"
	EventCourtPhase2Completed = "court.phase2.completed"

	// Projection & Snapshot
	EventProjectionUpdated = "projection.updated"
	EventSnapshotCreated   = "snapshot.created" // 遥测帧/迁移检查点快照

	// 高维审计数据大底座契约
	EventAuditRecorded = "audit.recorded"
	EventSpanRecorded  = "span.recorded"

	// 跨域信誉中继器 (reputation-bridge 单向广播关卡)
	EventReputationIncrementRequested = "governor.reputation.increment.requested"

	// AI 社会角色演化
	EventAgentRoleEvolved = "society.agent.role.evolved"

	// Agent 生命周期
	EventAgentTaskDispatched    = "agent.task.dispatched"
	EventAgentTaskExecuted      = "agent.task.executed"
	EventAgentDisputeRaised     = "agent.dispute.raised"
	EventAgentReputationUpdated = "agent.reputation.updated"
)

// ── CourtEvent (对齐 TS court-events.ts) ─────────────────────────

const (
	EventCourtClaimSubmitted      = "court:claim_submitted"
	EventCourtEvidenceEvaluated   = "court:evidence_evaluated"
	EventCourtArbitrationDecided  = "court:arbitration_decided"
	EventCourtDeadlockDetected    = "court:deadlock_detected"
	EventCourtEscalationTriggered = "court:escalation_triggered"
)

// ── DecisionEvent (对齐 TS decision-events.ts) ───────────────────

const (
	EventDecisionRouteRequested         = "decision:route_requested"
	EventDecisionRouteCompleted         = "decision:route_completed"
	EventDecisionConfidenceCalculated   = "decision:confidence_calculated"
	EventDecisionVoteTriggered          = "decision:vote_triggered"
	EventDecisionAdaptivePenaltyApplied = "decision:adaptive_penalty_applied"
	EventDecisionMARLPolicyInjected     = "decision:marl_policy_injected"
)

// ── 逻辑时钟 ────────────────────────────────────────────────────

// Tick 当前逻辑时钟 tick
func (k *RuntimeKernel) Tick() int64 {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.tick
}

// AdvanceTick 时钟步进 (编排器时钟飞轮调用; 返回新 tick)。
// 单线程串行因果连续性由 mu 串行化保证。
func (k *RuntimeKernel) AdvanceTick(_ context.Context) int64 {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.tick++
	return k.tick
}

// EmitTraceContext 事件载荷 traceId 绑定细则 (对齐 TS EventBus.emit 的
// payload.traceId = global.__CURRENT_TRACE_ID): 统一注入 timestamp 兜底
// 与 traceId (不覆盖调用方已设置的值), 供纯内存事件使用。
func EmitTraceContext(payload map[string]any, traceID string) map[string]any {
	if payload == nil {
		payload = map[string]any{}
	}
	if _, has := payload["timestamp"]; !has {
		payload["timestamp"] = time.Now().UnixMilli()
	}
	if _, has := payload["traceId"]; !has && traceID != "" {
		payload["traceId"] = traceID
	}
	return payload
}
