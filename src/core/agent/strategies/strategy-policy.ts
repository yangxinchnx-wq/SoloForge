// ─────────────────────────────────────────────────────────────────
// SoloForge Agent Core: Pluggable Strategy Policy Interface
// Path: src/core/agent/strategies/strategy-policy.ts
//
// 参考: RepuNet (AAMAS 2026) 策略自适应 + 专家共识
// 设计: 策略可插拔、可运行时替换、支持信用驱动自适应
// ─────────────────────────────────────────────────────────────────

import { ModelStrategyCandidate } from '../../decision/rtr-racer-engine';

/**
 * 策略策略接口 — 可插拔的行为函数
 * 每个策略实现定义自己的延迟/质量/成本特征
 */
export interface StrategyPolicy {
  readonly name: string;

  /** 计算延迟得分 (0-1, 越高越快) */
  calculateLatency(cpuLoad: number): number;

  /** 计算生成质量 (0-1, 越高越好) */
  calculateQuality(): number;

  /** 计算成本效率 (0-1, 越高越省) */
  calculateCostEfficiency(): number;

  /**
   * 信用驱动自适应: Agent 可根据自身声誉决定是否切换策略
   * 返回 null 表示保持当前策略
   */
  shouldAdapt(currentReputation: number): StrategyPolicy | null;

  /** 生成路由候选 */
  toCandidate(agentId: string, cpuLoad: number, reputation: number): ModelStrategyCandidate;
}

/**
 * 直接快速策略 (Alpha) — 牺牲质量换取响应速度
 */
export class DirectPolicy implements StrategyPolicy {
  readonly name = 'direct';

  calculateLatency(cpuLoad: number): number {
    return Math.max(0.6, 0.95 - cpuLoad * 0.1);
  }

  calculateQuality(): number {
    return 0.65;
  }

  calculateCostEfficiency(): number {
    return 0.8;
  }

  shouldAdapt(): StrategyPolicy | null {
    return null; // 快速策略不自适应
  }

  toCandidate(agentId: string, cpuLoad: number, reputation: number): ModelStrategyCandidate {
    return {
      modelName: agentId,
      reasoningStrategy: 'direct',
      baseGenerationQuality: this.calculateQuality(),
      normalizedLatencyScore: this.calculateLatency(cpuLoad),
      normalizedCostEfficiency: this.calculateCostEfficiency(),
      historicalSuccessIndex: reputation,
    };
  }
}

/**
 * 深度推理策略 (Beta) — 高质量但高延迟
 */
export class ChainOfThoughtPolicy implements StrategyPolicy {
  readonly name = 'chain_of_thought';

  calculateLatency(cpuLoad: number): number {
    return Math.max(0.1, 0.5 - cpuLoad * 0.2);
  }

  calculateQuality(): number {
    return 0.95;
  }

  calculateCostEfficiency(): number {
    return 0.3;
  }

  shouldAdapt(currentReputation: number): StrategyPolicy | null {
    // 信用过低时降级到 direct，避免占用深度推理资源
    return currentReputation < 0.5 ? new DirectPolicy() : null;
  }

  toCandidate(agentId: string, cpuLoad: number, reputation: number): ModelStrategyCandidate {
    return {
      modelName: agentId,
      reasoningStrategy: 'chain_of_thought',
      baseGenerationQuality: this.calculateQuality(),
      normalizedLatencyScore: this.calculateLatency(cpuLoad),
      normalizedCostEfficiency: this.calculateCostEfficiency(),
      historicalSuccessIndex: reputation,
    };
  }
}

/**
 * 少样本策略 (Gamma) — 平衡型
 */
export class FewShotPolicy implements StrategyPolicy {
  readonly name = 'few_shot';

  calculateLatency(cpuLoad: number): number {
    return Math.max(0.3, 0.7 - cpuLoad * 0.15);
  }

  calculateQuality(): number {
    return 0.80;
  }

  calculateCostEfficiency(): number {
    return 0.5;
  }

  shouldAdapt(currentReputation: number): StrategyPolicy | null {
    return currentReputation < 0.3 ? new DirectPolicy() : null;
  }

  toCandidate(agentId: string, cpuLoad: number, reputation: number): ModelStrategyCandidate {
    return {
      modelName: agentId,
      reasoningStrategy: 'few_shot',
      baseGenerationQuality: this.calculateQuality(),
      normalizedLatencyScore: this.calculateLatency(cpuLoad),
      normalizedCostEfficiency: this.calculateCostEfficiency(),
      historicalSuccessIndex: reputation,
    };
  }
}

/**
 * 策略工厂 — 根据名称创建策略实例
 */
export function createStrategyPolicy(name: string): StrategyPolicy {
  switch (name) {
    case 'direct': return new DirectPolicy();
    case 'chain_of_thought': return new ChainOfThoughtPolicy();
    case 'few_shot': return new FewShotPolicy();
    default: return new DirectPolicy();
  }
}
