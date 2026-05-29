// ─────────────────────────────────────────────────────────────────
// SoloForge AI Society Layer: Social Reputation (社会信誉)
// Path: src/core/society/reputation.ts
// Description: 群体信任体系，驱动资源分配和权限管理
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';

export type EntityType = 'agent' | 'plugin' | 'mcp' | 'tool';

export interface ReputationScore {
  taskCompletion: number;    // 任务完成率 (0-1)
  errorRate: number;         // 错误率 (0-1，越低越好)
  collaboration: number;      // 协作反馈 (0-1)
  reliability: number;        // 可靠性历史 (0-1)
}

export interface SocialReputation {
  id: string;
  entityId: string;                // Agent/Plugin/Tool/MCP ID
  entityType: EntityType;
  score: number;                   // 0-1，信誉总分
  components: ReputationScore;     // 各项评分
  evidence: string[];              // 评分依据
  history: number[];               // 历史评分序列
  badges: ReputationBadge[];      // 获得的徽章
  penalties: ReputationPenalty[];  // 处罚记录
  createdAt: number;
  updatedAt: number;
}

export interface ReputationBadge {
  type: 'quality_master' | 'collaboration_champion' | 'reliability_hero' | 'fast_responder' | 'security_guard';
  earnedAt: number;
  reason: string;
}

export interface ReputationPenalty {
  type: string;
  deduction: number;
  reason: string;
  appliedAt: number;
  expiresAt: number;
}

export type ReputationTier = 'excellent' | 'good' | 'average' | 'poor' | 'isolated';

/**
 * 社会信誉管理器
 */
export class SocialReputationManager {
  private reputations: Map<string, SocialReputation> = new Map();
  private readonly SCORE_WEIGHTS = {
    taskCompletion: 0.4,
    errorRate: 0.3,
    collaboration: 0.2,
    reliability: 0.1
  };

  constructor() {}

  /**
   * 注册实体
   */
  public register(entityId: string, entityType: EntityType): SocialReputation {
    const existing = this.reputations.get(`${entityType}:${entityId}`);
    if (existing) return existing;

    const id = `rep_${ulid()}`;
    const now = Date.now();

    const reputation: SocialReputation = {
      id,
      entityId,
      entityType,
      score: 0.7,  // 默认中等信誉
      components: {
        taskCompletion: 0.7,
        errorRate: 0.3,  // 越低越好，所以初始化为低错误率
        collaboration: 0.7,
        reliability: 0.7
      },
      evidence: [],
      history: [0.7],
      badges: [],
      penalties: [],
      createdAt: now,
      updatedAt: now
    };

    this.reputations.set(`${entityType}:${entityId}`, reputation);
    console.log(`[Reputation] 注册实体: ${entityType}/${entityId} (初始信誉: 0.7)`);

    return reputation;
  }

  /**
   * 更新信誉评分
   */
  public updateScore(
    entityId: string,
    entityType: EntityType,
    components: Partial<ReputationScore>,
    evidence?: string
  ): SocialReputation | undefined {
    const key = `${entityType}:${entityId}`;
    let rep = this.reputations.get(key);

    if (!rep) {
      rep = this.register(entityId, entityType);
    }

    // 更新组件
    if (components.taskCompletion !== undefined) {
      rep.components.taskCompletion = components.taskCompletion;
    }
    if (components.errorRate !== undefined) {
      rep.components.errorRate = components.errorRate;
    }
    if (components.collaboration !== undefined) {
      rep.components.collaboration = components.collaboration;
    }
    if (components.reliability !== undefined) {
      rep.components.reliability = components.reliability;
    }

    // 计算总分
    const newScore = this.calculateScore(rep.components);
    rep.score = newScore;
    rep.history.push(newScore);
    if (rep.history.length > 100) {
      rep.history = rep.history.slice(-100);
    }

    if (evidence) {
      rep.evidence.push(evidence);
      if (rep.evidence.length > 50) {
        rep.evidence = rep.evidence.slice(-50);
      }
    }

    rep.updatedAt = Date.now();

    // 检查是否获得徽章
    this.checkAndAwardBadges(rep);

    // 检查处罚是否过期
    this.cleanExpiredPenalties(rep);

    return rep;
  }

  /**
   * 计算信誉总分
   */
  private calculateScore(components: ReputationScore): number {
    // errorRate 越低越好，需要反转
    const errorScore = 1 - components.errorRate;

    return (
      components.taskCompletion * this.SCORE_WEIGHTS.taskCompletion +
      errorScore * this.SCORE_WEIGHTS.errorRate +
      components.collaboration * this.SCORE_WEIGHTS.collaboration +
      components.reliability * this.SCORE_WEIGHTS.reliability
    );
  }

