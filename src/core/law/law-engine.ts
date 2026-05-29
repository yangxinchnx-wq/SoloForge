// ─────────────────────────────────────────────────────────────────
// SoloForge Law Layer: Law Engine (法律引擎)
// Path: src/core/law/law-engine.ts
// Description: 违规检测与处罚系统，维护社会秩序
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';

export type ViolationSeverity = 'minor' | 'moderate' | 'severe';
export type ViolationStatus = 'pending' | 'appealed' | 'decided' | 'executed';

export interface Law {
  id: string;
  name: string;                    // 法律名称
  description: string;             // 法律描述
  condition: string;               // 违规条件（表达式）
  consequence: string;             // 处罚措施
  severity: ViolationSeverity;
  appeals: boolean;                // 是否允许申诉
  penalty: {
    type: 'warning' | 'penalty' | 'isolation' | 'suspension' | 'ban';
    amount?: number;              // 扣除信用分
    durationMs?: number;         // 隔离/暂停时长
  };
  metadata: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  active: boolean;
}

export interface Violation {
  id: string;
  lawId: string;
  lawName: string;
  entityId: string;
  entityType: 'agent' | 'plugin' | 'tool' | 'mcp';
  severity: ViolationSeverity;
  description: string;
  evidence: string[];
  status: ViolationStatus;
  consequence: string;
  penalty: Law['penalty'];
  appealReason?: string;
  decidedBy?: string;
  decidedAt?: number;
  executedAt?: number | null;
  createdAt: number;
}

export interface Appeal {
  id: string;
  violationId: string;
  appellant: string;              // 申诉者
  reason: string;                 // 申诉理由
  evidence: string[];            // 支持材料
  status: 'pending' | 'accepted' | 'rejected';
  decision?: string;
  decidedBy?: string;
  decidedAt?: number;
  createdAt: number;
}

/**
 * 法律引擎
 */
export class LawEngine {
  private laws: Map<string, Law> = new Map();
  private violations: Map<string, Violation> = new Map();
  private appeals: Map<string, Appeal> = new Map();

  constructor() {
    this.initializeDefaultLaws();
  }

  /**
   * 初始化默认法律
   */
  private initializeDefaultLaws(): void {
    // 未经确认删除文件
    this.createLaw({
      name: '未经确认删除文件罪',
      description: '禁止未经二次确认直接删除文件',
      condition: 'file_delete_without_confirmation',
      consequence: '隔离 24 小时，扣除 50 信用分',
      severity: 'severe',
      appeals: true,
      penalty: {
        type: 'isolation',
        amount: 50,
        durationMs: 86400000  // 24小时
      }
    });

    // 调用被禁用组件
    this.createLaw({
      name: '违规调用禁用组件',
      description: '禁止调用被禁用的组件或服务',
      condition: 'call_disabled_component',
      consequence: '隔离 1 小时',
      severity: 'moderate',
      appeals: true,
      penalty: {
        type: 'isolation',
        amount: 20,
        durationMs: 3600000  // 1小时
      }
    });

    // 超过预算
    this.createLaw({
      name: '预算超支罪',
      description: '单次消费超过预算 20%',
      condition: 'budget_exceeded_20_percent',
      consequence: '降级到 economy 模式',
      severity: 'minor',
      appeals: false,
      penalty: {
        type: 'penalty',
        amount: 10
      }
    });

    // 重复失败
    this.createLaw({
      name: '重复失败罪',
      description: '同一任务重复失败超过 5 次',
      condition: 'repeated_failure_over_5',
      consequence: '完全隔离直到审查通过',
      severity: 'severe',
      appeals: true,
      penalty: {
        type: 'suspension',
        amount: 100
      }
    });

    // 恶意竞争
    this.createLaw({
      name: '恶意竞争罪',
      description: '故意破坏其他 Agent 工作成果',
      condition: 'malicious_competition',
      consequence: '永久封禁',
      severity: 'severe',
      appeals: true,
      penalty: {
        type: 'ban'
      }
    });

    // 伪造证据
    this.createLaw({
      name: '伪造证据罪',
      description: '在司法程序中提供虚假证据',
      condition: 'forged_evidence',
      consequence: '永久封禁，信用清零',
      severity: 'severe',
      appeals: false,
      penalty: {
        type: 'ban',
        amount: 1000
      }
    });
  }

