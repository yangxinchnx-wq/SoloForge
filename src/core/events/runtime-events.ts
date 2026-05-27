// ─────────────────────────────────────────────────────────────────
// SoloForge Core Layer: Runtime Event Specifications
// Path: src/core/events/runtime-events.ts
// ─────────────────────────────────────────────────────────────────

export enum RuntimeEvent {
  // Kernel 生命周期
  KernelInitialized = 'kernel.initialized',
  RuntimeModeChanged = 'runtime.mode.changed',
  RuntimeShutdown = 'runtime.shutdown',
  RuntimeRecovery = 'runtime.recovery',

  // Command & Transaction
  CommandAccepted = 'command.accepted',
  CommandRejected = 'command.rejected',
  TransactionCommitted = 'transaction.committed',
  TransactionRolledBack = 'transaction.rolledback',

  // Heartbeat & Timing
  Heartbeat = 'sys.heartbeat',                    // 核心系统心跳
  Tick = 'sys.tick',

  // System Events
  SystemLogEvent = 'system.log',
  TelemetryMarl = 'telemetry.marl',

  // Domain Events
  AIRuntimeTick = 'ai.runtime.tick',
  CourtPhase1Completed = 'court.phase1.completed',
  CourtPhase2Completed = 'court.phase2.completed',

  // Projection & Snapshot
  ProjectionUpdated = 'projection.updated',
  SnapshotCreated = 'snapshot.created'
}

export default RuntimeEvent;