/**
 * TaskActor — 单任务隔离的 Actor 模型
 *
 * 设计参考:
 *   - XState Actor Model: 每个状态机是独立 Actor, 通过消息通信
 *   - Erlang/Akka Actor: mailbox 串行处理, 错误隔离, 监督策略
 *   - React's useReducer: 事件 → 状态映射, 但在 Actor 边界内执行
 *
 * 核心能力:
 *   1. Mailbox: 事件入队后串行处理, 消除并发 set() 竞态
 *   2. 隔离: 单个 Actor 的错误不会 crash 其他 Actor
 *   3. 生命周期: created → active → idle → stopped (可重启)
 *   4. waitFor: 等待特定条件满足, 超时自动降级
 *   5. 订阅: 外部组件可订阅 Actor 的状态变更
 *
 * 2026-07-10: P2-2 + P2-3 合并实现
 */

import type { StreamEvent, StreamEventKind, TaskPhase, RootTask } from '../types/streaming';
import type { UIPart } from '../types/messages';
import { streamEventToUIPart } from './eventToUIPart';

// ==================== Actor 生命周期 ====================

export type ActorStatus = 'created' | 'active' | 'idle' | 'error' | 'stopped';

export interface ActorStateSnapshot {
  taskId: string;
  chatId: string;
  phase: TaskPhase;
  progress: number;
  status: ActorStatus;
  /** 当前 mailbox 中待处理事件数 */
  pendingCount: number;
  /** 总处理事件数 */
  processedCount: number;
  /** 最后错误 (如果有) */
  lastError?: { message: string; timestamp: number; eventKind?: StreamEventKind };
  /** 最后处理时间 */
  lastProcessedAt: number;
}

// ==================== Mailbox 消息 ====================

interface MailboxMessage {
  event: StreamEvent;
  /** 入队时间 (用于计算延迟) */
  enqueuedAt: number;
  /** 是否已处理 */
  processed: boolean;
}

// ==================== 等待条件 ====================

export interface WaitForOptions {
  /** 超时毫秒数 */
  timeout: number;
  /** 超时后的降级行为描述 (日志用) */
  fallbackDescription?: string;
  /** 是否在超时后自动执行降级事件 */
  fallbackEvent?: StreamEvent;
}

export interface WaitForResult {
  /** 是否满足条件 */
  satisfied: boolean;
  /** 是否因超时而结束 */
  timedOut: boolean;
  /** 等待耗时 (毫秒) */
  elapsed: number;
}

// ==================== 订阅者 ====================

type StateListener = (snapshot: ActorStateSnapshot) => void;
type PartListener = (part: UIPart) => void;

// ==================== TaskActor ====================

export class TaskActor {
  readonly taskId: string;
  readonly chatId: string;

  private mailbox: MailboxMessage[] = [];
  private status: ActorStatus = 'created';
  private phase: TaskPhase;
  private progress: number = 0;
  private processedCount: number = 0;
  private lastProcessedAt: number = 0;
  private lastError?: ActorStateSnapshot['lastError'];

  private stateListeners = new Set<StateListener>();
  private partListeners = new Set<PartListener>();

  /** 是否正在 flush mailbox (防止重入) */
  private flushing = false;

