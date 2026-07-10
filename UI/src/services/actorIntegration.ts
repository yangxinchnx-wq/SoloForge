/**
 * actorIntegration — TaskActor 系统与 streamingStore 的集成层
 *
 * 设计目标:
 *   1. streamingStore 保持向后兼容 (现有组件无需改动)
 *   2. 新的 Actor 系统并行运行, 提供 mailbox 串行处理 + 错误隔离
 *   3. 事件投递: applyEvent → streamingStore.dispatch + actor.tell (双写)
 *   4. 状态同步: Actor 状态变更 → 可选回调 → streamingStore (单向)
 *   5. 持久化: 定期自动保存到 localStorage + IndexedDB
 *
 * 2026-07-10: P3-2 + P3-3 集成层
 */

import { useEffect, useRef, useState } from 'react';
import type { StreamEvent, RootTask, PermissionMode, SubAgent } from '../types/streaming';
import { useStreamingStore } from '../state/streamingStore';
import { taskActorSystem, type ActorStateSnapshot } from './taskActor';
import { taskActorSupervisor, type ActorErrorEvent } from './supervisorStrategy';
import { streamPersistence } from './streamPersistence';
import { uiMessageStore } from './uiMessageStore';

// ==================== 初始化 (应用启动时调用) ====================

let initialized = false;

/**
 * 初始化 Actor 系统 + 持久化 + 监督策略
 * 在应用启动 (bootstrap) 时调用一次
 */
export async function initActorSystem(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // 1. 初始化持久化层
  await streamPersistence.init();

  // 2. 设置监督策略: 错误事件通知 UI
  taskActorSupervisor.onError((event: ActorErrorEvent) => {
    // 将 Actor 错误转换为 StreamEvent, 投递到 streamingStore
    if (event.decision.action === 'stop') {
      // Actor 已停止, 标记任务为 ERROR
      const errorEvent: StreamEvent = {
        id: `actor-error-${event.timestamp}`,
        chatId: event.chatId,
        rootTaskId: event.taskId,
        kind: 'error',
        content: event.message,
        detail: event.decision.reason,
        ts: event.timestamp,
        status: 'error',
      };
      useStreamingStore.getState().applyEvent(errorEvent);
    }
    // 非致命错误 (restart/resume) 不发 error 事件, Actor 会自动恢复
  });

  // 3. 从持久化恢复热状态
  const hotState = streamPersistence.restoreHotState();
  if (hotState) {
    // 恢复 tasks 到 streamingStore
    if (hotState.tasks) {
      useStreamingStore.setState(s => ({
        tasks: { ...s.tasks, ...hotState.tasks! },
      }));
    }
    // 恢复 textBuffers
    if (hotState.textBuffers) {
      useStreamingStore.setState(s => ({
        textBuffers: { ...s.textBuffers, ...hotState.textBuffers! },
      }));
    }
    // 恢复 agents
    if (hotState.agents) {
      useStreamingStore.setState(s => ({
        agentsMap: { ...s.agentsMap, ...hotState.agents! },
      }));
    }
    // 恢复 Actor 快照
    if (hotState.actorSnapshots) {
      for (const snapshot of hotState.actorSnapshots) {
        const actor = taskActorSystem.createActor(snapshot.taskId, snapshot.chatId);
        actor.restoreFromSnapshot(snapshot);
      }
    }
  }
}

// ==================== 事件投递适配器 ====================

/**
 * 增强版 applyEvent: 同时投递到 streamingStore 和 TaskActor
 *
 * 使用方式:
 *   旧代码: useStreamingStore.getState().applyEvent(event)
 *   新代码: dispatchStreamEvent(event)
 *
 * 行为:
 *   1. streamingStore.applyEvent (向后兼容, 立即执行)
 *   2. taskActorSystem.tell (mailbox 排队, 微任务异步处理)
 *   3. uiMessageStore.appendEventAsPart (Data Parts 模式)
 *   4. streamPersistence.appendEvents (持久化日志)
 */
