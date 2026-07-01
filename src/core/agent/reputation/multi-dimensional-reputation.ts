// ─────────────────────────────────────────────────────────────────
// SoloForge Agent Core: Multi-Dimensional Reputation System
// Path: src/core/agent/reputation/multi-dimensional-reputation.ts
//
// 参考: RepuNet (AAMAS 2026) 双层声誉 + 间接闲谈传播
// 参考: LOKA 协议多维信任 (能力/可靠性/诚实性/意图)
// ─────────────────────────────────────────────────────────────────

import { logger } from '../../logger';

/**
 * 多维度声誉组件 — 参考 LOKA 协议的 4 维信任模型
 */
export interface ReputationComponents {
  /** 能力: 完成任务的技能水平 */
  competence: number;
  /** 可靠性: 行为一致性 */
  reliability: number;
  /** 诚实性: 不欺骗、不伪造证据 */
  integrity: number;
  /** 协作意愿: 与其他 Agent 合作的倾向 */
  collaboration: number;
}

/**
 * 声誉快照 — 包含聚合分和各维度
 */
export interface ReputationSnapshot {
  entityId: string;
  components: ReputationComponents;
  aggregateScore: number;
  version: number;
  lastUpdated: number;
}

/**
 * Gossip 消息 — 间接声誉传播载体
 * 参考 RepuNet: Agent 通过"闲谈"间接了解其他 Agent 的声誉
 */
export interface GossipMessage {
  fromAgentId: string;
  aboutAgentId: string;
  /** 评价维度 */
  dimension: keyof ReputationComponents;
  /** 评价分值 (-1 到 1) */
  score: number;
  /** 置信度 (直接交互 > 间接闲谈) */
  confidence: number;
  timestamp: number;
}

/**
 * 多维度声誉引擎
 *
 * 设计原则:
 * 1. 声誉分 4 个维度，非单一分数
 * 2. 直接交互权重 > 间接闲谈权重 (参考 RepuNet)
 * 3. 支持版本号 CAS，解决同步竞态
 * 4. 支持 Gossip 机制传播间接声誉
 */
export class MultiDimensionalReputation {
  private readonly moduleName = 'MultiDimReputation';
  private readonly store = new Map<string, ReputationSnapshot>();
  private readonly gossipBuffer: GossipMessage[] = [];

  // 权重配置 (可从 configCenter 注入)
  private readonly weights: ReputationComponents = {
    competence: 0.30,
    reliability: 0.30,
    integrity: 0.25,
    collaboration: 0.15,
  };

  // 直接交互 vs 间接闲谈的权重比 (参考 RepuNet)
  private readonly directInteractionWeight = 0.75;
  private readonly gossipWeight = 0.25;

  /**
   * 注册实体的初始声誉
   */
  register(entityId: string, initial?: Partial<ReputationComponents>): ReputationSnapshot {
    const components: ReputationComponents = {
      competence: initial?.competence ?? 0.5,
      reliability: initial?.reliability ?? 0.5,
      integrity: initial?.integrity ?? 0.5,
      collaboration: initial?.collaboration ?? 0.5,
    };
    const snapshot: ReputationSnapshot = {
      entityId,
      components,
      aggregateScore: this.calculateAggregate(components),
      version: 1,
      lastUpdated: Date.now(),
    };
    this.store.set(entityId, snapshot);
    return snapshot;
  }

  /**
   * 获取实体声誉快照
   */
  get(entityId: string): ReputationSnapshot | undefined {
    return this.store.get(entityId);
  }

  /**
   * 获取聚合声誉分 (单一分数, 向后兼容)
   */
  getAggregate(entityId: string): number {
    return this.store.get(entityId)?.aggregateScore ?? 0.5;
  }

  /**
   * 直接交互驱动的声誉更新
   * 参考 RepuNet 3.3.1: Reputation Driven by Direct Encounters
   */
  updateFromDirectInteraction(
    entityId: string,
    dimension: keyof ReputationComponents,
    delta: number,
    version?: number
  ): ReputationSnapshot {
    const current = this.store.get(entityId);
    if (!current) {
      return this.register(entityId, { [dimension]: 0.5 + delta });
    }

    // CAS: 版本号检查，防止旧数据覆盖新数据
    if (version !== undefined && version < current.version) {
      logger.debug(this.moduleName, `stale update rejected for ${entityId}: v${version} < v${current.version}`);
      return current;
    }

    const newScore = Math.max(0, Math.min(1, current.components[dimension] + delta * this.directInteractionWeight));
    current.components[dimension] = newScore;
    current.aggregateScore = this.calculateAggregate(current.components);
    current.version += 1;
    current.lastUpdated = Date.now();

    logger.debug(this.moduleName, `${entityId}.${dimension} → ${newScore.toFixed(3)} (v${current.version})`);
    return current;
  }

  /**
   * 间接闲谈 (Gossip) 驱动的声誉更新
   * 参考 RepuNet 3.3.2: Reputation Driven by Indirect Gossip
   */
  updateFromGossip(entityId: string, dimension: keyof ReputationComponents, delta: number): ReputationSnapshot {
    const current = this.store.get(entityId);
    if (!current) {
      return this.register(entityId, { [dimension]: 0.5 + delta * this.gossipWeight });
    }

    // 闲谈权重低于直接交互
    const newScore = Math.max(0, Math.min(1, current.components[dimension] + delta * this.gossipWeight));
    current.components[dimension] = newScore;
    current.aggregateScore = this.calculateAggregate(current.components);
    current.version += 1;
    current.lastUpdated = Date.now();

    return current;
  }

  /**
   * 接收 Gossip 消息并缓冲
   * Agent 可以选择性地信任或忽略闲谈
   */
  receiveGossip(msg: GossipMessage): void {
    if (msg.confidence < 0.3) return; // 低置信度闲谈直接丢弃
    this.gossipBuffer.push(msg);
  }

  /**
   * 批量处理 Gossip 缓冲
   * 参考 RepuNet: Agent 评估闲谈可信度后决定是否采纳
   */
  processGossipBuffer(): void {
    const now = Date.now();
    const validGossip = this.gossipBuffer.filter(g => now - g.timestamp < 60000); // 1 分钟有效期

    for (const gossip of validGossip) {
      this.updateFromGossip(gossip.aboutAgentId, gossip.dimension, gossip.score * gossip.confidence);
    }

    // 清空已处理的
    this.gossipBuffer.length = 0;
  }

  /**
   * 生成 Gossip 消息 — Agent 主动向其他 Agent 传播声誉信息
   */
  createGossip(fromAgentId: string, aboutAgentId: string, dimension: keyof ReputationComponents, score: number): GossipMessage {
    return {
      fromAgentId,
      aboutAgentId,
      dimension,
      score,
      confidence: 0.5, // 闲谈默认置信度
      timestamp: Date.now(),
    };
  }

  /**
   * 快照导出 (用于调试和 UI 展示)
   */
  snapshot(): ReputationSnapshot[] {
    return Array.from(this.store.values());
  }

  private calculateAggregate(components: ReputationComponents): number {
    return (
      components.competence * this.weights.competence +
      components.reliability * this.weights.reliability +
      components.integrity * this.weights.integrity +
      components.collaboration * this.weights.collaboration
    );
  }
}
