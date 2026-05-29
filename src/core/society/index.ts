// ─────────────────────────────────────────────────────────────────
// SoloForge AI Society Layer: Unified Export
// Path: src/core/society/index.ts
// ─────────────────────────────────────────────────────────────────

// Institution - 制度系统
export {
  InstitutionManager,
  institutionManager,
  Institution,
  InstitutionScope,
  EnforcementType
} from './institution';

// Governance - 治理层
export {
  GovernanceEngine,
  governanceEngine,
  GovernancePolicy,
  GovernanceAssessment,
  GovernanceStatus,
  GovernorMode,
  GovernanceAction
} from './governance';

// Social Memory - 社会记忆
export {
  SocialMemoryManager,
  socialMemoryManager,
  SocialMemory,
  MemorySeverity,
  MemoryImpact
} from './social-memory';

// Culture - 文化规范
export {
  CulturalNormManager,
  culturalNormManager,
  CulturalNorm,
  CulturalPractice,
  CultureAdoptionLevel
} from './culture';

// Reputation - 社会信誉
export {
  SocialReputationManager,
  socialReputationManager,
  SocialReputation,
  ReputationScore,
  ReputationBadge,
  ReputationPenalty,
  ReputationTier,
  EntityType
} from './reputation';

// Role Evolution - 角色进化
export {
  RoleEvolutionManager,
  roleEvolutionManager,
  AgentRole,
  RoleEvolution,
  RoleType,
  EvolutionStatus,
  EvolutionEvidence,
  RoleCapability
} from './role-evolution';

// Coalition - 联盟机制
export {
  CoalitionManager,
  coalitionManager,
  Coalition,
  CoalitionMember,
  CoalitionTask,
  CoalitionStatus
} from './coalition';
