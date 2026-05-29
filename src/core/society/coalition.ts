// ─────────────────────────────────────────────────────────────────
// SoloForge AI Society Layer: Coalition (联盟机制)
// Path: src/core/society/coalition.ts
// Description: 临时组队完成复杂任务，自动解散防止组织僵化
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';

export type CoalitionStatus = 'forming' | 'active' | 'dissolved' | 'failed';

export interface CoalitionMember {
  agentId: string;
  role: string;                    // 在联盟中的角色
  contribution: number;            // 贡献度 0-1
  joinedAt: number;
  status: 'active' | 'paused' | 'left';
}

export interface CoalitionTask {
  id: string;
  description: string;
  assignedTo: string;              // Agent ID
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress: number;                // 0-100
  result?: string;
}

export interface Coalition {
  id: string;
  goal: string;                    // 联盟目标
  description: string;              // 详细描述
  members: CoalitionMember[];      // 成员 Agent
  leader: string;                 // 协调者
  lifetime: number;                // 生存周期（毫秒）
  status: CoalitionStatus;
  tasks: CoalitionTask[];
  performance: {
    completedTasks: number;
    failedTasks: number;
    efficiency: number;            // 0-1，完成率/时间
  };
  createdAt: number;
  activatedAt: number | null;
  dissolvedAt: number | null;
}

/**
 * 联盟管理器
 */
export class CoalitionManager {
  private coalitions: Map<string, Coalition> = new Map();
  private readonly DEFAULT_LIFETIME = 3600000;  // 1小时
  private readonly MAX_LIFETIME = 7200000;       // 2小时最大

  constructor() {}

  /**
   * 创建联盟
   */
  public create(data: {
    goal: string;
    description?: string;
    leader: string;
    memberIds: string[];
    lifetime?: number;             // 毫秒
  }): Coalition {
    const id = `coalition_${ulid()}`;
    const now = Date.now();

    const members: CoalitionMember[] = data.memberIds.map(agentId => ({
      agentId,
      role: 'member',
      contribution: 0,
      joinedAt: now,
      status: 'active'
    }));

    // 领导者在联盟中的角色升级
    const leaderMember = members.find(m => m.agentId === data.leader);
    if (leaderMember) {
      leaderMember.role = 'coordinator';
    }

    const coalition: Coalition = {
      id,
      goal: data.goal,
      description: data.description || '',
      members,
      leader: data.leader,
      lifetime: Math.min(data.lifetime || this.DEFAULT_LIFETIME, this.MAX_LIFETIME),
      status: 'forming',
      tasks: [],
      performance: {
        completedTasks: 0,
        failedTasks: 0,
        efficiency: 0
      },
      createdAt: now,
      activatedAt: null,
      dissolvedAt: null
    };

    this.coalitions.set(id, coalition);
    console.log(`[Coalition] 创建联盟: ${id} - ${data.goal}`);

    return coalition;
  }

  /**
   * 激活联盟
   */
  public activate(coalitionId: string): Coalition | undefined {
    const coalition = this.coalitions.get(coalitionId);
    if (!coalition || coalition.status !== 'forming') return undefined;

    coalition.status = 'active';
    coalition.activatedAt = Date.now();

    console.log(`[Coalition] 激活联盟: ${coalitionId}`);

    // 设置自动解散定时器
    setTimeout(() => {
      this.checkAndDissolve(coalitionId);
    }, coalition.lifetime);

    return coalition;
  }

  /**
   * 添加任务
   */
  public addTask(
    coalitionId: string,
    data: { description: string; assignedTo: string }
  ): CoalitionTask | undefined {
    const coalition = this.coalitions.get(coalitionId);
    if (!coalition || coalition.status !== 'active') return undefined;

    const task: CoalitionTask = {
      id: `task_${ulid()}`,
      description: data.description,
      assignedTo: data.assignedTo,
      status: 'pending',
      progress: 0
    };

    coalition.tasks.push(task);
    return task;
  }

  /**
   * 更新任务进度
   */
  public updateTaskProgress(
    coalitionId: string,
    taskId: string,
    progress: number
  ): CoalitionTask | undefined {
    const coalition = this.coalitions.get(coalitionId);
    if (!coalition) return undefined;

    const task = coalition.tasks.find(t => t.id === taskId);
    if (!task) return undefined;

    task.progress = Math.min(100, Math.max(0, progress));
    if (task.progress === 100) {
      task.status = 'completed';
      coalition.performance.completedTasks++;
      this.updateEfficiency(coalition);
    }

    return task;
  }

  /**
   * 完成任务
   */
  public completeTask(
    coalitionId: string,
    taskId: string,
    result: string
  ): CoalitionTask | undefined {
    const coalition = this.coalitions.get(coalitionId);
    if (!coalition) return undefined;

    const task = coalition.tasks.find(t => t.id === taskId);
    if (!task) return undefined;

    task.status = 'completed';
    task.progress = 100;
    task.result = result;
    coalition.performance.completedTasks++;

    this.updateEfficiency(coalition);

    // 检查是否所有任务都完成
    this.checkGoalCompletion(coalitionId);

    return task;
  }

