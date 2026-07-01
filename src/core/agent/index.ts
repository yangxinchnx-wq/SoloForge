// ─────────────────────────────────────────────────────────────────
// SoloForge Core Layer: Agent Module Public Surface (v2)
// Path: src/core/agent/index.ts
// ─────────────────────────────────────────────────────────────────

export { AutonomousNetworkAgent } from './autonomous_agent';
export type { AgentSnapshotV2 } from './autonomous_agent';
export { AgentRegistry } from './agent-registry';
export { AgentDecisionOrchestrator } from './agent-decision-orchestrator';

export type { AgentSnapshot, AgentDispatchRequest, AgentDispatchResult } from './agent-registry';

// 策略接口
export { DirectPolicy, ChainOfThoughtPolicy, FewShotPolicy, createStrategyPolicy } from './strategies/strategy-policy';
export type { StrategyPolicy } from './strategies/strategy-policy';

// 声誉系统
export { MultiDimensionalReputation } from './reputation/multi-dimensional-reputation';
export type { ReputationComponents, ReputationSnapshot, GossipMessage } from './reputation/multi-dimensional-reputation';

// 通信总线
export { AgentCommunicationBus } from './communication/agent-communication-bus';
export type { FIPAACLMessage, ACLPerformative } from './communication/agent-communication-bus';
