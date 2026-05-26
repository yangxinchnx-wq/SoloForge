// ─────────────────────────────────────────────────────────────────
// SoloForge Architecture: ConsensAgent Court Event Enum
// Path: src/core/events/court-events.ts
// ─────────────────────────────────────────────────────────────────

export enum CourtEvent {
  CLAIM_SUBMITTED = 'court:claim_submitted',
  EVIDENCE_EVALUATED = 'court:evidence_evaluated',
  ARBITRATION_DECIDED = 'court:arbitration_decided',
  DEADLOCK_DETECTED = 'court:deadlock_detected',
  ESCALATION_TRIGGERED = 'court:escalation_triggered'
}