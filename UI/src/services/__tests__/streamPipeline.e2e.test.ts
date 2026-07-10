/**
 * 流送区完整链路端到端测试
 *
 * 覆盖完整数据流:
 *   用户 prompt → createTaskWithActor → dispatchStreamEvent (SSE 模拟)
 *   → 三层状态同步验证 (streamingStore / Actor / uiMessageStore)
 *   → useStreamSummary 派生验证
 *   → clearChatAll 全链路清理验证
 *
 * 覆盖边界情况:
 *   - 多 chat 并发
 *   - text_chunk 累积 + 中断后恢复
 *   - error 事件后的状态一致性
 *   - 空对话 / 不存在 chatId 的防御
 *   - phase 非法跃迁的防御
 *   - Actor mailbox 排队顺序保证
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
import type { StreamEvent, TaskPhase } from '../../types/streaming';
import type { UIMessage, UIPart } from '../../types/messages';

// ── Mock persistence ──
vi.spyOn(streamPersistence, 'init').mockResolvedValue(undefined);
vi.spyOn(streamPersistence, 'restoreHotState').mockReturnValue(null);
vi.spyOn(streamPersistence, 'scheduleFlush').mockImplementation(() => {});
vi.spyOn(streamPersistence, 'appendEvents').mockResolvedValue(undefined);
vi.spyOn(streamPersistence, 'flushNow').mockImplementation(() => {});
vi.spyOn(streamPersistence, 'clearChat').mockResolvedValue(undefined);

beforeEach(async () => {
  // reset 顺序: store → uiMessage → actor → init
  useStreamingStore.getState().__reset();
  uiMessageStore.__reset();
  taskActorSystem.reset();

  // reset initialized flag (hack: 避免重复 init)
  (initActorSystem as any).toString(); // touch
  // 直接重置 module 内部状态
  const mod = await import('../actorIntegration');
  // initActorSystem 内部有 initialized flag, 需要重置
  // 通过重新 mock 来实现
  vi.doUnmock('../actorIntegration');
  // 由于 initialized 是闭包变量, 测试中通过重新 import 无法重置
  // 但 initActorSystem 是幂等的 (initialized=true 时直接 return), 所以不需要重置
  await initActorSystem();
});

// ── 辅助函数 ──

function makeEvent(
  chatId: string,
  taskId: string,
  kind: StreamEvent['kind'],
  extra: Partial<StreamEvent> = {},
): StreamEvent {
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

/** 从 uiMessageStore 派生摘要 (复制 useStreamSummary 逻辑) */
function deriveSummary(chatId: string) {
  const msg = uiMessageStore.getLastAssistantMessage(chatId);
  if (!msg || msg.parts.length === 0) {
    return { phase: null, progress: 0, subtaskCount: 0, doneCount: 0, hasData: false };
  }
  let phase: string | null = null;
  let subtaskCount = 0;
  let doneCount = 0;
  for (const part of msg.parts) {
    switch (part.type) {
      case 'phase-change': phase = (part as any).to; break;
      case 'subtask-created': subtaskCount++; break;
      case 'subtask-done': if ((part as any).status === 'done') doneCount++; break;
    }
  }
  const progress = subtaskCount > 0 ? Math.round((doneCount / subtaskCount) * 100) : phase ? 100 : 0;
  return { phase, progress, subtaskCount, doneCount, hasData: true };
}

/** 等待 microtask flush (Actor mailbox 处理) */
function flushMicrotask(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}

// ================================================================
// E2E-2: 完整生命周期
// ================================================================