  /** waitFor 等待队列 */
  private waiters: Array<{
    predicate: (snapshot: ActorStateSnapshot) => boolean;
    resolve: (result: WaitForResult) => void;
    startTime: number;
    timeoutId: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(taskId: string, chatId: string, initialPhase: TaskPhase = 'CLARIFY') {
    this.taskId = taskId;
    this.chatId = chatId;
    this.phase = initialPhase;
    this.status = 'active';
  }

  // ============== Mailbox: 投递事件 ==============

  /**
   * 投递事件到 mailbox (非阻塞)
   * 等价于 Actor 模型的 tell()
   */
  tell(event: StreamEvent): void {
    if (this.status === 'stopped') {
      // 已停止的 Actor 静默丢弃事件
      return;
    }

    this.mailbox.push({
      event,
      enqueuedAt: Date.now(),
      processed: false,
    });

    // 触发异步 flush (microtask 批处理)
    this.scheduleFlush();
  }

  /**
   * 投递事件并等待结果 (阻塞 Promise)
   * 等价于 Actor 模型的 ask()
   */
  ask(event: StreamEvent, options: WaitForOptions): Promise<WaitForResult> {
    this.tell(event);
    // 等待下一个状态快照满足条件
    return this.waitFor(
      (snapshot) => snapshot.processedCount > this.processedCount,
      options,
    );
  }

  // ============== Mailbox: flush 处理 ==============

  private scheduleFlush(): void {
    if (this.flushing) return; // 已有 flush 在排程中
    // 使用 queueMicrotask 批量处理, 避免每个事件都触发同步 flush
    queueMicrotask(() => this.flush());
  }

  /**
   * 串行处理 mailbox 中所有待处理事件
   * 关键: 事件处理是同步串行的, 消除并发 set() 竞态
   */
  private flush(): void {
    if (this.flushing) return;
    if (this.mailbox.length === 0) return;
    this.flushing = true;

    try {
      while (this.mailbox.length > 0) {
        const msg = this.mailbox.shift()!;
        if (msg.processed) continue;

        try {
          this.processEvent(msg.event);
          msg.processed = true;
          this.processedCount++;
          this.lastProcessedAt = Date.now();
        } catch (err) {
          // Actor 级错误隔离: 单个事件处理失败不 crash 整个 Actor
          // 记录错误, 标记消息已处理, 继续处理下一条
          this.lastError = {
            message: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
            eventKind: msg.event.kind,
          };
          msg.processed = true;
          this.processedCount++;
          this.lastProcessedAt = Date.now();

          // 如果是 error 类事件, 标记 Actor 为 error 状态
          if (msg.event.kind === 'error') {
            this.status = 'error';
          }
        }
      }

      // 所有消息处理完毕, 如果 Actor 不是 error/stopped 状态则回到 idle
      if (this.status === 'active' && this.mailbox.length === 0) {
        this.status = 'idle';
      }
    } finally {
      this.flushing = false;
    }

    // 通知订阅者
    this.notifyStateListeners();
  }

  /**
   * 处理单个事件 — 子类/外部可覆盖
   * 默认行为: 转换为 UIPart 并通知 part 订阅者
   */
  protected processEvent(event: StreamEvent): void {
    // 跟踪 phase 变化
    if (event.kind === 'phase_change') {
      const newPhase = event.content as TaskPhase;
      this.phase = newPhase;
    }

    // 跟踪 progress 变化
    if (event.progress !== undefined) {
      this.progress = event.progress;
    }

    // error 事件 → 标记 Actor 为 error 状态
    if (event.kind === 'error') {
      this.status = 'error';
    }

    // 转换为 UIPart
    const part = streamEventToUIPart(event, this.phase);
    if (part) {
      this.notifyPartListeners(part);
    }

    // 标记为 active (有事件到来, 但不覆盖 error 状态)
    if (this.status === 'idle') {
      this.status = 'active';
    }
  }

  // ============== waitFor: 条件等待 + 超时降级 ==============

  /**
   * 等待特定条件满足
   * 超时后自动执行降级事件 (如果配置了 fallbackEvent)
   *
   * @example
   * // 等待进入 REVIEWING 阶段, 30秒超时后跳过审查
   * actor.waitFor(
   *   (s) => s.phase === 'REVIEWING',
   *   { timeout: 30000, fallbackDescription: '审查超时, 跳过审查', fallbackEvent: { ... } }
   * ).then(result => {
   *   if (result.timedOut) console.log('审查已跳过');
   * });
   */
  waitFor(
    predicate: (snapshot: ActorStateSnapshot) => boolean,
    options: WaitForOptions,
  ): Promise<WaitForResult> {
    return new Promise<WaitForResult>((resolve) => {
      const startTime = Date.now();

      // 先检查当前状态是否已满足
      const currentSnapshot = this.getSnapshot();
      if (predicate(currentSnapshot)) {
        resolve({ satisfied: true, timedOut: false, elapsed: 0 });
        return;
      }

      const timeoutId = setTimeout(() => {
        // 超时: 从等待队列中移除
        const idx = this.waiters.findIndex(w => w.timeoutId === timeoutId);
        if (idx >= 0) this.waiters.splice(idx, 1);

        // 执行降级事件
        if (options.fallbackEvent) {
          this.tell(options.fallbackEvent);
        }

        resolve({
          satisfied: false,
          timedOut: true,
          elapsed: Date.now() - startTime,
        });
      }, options.timeout);

      this.waiters.push({
        predicate,
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        startTime,
        timeoutId,
      });
    });
  }

  // ============== 订阅 ==============

  /** 订阅 Actor 状态变更 */
  subscribeState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    // 立即推送当前快照
    listener(this.getSnapshot());
    return () => this.stateListeners.delete(listener);
  }

  /** 订阅 Actor 产生的 UIPart */
  subscribeParts(listener: PartListener): () => void {
    this.partListeners.add(listener);
    return () => this.partListeners.delete(listener);
  }

  private notifyStateListeners(): void {
    const snapshot = this.getSnapshot();

    // 检查 waiters
    const satisfied: typeof this.waiters = [];
    this.waiters = this.waiters.filter(w => {
      if (w.predicate(snapshot)) {
        satisfied.push(w);
        return false;
      }
      return true;
    });

    for (const w of satisfied) {
      w.resolve({ satisfied: true, timedOut: false, elapsed: Date.now() - w.startTime });
    }

    // 通知外部订阅者
    for (const listener of this.stateListeners) {
      listener(snapshot);
    }
  }