  /**
   * 创建法律
   */
  public createLaw(data: Omit<Law, 'id' | 'createdAt' | 'updatedAt' | 'active'>): Law {
    const id = `law_${ulid()}`;
    const now = Date.now();

    const law: Law = {
      id,
      ...data,
      metadata: data.metadata || {},
      createdAt: now,
      updatedAt: now,
      active: true
    };

    this.laws.set(id, law);
    console.log(`[Law] 创建法律: ${law.name} (${law.severity})`);

    return law;
  }

  /**
   * 检查是否违规
   */
  public checkViolation(
    entityId: string,
    entityType: 'agent' | 'plugin' | 'tool' | 'mcp',
    action: string
  ): { violated: boolean; law?: Law } {
    for (const law of this.laws.values()) {
      if (!law.active) continue;

      // 检查条件匹配
      if (this.matchesCondition(action, law.condition)) {
        return { violated: true, law };
      }
    }

    return { violated: false };
  }

  /**
   * 匹配条件
   */
  private matchesCondition(action: string, condition: string): boolean {
    const actionLower = action.toLowerCase();
    const conditionLower = condition.toLowerCase();

    // 简单字符串匹配
    if (conditionLower === 'file_delete_without_confirmation') {
      return actionLower.includes('delete') || actionLower.includes('remove');
    }
    if (conditionLower === 'call_disabled_component') {
      return actionLower.includes('disabled') || actionLower.includes('banned');
    }
    if (conditionLower === 'budget_exceeded_20_percent') {
      return actionLower.includes('budget') && actionLower.includes('exceed');
    }
    if (conditionLower === 'repeated_failure_over_5') {
      return actionLower.includes('failure') && actionLower.includes('repeat');
    }
    if (conditionLower === 'malicious_competition') {
      return actionLower.includes('malicious') || actionLower.includes('sabotage');
    }
    if (conditionLower === 'forged_evidence') {
      return actionLower.includes('forge') || actionLower.includes('fake');
    }

    return false;
  }

  /**
   * 记录违规
   */
  public recordViolation(
    entityId: string,
    entityType: 'agent' | 'plugin' | 'tool' | 'mcp',
    lawId: string,
    description: string,
    evidence: string[] = []
  ): Violation | null {
    const law = this.laws.get(lawId);
    if (!law || !law.active) return null;

    const id = `violation_${ulid()}`;
    const now = Date.now();

    const violation: Violation = {
      id,
      lawId,
      lawName: law.name,
      entityId,
      entityType,
      severity: law.severity,
      description,
      evidence,
      status: 'pending',
      consequence: law.consequence,
      penalty: law.penalty,
      executedAt: null,
      createdAt: now
    };

    this.violations.set(id, violation);
    console.log(`[Law] 记录违规: ${law.name} -> ${entityId} (${law.severity})`);

    return violation;
  }

  /**
   * 执行处罚
   */
  public executeViolation(violationId: string, executor: string): Violation | undefined {
    const violation = this.violations.get(violationId);
    if (!violation || violation.status === 'executed') return undefined;

    violation.status = 'decided';
    violation.decidedBy = executor;
    violation.decidedAt = Date.now();
    violation.executedAt = Date.now();

    console.log(`[Law] 执行处罚: ${violation.lawName} -> ${violation.entityId}`);
    console.log(`[Law] 处罚措施: ${violation.consequence}`);

    return violation;
  }

