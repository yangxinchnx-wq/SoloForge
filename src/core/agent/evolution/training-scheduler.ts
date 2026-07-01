/**
 * training-scheduler.ts — 全局训练调度器
 *
 * 职责:
 *   1. 管理所有 Agent 的 AutoTrainingTrigger
 *   2. 监听训练触发事件
 *   3. 调度训练任务到 MARL 服务
 *   4. 管理训练队列（防止并发训练冲突）
 *   5. 将训练后的策略写入技能库
 *
 * 生命周期:
 *   - bootstrap 时创建单例
 *   - 每个 Agent 注册时自动绑定 trigger
 *   - 服务关闭时 flush 所有缓冲区
 */

import { logger } from '../../logger/index';
import { AutoTrainingTrigger, type ExecutionTrace } from './auto-training-trigger';
import { SkillLibrary } from './skill-library';

// ─── 训练任务 ─────────────────────────────────────────────────

interface PendingTrainingJob {
  agentId: string;
  reason: 'batch_ready' | 'emergency';
  traces: ExecutionTrace[];
  successRate: number;
  enqueuedAt: number;
}

// ─── 训练调度器 ───────────────────────────────────────────────

export class TrainingScheduler {
  private static instance: TrainingScheduler | null = null;

  // 所有 Agent 的触发器
  private readonly triggers = new Map<string, AutoTrainingTrigger>();

  // 训练队列
  private readonly jobQueue: PendingTrainingJob[] = [];
  private isTraining = false;

  // 技能库引用
  private skillLibrary: SkillLibrary | null = null;

  // 统计
  private totalJobsProcessed = 0;
  private totalTracesProcessed = 0;

  private constructor() {}

  static getInstance(): TrainingScheduler {
    if (!TrainingScheduler.instance) {
      TrainingScheduler.instance = new TrainingScheduler();
    }
    return TrainingScheduler.instance;
  }

  /**
   * 设置技能库引用
   */
  setSkillLibrary(library: SkillLibrary): void {
    this.skillLibrary = library;
  }

  /**
   * 为 Agent 注册训练触发器
   * Agent 创建时自动调用
   */
  registerAgent(agentId: string, domain: string): AutoTrainingTrigger {
    if (this.triggers.has(agentId)) {
      return this.triggers.get(agentId)!;
    }

    const trigger = new AutoTrainingTrigger(agentId);

    // 监听训练触发事件
    trigger.on('training_triggered', (event) => {
      this.enqueueTrainingJob(event);
    });

    this.triggers.set(agentId, trigger);

    logger.info('TrainingScheduler', `Registered trigger for agent: ${agentId} (${domain})`);
    return trigger;
  }

  /**
   * 注销 Agent 的训练触发器
   */
  unregisterAgent(agentId: string): void {
    const trigger = this.triggers.get(agentId);
    if (trigger) {
      trigger.removeAllListeners();
      this.triggers.delete(agentId);
      logger.info('TrainingScheduler', `Unregistered trigger for agent: ${agentId}`);
    }
  }

  /**
   * 获取 Agent 的触发器
   */
  getTrigger(agentId: string): AutoTrainingTrigger | undefined {
    return this.triggers.get(agentId);
  }

  /**
   * 将训练任务加入队列
   */
  private enqueueTrainingJob(event: {
    agentId: string;
    reason: 'batch_ready' | 'emergency';
    traces: ExecutionTrace[];
    successRate: number;
  }): void {
    this.jobQueue.push({
      ...event,
      enqueuedAt: Date.now(),
    });

    logger.info('TrainingScheduler',
      `Enqueued training job for ${event.agentId}: reason=${event.reason}, traces=${event.traces.length}, queue=${this.jobQueue.length}`
    );

    // 尝试处理队列
    this.processQueue();
  }

  /**
   * 处理训练队列
   * 保证同一时间只有一个训练在运行
   */
  private async processQueue(): Promise<void> {
    if (this.isTraining || this.jobQueue.length === 0) return;

    this.isTraining = true;
    const job = this.jobQueue.shift()!;

    try {
      logger.info('TrainingScheduler',
        `Processing training job for ${job.agentId}: reason=${job.reason}, traces=${job.traces.length}`
      );

      // 1. 发送轨迹到 MARL 服务训练
      await this.sendToMarlService(job);

      // 2. 从轨迹中提炼技能写入技能库
      this.extractSkills(job.agentId, job.traces);

      this.totalJobsProcessed++;
      this.totalTracesProcessed += job.traces.length;

      logger.info('TrainingScheduler',
        `Training completed for ${job.agentId}: total_jobs=${this.totalJobsProcessed}, total_traces=${this.totalTracesProcessed}`
      );
    } catch (err) {
      logger.error('TrainingScheduler', `Training failed for ${job.agentId}: ${err}`);
    } finally {
      this.isTraining = false;
      // 继续处理下一个
      if (this.jobQueue.length > 0) {
        setTimeout(() => this.processQueue(), 1000);
      }
    }
  }

