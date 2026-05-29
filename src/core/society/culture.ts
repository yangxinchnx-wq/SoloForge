// ─────────────────────────────────────────────────────────────────
// SoloForge AI Society Layer: Cultural Norms (文化规范)
// Path: src/core/society/culture.ts
// Description: 群体习惯形成的文化，稳定且自强化
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';

export type CultureAdoptionLevel = 'experimental' | 'common' | 'dominant';

/**
 * 文化规范
 */
export interface CulturalNorm {
  id: string;
  principle: string;               // 如 "Review优先"
  description: string;             // 详细描述
  adoptionRate: number;            // 0-1，有多少 Agent 实践了这个原则
  adoptionLevel: CultureAdoptionLevel;
  evidence: string[];              // 采纳证据
  practices: CulturalPractice[];   // 实践记录
  createdAt: number;
  updatedAt: number;
}

/**
 * 文化实践记录
 */
export interface CulturalPractice {
  agentId: string;
  action: string;
  timestamp: number;
  success: boolean;
}

/**
 * 文化规范管理器
 */
export class CulturalNormManager {
  private norms: Map<string, CulturalNorm> = new Map();
  private agentPractices: Map<string, string[]> = new Map();  // agentId -> normIds

  constructor() {
    this.initializeDefaultNorms();
  }

  /**
   * 初始化默认文化规范
   */
  private initializeDefaultNorms(): void {
    // Review 优先
    this.create({
      principle: 'Review优先',
      description: '代码变更需要审查，确保质量',
      adoptionRate: 0.85,
      evidence: ['多个项目采用 PR Review 流程'],
      adoptionLevel: 'common'
    });

    // 证据优先
    this.create({
      principle: '证据优先',
      description: '决策必须有证据链，避免盲目猜测',
      adoptionRate: 0.78,
      evidence: ['研究结论必须标注来源'],
      adoptionLevel: 'common'
    });

    // 不要猜
    this.create({
      principle: '不要猜',
      description: '不确定时停下来问，不要凭猜测行动',
      adoptionRate: 0.72,
      evidence: ['系统记录多次主动询问行为'],
      adoptionLevel: 'experimental'
    });

    // 可恢复优先
    this.create({
      principle: '可恢复优先',
      description: '没有回滚的操作不能做',
      adoptionRate: 0.92,
      evidence: ['所有破坏性操作都配置了回滚方案'],
      adoptionLevel: 'dominant'
    });

    // 协作互助
    this.create({
      principle: '协作互助',
      description: '主动帮助其他 Agent 解决问题',
      adoptionRate: 0.65,
      evidence: ['记录多次跨 Agent 协助事件'],
      adoptionLevel: 'experimental'
    });
  }

  /**
   * 创建文化规范
   */
  public create(data: Omit<CulturalNorm, 'id' | 'practices' | 'createdAt' | 'updatedAt' | 'adoptionLevel'>): CulturalNorm {
    const id = `culture_${ulid()}`;
    const now = Date.now();

    const norm: CulturalNorm = {
      id,
      ...data,
      adoptionLevel: this.calculateAdoptionLevel(data.adoptionRate),
      practices: [],
      createdAt: now,
      updatedAt: now
    };

    this.norms.set(id, norm);
    console.log(`[Culture] 创建规范: ${norm.principle} (采纳率: ${(norm.adoptionRate * 100).toFixed(1)}%)`);

    return norm;
  }

  /**
   * 计算采纳等级
   */
  private calculateAdoptionLevel(rate: number): CultureAdoptionLevel {
    if (rate >= 0.8) return 'dominant';
    if (rate >= 0.5) return 'common';
    return 'experimental';
  }

  /**
   * 记录实践行为
   */
  public recordPractice(normId: string, agentId: string, action: string, success: boolean): void {
    const norm = this.norms.get(normId);
    if (!norm) return;

    const practice: CulturalPractice = {
      agentId,
      action,
      timestamp: Date.now(),
      success
    };

    norm.practices.push(practice);

    // 更新采纳率
    this.updateAdoptionRate(normId);

    // 记录 Agent 实践
    if (!this.agentPractices.has(agentId)) {
      this.agentPractices.set(agentId, []);
    }
    if (!this.agentPractices.get(agentId)!.includes(normId)) {
      this.agentPractices.get(agentId)!.push(normId);
    }
  }

