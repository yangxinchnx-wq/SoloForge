// ─────────────────────────────────────────────────────────────────
// SoloForge AI Society Layer: Unified Export
// Path: src/core/society/index.ts
// ─────────────────────────────────────────────────────────────────

// Institution - 制度系统
export { InstitutionEngine } from './institution';
export type { Institution, InstitutionScope, EnforcementType } from './institution';

// Governance - 治理层
export { GovernancePolicyEngine } from './governance';
export type { GovernancePolicy, GovernanceAssessment, GovernanceStatus, GovernorMode, GovernanceAction } from './governance';

// Social Memory - 社会记忆
export { SocialMemoryEngine } from './social-memory';
export type { SocialMemory, MemorySeverity, MemoryImpact } from './social-memory';

// Culture - 文化规范（实际类名为 MemeticPropagationEngine）
export { MemeticPropagationEngine } from './culture';
export type { MemeticVector } from './culture';

// Reputation - 社会信誉
export { SocialReputationEngine } from './reputation';
export type { SocialReputation, ReputationScore, ReputationBadge, ReputationPenalty, ReputationTier, EntityType } from './reputation';

// Role Evolution - 角色进化（实际类名为 RoleEvolutionEngine）
export { RoleEvolutionEngine } from './role-evolution';
export type { AgentRoleType, EvolutionProposal } from './role-evolution';

// Coalition - 联盟机制（实际类名为 CoalitionEngine）
export { CoalitionEngine } from './coalition';
export type { CoalitionProfile } from './coalition';
