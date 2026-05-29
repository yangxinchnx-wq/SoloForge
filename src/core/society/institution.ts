// ─────────────────────────────────────────────────────────────────
// SoloForge AI Society Layer: Institution System (制度系统)
// Path: src/core/society/institution.ts
// Description: 行为规范的结构化集合，定义 AI 社会的基本规则
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';
import { deleteProtection, DeletePermission, ConfirmLevel } from '../../data/delete_protection';

export type InstitutionScope = 'global' | 'agent' | 'task' | 'domain';
export type EnforcementType = 'hard' | 'soft' | 'advisory';

/**
 * 制度实体
 */
export interface Institution {
  id: string;
  name: string;                      // 如 "CodeInstitution"
  description: string;                // 制度描述
  rules: string[];                   // 规则列表
  scope: InstitutionScope;            // 生效范围
  enforcement: EnforcementType;       // 执行类型
  priority: number;                  // 冲突时高优先级覆盖
  metadata: Record<string, any>;     // 扩展元数据
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/**
 * 制度管理器 - 管理所有制度定义
 */
export class InstitutionManager {
  private institutions: Map<string, Institution> = new Map();
  private readonly domainSignature = 'InstitutionSystem';

  constructor() {
    this.initializeDefaultInstitutions();
  }

  /**
   * 初始化默认制度
   */
  private initializeDefaultInstitutions(): void {
    // 代码审查制度
    this.create({
      name: 'CodeInstitution',
      description: '代码修改必须经过 Review',
      rules: [
        '所有代码变更必须经过至少一次 Review',
        'Reviewer 必须独立于提交者',
        '高风险变更需要二次确认'
      ],
      scope: 'global',
      enforcement: 'hard',
      priority: 100
    });

    // 研究制度
    this.create({
      name: 'ResearchInstitution',
      description: '研究结论必须有证据链',
      rules: [
        '研究结论必须标注来源',
        '重要发现需要多源验证',
        '不确定性必须明确声明'
      ],
      scope: 'domain',
      enforcement: 'soft',
      priority: 80
    });

    // 安全制度
    this.create({
      name: 'SecurityInstitution',
      description: '高风险操作必须双人确认',
      rules: [
        '删除操作需要二次确认',
        '敏感数据访问需要授权',
        '异常行为触发告警'
      ],
      scope: 'global',
      enforcement: 'hard',
      priority: 150  // 最高优先级
    });

    // 可恢复性制度
    this.create({
      name: 'RecoverabilityInstitution',
      description: '没有回滚的操作不能执行',
      rules: [
        '破坏性操作必须先创建备份',
        '关键操作必须记录回滚步骤',
        '重大变更需要灰度发布'
      ],
      scope: 'global',
      enforcement: 'hard',
      priority: 120
    });
  }