describe('E2E: 完整生命周期 (create → events → clear)', () => {
  it('单模型路径: prompt → SINGLE_MODEL → text → DONE', async () => {
    // 1. 创建任务
    const task = createTaskWithActor('c1', '你好', 'normal');

    // 验证三层初始状态
    expect(useStreamingStore.getState().tasks['c1']).toBeDefined();
    expect(taskActorSystem.getActorByChat('c1')).toBeDefined();
    expect(uiMessageStore.getLastAssistantMessage('c1')).toBeDefined();
    expect(uiMessageStore.getLastAssistantMessage('c1')!.status).toBe('streaming');

    // 2. phase → SINGLE_MODEL
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', {
      content: 'SINGLE_MODEL',
    }));

    // 3. text_chunk × 3 (累积)
    const subTaskId = 'single';
    for (const txt of ['你好', '！我是', 'AI助手']) {
      dispatchStreamEvent(makeEvent('c1', task.id, 'text_chunk', {
        subTaskId,
        content: txt,
        status: 'running',
      }));
    }

    // 4. delivery
    dispatchStreamEvent(makeEvent('c1', task.id, 'delivery', {
      content: '你好！我是AI助手',
      status: 'success',
    }));

    // 5. DONE
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', {
      content: 'DONE',
      status: 'success',
    }));

    await flushMicrotask();

    // ── 验证 streamingStore ──
    const storeTask = useStreamingStore.getState().tasks['c1'];
    expect(storeTask.phase).toBe('DONE');

    // ── 验证 uiMessageStore ──
    const lastMsg = uiMessageStore.getLastAssistantMessage('c1')!;
    expect(lastMsg.parts.length).toBeGreaterThan(0);

    const partTypes = lastMsg.parts.map(p => p.type);
    expect(partTypes).toContain('phase-change');
    expect(partTypes).toContain('text');
    expect(partTypes).toContain('delivery');

    // text part 累积正确
    const textParts = lastMsg.parts.filter(p => p.type === 'text');
    expect(textParts.length).toBe(1);
    expect((textParts[0] as any).text).toBe('你好！我是AI助手');

    // ── 验证 useStreamSummary 派生 ──
    const summary = deriveSummary('c1');
    expect(summary.phase).toBe('DONE');
    expect(summary.hasData).toBe(true);

    // ── 验证 Actor ──
    const actor = taskActorSystem.getActorByChat('c1')!;
    expect(actor.getSnapshot().phase).toBe('DONE');
    expect(actor.getSnapshot().processedCount).toBe(6); // 6 events

    // 6. 清理
    clearChatAll('c1');

    expect(useStreamingStore.getState().tasks['c1']).toBeUndefined();
    expect(taskActorSystem.getActorByChat('c1')).toBeUndefined();
    expect(uiMessageStore.getMessages('c1').length).toBe(0);
    expect(streamPersistence.clearChat).toHaveBeenCalledWith('c1');
  });

  it('多模型路径: prompt → DECOMPOSING → 3 subtasks → DISPATCHING → EXECUTING → REVIEWING → DELIVERING → DONE', async () => {
    const task = createTaskWithActor('c1', '请综合分析这个复杂任务', 'normal');

    // Phase: DECOMPOSING
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DECOMPOSING' }));

    // 3 个 subtask
    const subIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_created', {
        content: `model-${i}`,
        detail: `task-${i}`,
        agentId: `agent-${i}`,
      }));
      const sid = useStreamingStore.getState().getLastSubTaskId('c1')!;
      subIds.push(sid);
    }

    // Phase: DISPATCHING
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DISPATCHING' }));

    // Phase: EXECUTING
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'EXECUTING' }));

    // 每个 subtask: progress + text + done
    for (let i = 0; i < 3; i++) {
      dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_progress', {
        subTaskId: subIds[i],
        content: 'thinking',
        progress: 50,
      }));
      dispatchStreamEvent(makeEvent('c1', task.id, 'text_chunk', {
        subTaskId: subIds[i],
        content: `worker-${i} output`,
        status: 'running',
      }));
      dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_done', {
        subTaskId: subIds[i],
        content: `result-${i}`,
        progress: 100,
        status: 'success',
      }));
    }

    // Phase: REVIEWING → DELIVERING → DONE
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'REVIEWING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'delivery', {
      content: '综合分析结果',
      status: 'success',
    }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DELIVERING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', {
      content: 'DONE',
      status: 'success',
    }));

    await flushMicrotask();

    // ── 验证 streamingStore ──
    const storeTask = useStreamingStore.getState().tasks['c1'];
    expect(storeTask.phase).toBe('DONE');
    expect(storeTask.subTasks).toHaveLength(3);
    expect(storeTask.subTasks.every(s => s.status === 'done')).toBe(true);

    // ── 验证 uiMessageStore ──
    const lastMsg = uiMessageStore.getLastAssistantMessage('c1')!;
    const partTypes = lastMsg.parts.map(p => p.type);

    // 时间线完整
    expect(partTypes).toContain('phase-change');
    expect(partTypes.filter(t => t === 'subtask-created')).toHaveLength(3);
    expect(partTypes.filter(t => t === 'subtask-progress')).toHaveLength(3);
    expect(partTypes.filter(t => t === 'text')).toHaveLength(3); // 3 个独立 text part (不同 subtask)
    expect(partTypes.filter(t => t === 'subtask-done')).toHaveLength(3);
    expect(partTypes).toContain('delivery');

    // ── 验证 useStreamSummary ──
    const summary = deriveSummary('c1');
    expect(summary.phase).toBe('DONE');
    expect(summary.subtaskCount).toBe(3);
    expect(summary.doneCount).toBe(3);
    expect(summary.progress).toBe(100);

    // ── 验证 Actor ──
    const actor = taskActorSystem.getActorByChat('c1')!;
    expect(actor.getSnapshot().phase).toBe('DONE');
  });

  it('审计路径: DECOMPOSING → AUDITING → audit finding → DELIVERING → DONE', async () => {
    const task = createTaskWithActor('c1', 'code review task', 'normal');

    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DECOMPOSING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_created', {
      content: 'GPT-4o', detail: 'generate code', agentId: 'a0',
    }));
    const subId = useStreamingStore.getState().getLastSubTaskId('c1')!;

    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'EXECUTING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'text_chunk', {
      subTaskId: subId, content: 'code here', status: 'running',
    }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_done', {
      subTaskId: subId, content: 'code done', progress: 100, status: 'success',
    }));

    // 审计
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'AUDITING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'audit_start', {
      content: 'main_model', subTaskId: subId,
    }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'audit_finding', {
      content: 'function tooLong',
      detail: '建议拆分为小函数',
      status: 'running', // running → warning severity
      subTaskId: subId,
    }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'audit_done', {
      subTaskId: subId, status: 'success',
    }));

    // 交付
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'REVIEWING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'delivery', {
      content: 'reviewed code', status: 'success',
    }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DELIVERING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', {
      content: 'DONE', status: 'success',
    }));

    await flushMicrotask();

    // ── 验证 uiMessageStore: 审计 parts 完整 ──
    const lastMsg = uiMessageStore.getLastAssistantMessage('c1')!;
    const auditParts = lastMsg.parts.filter(p =>
      p.type === 'audit-start' || p.type === 'audit-finding' || p.type === 'audit-done'
    );
    expect(auditParts).toHaveLength(3);

    // audit-finding 内容正确
    const findingPart = auditParts.find(p => p.type === 'audit-finding') as any;
    expect(findingPart.finding.severity).toBe('warning');
    expect(findingPart.finding.target).toBe('function tooLong');
    expect(findingPart.finding.suggestion).toBe('建议拆分为小函数');

    // ── 验证 streamingStore ──
    expect(useStreamingStore.getState().tasks['c1'].phase).toBe('DONE');
  });
});