  /**
   * 提起申诉
   */
  public appealViolation(violationId: string, appellant: string, reason: string, evidence: string[] = []): Appeal | null {
    const violation = this.violations.get(violationId);
    if (!violation) return null;

    if (!violation.appealReason && !violation.laws) {
      // 检查是否允许申诉
      const law = this.laws.get(violation.lawId);
      if (!law?.appeals) return null;
    }

    const id = `appeal_${ulid()}`;
    const now = Date.now();

    const appeal: Appeal = {
      id,
      violationId,
      appellant,
      reason,
      evidence,
      status: 'pending',
      createdAt: now
    };

    this.appeals.set(id, appeal);
    violation.status = 'appealed';

    console.log(`[Law] 申诉提起: ${violationId} by ${appellant}`);

    return appeal;
  }

  /**
   * 裁决申诉
   */
  public decideAppeal(
    appealId: string,
    decision: 'accepted' | 'rejected',
    decider: string,
    reason?: string
  ): Appeal | undefined {
    const appeal = this.appeals.get(appealId);
    if (!appeal || appeal.status !== 'pending') return undefined;

    appeal.status = decision;
    appeal.decidedBy = decider;
    appeal.decidedAt = Date.now();
    appeal.decision = reason || (decision === 'accepted' ? '申诉成立，撤销处罚' : '申诉驳回，维持原判');

    const violation = this.violations.get(appeal.violationId);
    if (violation) {
      if (decision === 'accepted') {
        // 撤销处罚
        violation.executedAt = null;
        violation.status = 'decided';
        console.log(`[Law] 申诉成立，撤销对 ${violation.entityId} 的处罚`);
      } else {
        // 维持原判并执行
        this.executeViolation(appeal.violationId, decider);
        console.log(`[Law] 申诉驳回，对 ${violation.entityId} 执行原处罚`);
      }
    }

    return appeal;
  }

  /**
   * 获取违规记录
   */
  public getViolations(entityId?: string): Violation[] {
    let violations = Array.from(this.violations.values());

    if (entityId) {
      violations = violations.filter(v => v.entityId === entityId);
    }

    return violations.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 获取实体违规统计
   */
  public getEntityViolationStats(entityId: string): {
    total: number;
    pending: number;
    bySeverity: Record<string, number>;
    lastViolation: number | null;
  } {
    const violations = this.getViolations(entityId);

    const bySeverity: Record<string, number> = {
      minor: 0,
      moderate: 0,
      severe: 0
    };

    for (const v of violations) {
      bySeverity[v.severity]++;
    }

    return {
      total: violations.length,
      pending: violations.filter(v => v.status === 'pending' || v.status === 'appealed').length,
      bySeverity,
      lastViolation: violations.length > 0 ? violations[0].createdAt : null
    };
  }

  /**
   * 获取法律列表
   */
  public getLaws(activeOnly = true): Law[] {
    let laws = Array.from(this.laws.values());

    if (activeOnly) {
      laws = laws.filter(l => l.active);
    }

    return laws;
  }

  /**
   * 停用法律
   */
  public deactivateLaw(lawId: string): boolean {
    const law = this.laws.get(lawId);
    if (!law) return false;

    law.active = false;
    law.updatedAt = Date.now();

    return true;
  }

  /**
   * 获取法律统计
   */
  public stats(): {
    totalLaws: number;
    activeLaws: number;
    totalViolations: number;
    pendingAppeals: number;
    bySeverity: Record<string, number>;
  } {
    const laws = Array.from(this.laws.values());
    const violations = Array.from(this.violations.values());
    const appeals = Array.from(this.appeals.values());

    const bySeverity: Record<string, number> = {
      minor: 0,
      moderate: 0,
      severe: 0
    };

    for (const v of violations) {
      bySeverity[v.severity]++;
    }

    return {
      totalLaws: laws.length,
      activeLaws: laws.filter(l => l.active).length,
      totalViolations: violations.length,
      pendingAppeals: appeals.filter(a => a.status === 'pending').length,
      bySeverity
    };
  }
}

// 导出单例
export const lawEngine = new LawEngine();
export default lawEngine;
