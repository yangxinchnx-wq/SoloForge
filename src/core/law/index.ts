// ─────────────────────────────────────────────────────────────────
// SoloForge Law Layer: Unified Export
// Path: src/core/law/index.ts
// ─────────────────────────────────────────────────────────────────

export { LawEngine } from './law-engine';

// 类型导出（必须用 export type 满足 isolatedModules）
export type {
  Law,
  Violation,
  Appeal,
  ViolationSeverity,
  ViolationStatus
} from './law-engine';