export function dispatchStreamEvent(event: StreamEvent): void {
  // 1. 旧 store 同步处理 (向后兼容)
  useStreamingStore.getState().applyEvent(event);

  // 2. Actor 系统异步处理 (mailbox 串行)
  taskActorSystem.tell(event.chatId, event);

  // 3. Data Parts: 追加到 uiMessageStore
  const task = useStreamingStore.getState().tasks[event.chatId];
  if (task) {
    // 找到或创建 assistant 消息
    let lastMsg = uiMessageStore.getLastAssistantMessage(event.chatId);
    if (!lastMsg) {
      lastMsg = uiMessageStore.createMessage(
        event.chatId,
        'assistant',
        task.id,
      );
    }
    // text_chunk 特殊处理: 累积到 text part
    if (event.kind === 'text_chunk') {
      uiMessageStore.appendTextChunk(
        event.chatId,
        lastMsg.id,
        event.content,
        event.status === 'running',
      );
    } else {
      uiMessageStore.appendEventAsPart(
        event.chatId,
        lastMsg.id,
        event,
        task.phase,
      );
    }
  }

  // 4. 持久化 (异步, 不阻塞)
  streamPersistence.appendEvents(event.chatId, [event]).catch(() => {
    // 持久化失败不影响主流程
  });
}

// ==================== 任务创建适配器 ====================

/**
 * 增强版 createTask: 同时创建 Actor + 初始化持久化
 */
export function createTaskWithActor(
  chatId: string,
  userInput: string,
  mode: PermissionMode,
): RootTask {
  // 1. 旧 store 创建任务
  const task = useStreamingStore.getState().createTask(chatId, userInput, mode);

  // 2. 创建 Actor
  taskActorSystem.createActor(task.id, chatId, task.phase);

  // 3. 创建 assistant UIMessage
  uiMessageStore.createMessage(chatId, 'assistant', task.id);

  // 4. 立即持久化
  streamPersistence.scheduleFlush({
    tasks: useStreamingStore.getState().tasks,
  });

  return task;
}

// ==================== React Hooks ====================

/**
 * useActorState — 订阅指定 chatId 的 Actor 状态
 * 使用 useState 确保状态变更触发重渲染 (useRef 不会触发重渲染)
 */
export function useActorState(chatId: string | null | undefined): ActorStateSnapshot | null {
  const [snapshot, setSnapshot] = useState<ActorStateSnapshot | null>(null);

  useEffect(() => {
    if (!chatId) {
      setSnapshot(null);
      return;
    }
    const actor = taskActorSystem.getActorByChat(chatId);
    if (!actor) {
      setSnapshot(null);
      return;
    }

    // subscribeState 立即推送当前快照, 后续每次 flush 都会推送
    const unsubscribe = actor.subscribeState((snap) => {
      setSnapshot(snap);
    });
    return unsubscribe;
  }, [chatId]);

  return snapshot;
}

/**
 * useAutoPersist — 自动持久化 streamingStore 状态
 * 在 StreamPanel 或顶层组件挂载时使用
 */
export function useAutoPersist(chatId: string | null): void {
  const flushCounter = useRef(0);

  useEffect(() => {
    if (!chatId) return;

    // 订阅 store 变化, 节流写入
    const unsubscribe = useStreamingStore.subscribe((state) => {
      const task = state.tasks[chatId];
      if (!task) return;

      flushCounter.current++;
      // 每 10 次变化触发一次持久化 (或由 scheduleFlush 的节流控制)
      if (flushCounter.current % 10 === 0) {
        streamPersistence.scheduleFlush({
          tasks: state.tasks,
          textBuffers: state.textBuffers,
          agents: state.agentsMap,
        });
      }
    });

    return unsubscribe;
  }, [chatId]);

  // 页面卸载时强制写入
  useEffect(() => {
    const handler = () => {
      streamPersistence.flushNow();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
}

/**
 * useActorErrors — 订阅 Actor 错误事件 (用于 UI 通知)
 * 使用 useState 确保新错误触发重渲染
 */
export function useActorErrors(): ActorErrorEvent[] {
  const [errors, setErrors] = useState<ActorErrorEvent[]>([]);

  useEffect(() => {
    const unsubscribe = taskActorSupervisor.onError((event) => {
      setErrors(prev => [...prev, event]);
    });
    return unsubscribe;
  }, []);

  return errors;
}

// ==================== 清理适配器 ====================

/**
 * 增强版 clearChat: 同时清理 Actor + 持久化 + uiMessageStore
 */
export function clearChatAll(chatId: string): void {
  // 1. 旧 store 清理
  useStreamingStore.getState().clearChat(chatId);

  // 2. 停止 Actor
  taskActorSystem.stopActorByChat(chatId);

  // 3. 清理 uiMessageStore
  uiMessageStore.clearChat(chatId);

  // 4. 清理持久化
  streamPersistence.clearChat(chatId).catch(() => {
    // 清理失败不影响主流程
  });
}
