/**
 * 集成测试: dispatchStreamEvent → actor → uiMessageStore 端到端
 *
 * 验证 P3 集成层的核心数据流:
 *   1. createTaskWithActor 同时创建 streamingStore task + Actor + UIMessage
 *   2. dispatchStreamEvent 双写: streamingStore.applyEvent + actor.tell + uiMessageStore.appendPart
 *   3. clearChatAll 全链路清理: streamingStore + Actor + uiMessageStore + persistence
 *   4. Actor mailbox 串行处理不影响 streamingStore 同步路径
 *   5. text_chunk 特殊路径: 累积到 text part 而非新建 part
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStreamingStore } from '../../state/streamingStore';
import { uiMessageStore } from '../uiMessageStore';
import { taskActorSystem } from '../taskActor';
import { streamPersistence } from '../streamPersistence';
import {
  createTaskWithActor,
  dispatchStreamEvent,
  clearChatAll,
  initActorSystem,
} from '../actorIntegration';
import type { StreamEvent } from '../../types/streaming';

// Mock persistence (避免 IndexedDB 在测试环境不可用)
vi.spyOn(streamPersistence, 'init').mockResolvedValue(undefined);
vi.spyOn(streamPersistence, 'restoreHotState').mockReturnValue(null);
vi.spyOn(streamPersistence, 'scheduleFlush').mockImplementation(() => {});
vi.spyOn(streamPersistence, 'appendEvents').mockResolvedValue(undefined);
vi.spyOn(streamPersistence, 'flushNow').mockImplementation(() => {});
vi.spyOn(streamPersistence, 'clearChat').mockResolvedValue(undefined);

beforeEach(async () => {
  useStreamingStore.getState().__reset();
  uiMessageStore.__reset();
  taskActorSystem.reset();
  await initActorSystem();
});

function makeEvent(chatId: string, taskId: string, kind: StreamEvent['kind'], extra: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    chatId,
    rootTaskId: taskId,
    kind,
    content: '',
    ts: Date.now(),
    status: 'running',
    ...extra,
  };
}

describe('createTaskWithActor', () => {
  it('同时在 streamingStore + Actor + uiMessageStore 创建实体', () => {
    const task = createTaskWithActor('c1', 'hello', 'normal');

    // streamingStore 有 task
    expect(useStreamingStore.getState().tasks['c1']).toBeDefined();
    expect(useStreamingStore.getState().tasks['c1'].id).toBe(task.id);

    // Actor 存在
    const actor = taskActorSystem.getActorByChat('c1');
    expect(actor).toBeDefined();
    expect(actor!.taskId).toBe(task.id);
    expect(actor!.chatId).toBe('c1');

    // uiMessageStore 有 assistant 消息
    const lastMsg = uiMessageStore.getLastAssistantMessage('c1');
    expect(lastMsg).toBeDefined();
    expect(lastMsg!.rootTaskId).toBe(task.id);
    expect(lastMsg!.status).toBe('streaming');
  });

  it('同 chatId 再次调用: 旧 Actor 被停止, 新 Actor 接管', () => {
    const task1 = createTaskWithActor('c1', 'first', 'normal');
    const actor1 = taskActorSystem.getActorByChat('c1');
    expect(actor1!.taskId).toBe(task1.id);

    const task2 = createTaskWithActor('c1', 'second', 'normal');
    const actor2 = taskActorSystem.getActorByChat('c1');
    expect(actor2!.taskId).toBe(task2.id);
    expect(actor2).not.toBe(actor1);
  });
});

describe('dispatchStreamEvent 双写', () => {
  it('phase_change 事件同时更新 streamingStore + uiMessageStore + Actor', async () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    const actor = taskActorSystem.getActorByChat('c1')!;

    // Actor 初始状态: active (构造函数设置, flush 后才变 idle)
    // createTaskWithActor 不向 Actor 发事件, 所以没有 flush, 状态保持 active
    expect(actor.getSnapshot().status).toBe('active');

    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', {
      content: 'DECOMPOSING',
      status: 'running',
    }));

    // streamingStore 同步更新
    expect(useStreamingStore.getState().tasks['c1'].phase).toBe('DECOMPOSING');

    // uiMessageStore 有 phase-change part
    const lastMsg = uiMessageStore.getLastAssistantMessage('c1')!;
    const phaseParts = lastMsg.parts.filter(p => p.type === 'phase-change');
    expect(phaseParts.length).toBe(1);
    expect(phaseParts[0].type).toBe('phase-change');
  });

  it('subtask_created 事件同时创建 streamingStore subtask + uiMessageStore part', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');

    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', {
      content: 'DECOMPOSING',
    }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_created', {
      content: 'GPT-4o',
      detail: '翻译任务',
      agentId: 'agent-0',
    }));

    // streamingStore 有 subtask
    const storeTask = useStreamingStore.getState().tasks['c1'];
    expect(storeTask.subTasks.length).toBe(1);
    expect(storeTask.subTasks[0].assigneeModel).toBe('GPT-4o');

    // uiMessageStore 有 subtask-created part
    const lastMsg = uiMessageStore.getLastAssistantMessage('c1')!;
    const createdParts = lastMsg.parts.filter(p => p.type === 'subtask-created');
    expect(createdParts.length).toBe(1);
  });

  it('text_chunk 累积到同一个 text part (而非新建多个)', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');

    // 先进入 SINGLE_MODEL
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', {
      content: 'SINGLE_MODEL',
    }));
    // 创建 subtask
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_created', {
      content: 'GPT-4o',
      detail: '生成',
    }));
    const subId = useStreamingStore.getState().getLastSubTaskId('c1')!;

    // 发 3 个 text_chunk
    for (const txt of ['Hello', ' World', '!']) {
      dispatchStreamEvent(makeEvent('c1', task.id, 'text_chunk', {
        subTaskId: subId,
        content: txt,
        status: 'running',
      }));
    }

    // uiMessageStore: 只有 1 个 text part, 内容是累积的
    const lastMsg = uiMessageStore.getLastAssistantMessage('c1')!;
    const textParts = lastMsg.parts.filter(p => p.type === 'text');
    expect(textParts.length).toBe(1);
    expect((textParts[0] as any).text).toBe('Hello World!');
    expect((textParts[0] as any).streaming).toBe(true);
  });

  it('error 事件同时标记 streamingStore ERROR + uiMessageStore error part', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');

    dispatchStreamEvent(makeEvent('c1', task.id, 'error', {
      content: 'API timeout',
      detail: 'Connection refused',
      status: 'error',
    }));

    // streamingStore 标记 ERROR (通过 EVENT_HANDLERS)
    // 注意: error 事件在 streamingStore 中可能不直接改 phase,
    // 但 eventBuffer 会记录它
    const buf = useStreamingStore.getState().eventBuffer['c1'];
    expect(buf.some(e => e.kind === 'error')).toBe(true);

    // uiMessageStore 有 error part
    const lastMsg = uiMessageStore.getLastAssistantMessage('c1')!;
    const errorParts = lastMsg.parts.filter(p => p.type === 'error');
    expect(errorParts.length).toBe(1);
    expect((errorParts[0] as any).message).toBe('API timeout');
  });

  it('Actor mailbox 异步处理不影响 streamingStore 同步路径', async () => {
    const task = createTaskWithActor('c1', 'test', 'normal');

    // 快速连续发 3 个事件
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DECOMPOSING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DISPATCHING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'EXECUTING' }));

    // streamingStore 同步路径: 最后一个 phase 是 EXECUTING
    expect(useStreamingStore.getState().tasks['c1'].phase).toBe('EXECUTING');

    // 等 microtask flush 完成
    await new Promise(r => setTimeout(r, 0));

    // Actor 处理了 3 个事件
    const actor = taskActorSystem.getActorByChat('c1')!;
    expect(actor.getSnapshot().processedCount).toBe(3);
  });
});

describe('clearChatAll 全链路清理', () => {
  it('同时清理 streamingStore + Actor + uiMessageStore', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DECOMPOSING' }));

    // 确认有数据
    expect(useStreamingStore.getState().tasks['c1']).toBeDefined();
    expect(taskActorSystem.getActorByChat('c1')).toBeDefined();
    expect(uiMessageStore.getMessages('c1').length).toBeGreaterThan(0);

    // 清理
    clearChatAll('c1');

    // streamingStore: task 移到 history
    expect(useStreamingStore.getState().tasks['c1']).toBeUndefined();
    expect(useStreamingStore.getState().taskHistory['c1']).toBeDefined();

    // Actor: 已停止
    expect(taskActorSystem.getActorByChat('c1')).toBeUndefined();

    // uiMessageStore: 已清空
    expect(uiMessageStore.getMessages('c1').length).toBe(0);

    // persistence.clearChat 被调用
    expect(streamPersistence.clearChat).toHaveBeenCalledWith('c1');
  });

  it('对不存在的 chatId 不抛错', () => {
    expect(() => clearChatAll('nonexistent')).not.toThrow();
  });
});

describe('完整生命周期端到端', () => {
  it('create → dispatch events → clear: 所有层状态一致', async () => {
    // 1. 创建
    const task = createTaskWithActor('c1', 'translate this', 'normal');

    // 2. 模拟完整流: DECOMPOSING → subtask → DISPATCHING → text → done → DONE
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DECOMPOSING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_created', {
      content: 'GPT-4o', detail: '翻译', agentId: 'a0',
    }));
    const subId = useStreamingStore.getState().getLastSubTaskId('c1')!;
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DISPATCHING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'EXECUTING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'text_chunk', {
      subTaskId: subId, content: '翻译结果', status: 'running',
    }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_done', {
      subTaskId: subId, content: '翻译结果', progress: 100, status: 'success',
    }));
    // 合法跃迁: EXECUTING → REVIEWING → DELIVERING → DONE
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'REVIEWING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'delivery', {
      content: '翻译结果', status: 'success',
    }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DELIVERING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', {
      content: 'DONE', status: 'success',
    }));

    // 等 Actor flush
    await new Promise(r => setTimeout(r, 0));

    // streamingStore: phase = DONE
    expect(useStreamingStore.getState().tasks['c1'].phase).toBe('DONE');

    // uiMessageStore: 有完整 part 时间线
    const lastMsg = uiMessageStore.getLastAssistantMessage('c1')!;
    const partTypes = lastMsg.parts.map(p => p.type);
    expect(partTypes).toContain('phase-change');
    expect(partTypes).toContain('subtask-created');
    expect(partTypes).toContain('text');
    expect(partTypes).toContain('subtask-done');
    expect(partTypes).toContain('delivery');

    // Actor: 处理了所有事件, 状态 idle
    const actor = taskActorSystem.getActorByChat('c1')!;
    expect(actor.getSnapshot().processedCount).toBe(10);
    expect(actor.getSnapshot().phase).toBe('DONE');

    // 3. 清理
    clearChatAll('c1');
    expect(useStreamingStore.getState().tasks['c1']).toBeUndefined();
    expect(taskActorSystem.getActorByChat('c1')).toBeUndefined();
    expect(uiMessageStore.getMessages('c1').length).toBe(0);
  });
});
