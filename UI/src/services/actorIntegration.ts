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
import type { StreamEvent, PermissionMode, SubAgent, TaskPhase, PromptCardSpec } from '../types/streaming';
import type { UIPhaseChangePart } from '../types/messages';
import { useStreamingStore } from '../state/streamingStore';
import { taskActorSystem, type ActorStateSnapshot } from './taskActor';
import { taskActorSupervisor, type ActorErrorEvent } from './supervisorStrategy';
import { streamPersistence } from './streamPersistence';
import { uiMessageStore } from './uiMessageStore';
import { promptCardPool } from './promptCardPool';
import { createTaskMachineActor, type Actor as XstateActor, type TaskMachineSnapshot } from './taskMachine';

// ==================== 初始化 (应用启动时调用) ====================

let initialized = false;

// P2: taskMachine actor 存储 (chatId → xstate actor)
// 作为声明式 phase 跟踪器, 与 streamingStore.transitionTaskPhase 并行运行
// 用于: 调试/监控/未来迁移到 FSM 单一数据源
const taskMachineActors = new Map<string, XstateActor<typeof import('./taskMachine').taskMachine>>();

/**
 * 获取指定 chatId 的 taskMachine actor 快照 (调试/监控用)
 * 返回 undefined 表示该 chat 未创建 actor
 */
