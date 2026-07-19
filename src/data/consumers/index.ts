// ─────────────────────────────────────────────────────────────────
// SoloForge Data Layer: Consumers Index
// Path: src/data/consumers/index.ts
//
// 导出所有数据消费者模块
// ─────────────────────────────────────────────────────────────────

export {
  initializeGovernorShadowConsumer,
  queryGovernorShadowDecisions
} from './governor-shadow-consumer';

export {
  initializeSocietyEvolutionConsumer
} from './society-evolution-consumer';

export {
  initializeSocietyCultureConsumer
} from './society-culture-consumer';

export {
  initializeSocialMemoryConsumer
} from './social-memory-consumer';

export {
  initializeCourtAdjudicationConsumer
} from './court-adjudication-consumer';

export {
  initializeLawComplianceConsumer
} from './law-compliance-consumer';

export {
  initializeReputationAnalyticsConsumer
} from './reputation-analytics-consumer';

export {
  initializeSocietyGovernanceConsumer
} from './society-governance-consumer';

export {
  initializeTelemetryAggregationConsumer
} from './telemetry-aggregation-consumer';

export {
  initializeConsensusAuditConsumer
} from './consensus-audit-consumer';
