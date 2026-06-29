/**
 * pipelineConfig.ts — 新 LLM pipeline 调参
 *
 * 设计原则：
 *   - 没有"走不走 LLM"的开关了 —— 现在 LLM pipeline 是唯一路径
 *   - 只保留运行时调参项（推送节流）
 *
 * 用法：
 *   import { pipelineConfig } from '@/services/canvas/pipelineConfig';
 *   const ms = pipelineConfig.pushIntervalMs;
 */

export interface PipelineConfig {
  /** 推送 IPC 的节流间隔（ms） */
  pushIntervalMs: number;
}

const DEFAULT: PipelineConfig = {
  pushIntervalMs: 50,
};

function loadConfig(): PipelineConfig {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  if (!env) return { ...DEFAULT };
  return {
    pushIntervalMs: parseInt(env.SOLOFORGE_PUSH_INTERVAL_MS ?? String(DEFAULT.pushIntervalMs), 10),
  };
}

let cached: PipelineConfig = loadConfig();

export const pipelineConfig: PipelineConfig = new Proxy({} as PipelineConfig, {
  get(_t, prop: keyof PipelineConfig) {
    return cached[prop];
  },
  set(_t, prop: keyof PipelineConfig, value) {
    cached = { ...cached, [prop]: value };
    return true;
  },
});

/** 运行时切换（测试用） */
export function setPipelineConfig(overrides: Partial<PipelineConfig>): void {
  cached = { ...cached, ...overrides };
}

/** 重置为默认值（测试清理） */
export function resetPipelineConfig(): void {
  cached = loadConfig();
}

/** 取当前快照（不可变） */
export function snapshotPipelineConfig(): PipelineConfig {
  return { ...cached };
}