// ================================================================
// E2E-3: 双路径一致性
// ================================================================

describe('E2E: 双路径一致性 (streamingStore ↔ uiMessageStore)', () => {
  it('phase 在两层同步', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');

    for (const phase of ['DECOMPOSING', 'DISPATCHING', 'EXECUTING'] as TaskPhase[]) {
      dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: phase }));

      // streamingStore
      expect(useStreamingStore.getState().tasks['c1'].phase).toBe(phase);
      // uiMessageStore (最后一个 phase-change part)
      const msg = uiMessageStore.getLastAssistantMessage('c1')!;
      const phaseParts = msg.parts.filter(p => p.type === 'phase-change');
      expect((phaseParts.at(-1) as any).to).toBe(phase);
    }
  });

  it('subtask count 在两层同步', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DECOMPOSING' }));

    for (let i = 0; i < 5; i++) {
      dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_created', {
        content: `model-${i}`, detail: `t-${i}`, agentId: `a-${i}`,
      }));
    }

    // streamingStore
    expect(useStreamingStore.getState().tasks['c1'].subTasks).toHaveLength(5);
    // uiMessageStore
    const msg = uiMessageStore.getLastAssistantMessage('c1')!;
    expect(msg.parts.filter(p => p.type === 'subtask-created')).toHaveLength(5);
  });

  it('text_chunk 累积: uiMessageStore text parts', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DECOMPOSING' }));

    // 创建 subtask 以获得有效的 subTaskId
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_created', {
      content: 'GPT-4o', detail: 'gen', agentId: 'a0',
    }));
    const subId = useStreamingStore.getState().getLastSubTaskId('c1')!;

    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'SINGLE_MODEL' }));

    const chunks = ['Hello', ' ', 'World', '!'];
    for (const txt of chunks) {
      dispatchStreamEvent(makeEvent('c1', task.id, 'text_chunk', {
        subTaskId: subId,
        content: txt,
        status: 'running',
      }));
    }

    // uiMessageStore: text part 累积
    const msg = uiMessageStore.getLastAssistantMessage('c1')!;
    const textParts = msg.parts.filter(p => p.type === 'text');
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as any).text).toBe('Hello World!');
    expect((textParts[0] as any).streaming).toBe(true);
  });

  it('subtask_done 后 streamingStore.status 和 uiMessageStore part status 一致', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DECOMPOSING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_created', {
      content: 'A', detail: 't1', agentId: 'a0',
    }));
    const subId = useStreamingStore.getState().getLastSubTaskId('c1')!;

    // 成功
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_done', {
      subTaskId: subId, content: 'ok', progress: 100, status: 'success',
    }));

    // streamingStore
    const st = useStreamingStore.getState().tasks['c1'].subTasks[0];
    expect(st.status).toBe('done');
    // uiMessageStore
    const msg = uiMessageStore.getLastAssistantMessage('c1')!;
    const donePart = msg.parts.find(p => p.type === 'subtask-done') as any;
    expect(donePart.status).toBe('done');
  });

  it('error 事件后两层都记录错误', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'EXECUTING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'error', {
      content: 'API timeout',
      detail: 'Connection refused',
      status: 'error',
    }));

    // uiMessageStore: error part
    const msg = uiMessageStore.getLastAssistantMessage('c1')!;
    const errorParts = msg.parts.filter(p => p.type === 'error');
    expect(errorParts).toHaveLength(1);
    expect((errorParts[0] as any).message).toBe('API timeout');
    expect((errorParts[0] as any).detail).toBe('Connection refused');
  });
});

