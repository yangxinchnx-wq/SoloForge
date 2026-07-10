/**
 * SupervisorStrategy — Actor 监督策略
 *
 * 设计参考:
 *   - Erlang/OTP Supervisor: one_for_one / one_for_all / rest_for_one
 *   - Akka Supervisor: Restart/Resume/Stop/Escalate
 *   - XState Guardian: 顶层 Actor 的错误处理
 *
 * 核心原则:
 *   1. 单个 Actor 的错误不 crash 整个系统
 *   2. 错误恢复策略可配置 (重启/停止/升级)
 *   3. 错误次数有上限, 超过后转为停止 (避免无限重启)
 *   4. 错误事件可被外部监听 (用于 UI 提示 / 日志上报)
 *
 * 2026-07-10: P3-2 实现
 */

import type { TaskActor, ActorStateSnapshot } from './taskActor';
import { taskActorSystem } from './taskActor';

// ==================== 监督策略类型 ====================

export type SupervisorAction = 'restart' | 'stop' | 'escalate' | 'resume';

export interface SupervisorDecision {
  action: SupervisorAction;
  reason: string;
  /** 重启后的初始 phase */
  restartPhase?: string;
}

export interface SupervisorConfig {
  /** 最大重启次数 (在 timeWindow 内) */
  maxRestarts: number;
  /** 重启次数计数窗口 (毫秒) */
  timeWindow: number;
  /** 默认动作 */
  defaultAction: SupervisorAction;
  /** 是否自动通知 UI (通过 error 事件) */
  notifyUI: boolean;
}

// ==================== 错误事件 ====================

export interface ActorErrorEvent {
  taskId: string;
  chatId: string;
  message: string;
  timestamp: number;
  /** 错误前 Actor 的 phase */
  phase: string;
  /** 监督决策 */
  decision: SupervisorDecision;
  /** 此 Actor 在 timeWindow 内的错误次数 */
  errorCount: number;
}

type ErrorListener = (event: ActorErrorEvent) => void;

// ==================== Supervisor 实现 ====================

class TaskActorSupervisor {
  private config: SupervisorConfig;
  /** taskId → 错误时间戳列表 (用于计数) */
  private errorHistory = new Map<string, number[]>();
  /** 错误事件监听者 */
  private errorListeners = new Set<ErrorListener>();

  constructor(config: Partial<SupervisorConfig> = {}) {
    this.config = {
      maxRestarts: 3,
      timeWindow: 60_000, // 1 分钟
      defaultAction: 'restart',
      notifyUI: true,
      ...config,
    };
  }

  /** 更新配置 */
  updateConfig(partial: Partial<SupervisorConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /**
   * 处理 Actor 错误 — 核心监督入口
   * 由 TaskActor 内部在 processEvent 失败时调用
   */
  handleActorError(
    actor: TaskActor,
    error: Error,
    snapshot: ActorStateSnapshot,
  ): SupervisorDecision {
    const { taskId, chatId, phase } = snapshot;

    // 记录错误时间戳
    const now = Date.now();
    const history = this.errorHistory.get(taskId) ?? [];
    // 过滤掉 timeWindow 之外的旧错误
    const recent = history.filter(ts => now - ts < this.config.timeWindow);
    recent.push(now);
    this.errorHistory.set(taskId, recent);

    const errorCount = recent.length;
    const exceededMax = errorCount > this.config.maxRestarts;

    // 决策: 超过最大重启次数 → 停止; 否则 → 重启
    let decision: SupervisorDecision;
    if (exceededMax) {
      decision = {
        action: 'stop',
        reason: `Actor ${taskId} 在 ${this.config.timeWindow / 1000}s 内错误 ${errorCount} 次, 超过上限 ${this.config.maxRestarts}, 停止 Actor`,
      };
    } else {
      decision = {
        action: this.config.defaultAction,
        reason: `Actor ${taskId} 第 ${errorCount} 次错误 (上限 ${this.config.maxRestarts}): ${error.message}`,
        restartPhase: phase,
      };
    }

    // 执行决策
    switch (decision.action) {
      case 'restart':
        actor.restart();
        break;
      case 'stop':
        actor.stop();
        // 清理错误历史
        this.errorHistory.delete(taskId);
        break;
      case 'resume':
        // 继续处理 (忽略错误, 继续下一条消息)
        break;
      case 'escalate':
        // 升级到系统级处理 (停止所有 Actor)
        // 通常不使用, 仅在灾难性错误时触发
        break;
    }

    // 通知错误监听者
    const errorEvent: ActorErrorEvent = {
      taskId,
      chatId,
      message: error.message,
      timestamp: now,
      phase,
      decision,
      errorCount,
    };

    for (const listener of this.errorListeners) {
      try {
        listener(errorEvent);
      } catch {
        // 监听者错误不影响监督策略
      }
    }

    return decision;
  }

  /** 订阅 Actor 错误事件 */
  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** 获取指定 Actor 的错误次数 */
  getErrorCount(taskId: string): number {
    const now = Date.now();
    const history = this.errorHistory.get(taskId) ?? [];
    return history.filter(ts => now - ts < this.config.timeWindow).length;
  }

  /** 清理指定 Actor 的错误历史 */
  clearErrorHistory(taskId: string): void {
    this.errorHistory.delete(taskId);
  }

  /** 重置所有监督状态 */
  reset(): void {
    this.errorHistory.clear();
    this.errorListeners.clear();
  }
}

// ==================== 单例导出 ====================

export const taskActorSupervisor = new TaskActorSupervisor();

// ==================== React 错误边界集成 ====================

/**
 * 将 Actor 错误事件转换为用户可读的提示
 * 用于 UI 错误通知
 */
export function formatActorErrorForUI(event: ActorErrorEvent): {
  title: string;
  message: string;
  severity: 'warning' | 'error';
  isRecoverable: boolean;
} {
  const isStopped = event.decision.action === 'stop';
  return {
    title: isStopped ? '任务执行已停止' : '任务执行遇到错误, 正在自动恢复',
    message: event.decision.reason,
    severity: isStopped ? 'error' : 'warning',
    isRecoverable: !isStopped,
  };
}