  /**
   * 发送轨迹到 MARL 服务
   */
  private async sendToMarlService(job: PendingTrainingJob): Promise<void> {
    // 将轨迹转换为 MARL 训练格式
    const trainingData = job.traces.map(trace => ({
      observation: [
        trace.observation.taskComplexity,
        trace.observation.taskDomainMatch,
        trace.observation.taskCodeLines,
        trace.observation.taskRequiresTools,
        trace.observation.agentSkillCount,
        trace.observation.agentSuccessRate,
        trace.observation.agentCurrentRound,
        trace.observation.agentToolErrorRate,
        trace.observation.contextHasExistingCode,
        trace.observation.contextFileCount,
      ],
      reward: trace.reward,
      tools_used: trace.toolsUsed,
      strategy: trace.strategyUsed,
      success: trace.success,
    }));

    // 通过 TCP 发送到 MARL 服务 (端口 8765)
    // 使用现有的分布式协议
    try {
      const net = await import('net');
      const client = new net.Socket();

      await new Promise<void>((resolve, reject) => {
        client.connect(8765, '127.0.0.1', () => {
          const frame = JSON.stringify({
            frameId: `train-${job.agentId}-${Date.now()}`,
            type: 'AGENT_TRAINING_DATA',
            agentId: job.agentId,
            reason: job.reason,
            payload: trainingData,
            timestamp: Date.now(),
          }) + '\n';

          client.write(frame);
          client.end();
          resolve();
        });

        client.on('error', (err) => {
          // MARL 服务未启动时静默失败
          logger.warn('TrainingScheduler', `MARL service not available: ${err.message}`);
          resolve();  // 不阻塞
        });

        setTimeout(() => {
          client.destroy();
          resolve();
        }, 5000);
      });
    } catch {
      // 静默失败，不影响 Agent 工作
    }
  }

  /**
   * 从轨迹中提炼技能写入技能库
   */
  private extractSkills(agentId: string, traces: ExecutionTrace[]): void {
    if (!this.skillLibrary) return;

    // 找出成功的轨迹
    const successfulTraces = traces.filter(t => t.success);
    if (successfulTraces.length === 0) return;

    // 提炼工具使用模式
    const toolPatterns = new Map<string, number>();
    for (const trace of successfulTraces) {
      const key = trace.toolsUsed.join(' → ');
      toolPatterns.set(key, (toolPatterns.get(key) ?? 0) + 1);
    }

    // 找出最常用的工具组合
    const sortedPatterns = [...toolPatterns.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    for (const [pattern, count] of sortedPatterns) {
      this.skillLibrary.addSkill({
        id: `auto-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        domain: agentId.split('-')[0] as any,
        pattern: `有效的工具组合: ${pattern} (成功 ${count} 次)`,
        confidence: Math.min(1.0, count / 5),
        usageCount: count,
        successRate: 1.0,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      });
    }

    // 提炼策略偏好
    const strategyCounts = new Map<string, number>();
    for (const trace of successfulTraces) {
      strategyCounts.set(trace.strategyUsed, (strategyCounts.get(trace.strategyUsed) ?? 0) + 1);
    }

    const bestStrategy = [...strategyCounts.entries()]
      .sort((a, b) => b[1] - a[1])[0];

    if (bestStrategy) {
      this.skillLibrary.addSkill({
        id: `auto-strategy-${agentId}-${Date.now()}`,
        domain: agentId.split('-')[0] as any,
        pattern: `推荐策略: ${bestStrategy[0]} (成功 ${bestStrategy[1]} 次)`,
        confidence: Math.min(1.0, bestStrategy[1] / 5),
        usageCount: bestStrategy[1],
        successRate: 1.0,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      });
    }
  }

  /**
   * 获取全局状态
   */
  getGlobalStatus(): {
    registeredAgents: number;
    queueLength: number;
    isTraining: boolean;
    totalJobsProcessed: number;
    totalTracesProcessed: number;
    agentStatuses: Array<ReturnType<AutoTrainingTrigger['getStatus']>>;
  } {
    return {
      registeredAgents: this.triggers.size,
      queueLength: this.jobQueue.length,
      isTraining: this.isTraining,
      totalJobsProcessed: this.totalJobsProcessed,
      totalTracesProcessed: this.totalTracesProcessed,
      agentStatuses: [...this.triggers.values()].map(t => t.getStatus()),
    };
  }

  /**
   * 关闭时 flush 所有缓冲区
   */
  async shutdown(): Promise<void> {
    // 将所有未处理的轨迹保存到技能库
    for (const [agentId, trigger] of this.triggers) {
      const traces = trigger.exportTraces();
      if (traces.length > 0) {
        this.extractSkills(agentId, traces);
      }
      trigger.removeAllListeners();
    }
    this.triggers.clear();
    logger.info('TrainingScheduler', 'Shutdown complete');
  }
}