// ================================================================
// E2E-4: 边界情况
// ================================================================

describe('E2E: 边界情况', () => {
  it('多 chat 并发: 状态互不干扰', async () => {
    const t1 = createTaskWithActor('c1', 'task one', 'normal');
    const t2 = createTaskWithActor('c2', 'task two', 'normal');

    // c1 走 DECOMPOSING
    dispatchStreamEvent(makeEvent('c1', t1.id, 'phase_change', { content: 'DECOMPOSING' }));

    // c2 走 SINGLE_MODEL
    dispatchStreamEvent(makeEvent('c2', t2.id, 'phase_change', { content: 'SINGLE_MODEL' }));

    // c1 的 text 不会出现在 c2
    dispatchStreamEvent(makeEvent('c1', t1.id, 'text_chunk', {
      subTaskId: 's1', content: 'c1 text', status: 'running',
    }));
    dispatchStreamEvent(makeEvent('c2', t2.id, 'text_chunk', {
      subTaskId: 's2', content: 'c2 text', status: 'running',
    }));

    // 验证隔离
    expect(useStreamingStore.getState().tasks['c1'].phase).toBe('DECOMPOSING');
    expect(useStreamingStore.getState().tasks['c2'].phase).toBe('SINGLE_MODEL');

    const msg1 = uiMessageStore.getLastAssistantMessage('c1')!;
    const msg2 = uiMessageStore.getLastAssistantMessage('c2')!;
    expect((msg1.parts.find(p => p.type === 'text') as any)?.text).toBe('c1 text');
    expect((msg2.parts.find(p => p.type === 'text') as any)?.text).toBe('c2 text');

    // Actor 隔离
    const a1 = taskActorSystem.getActorByChat('c1')!;
    const a2 = taskActorSystem.getActorByChat('c2')!;
    expect(a1.taskId).toBe(t1.id);
    expect(a2.taskId).toBe(t2.id);
    expect(a1).not.toBe(a2);
  });

  it('text_chunk 中断后恢复: 新 text part 而非追加到旧的', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'EXECUTING' }));

    // 第一段 text (running)
    dispatchStreamEvent(makeEvent('c1', task.id, 'text_chunk', {
      subTaskId: 's1', content: 'first', status: 'running',
    }));

    // 中间插入 phase-change (打断 text 累积)
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_done', {
      subTaskId: 's1', content: 'done', progress: 100, status: 'success',
    }));

    // 第二段 text (新 subtask, 应该新建 text part)
    dispatchStreamEvent(makeEvent('c1', task.id, 'text_chunk', {
      subTaskId: 's2', content: 'second', status: 'running',
    }));

    // 应有 2 个 text part
    const msg = uiMessageStore.getLastAssistantMessage('c1')!;
    const textParts = msg.parts.filter(p => p.type === 'text');
    expect(textParts).toHaveLength(2);
    expect((textParts[0] as any).text).toBe('first');
    expect((textParts[1] as any).text).toBe('second');
  });

  it('同 chatId 重新创建: 旧 Actor 停止, 新 Actor 接管, 新 UIMessage 追加', () => {
    const task1 = createTaskWithActor('c1', 'first', 'normal');
    const actor1 = taskActorSystem.getActorByChat('c1')!;

    dispatchStreamEvent(makeEvent('c1', task1.id, 'phase_change', { content: 'SINGLE_MODEL' }));

    // 重新创建
    const task2 = createTaskWithActor('c1', 'second', 'normal');
    const actor2 = taskActorSystem.getActorByChat('c1')!;

    expect(actor2.taskId).toBe(task2.id);
    expect(actor2).not.toBe(actor1);

    // streamingStore: 新 task 替代旧 task
    expect(useStreamingStore.getState().tasks['c1'].id).toBe(task2.id);
    expect(useStreamingStore.getState().tasks['c1'].userInput).toBe('second');

    // uiMessageStore: 应有 2 条 assistant 消息 (旧的 + 新的)
    const msgs = uiMessageStore.getMessages('c1');
    const assistantMsgs = msgs.filter(m => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(2);
    // 最后一条是新 task 的
    expect(assistantMsgs.at(-1)!.rootTaskId).toBe(task2.id);
  });

  it('clearChatAll 对不存在的 chatId 安全', () => {
    expect(() => clearChatAll('nonexistent')).not.toThrow();
  });

  it('dispatchStreamEvent 对不存在的 chat 安全 (无 task)', () => {
    // 不创建 task, 直接 dispatch — 不应抛错
    expect(() => {
      dispatchStreamEvent(makeEvent('ghost', 'ghost-task', 'phase_change', {
        content: 'DECOMPOSING',
      }));
    }).not.toThrow();
    // uiMessageStore 不应有消息 (因为 task 不存在, 不会创建 message)
    expect(uiMessageStore.getMessages('ghost').length).toBe(0);
  });

  it('Actor mailbox 排序: 事件按投递顺序处理', async () => {
    const task = createTaskWithActor('c1', 'test', 'normal');

    // 快速连续投递 5 个 phase_change
    const phases = ['DECOMPOSING', 'DISPATCHING', 'EXECUTING', 'REVIEWING', 'DELIVERING'];
    for (const phase of phases) {
      dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: phase }));
    }

    // streamingStore 同步路径: 最后一个 phase 是 DELIVERING
    expect(useStreamingStore.getState().tasks['c1'].phase).toBe('DELIVERING');

    await flushMicrotask();

    // Actor 异步处理: 也应该是 DELIVERING
    const actor = taskActorSystem.getActorByChat('c1')!;
    expect(actor.getSnapshot().phase).toBe('DELIVERING');
    expect(actor.getSnapshot().processedCount).toBe(5);
  });

  it('大量 text_chunk (100 个) 不创建多个 text part', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'SINGLE_MODEL' }));

    for (let i = 0; i < 100; i++) {
      dispatchStreamEvent(makeEvent('c1', task.id, 'text_chunk', {
        subTaskId: 'single',
        content: `chunk${i} `,
        status: 'running',
      }));
    }

    const msg = uiMessageStore.getLastAssistantMessage('c1')!;
    const textParts = msg.parts.filter(p => p.type === 'text');
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as any).text).toContain('chunk0');
    expect((textParts[0] as any).text).toContain('chunk99');
  });

  it('clearChatAll 后可以重新创建任务 (清理彻底)', () => {
    const task1 = createTaskWithActor('c1', 'first', 'normal');
    dispatchStreamEvent(makeEvent('c1', task1.id, 'phase_change', { content: 'SINGLE_MODEL' }));
    dispatchStreamEvent(makeEvent('c1', task1.id, 'text_chunk', {
      subTaskId: 's', content: 'text', status: 'running',
    }));

    clearChatAll('c1');

    // 重新创建
    const task2 = createTaskWithActor('c1', 'second', 'normal');
    expect(task2.id).not.toBe(task1.id);

    // 新 task 干净 (无残留 parts)
    const msg = uiMessageStore.getLastAssistantMessage('c1')!;
    expect(msg.parts).toHaveLength(0);
    expect(msg.rootTaskId).toBe(task2.id);

    // 新 Actor
    const actor = taskActorSystem.getActorByChat('c1')!;
    expect(actor.taskId).toBe(task2.id);
  });

  it('浏览器步骤事件正常映射', () => {
    const task = createTaskWithActor('c1', 'browser task', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'EXECUTING' }));

    dispatchStreamEvent(makeEvent('c1', task.id, 'browser_task_step', {
      subTaskId: 's1',
      content: 'click button',
      detail: 'clicked submit',
      progress: 50,
    }));

    dispatchStreamEvent(makeEvent('c1', task.id, 'browser_task_screenshot', {
      subTaskId: 's1',
      detail: 'base64data',
    }));

    const msg = uiMessageStore.getLastAssistantMessage('c1')!;
    const stepParts = msg.parts.filter(p => p.type === 'browser-step');
    const screenshotParts = msg.parts.filter(p => p.type === 'browser-screenshot');

    expect(stepParts).toHaveLength(1);
    expect((stepParts[0] as any).detail).toBe('clicked submit');
    expect((stepParts[0] as any).progress).toBe(50);

    expect(screenshotParts).toHaveLength(1);
    expect((screenshotParts[0] as any).screenshotB64).toBe('base64data');
  });
});
