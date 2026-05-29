// ─────────────────────────────────────────────────────────────────
// SoloForge AI Society Layer: Role Evolution (角色进化)
// Path: src/core/society/role-evolution.ts
// Description: 社会自动分工，Agent 能力成长与角色演进
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';

export type RoleType =
  | 'research'
  | 'coding'
  | 'review'
  | 'test'
  | 'security'
  | 'operations'
  | 'coordination';

export type EvolutionStatus = 'pending' | 'approved' | 'rejected' | 'rolled_back';

export interface RoleCapability {
  skill: string;                   // 技能名称
  level: number;                   // 0-1，掌握程度
  evidence: string[];              // 证明材料
  lastVerified: number;
}

export interface RoleEvolution {
  id: string;
  agentId: string;
  beforeRole: string;              // 进化前角色
  afterRole: string;               // 进化后角色
  reason: string;                  // 进化原因
  evidence: EvolutionEvidence[];   // 支撑证据
  status: EvolutionStatus;
  approvedBy: string | null;
  approvedAt: number | null;
  createdAt: number;
}

export interface EvolutionEvidence {
  type: 'task_completion' | 'peer_review' | 'domain_depth' | 'collaboration';
  description: string;
  metric: number;
  timestamp: number;
}

export interface AgentRole {
  agentId: string;
  primaryRole: RoleType;
  secondaryRoles: RoleType[];
  capabilities: RoleCapability[];
  experience: number;              // 累计经验值
  evolutionHistory: string[];      // 进化记录 ID
  createdAt: number;
  updatedAt: number;
}

/**
 * 角色进化管理器
 */
export class RoleEvolutionManager {
  private roles: Map<string, AgentRole> = new Map();          // agentId -> AgentRole
  private evolutions: Map<string, RoleEvolution> = new Map(); // evolutionId -> Evolution

  constructor() {}

  /**
   * 注册 Agent 角色
   */
  public registerAgent(
    agentId: string,
    primaryRole: RoleType,
    secondaryRoles: RoleType[] = []
  ): AgentRole {
    const existing = this.roles.get(agentId);
    if (existing) return existing;

    const now = Date.now();
    const role: AgentRole = {
      agentId,
      primaryRole,
      secondaryRoles,
      capabilities: this.initializeCapabilities(primaryRole),
      experience: 0,
      evolutionHistory: [],
      createdAt: now,
      updatedAt: now
    };

    this.roles.set(agentId, role);
    console.log(`[RoleEvolution] 注册 Agent ${agentId} 角色: ${primaryRole}`);

    return role;
  }

  /**
   * 初始化角色能力
   */
  private initializeCapabilities(role: RoleType): RoleCapability[] {
    const capabilityTemplates: Record<RoleType, string[]> = {
      research: ['information_gathering', 'analysis', 'synthesis', 'citation'],
      coding: ['implementation', 'refactoring', 'debugging', 'optimization'],
      review: ['code_review', 'security_audit', 'quality_assessment', 'feedback'],
      test: ['test_design', 'test_execution', 'coverage_analysis', 'failure_diagnosis'],
      security: ['vulnerability_detection', 'threat_analysis', 'secure_coding', 'incident_response'],
      operations: ['deployment', 'monitoring', 'incident_management', 'recovery'],
      coordination: ['task_planning', 'resource_allocation', 'conflict_resolution', 'communication']
    };

    const skills = capabilityTemplates[role] || [];
    const now = Date.now();

    return skills.map(skill => ({
      skill,
      level: 0.3,  // 初始等级
      evidence: [],
      lastVerified: now
    }));
  }

  /**
   * 添加经验
   */
  public addExperience(agentId: string, amount: number, evidence?: string): AgentRole | undefined {
    const role = this.roles.get(agentId);
    if (!role) return undefined;

    role.experience += amount;
    role.updatedAt = Date.now();

    if (evidence) {
      // 可以记录经验来源
      console.log(`[RoleEvolution] ${agentId} 获得 ${amount} 经验: ${evidence}`);
    }

    // 检查是否可以进化
    if (role.experience >= this.getEvolutionThreshold(role)) {
      this.suggestEvolution(agentId);
    }

    return role;
  }

  /**
   * 获取进化阈值
   */
  private getEvolutionThreshold(role: AgentRole): number {
    // 基础阈值 + 角色复杂度调整
    const baseThreshold = 100;
    const roleComplexity = role.secondaryRoles.length * 20;
    return baseThreshold + roleComplexity;
  }

  /**
   * 更新能力等级
   */
  public updateCapability(
    agentId: string,
    skill: string,
    level: number,
    evidence?: string
  ): AgentRole | undefined {
    const role = this.roles.get(agentId);
    if (!role) return undefined;

    const capability = role.capabilities.find(c => c.skill === skill);
    if (!capability) {
      // 新技能
      role.capabilities.push({
        skill,
        level: Math.min(1, level),
        evidence: evidence ? [evidence] : [],
        lastVerified: Date.now()
      });
    } else {
      capability.level = Math.min(1, Math.max(capability.level, level));
      if (evidence) {
        capability.evidence.push(evidence);
      }
      capability.lastVerified = Date.now();
    }

    role.updatedAt = Date.now();
    return role;
  }