export function getTaskMachineSnapshot(chatId: string): TaskMachineSnapshot | undefined {
  const actor = taskMachineActors.get(chatId);
  return actor?.getSnapshot();
}

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
    // 将 Actor 错误转换为 StreamEvent, 投递到 uiMessageStore
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
      dispatchStreamEvent(errorEvent);
    }
    // 非致命错误 (restart/resume) 不发 error 事件, Actor 会自动恢复
  });

  // 3. 从持久化恢复热状态
  const hotState = streamPersistence.restoreHotState();
  if (hotState) {
    // P0: 恢复 uiMessageStore messages (替代 streamingStore.tasks + textBuffers)
    if ((hotState as any).messages) {
      for (const [chatId, msgs] of Object.entries((hotState as any).messages)) {
        uiMessageStore.deserialize(chatId, JSON.stringify(msgs));
      }
    }
    // 恢复 agents (控制流字段, 保留)
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
 * 事件分发: 投递到 TaskActor + uiMessageStore + 持久化
 *
 * 使用方式:
 *   dispatchStreamEvent(event)
 *
 * 行为:
 *   1. promptCardPool 直投 (clarify_request / browser_enable_request / tool_suggestion)
 *   2. taskActorSystem.tell (mailbox 排队, 微任务异步处理)
 *   3. uiMessageStore.appendEventAsPart (Data Parts 模式)
 *   4. streamPersistence.appendEvents (持久化日志)
 */
export function dispatchStreamEvent(event: StreamEvent): void {
  const meta = useStreamingStore.getState().getStreamTaskMeta(event.chatId);

  // 1. promptCardPool 直投 (原由 applyEvent handler 处理, 现直接调用)
  if (meta) {
    handlePromptCardEvent(event, meta.mode);
  }

  // 1.5. subtask_created: 自动创建 SubAgent 入池
  // Java 链路: agentId 是真实 agent id (如 "code_agent"), name 是中文显示名 (如 "代码工程师")
  // RACER 链路不进流送区 (aiBackend 已阻断 phase 事件), 所以这里只处理 Java 链路的 subtask
  if (event.kind === 'subtask_created' && event.agentId) {
    const store = useStreamingStore.getState();
    const existing = store.getAgents(event.chatId).find(a => a.id === event.agentId);
    if (!existing) {
      const agent: SubAgent = {
        id: event.agentId,
        chatId: event.chatId,
        name: event.detail || event.agentId, // detail 字段带 Java 传来的 agent 中文 name
        avatar: event.avatar,                 // Java 传来的 emoji 或图片 URL
        role: 'assistant',
        parentModelId: meta?.rootTaskId ?? '',
        reputation: 0.5,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      store.addAgent(event.chatId, agent);
    } else if (existing && event.avatar && existing.avatar !== event.avatar) {
      // 已存在但 avatar 变了 (用户在设置页改了头像) → 更新
      store.renameAgent(event.chatId, event.agentId, existing.name, event.avatar);
    }
  }

  // 2. Actor 系统异步处理 (mailbox 串行)
  taskActorSystem.tell(event.chatId, event);

  // 3. Data Parts: 追加到 uiMessageStore
  const rootTaskId = meta?.rootTaskId;
  if (rootTaskId) {
    // 找到或创建 assistant 消息
    let lastMsg = uiMessageStore.getLastAssistantMessage(event.chatId);
    if (!lastMsg) {
      lastMsg = uiMessageStore.createMessage(
        event.chatId,
        'assistant',
        rootTaskId,
      );
    }
    // text_chunk 特殊处理: 累积到 text part (已直接产 Part, 不经 eventToUIPart)
    if (event.kind === 'text_chunk') {
      uiMessageStore.appendTextChunk(
        event.chatId,
        lastMsg.id,
        event.content,
        event.status === 'running',
      );
    } else if (event.kind === 'phase_change') {
      // P1低风险: phase_change 直接构造 UIPart (不经 eventToUIPart, 示范后端直产 Part 路径)
      const prevPhase = derivePhaseFromLastMessage(lastMsg);
      const part: UIPhaseChangePart = {
        type: 'phase-change',
        from: prevPhase ?? 'CLARIFY',
        to: event.content as TaskPhase,
        detail: event.detail,
        timestamp: event.ts,
      };
      uiMessageStore.appendPart(event.chatId, lastMsg.id, part);
      // P2: 同步 send 给 taskMachine actor (声明式 FSM 跟踪, 非法跃迁 actor 自动忽略)
      const machineActor = taskMachineActors.get(event.chatId);
      if (machineActor) {
        machineActor.send({ type: 'PHASE_CHANGE', to: event.content as TaskPhase, detail: event.detail });
      }
    } else if (event.kind === 'error') {
      // 其余事件类型仍走 eventToUIPart 桥接 (纯函数, 零开销)
      const prevPhase = derivePhaseFromLastMessage(lastMsg);
      uiMessageStore.appendEventAsPart(
        event.chatId,
        lastMsg.id,
        event,
        prevPhase,
      );
      // P2: error 事件同步 send 给 taskMachine actor (除 DONE/ERROR 外都可转 ERROR)
      const machineActor = taskMachineActors.get(event.chatId);
      if (machineActor) {
        machineActor.send({ type: 'ERROR', message: event.content, detail: event.detail });
      }
    } else {
      // 其余事件类型仍走 eventToUIPart 桥接 (纯函数, 零开销)
      const prevPhase = derivePhaseFromLastMessage(lastMsg);
      uiMessageStore.appendEventAsPart(
        event.chatId,
        lastMsg.id,
        event,
        prevPhase,
      );
    }
  }

  // 4. 持久化 (异步, 不阻塞)
  streamPersistence.appendEvents(event.chatId, [event]).catch(() => {
    // 持久化失败不影响主流程
  });
}

/**
 * 处理需要 promptCardPool 的事件 (原 applyEvent handler 逻辑)
 * 从 dispatchStreamEvent 调用, mode 从 streamTaskMeta 获取
 */
function handlePromptCardEvent(event: StreamEvent, mode: PermissionMode): void {
  if (event.kind === 'clarify_request') {
    const spec: PromptCardSpec = {
      id: `clarify-${event.id}`,
      type: 'clarification',
      title: '需要你补充信息',
      message: event.content,
      countdown: event.detail?.includes('urgent') ? 30 : 120,
      options: [
        { id: 'answer', label: '回答', action: { kind: 'custom', payload: { chatId: event.chatId } }, isRecommended: true },
        { id: 'skip', label: '跳过', action: { kind: 'skip' } },
      ],
      defaultAction: { kind: 'skip' },
      context: { chatId: event.chatId, eventId: event.id },
      priority: 'blocking',
    };
    promptCardPool.upsert(spec, mode);
  } else if (event.kind === 'browser_enable_request') {
    const spec: PromptCardSpec = {
      id: `browser-enable-${event.id}`,
      type: 'browser_tool_enable',
      title: '启用浏览器自动化',
      message: event.content,
      countdown: 60,
      options: [
        { id: 'enable', label: '启用', action: { kind: 'accept' }, isRecommended: true },
        { id: 'skip', label: '跳过', action: { kind: 'skip' } },
      ],
      defaultAction: { kind: 'skip' },
      context: { chatId: event.chatId, url: event.detail, eventId: event.id },
      priority: 'non_blocking',
      cooldown: 30,
      groupKey: `browser-enable-${event.detail ?? 'default'}`,
    };
    promptCardPool.upsert(spec, mode);
  } else if (event.kind === 'tool_suggestion') {
    const spec: PromptCardSpec = {
      id: `tool-suggest-${event.id}`,
      type: 'tool_suggestion',
      title: `建议使用工具: ${event.content}`,
      message: event.detail ?? `模型建议使用工具 ${event.content}`,
      countdown: 90,
      options: [
        { id: 'accept', label: '使用', action: { kind: 'accept' }, isRecommended: true },
        { id: 'skip', label: '跳过', action: { kind: 'skip' } },
      ],
      defaultAction: { kind: 'skip' },
      context: { chatId: event.chatId, tool: event.content, eventId: event.id },
      priority: 'non_blocking',
      cooldown: 15,
      groupKey: `tool-suggest-${event.content}`,
    };
    promptCardPool.upsert(spec, mode);
  }
}

/**
 * P0: 从 UIMessage 的 parts 中派生最后一个 phase (替代 streamingStore.tasks[chatId].phase)
 */
function derivePhaseFromLastMessage(msg: { parts: Array<{ type: string; to?: string }> } | undefined): import('../types/streaming').TaskPhase | undefined {
  if (!msg || !msg.parts) return undefined;
  for (let i = msg.parts.length - 1; i >= 0; i--) {
    const p = msg.parts[i];
    if (p.type === 'phase-change' && p.to) {
      return p.to as import('../types/streaming').TaskPhase;
    }
  }
  return undefined;
}

// ==================== 任务创建适配器 ====================

/**
 * 增强版 createTask: 同时创建 Actor + 初始化持久化
 */
export function createTaskWithActor(
  chatId: string,
  userInput: string,
  mode: PermissionMode,
): { id: string; chatId: string; phase: 'CLARIFY' } {
  // 1. store 创建任务元数据 (streamTaskMeta)
  const task = useStreamingStore.getState().createTask(chatId, userInput, mode);

  // 2. 创建 Actor (初始 phase 永远是 CLARIFY)
  taskActorSystem.createActor(task.id, chatId, 'CLARIFY');

  // 2.5 P2: 创建 taskMachine actor (声明式 FSM 跟踪 phase)
  const machineActor = createTaskMachineActor(task.id, chatId, 'CLARIFY');
  machineActor.start();
  taskMachineActors.set(chatId, machineActor);

  // 3. 创建 assistant UIMessage
  uiMessageStore.createMessage(chatId, 'assistant', task.id);

  // 4. 立即持久化 (P0: 持久化 uiMessageStore messages 替代 streamingStore.tasks)
  const messages = uiMessageStore.getMessages(chatId);
  streamPersistence.scheduleFlush({
    messages,
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

    // P0: 订阅 uiMessageStore 变化 (替代 streamingStore.tasks)
    // uiMessageStore.subscribe 是同步通知, 回调内读取最新 messages
    const unsubscribe = uiMessageStore.subscribe(() => {
      const messages = uiMessageStore.getMessages(chatId);
      if (messages.length === 0) return;

      flushCounter.current++;
      // 每 10 次变化触发一次持久化 (或由 scheduleFlush 的节流控制)
      if (flushCounter.current % 10 === 0) {
        streamPersistence.scheduleFlush({
          messages,
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

  // 2.5 P2: 停止 taskMachine actor 并清理
  const machineActor = taskMachineActors.get(chatId);
  if (machineActor) {
    machineActor.stop();
    taskMachineActors.delete(chatId);
  }

  // 3. 清理 uiMessageStore
  uiMessageStore.clearChat(chatId);

  // 4. 清理持久化
  streamPersistence.clearChat(chatId).catch(() => {
    // 清理失败不影响主流程
  });
}
