// ─────────────────────────────────────────────────────────────────
// SoloForge AI Society Layer: Governance System (治理层)
// Path: src/core/society/governance.ts
// Description: 制度的执行与评估，持续监督 Agent 行为
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';

export type GovernorMode = 'performance' | 'balanced' | 'economy' | 'emergency';
export type GovernanceStatus = 'active' | 'warning' | 'critical' | 'suspended';

/**
 * 治理策略
 */
export interface GovernancePolicy {
  id: string;
  policyId: string;                // 关联的制度 ID
  owner: string;                   // 治理者 (Agent/User/System)
  targetMetrics: {
    effectiveness: number;         // 目标效果 (0-1)
    maxViolations: number;        // 最大违规次数
    reviewIntervalMs: number;     // 审查间隔
  };
  actions: GovernanceAction[];
  createdAt: number;
  updatedAt: number;
}

/**
 * 治理动作
 */
export interface GovernanceAction {
  type: 'warn' | 'penalize' | 'isolate' | 'escalate' | 'suspend';
  trigger: string;                // 触发条件
  severity: 'minor' | 'moderate' | 'severe';
  cooldownMs: number;            // 冷却时间
  lastTriggered: number | null;
}

/**
 * 治理评估记录
 */
export interface GovernanceAssessment {
  id: string;
  policyId: string;
  targetId: string;               // 被评估的目标 (Agent/Plugin/Tool)
  targetType: 'agent' | 'plugin' | 'tool' | 'mcp';
  effectiveness: number;           // 0-1，效果评分
  violations: number;             // 违规次数
  lastReview: number;
  status: GovernanceStatus;
  notes: string;
  createdAt: number;
}

/**
 * 治理引擎
 */
export class GovernanceEngine {
  private policies: Map<string, GovernancePolicy> = new Map();
  private assessments: Map<string, GovernanceAssessment> = new Map();
  private globalEffectiveness = 1.0;
  private currentMode: GovernorMode = 'performance';

  constructor() {
    this.initializeDefaultPolicies();
  }

  /**
   * 初始化默认治理策略
   */
  private initializeDefaultPolicies(): void {
    // 成本控制策略
    this.createPolicy({
      policyId: 'cost_control',
      owner: 'GovernorAgent',
      targetMetrics: {
        effectiveness: 0.9,
        maxViolations: 10,
        reviewIntervalMs: 3600000  // 1小时
      },
      actions: [
        {
          type: 'escalate',
          trigger: 'token_usage > 0.8',
          severity: 'moderate',
          cooldownMs: 300000,
          lastTriggered: null
        },
        {
          type: 'isolate',
          trigger: 'token_usage > 0.95',
          severity: 'severe',
          cooldownMs: 600000,
          lastTriggered: null
        }
      ]
    });

    // 质量控制策略
    this.createPolicy({
      policyId: 'quality_control',
      owner: 'QualityAssuranceAgent',
      targetMetrics: {
        effectiveness: 0.85,
        maxViolations: 5,
        reviewIntervalMs: 1800000  // 30分钟
      },
      actions: [
        {
          type: 'warn',
          trigger: 'error_rate > 0.1',
          severity: 'minor',
          cooldownMs: 60000,
          lastTriggered: null
        },
        {
          type: 'penalize',
          trigger: 'error_rate > 0.2',
          severity: 'moderate',
          cooldownMs: 300000,
          lastTriggered: null
        }
      ]
    });

    // 安全治理策略
    this.createPolicy({
      policyId: 'security_control',
      owner: 'SecurityPatchAgent',
      targetMetrics: {
        effectiveness: 0.95,
        maxViolations: 0,
        reviewIntervalMs: 300000  // 5分钟
      },
      actions: [
        {
          type: 'suspend',
          trigger: 'security_violation_detected',
          severity: 'severe',
          cooldownMs: 0,
          lastTriggered: null
        },
        {
          type: 'escalate',
          trigger: 'anomaly_detected',
          severity: 'moderate',
          cooldownMs: 60000,
          lastTriggered: null
        }
      ]
    });
  }

