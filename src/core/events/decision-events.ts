// ─────────────────────────────────────────────────────────────────
// SoloForge Architecture: Decision Engine Event Enum
// Path: src/core/events/decision-events.ts
// ─────────────────────────────────────────────────────────────────

export enum DecisionEvent {
  ROUTE_REQUESTED = 'decision:route_requested',
  ROUTE_COMPLETED = 'decision:route_completed',
  CONFIDENCE_CALCULATED = 'decision:confidence_calculated',
  VOTE_TRIGGERED = 'decision:vote_triggered',
  ADAPTIVE_PENALTY_APPLIED = 'decision:adaptive_penalty_applied',
  // 🧠 MARL 训练后策略信号注入到 RACER 决策链
  MARL_POLICY_INJECTED = 'decision:marl_policy_injected',
}