  /**
   * 标记任务失败
   */
  public failTask(coalitionId: string, taskId: string): CoalitionTask | undefined {
    const coalition = this.coalitions.get(coalitionId);
    if (!coalition) return undefined;

    const task = coalition.tasks.find(t => t.id === taskId);
    if (!task) return undefined;

    task.status = 'failed';
    coalition.performance.failedTasks++;

    this.updateEfficiency(coalition);

    return task;
  }

  /**
   * 更新效率
   */
  private updateEfficiency(coalition: Coalition): void {
    const totalTasks = coalition.performance.completedTasks + coalition.performance.failedTasks;
    if (totalTasks === 0) {
      coalition.performance.efficiency = 0;
      return;
    }

    // 效率 = 完成率 * 时间利用率
    const completionRate = coalition.performance.completedTasks / totalTasks;
    const elapsed = coalition.activatedAt ? Date.now() - coalition.activatedAt : 0;
    const timeUtilization = Math.min(1, elapsed / coalition.lifetime);

    coalition.performance.efficiency = completionRate * 0.7 + timeUtilization * 0.3;
  }

  /**
   * 检查目标完成情况
   */
  private checkGoalCompletion(coalitionId: string): void {
    const coalition = this.coalitions.get(coalitionId);
    if (!coalition || coalition.status !== 'active') return;

    const allCompleted = coalition.tasks.every(
      t => t.status === 'completed' || t.status === 'failed'
    );

    if (allCompleted && coalition.tasks.length > 0) {
      this.dissolve(coalitionId, 'goal_completed');
    }
  }

  /**
   * 检查并解散联盟
   */
  private checkAndDissolve(coalitionId: string): void {
    const coalition = this.coalitions.get(coalitionId);
    if (!coalition || coalition.status !== 'active') return;

    this.dissolve(coalitionId, 'lifetime_expired');
  }

  /**
   * 解散联盟
   */
  public dissolve(coalitionId: string, reason: string): Coalition | undefined {
    const coalition = this.coalitions.get(coalitionId);
    if (!coalition || coalition.status === 'dissolved') return undefined;

    coalition.status = 'dissolved';
    coalition.dissolvedAt = Date.now();

    // 计算最终表现
    this.updateEfficiency(coalition);

    console.log(`[Coalition] 解散联盟: ${coalitionId} (原因: ${reason})`);
    console.log(`[Coalition] 联盟表现: 完成 ${coalition.performance.completedTasks} 个任务, 失败 ${coalition.performance.failedTasks} 个, 效率 ${(coalition.performance.efficiency * 100).toFixed(1)}%`);

    return coalition;
  }

  /**
   * 成员离开联盟
   */
  public leaveCoalition(coalitionId: string, agentId: string): boolean {
    const coalition = this.coalitions.get(coalitionId);
    if (!coalition || coalition.status !== 'active') return false;

    const member = coalition.members.find(m => m.agentId === agentId);
    if (!member) return false;

    member.status = 'left';

    // 如果领导离开，指定新领导
    if (agentId === coalition.leader) {
      const newLeader = coalition.members.find(m => m.status === 'active' && m.agentId !== agentId);
      if (newLeader) {
        coalition.leader = newLeader.agentId;
        newLeader.role = 'coordinator';
        console.log(`[Coalition] 新领导: ${newLeader.agentId}`);
      } else {
        // 没有可用成员，解散联盟
        this.dissolve(coalitionId, 'no_leader');
        return true;
      }
    }

    return true;
  }

  /**
   * 获取联盟
   */
  public get(id: string): Coalition | undefined {
    return this.coalitions.get(id);
  }

  /**
   * 获取活跃联盟
   */
  public getActiveCoalitions(): Coalition[] {
    return Array.from(this.coalitions.values())
      .filter(c => c.status === 'active');
  }

  /**
   * 获取 Agent 参与的联盟
   */
  public getAgentCoalitions(agentId: string): Coalition[] {
    return Array.from(this.coalitions.values())
      .filter(c => c.members.some(m => m.agentId === agentId && m.status === 'active'));
  }

  /**
   * 获取联盟统计
   */
  public stats(): {
    totalCoalitions: number;
    active: number;
    dissolved: number;
    averageEfficiency: number;
    topPerformers: Array<{ id: string; goal: string; efficiency: number }>;
  } {
    const all = Array.from(this.coalitions.values());
    const active = all.filter(c => c.status === 'active');
    const dissolved = all.filter(c => c.status === 'dissolved');

    const completed = all.filter(c => c.performance.completedTasks > 0);
    const averageEfficiency = completed.length > 0
      ? completed.reduce((sum, c) => sum + c.performance.efficiency, 0) / completed.length
      : 0;

    const topPerformers = [...completed]
      .sort((a, b) => b.performance.efficiency - a.performance.efficiency)
      .slice(0, 5)
      .map(c => ({
        id: c.id,
        goal: c.goal,
        efficiency: c.performance.efficiency
      }));

    return {
      totalCoalitions: all.length,
      active: active.length,
      dissolved: dissolved.length,
      averageEfficiency,
      topPerformers
    };
  }
}

// 导出单例
export const coalitionManager = new CoalitionManager();
export default coalitionManager;
