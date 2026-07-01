/**
 * skill-library.ts — Agent 技能库
 *
 * 存储从执行轨迹中提炼的经验，供 Agent 下次执行时参考。
 * 支持按领域查询、置信度排序、自动衰减。
 */

export interface SkillEntry {
  id: string;
  domain: string;
  pattern: string;       // 经验描述
  confidence: number;    // 0-1 置信度
  usageCount: number;    // 被引用次数
  successRate: number;   // 使用成功率
  createdAt: number;
  lastUsedAt: number;
}

export class SkillLibrary {
  private readonly skills = new Map<string, SkillEntry>();

  /**
   * 添加一条技能
   */
  addSkill(skill: SkillEntry): void {
    this.skills.set(skill.id, skill);
  }

  /**
   * 按领域查询技能，按置信度排序
   */
  queryByDomain(domain: string, limit = 10): SkillEntry[] {
    return [...this.skills.values()]
      .filter(s => s.domain === domain)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
  }

  /**
   * 查询所有技能
   */
  queryAll(limit = 20): SkillEntry[] {
    return [...this.skills.values()]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
  }

  /**
   * 记录技能被使用
   */
  recordUsage(skillId: string, success: boolean): void {
    const skill = this.skills.get(skillId);
    if (skill) {
      skill.usageCount++;
      skill.lastUsedAt = Date.now();
      // 滑动窗口更新成功率
      skill.successRate = (skill.successRate * 0.9) + (success ? 0.1 : 0);
    }
  }

  /**
   * 获取技能库大小
   */
  size(): number {
    return this.skills.size;
  }
}