  /**
   * 检查并授予徽章
   */
  private checkAndAwardBadges(rep: SocialReputation): void {
    // 质量大师：任务完成率连续 10 次 > 0.9
    if (rep.components.taskCompletion > 0.9 && !rep.badges.find(b => b.type === 'quality_master')) {
      const recentHigh = rep.history.slice(-10).filter(s => s > 0.9).length;
      if (recentHigh >= 10) {
        rep.badges.push({
          type: 'quality_master',
          earnedAt: Date.now(),
          reason: '连续10次任务完成率超过90%'
        });
        console.log(`[Reputation] ${rep.entityId} 获得徽章: quality_master`);
      }
    }

    // 协作冠军：高协作评分
    if (rep.components.collaboration > 0.95 && !rep.badges.find(b => b.type === 'collaboration_champion')) {
      rep.badges.push({
        type: 'collaboration_champion',
        earnedAt: Date.now(),
        reason: '协作评分超过95%'
      });
    }

    // 可靠性英雄：历史评分稳定
    if (rep.history.length >= 20) {
      const recentHistory = rep.history.slice(-20);
      const avg = recentHistory.reduce((a, b) => a + b, 0) / recentHistory.length;
      const variance = recentHistory.reduce((sum, s) => sum + Math.pow(s - avg, 2), 0) / recentHistory.length;
      if (avg > 0.85 && variance < 0.01 && !rep.badges.find(b => b.type === 'reliability_hero')) {
        rep.badges.push({
          type: 'reliability_hero',
          earnedAt: Date.now(),
          reason: '信誉评分长期稳定在85%以上'
        });
      }
    }
  }

  /**
   * 清理过期处罚
   */
  private cleanExpiredPenalties(rep: SocialReputation): void {
    const now = Date.now();
    rep.penalties = rep.penalties.filter(p => p.expiresAt > now);
  }

  /**
   * 应用处罚
   */
  public applyPenalty(entityId: string, entityType: EntityType, penalty: Omit<ReputationPenalty, 'appliedAt'>): void {
    const key = `${entityType}:${entityId}`;
    const rep = this.reputations.get(key);
    if (!rep) return;

    rep.penalties.push({
      ...penalty,
      appliedAt: Date.now()
    });

    // 实际扣减信誉
    rep.score = Math.max(0, rep.score - penalty.deduction);
    rep.updatedAt = Date.now();
  }

  /**
   * 获取信誉等级
   */
  public getTier(score: number): ReputationTier {
    if (score >= 0.85) return 'excellent';
    if (score >= 0.7) return 'good';
    if (score >= 0.5) return 'average';
    if (score >= 0.3) return 'poor';
    return 'isolated';
  }

  /**
   * 获取信誉
   */
  public get(entityId: string, entityType: EntityType): SocialReputation | undefined {
    return this.reputations.get(`${entityType}:${entityId}`);
  }

  /**
   * 获取信誉排名
   */
  public getRanking(entityType?: EntityType): SocialReputation[] {
    let reps = Array.from(this.reputations.values());

    if (entityType) {
      reps = reps.filter(r => r.entityType === entityType);
    }

    return reps
      .sort((a, b) => b.score - a.score)
      .map((r, index) => ({ ...r, rank: index + 1 } as SocialReputation & { rank: number }));
  }

  /**
   * 获取实体权限等级
   */
  public getPermissions(entityId: string, entityType: EntityType): {
    canHandleComplexTasks: boolean;
    canPerformHighRiskOps: boolean;
    resourcePriority: number;
    requiresConfirmation: boolean;
  } {
    const rep = this.get(entityId, entityType);
    if (!rep) {
      return {
        canHandleComplexTasks: false,
        canPerformHighRiskOps: false,
        resourcePriority: 0,
        requiresConfirmation: true
      };
    }

    const tier = this.getTier(rep.score);

    return {
      canHandleComplexTasks: tier !== 'isolated' && tier !== 'poor',
      canPerformHighRiskOps: tier === 'excellent' || tier === 'good',
      resourcePriority: rep.score,
      requiresConfirmation: tier === 'poor' || tier === 'isolated'
    };
  }

  /**
   * 获取统计
   */
  public stats(): {
    totalEntities: number;
    byTier: Record<string, number>;
    averageScore: number;
    topEntity: { id: string; score: number } | null;
  } {
    const all = Array.from(this.reputations.values());
    const byTier: Record<string, number> = {
      excellent: 0,
      good: 0,
      average: 0,
      poor: 0,
      isolated: 0
    };

    let totalScore = 0;
    let topEntity: { id: string; score: number } | null = null;

    for (const rep of all) {
      const tier = this.getTier(rep.score);
      byTier[tier]++;
      totalScore += rep.score;

      if (!topEntity || rep.score > topEntity.score) {
        topEntity = { id: `${rep.entityType}/${rep.entityId}`, score: rep.score };
      }
    }

    return {
      totalEntities: all.length,
      byTier,
      averageScore: all.length > 0 ? totalScore / all.length : 0,
      topEntity
    };
  }
}

// 导出单例
export const socialReputationManager = new SocialReputationManager();
export default socialReputationManager;