  /**
   * 创建制度
   */
  public create(data: Omit<Institution, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>): Institution {
    const id = `inst_${ulid()}`;
    const now = Date.now();

    const institution: Institution = {
      id,
      ...data,
      metadata: data.metadata || {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };

    this.institutions.set(id, institution);
    console.log(`[Institution] 创建制度: ${institution.name} (${id})`);

    return institution;
  }

  /**
   * 获取制度
   */
  public get(id: string): Institution | undefined {
    const inst = this.institutions.get(id);
    if (inst && !inst.deletedAt) return inst;
    return undefined;
  }

  /**
   * 获取所有有效制度
   */
  public getAll(): Institution[] {
    return Array.from(this.institutions.values()).filter(i => !i.deletedAt);
  }

  /**
   * 按范围获取制度
   */
  public getByScope(scope: InstitutionScope): Institution[] {
    return this.getAll().filter(i => i.scope === scope || i.scope === 'global');
  }

  /**
   * 按优先级获取制度（用于冲突裁决）
   */
  public getEffectiveRules(): Institution[] {
    return this.getAll().sort((a, b) => b.priority - a.priority);
  }

  /**
   * 检查操作是否合规
   */
  public checkCompliance(operation: string, context: { agentId?: string; taskType?: string; domain?: string }): {
    compliant: boolean;
    violatedRules: string[];
    enforcement: EnforcementType;
  } {
    const violatedRules: string[] = [];
    let enforcement: EnforcementType = 'advisory';

    for (const inst of this.getEffectiveRules()) {
      // 检查范围匹配
      const scopeMatch =
        inst.scope === 'global' ||
        (context.agentId && inst.scope === 'agent') ||
        (context.taskType && inst.scope === 'task') ||
        (context.domain && inst.scope === 'domain');

      if (!scopeMatch) continue;

      // 检查是否违反规则
      for (const rule of inst.rules) {
        if (this.violatesRule(operation, rule)) {
          violatedRules.push(`[${inst.name}] ${rule}`);
          if (inst.enforcement === 'hard') enforcement = 'hard';
          else if (inst.enforcement === 'soft' && enforcement !== 'hard') enforcement = 'soft';
        }
      }
    }

    return {
      compliant: violatedRules.length === 0 || enforcement === 'advisory',
      violatedRules,
      enforcement
    };
  }

  /**
   * 检查操作是否违反规则
   */
  private violatesRule(operation: string, rule: string): boolean {
    const op = operation.toLowerCase();
    const r = rule.toLowerCase();

    // 提取关键词
    const keywords = ['delete', 'remove', 'drop', 'backup', 'review', 'commit', 'confirm'];

    for (const kw of keywords) {
      if (r.includes(kw) && op.includes(kw)) {
        return true;
      }
    }

    // 删除相关规则
    if ((r.includes('删除') || r.includes('delete')) &&
        (op.includes('删除') || op.includes('delete') || op.includes('remove'))) {
      return true;
    }

    // 备份相关规则
    if ((r.includes('备份') || r.includes('backup')) &&
        (op.includes('backup') || !op.includes('备份'))) {
      // 没有备份的修改操作违规
      if (op.includes('修改') || op.includes('modify') || op.includes('delete')) {
        if (!op.includes('backup')) return true;
      }
    }

    // 审查相关规则
    if ((r.includes('审查') || r.includes('review')) && op.includes('提交')) {
      if (!op.includes('review')) return true;
    }

    return false;
  }

  /**
   * 更新制度
   */
  public update(id: string, updates: Partial<Institution>): Institution | undefined {
    const inst = this.institutions.get(id);
    if (!inst || inst.deletedAt) return undefined;

    const updated: Institution = {
      ...inst,
      ...updates,
      id: inst.id,  // 保持 ID 不变
      createdAt: inst.createdAt,  // 保持创建时间不变
      updatedAt: Date.now()
    };

    this.institutions.set(id, updated);
    return updated;
  }

  /**
   * 删除制度（软删除）
   */
  public delete(id: string): boolean {
    const inst = this.institutions.get(id);
    if (!inst || inst.deletedAt) return false;

    // 检查删除权限
    const check = deleteProtection.canDelete('institution', id);
    if (!check.allowed) {
      console.error(`[Institution] 无法删除 ${id}: ${check.reason}`);
      return false;
    }

    inst.deletedAt = Date.now();
    inst.updatedAt = Date.now();
    return true;
  }

  /**
   * 获取制度统计
   */
  public stats(): { total: number; byScope: Record<string, number>; byEnforcement: Record<string, number> } {
    const all = this.getAll();
    const byScope: Record<string, number> = {};
    const byEnforcement: Record<string, number> = {};

    for (const inst of all) {
      byScope[inst.scope] = (byScope[inst.scope] || 0) + 1;
      byEnforcement[inst.enforcement] = (byEnforcement[inst.enforcement] || 0) + 1;
    }

    return {
      total: all.length,
      byScope,
      byEnforcement
    };
  }
}

// 导出单例
export const institutionManager = new InstitutionManager();
export default institutionManager;