  private notifyPartListeners(part: UIPart): void {
    for (const listener of this.partListeners) {
      try {
        listener(part);
      } catch {
        // 订阅者错误不影响 Actor
      }
    }
  }

  // ============== 快照 ==============

  getSnapshot(): ActorStateSnapshot {
    return {
      taskId: this.taskId,
      chatId: this.chatId,
      phase: this.phase,
      progress: this.progress,
      status: this.status,
      pendingCount: this.mailbox.length,
      processedCount: this.processedCount,
      lastError: this.lastError,
      lastProcessedAt: this.lastProcessedAt,
    };
  }

  // ============== 生命周期管理 ==============

  /** 停止 Actor (不再接受新事件) */
  stop(): void {
    this.status = 'stopped';
    this.mailbox = [];
    this.waiters.forEach(w => {
      clearTimeout(w.timeoutId);
      w.resolve({ satisfied: false, timedOut: true, elapsed: Date.now() - w.startTime });
    });
    this.waiters = [];
    this.stateListeners.clear();
    this.partListeners.clear();
  }

  /** 重启 Actor (从 error 状态恢复) */
  restart(): void {
    this.status = 'active';
    this.lastError = undefined;
    this.notifyStateListeners();
  }

  /** 同步注入初始状态 (从持久化恢复时用) */
  restoreFromSnapshot(snapshot: ActorStateSnapshot): void {
    this.phase = snapshot.phase;
    this.progress = snapshot.progress;
    this.processedCount = snapshot.processedCount;
    this.lastProcessedAt = snapshot.lastProcessedAt;
    this.lastError = snapshot.lastError;
    this.status = snapshot.status === 'stopped' ? 'active' : snapshot.status;
  }
}

// ==================== TaskActorSystem ====================

/**
 * Actor 系统: 管理所有 TaskActor 的生命周期
 * 一个 chatId 对应一个 Actor, Actor 之间完全隔离
 */
export class TaskActorSystem {
  private actors = new Map<string, TaskActor>(); // taskId → Actor
  private chatToTask = new Map<string, string>(); // chatId → taskId (活跃)

  private stateListeners = new Set<(taskId: string, snapshot: ActorStateSnapshot) => void>();

  /** 创建新 Actor */
  createActor(taskId: string, chatId: string, initialPhase?: TaskPhase): TaskActor {
    // 同 chatId 若有旧 Actor, 先停止
    const oldTaskId = this.chatToTask.get(chatId);
    if (oldTaskId) {
      this.stopActor(oldTaskId);
    }

    const actor = new TaskActor(taskId, chatId, initialPhase);
    this.actors.set(taskId, actor);
    this.chatToTask.set(chatId, taskId);

    return actor;
  }

  /** 获取 Actor by taskId */
  getActor(taskId: string): TaskActor | undefined {
    return this.actors.get(taskId);
  }

  /** 获取活跃 Actor by chatId */
  getActorByChat(chatId: string): TaskActor | undefined {
    const taskId = this.chatToTask.get(chatId);
    if (!taskId) return undefined;
    return this.actors.get(taskId);
  }

  /** 投递事件到指定 chatId 的 Actor */
  tell(chatId: string, event: StreamEvent): boolean {
    const actor = this.getActorByChat(chatId);
    if (!actor) return false;
    actor.tell(event);
    return true;
  }

  /** 停止指定 Actor */
  stopActor(taskId: string): void {
    const actor = this.actors.get(taskId);
    if (!actor) return;
    actor.stop();
    this.actors.delete(taskId);
    // 清理 chatToTask 映射
    for (const [chatId, tid] of this.chatToTask) {
      if (tid === taskId) {
        this.chatToTask.delete(chatId);
        break;
      }
    }
  }

  /** 停止指定 chatId 的 Actor */
  stopActorByChat(chatId: string): void {
    const taskId = this.chatToTask.get(chatId);
    if (taskId) this.stopActor(taskId);
  }

  /** 获取所有活跃 Actor 的快照 */
  getAllSnapshots(): ActorStateSnapshot[] {
    return Array.from(this.actors.values()).map(a => a.getSnapshot());
  }

  /** 订阅所有 Actor 的状态变更 */
  subscribeAll(listener: (taskId: string, snapshot: ActorStateSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** 清理所有 Actor (测试/重置用) */
  reset(): void {
    for (const actor of this.actors.values()) {
      actor.stop();
    }
    this.actors.clear();
    this.chatToTask.clear();
  }
}

// ==================== 单例导出 ====================

export const taskActorSystem = new TaskActorSystem();
