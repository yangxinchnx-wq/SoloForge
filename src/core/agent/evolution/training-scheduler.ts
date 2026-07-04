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
  private totalTrainingFailures = 0;

  /**
   * 策略更新回调（可选）
   * 由 agent-decision-orchestrator 注入，用于训练完一次后通知决策层重置缓存
   */
  public onPolicyUpdated?: (event: {
    agentId: string;
    accepted?: number;
    trained?: boolean;
    checkpointWritten?: boolean;
  }) => void;

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
      const ack = await this.sendToMarlService(job);
      if (ack.ok) {
        this.totalJobsProcessed++;
        this.totalTracesProcessed += job.traces.length;
        if (ack.checkpointWritten) {
          logger.info('TrainingScheduler', `Policy checkpoint updated agent=${job.agentId}`);
          // 闭环关键:checkpoint 写完后通过 callback 通知 agent 决策层
          // 训练好的策略已经通过 8765 持久化为 policy.pt
          // 下次 POLICY_QUERY 帧会被 server.py 用新策略响应
          if (this.onPolicyUpdated) {
            try { this.onPolicyUpdated({ agentId: job.agentId, ...ack }); }
            catch (e) { logger.warn('TrainingScheduler', `onPolicyUpdated callback failed: ${(e as Error).message}`); }
          }
        }
      } else {
        // MARL 失败:不再静默,但保留 extractSkills 作为兜底技能提取
        logger.error('TrainingScheduler',
          `MARL training failed for ${job.agentId}: ${ack.error}; falling back to skill extraction only`
        );
        this.totalTrainingFailures = (this.totalTrainingFailures ?? 0) + 1;
      }

      // 2. 从轨迹中提炼技能写入技能库
      this.extractSkills(job.agentId, job.traces);

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
   * 同步等待 ACK;失败时返回错误(不再静默吞掉)
   */
  private async sendToMarlService(job: PendingTrainingJob): Promise<{
    ok: boolean;
    accepted?: number;
    trained?: boolean;
    loss?: Record<string, number> | null;
    checkpointWritten?: boolean;
    error?: string;
  }> {
    // 将轨迹转换为 MARL 训练格式
    // 字段对齐 AgentObservation.to_array() 的 10 维观测 + trainer.train_step() 的 (obs, action, log_prob, reward, value, done, kernel_version)
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
      action: this.inferAction(trace),
      log_prob: 0.0,                        // 由 trainer 内部 rollout 时记录;此处占位
      reward: trace.reward,
      value: trace.success ? 1.0 : 0.0,     // 简化:成功轨迹价值=1,失败=0
      done: true,                            // 每个 trace 是独立 episode 末尾
      kernel_version: (job as any).kernelVersion || 0,
      tools_used: trace.toolsUsed,
      strategy: trace.strategyUsed,
      success: trace.success,
    }));

    return new Promise((resolve) => {
      try {
        const net = require('net');
        const client = new net.Socket();
        let ackBuf = '';
        let done = false;
        const finish = (result: any) => {
          if (done) return;
          done = true;
          try { client.destroy(); } catch (_) { /* noop */ }
          resolve(result);
        };

        const timer = setTimeout(() => {
          finish({ ok: false, error: 'timeout(5s) waiting MARL ACK on 8765' });
        }, 5000);

        client.on('error', (err: Error) => {
          clearTimeout(timer);
          logger.error('TrainingScheduler', `MARL service not available on 8765: ${err.message}`);
          finish({ ok: false, error: err.message });
        });

        client.connect(8765, '127.0.0.1', () => {
          const frame = JSON.stringify({
            frameId: `train-${job.agentId}-${Date.now()}`,
            type: 'AGENT_TRAINING_DATA',
            agentId: job.agentId,
            reason: job.reason,
            payload: { trainingData },
            timestamp: Date.now(),
          }) + '\n';
          client.write(frame);
        });

        client.on('data', (chunk: Buffer) => {
          ackBuf += chunk.toString('utf-8');
          // 服务器用 \n 分隔,收到一行就当作 ACK
          const idx = ackBuf.indexOf('\n');
          if (idx >= 0) {
            clearTimeout(timer);
            const line = ackBuf.slice(0, idx).trim();
            try {
              const ack = JSON.parse(line);
              if (ack.type === 'AGENT_TRAINING_ACK') {
                const p = ack.payload || {};
                finish({
                  ok: true,
                  accepted: p.accepted,
                  trained: p.trained_this_call,
                  loss: p.loss,
                  checkpointWritten: p.checkpoint_written,
                });
                logger.info('TrainingScheduler',
                  `MARL ACK agent=${job.agentId} accepted=${p.accepted} trained=${p.trained_this_call} ckpt=${p.checkpoint_written}`
                );
              } else {
                finish({ ok: false, error: `unexpected ack type: ${ack.type}` });
              }
            } catch (e) {
              finish({ ok: false, error: `invalid ack json: ${(e as Error).message}` });
            }
          }
        });
      } catch (e) {
        resolve({ ok: false, error: (e as Error).message });
      }
    });
  }

  /**
   * 从 trace 反推 action index(对 AgentAction 离散空间)
   * 简化规则:成功 → 1 (PERFORMANCE_MODE),失败 → 2 (CIRCUIT_BREAKER),否则 0 (NO_OP)
   * 真实环境会用 policy(state) 采样,这里仅用于回放训练 trace 的 action 标签
   */
  private inferAction(trace: ExecutionTrace): number {
    if (trace.success) return 1;
    if (trace.toolsUsed.length === 0) return 0;
    return trace.toolsUsed.length >= 3 ? 2 : 1;
  }

  /**
   * 向 8765 查询当前训练好的策略决策
   * 供 SoloForgeRTRRacerEngine 调用,获取基于历史训练数据的 action
   * 失败时回退到 heuristic(0)
   */
  public async queryTrainedPolicy(observation: number[]): Promise<{
    action: number;
    confidence: number;
    source: 'trained_policy' | 'fallback' | 'fallback_error' | 'no_trainer';
  }> {
    return new Promise((resolve) => {
      try {
        const net = require('net');
        const client = new net.Socket();
        let buf = '';
        let done = false;
        const finish = (r: any) => {
          if (done) return;
          done = true;
          try { client.destroy(); } catch (_) { /* noop */ }
          resolve(r);
        };

        const timer = setTimeout(() => {
          finish({ action: 0, confidence: 0.0, source: 'fallback' });
        }, 1000);

        client.on('error', () => {
          clearTimeout(timer);
          finish({ action: 0, confidence: 0.0, source: 'fallback' });
        });

        client.connect(8765, '127.0.0.1', () => {
          const frame = JSON.stringify({
            frameId: `policy_q_${Date.now()}`,
            type: 'POLICY_QUERY',
            payload: { observation },
            timestamp: Date.now(),
          }) + '\n';
          client.write(frame);
        });

        client.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf-8');
          const idx = buf.indexOf('\n');
          if (idx >= 0) {
            clearTimeout(timer);
            try {
              const ack = JSON.parse(buf.slice(0, idx).trim());
              if (ack.type === 'POLICY_ANSWER') {
                finish({
                  action: ack.payload.action,
                  confidence: ack.payload.confidence,
                  source: ack.payload.source,
                });
              } else {
                finish({ action: 0, confidence: 0.0, source: 'fallback' });
              }
            } catch {
              finish({ action: 0, confidence: 0.0, source: 'fallback_error' });
            }
          }
        });
      } catch {
        resolve({ action: 0, confidence: 0.0, source: 'fallback_error' });
      }
    });
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