  /**
   * 更新采纳率
   */
  private updateAdoptionRate(normId: string): void {
    const norm = this.norms.get(normId);
    if (!norm) return;

    // 简化计算：基于最近实践的成功率
    const recentPractices = norm.practices.slice(-20);
    if (recentPractices.length === 0) return;

    const successRate = recentPractices.filter(p => p.success).length / recentPractices.length;
    const adoptionRate = successRate * 0.9 + norm.adoptionRate * 0.1;  // 平滑更新

    norm.adoptionRate = Math.min(1, adoptionRate);
    norm.adoptionLevel = this.calculateAdoptionLevel(norm.adoptionRate);
    norm.updatedAt = Date.now();
  }

  /**
   * 获取规范
   */
  public get(id: string): CulturalNorm | undefined {
    return this.norms.get(id);
  }

  /**
   * 获取所有规范
   */
  public getAll(): CulturalNorm[] {
    return Array.from(this.norms.values())
      .sort((a, b) => b.adoptionRate - a.adoptionRate);
  }

  /**
   * 获取主流文化（高采纳率）
   */
  public getDominantCulture(): CulturalNorm[] {
    return this.getAll().filter(n => n.adoptionLevel === 'dominant');
  }

  /**
   * 获取 Agent 遵循的文化
   */
  public getAgentCulture(agentId: string): CulturalNorm[] {
    const normIds = this.agentPractices.get(agentId) || [];
    return normIds.map(id => this.norms.get(id)).filter(Boolean) as CulturalNorm[];
  }

  /**
   * 检查 Agent 是否遵循特定文化
   */
  public isAgentFollowingCulture(agentId: string, principle: string): boolean {
    const norms = this.getAll();
    const target = norms.find(n => n.principle === principle);
    if (!target) return false;

    const agentNorms = this.agentPractices.get(agentId) || [];
    return agentNorms.includes(target.id);
  }

  /**
   * 获取文化统计
   */
  public stats(): {
    total: number;
    byLevel: Record<string, number>;
    averageAdoptionRate: number;
    mostPracticed: string | null;
  } {
    const all = this.getAll();
    const byLevel: Record<string, number> = {
      dominant: 0,
      common: 0,
      experimental: 0
    };

    let totalAdoption = 0;
    let mostPracticed: CulturalNorm | null = null;
    let maxPractices = 0;

    for (const norm of all) {
      byLevel[norm.adoptionLevel]++;
      totalAdoption += norm.adoptionRate;
      if (norm.practices.length > maxPractices) {
        maxPractices = norm.practices.length;
        mostPracticed = norm;
      }
    }

    return {
      total: all.length,
      byLevel,
      averageAdoptionRate: all.length > 0 ? totalAdoption / all.length : 0,
      mostPracticed: mostPracticed?.principle || null
    };
  }

  /**
   * 自强化机制：促进文化传播
   */
  public reinforceCulture(normId: string, incentiveType: 'reputation' | 'credit' | 'recognition'): void {
    const norm = this.norms.get(normId);
    if (!norm) return;

    // 模拟强化效果
    const boost = norm.adoptionLevel === 'experimental' ? 0.05 :
                   norm.adoptionLevel === 'common' ? 0.02 : 0.01;

    norm.adoptionRate = Math.min(1, norm.adoptionRate + boost);
    norm.adoptionLevel = this.calculateAdoptionLevel(norm.adoptionRate);
    norm.updatedAt = Date.now();

    console.log(`[Culture] 强化文化 ${norm.principle} (激励: ${incentiveType}, 采纳率: ${(norm.adoptionRate * 100).toFixed(1)}%)`);
  }
}

// 导出单例
export const culturalNormManager = new CulturalNormManager();
export default culturalNormManager;