  /**
   * 建议进化
   */
  public suggestEvolution(agentId: string): RoleEvolution | null {
    const role = this.roles.get(agentId);
    if (!role) return null;

    // 收集进化证据
    const evidence: EvolutionEvidence[] = [];

    // 任务完成证据
    if (role.experience >= 100) {
      evidence.push({
        type: 'task_completion',
        description: '累计完成大量任务',
        metric: role.experience,
        timestamp: Date.now()
      });
    }

    // 能力深度证据
    const avgCapability = role.capabilities.reduce((sum, c) => sum + c.level, 0) / role.capabilities.length;
    if (avgCapability >= 0.8) {
      evidence.push({
        type: 'domain_depth',
        description: '领域深度达到专家水平',
        metric: avgCapability,
        timestamp: Date.now()
      });
    }

    if (evidence.length === 0) return null;

    // 确定进化方向
    const afterRole = this.determineEvolutionPath(role);

    const evolution: RoleEvolution = {
      id: `evo_${ulid()}`,
      agentId,
      beforeRole: role.primaryRole,
      afterRole,
      reason: this.generateEvolutionReason(role, afterRole, evidence),
      evidence,
      status: 'pending',
      approvedBy: null,
      approvedAt: null,
      createdAt: Date.now()
    };

    this.evolutions.set(evolution.id, evolution);
    role.evolutionHistory.push(evolution.id);

    console.log(`[RoleEvolution] ${agentId} 建议进化: ${role.primaryRole} -> ${afterRole}`);

    return evolution;
  }

  /**
   * 确定进化路径
   */
  private determineEvolutionPath(role: AgentRole): RoleType {
    // 基于能力和经验确定进化方向
    const capabilityLevels = role.capabilities.reduce((acc, c) => {
      acc[c.skill] = c.level;
      return acc;
    }, {} as Record<string, number>);

    // 编码角色可能进化为审查角色
    if (role.primaryRole === 'coding' && capabilityLevels['review'] && capabilityLevels['review'] > 0.6) {
      return 'review';
    }

    // 研究角色可能进化为协调角色
    if (role.primaryRole === 'research' && capabilityLevels['synthesis'] && capabilityLevels['synthesis'] > 0.7) {
      return 'coordination';
    }

    // 默认进化为测试角色
    return 'test';
  }

  /**
   * 生成进化原因
   */
  private generateEvolutionReason(role: AgentRole, afterRole: RoleType, evidence: EvolutionEvidence[]): string {
    const reasons = [
      `累计经验达到 ${role.experience} 点，具备进化条件`,
      `核心能力评估达标，可承担更多责任`,
      `团队协作反馈积极，具备角色转型基础`
    ];
    return reasons[Math.floor(Math.random() * reasons.length)];
  }

  /**
   * 审批进化
   */
  public approveEvolution(evolutionId: string, approver: string): RoleEvolution | undefined {
    const evolution = this.evolutions.get(evolutionId);
    if (!evolution || evolution.status !== 'pending') return undefined;

    const role = this.roles.get(evolution.agentId);
    if (!role) return undefined;

    // 执行进化
    evolution.status = 'approved';
    evolution.approvedBy = approver;
    evolution.approvedAt = Date.now();

    // 更新角色
    const oldRole = role.primaryRole;
    role.primaryRole = evolution.afterRole as RoleType;
    role.secondaryRoles.push(oldRole as RoleType);
    role.capabilities = [
      ...role.capabilities,
      ...this.initializeCapabilities(evolution.afterRole as RoleType)
    ];
    role.experience = 0;  // 重置经验
    role.updatedAt = Date.now();

    console.log(`[RoleEvolution] ${evolution.agentId} 进化审批通过: ${oldRole} -> ${evolution.afterRole}`);

    return evolution;
  }

  /**
   * 拒绝进化
   */
  public rejectEvolution(evolutionId: string, rejector: string, reason: string): RoleEvolution | undefined {
    const evolution = this.evolutions.get(evolutionId);
    if (!evolution || evolution.status !== 'pending') return undefined;

    evolution.status = 'rejected';
    evolution.approvedBy = rejector;
    evolution.approvedAt = Date.now();

    console.log(`[RoleEvolution] ${evolution.agentId} 进化被拒绝: ${reason}`);

    return evolution;
  }

  /**
   * 获取 Agent 角色
   */
  public getAgentRole(agentId: string): AgentRole | undefined {
    return this.roles.get(agentId);
  }

  /**
   * 获取待审批进化
   */
  public getPendingEvolutions(): RoleEvolution[] {
    return Array.from(this.evolutions.values())
      .filter(e => e.status === 'pending');
  }

  /**
   * 获取进化历史
   */
  public getEvolutionHistory(agentId: string): RoleEvolution[] {
    const role = this.roles.get(agentId);
    if (!role) return [];

    return role.evolutionHistory
      .map(id => this.evolutions.get(id))
      .filter(Boolean) as RoleEvolution[];
  }

  /**
   * 获取角色统计
   */
  public stats(): {
    totalAgents: number;
    byRole: Record<string, number>;
    pendingEvolutions: number;
    approvedEvolutions: number;
  } {
    const agents = Array.from(this.roles.values());
    const evolutions = Array.from(this.evolutions.values());

    const byRole: Record<string, number> = {};
    for (const agent of agents) {
      byRole[agent.primaryRole] = (byRole[agent.primaryRole] || 0) + 1;
    }

    return {
      totalAgents: agents.length,
      byRole,
      pendingEvolutions: evolutions.filter(e => e.status === 'pending').length,
      approvedEvolutions: evolutions.filter(e => e.status === 'approved').length
    };
  }
}

// 导出单例
export const roleEvolutionManager = new RoleEvolutionManager();
export default roleEvolutionManager;
