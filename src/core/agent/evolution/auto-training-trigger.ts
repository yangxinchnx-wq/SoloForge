/**
 * auto-training-trigger.ts — 每个 Agent 的自动训练触发器
 *
 * 设计原则:
 *   1. 每个 Agent 实例化时自动创建一个 trigger
 *   2. 每次任务执行后自动记录轨迹
 *   3. 积累够 batch_size 条轨迹后自动触发训练
 *   4. 支持紧急训练（成功率骤降时）
 *   5. 训练在后台异步进行，不阻塞 Agent 工作
 *
 * 触发条件:
 *   - 轨迹数量 >= batch_size (默认 20)
 *   - 冷却时间已过 (默认 5 分钟)
 *   - 紧急: 成功率下降超过阈值
 */

import { logger } from '../../logger/index';
import { EventEmitter } from 'events';

// ─── 执行轨迹 ─────────────────────────────────────────────────

export interface ExecutionTrace {
  agentId: string;
  taskId: string;
  timestamp: number;

  // 观测 (10维，与 agent_env.py 对齐)
  observation: {
    taskComplexity: number;
    taskDomainMatch: number;
    taskCodeLines: number;
    taskRequiresTools: number;
    agentSkillCount: number;
    agentSuccessRate: number;
    agentCurrentRound: number;
    agentToolErrorRate: number;
    contextHasExistingCode: number;
    contextFileCount: number;
  };

  // 动作记录
  toolsUsed: string[];
  strategyUsed: string;

  // 结果
  success: boolean;
  durationMs: number;
  toolCallCount: number;

  // 奖励信号
  reward: number;
}

// ─── 训练触发器配置 ────────────────────────────────────────────

export interface TriggerConfig {
  batchSize: number;          // 积累多少条轨迹后触发训练
  cooldownMs: number;         // 训练冷却时间 (毫秒)
  emergencyThreshold: number; // 成功率下降多少触发紧急训练
  maxBufferSize: number;      // 最大缓冲区大小
}

const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  batchSize: 20,
  cooldownMs: 5 * 60 * 1000,  // 5 分钟
  emergencyThreshold: 0.15,    // 成功率下降 15%
  maxBufferSize: 200,
};

// ─── 训练触发器 ───────────────────────────────────────────────

export class AutoTrainingTrigger extends EventEmitter {
  private readonly agentId: string;
  private readonly config: TriggerConfig;

  private traceBuffer: ExecutionTrace[] = [];
  private lastTrainingTime = 0;
  private recentSuccessRate = 0.5;  // 滑动窗口成功率
  private totalTracesRecorded = 0;
  private totalTrainingsTriggered = 0;

  constructor(agentId: string, config?: Partial<TriggerConfig>) {
    super();
    this.agentId = agentId;
    this.config = { ...DEFAULT_TRIGGER_CONFIG, ...config };
  }

  /**
   * 记录一条执行轨迹
   * 每次 Agent 执行完任务后自动调用
   */
  recordTrace(trace: ExecutionTrace): void {
    this.traceBuffer.push(trace);
    this.totalTracesRecorded++;

    // 更新滑动窗口成功率 (最近 50 条)
    const recent = this.traceBuffer.slice(-50);
    this.recentSuccessRate = recent.filter(t => t.success).length / recent.length;

    // 限制缓冲区大小
    if (this.traceBuffer.length > this.config.maxBufferSize) {
      this.traceBuffer = this.traceBuffer.slice(-this.config.maxBufferSize);
    }

    // 检查是否应该触发训练
    this.checkAndTrigger();
  }

  /**
   * 检查触发条件并触发训练
   */
  private checkAndTrigger(): void {
    const now = Date.now();
    const cooldownPassed = now - this.lastTrainingTime >= this.config.cooldownMs;
    const hasEnoughTraces = this.traceBuffer.length >= this.config.batchSize;

    // 条件 1: 正常触发 — 轨迹够了 + 冷却过了
    if (hasEnoughTraces && cooldownPassed) {
      this.triggerTraining('batch_ready');
      return;
    }

    // 条件 2: 紧急触发 — 成功率骤降
    if (this.traceBuffer.length >= 10) {
      const olderHalf = this.traceBuffer.slice(0, Math.floor(this.traceBuffer.length / 2));
      const newerHalf = this.traceBuffer.slice(Math.floor(this.traceBuffer.length / 2));
      const olderRate = olderHalf.filter(t => t.success).length / olderHalf.length;
      const newerRate = newerHalf.filter(t => t.success).length / newerHalf.length;

      if (olderRate - newerRate > this.config.emergencyThreshold && cooldownPassed) {
        logger.warn('AutoTraining',
          `[${this.agentId}] 紧急触发: 成功率从 ${(olderRate * 100).toFixed(0)}% 下降到 ${(newerRate * 100).toFixed(0)}%`
        );
        this.triggerTraining('emergency');
        return;
      }
    }
  }

  /**
   * 触发训练
   */
  private triggerTraining(reason: 'batch_ready' | 'emergency'): void {
    const batch = this.traceBuffer.splice(0, this.config.batchSize);
    this.lastTrainingTime = Date.now();
    this.totalTrainingsTriggered++;

    logger.info('AutoTraining',
      `[${this.agentId}] 触发训练: reason=${reason}, batch=${batch.length}, ` +
      `total=${this.totalTrainingsTriggered}, success_rate=${(this.recentSuccessRate * 100).toFixed(0)}%`
    );

    // 发出训练事件，由 TrainingScheduler 接收处理
    this.emit('training_triggered', {
      agentId: this.agentId,
      reason,
      traces: batch,
      successRate: this.recentSuccessRate,
      timestamp: this.lastTrainingTime,
    });
  }

  /**
   * 获取触发器状态
   */
  getStatus(): {
    agentId: string;
    bufferSize: number;
    recentSuccessRate: number;
    totalTracesRecorded: number;
    totalTrainingsTriggered: number;
    lastTrainingTime: number;
    nextTrainingEstimate: number;  // 预计还需多少条轨迹
  } {
    return {
      agentId: this.agentId,
      bufferSize: this.traceBuffer.length,
      recentSuccessRate: this.recentSuccessRate,
      totalTracesRecorded: this.totalTracesRecorded,
      totalTrainingsTriggered: this.totalTrainingsTriggered,
      lastTrainingTime: this.lastTrainingTime,
      nextTrainingEstimate: Math.max(0, this.config.batchSize - this.traceBuffer.length),
    };
  }

  /**
   * 手动注入轨迹 (用于从持久化存储恢复)
   */
  injectTraces(traces: ExecutionTrace[]): void {
    for (const trace of traces) {
      this.traceBuffer.push(trace);
    }
    this.checkAndTrigger();
  }

  /**
   * 导出所有轨迹 (用于持久化)
   */
  exportTraces(): ExecutionTrace[] {
    return [...this.traceBuffer];
  }
}