  /**
   * 创建治理策略
   */
  public createPolicy(data: Omit<GovernancePolicy, 'id' | 'createdAt' | 'updatedAt'>): GovernancePolicy {
    const id = `gov_policy_${ulid()}`;
    const now = Date.now();

    const policy: GovernancePolicy = {
      id,
      ...data,
      createdAt: now,
      updatedAt: now
    };

    this.policies.set(id, policy);
    console.log(`[Governance] 创建策略: ${policy.policyId} (${id})`);

    return policy;
  }

  /**
   * 评估目标
   */
  public assess(
    targetId: string,
    targetType: 'agent' | 'plugin' | 'tool' | 'mcp',
    metrics: { effectiveness: number; violations: number; notes?: string }
  ): GovernanceAssessment {
    const id = `gov_assess_${ulid()}`;
    const now = Date.now();

    let status: GovernanceStatus = 'active';
    if (metrics.effectiveness < 0.5) status = 'critical';
    else if (metrics.effectiveness < 0.7) status = 'warning';
    if (metrics.violations > 5) status = 'critical';

    const assessment: GovernanceAssessment = {
      id,
      policyId: 'auto_assessment',
      targetId,
      targetType,
      effectiveness: metrics.effectiveness,
      violations: metrics.violations,
      lastReview: now,
      status,
      notes: metrics.notes || '',
      createdAt: now
    };

    this.assessments.set(`${targetType}:${targetId}`, assessment);

    // 更新全局有效性
    this.updateGlobalEffectiveness();

    return assessment;
  }

  /**
   * 触发治理动作
   */
  public async triggerAction(
    policyId: string,
    targetId: string,
    triggerType: string
  ): Promise<{ action: string; executed: boolean } | null> {
    const policy = Array.from(this.policies.values()).find(p => p.policyId === policyId);
    if (!policy) return null;

    for (const action of policy.actions) {
      if (action.trigger === triggerType) {
        // 检查冷却
        if (action.lastTriggered && Date.now() - action.lastTriggered < action.cooldownMs) {
          console.log(`[Governance] 动作 ${action.type} 处于冷却中`);
          return null;
        }

        action.lastTriggered = Date.now();
        console.log(`[Governance] 执行动作: ${action.type} -> ${targetId} (原因: ${triggerType})`);

        return {
          action: action.type,
          executed: true
        };
      }
    }

    return null;
  }

  /**
   * 更新全局有效性
   */
  private updateGlobalEffectiveness(): void {
    const assessments = Array.from(this.assessments.values());
    if (assessments.length === 0) {
      this.globalEffectiveness = 1.0;
      return;
    }

    const total = assessments.reduce((sum, a) => sum + a.effectiveness, 0);
    this.globalEffectiveness = total / assessments.length;
  }

  /**
   * 获取治理状态
   */
  public getGovernanceStatus(): {
    globalEffectiveness: number;
    mode: GovernorMode;
    activePolicies: number;
    criticalTargets: number;
  } {
    const critical = Array.from(this.assessments.values()).filter(a => a.status === 'critical').length;

    return {
      globalEffectiveness: this.globalEffectiveness,
      mode: this.currentMode,
      activePolicies: this.policies.size,
      criticalTargets: critical
    };
  }

  /**
   * 设置治理模式
   */
  public setMode(mode: GovernorMode): void {
    this.currentMode = mode;
    console.log(`[Governance] 模式切换: ${mode}`);
  }

  /**
   * 获取目标评估
   */
  public getAssessment(targetType: string, targetId: string): GovernanceAssessment | undefined {
    return this.assessments.get(`${targetType}:${targetId}`);
  }

  /**
   * 获取所有评估
   */
  public getAllAssessments(): GovernanceAssessment[] {
    return Array.from(this.assessments.values());
  }
}

// 导出单例
export const governanceEngine = new GovernanceEngine();
export default governanceEngine;
