/**
 * useStreamSummary 单元测试
 *
 * 验证从 uiMessageStore parts 派生的摘要状态正确性
 * 注: 不使用 @testing-library/react, 直接测试派生逻辑
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { uiMessageStore } from '../uiMessageStore';
import { taskActorSystem } from '../taskActor';
import { createTaskWithActor, dispatchStreamEvent, initActorSystem } from '../actorIntegration';
import { streamPersistence } from '../streamPersistence';
import { useStreamingStore } from '../../state/streamingStore';
import type { StreamEvent } from '../../types/streaming';
import type { UIMessage, UIPart } from '../../types/messages';

vi.mock('../streamPersistence', () => ({
  streamPersistence: {
    init: vi.fn().mockResolvedValue(undefined),
    restoreHotState: vi.fn().mockReturnValue(null),
    scheduleFlush: vi.fn(),
    appendEvents: vi.fn().mockResolvedValue(undefined),
    flushNow: vi.fn(),
    clearChat: vi.fn().mockResolvedValue(undefined),
  },
}));

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

/**
 * 从 uiMessageStore 派生摘要 (复制 useStreamSummary 的核心逻辑, 不依赖 React hooks)
 */
function deriveSummary(chatId: string) {
  const messages = uiMessageStore.getMessages(chatId);
  if (!messages || messages.length === 0) {
    return { phase: null, progress: 0, subtaskCount: 0, doneCount: 0, isDone: false, isError: false, isActive: false, hasData: false };
  }
  let msg: UIMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { msg = messages[i]; break; }
  }
  if (!msg || msg.parts.length === 0) {
    return { phase: null, progress: 0, subtaskCount: 0, doneCount: 0, isDone: false, isError: false, isActive: false, hasData: false };
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
  const isDone = phase === 'DONE';
  const isError = phase === 'ERROR';
  const isActive = phase !== null && !isDone && !isError;

  return { phase, progress, subtaskCount, doneCount, isDone, isError, isActive, hasData: true };
}

describe('useStreamSummary 派生逻辑', () => {
  it('无消息时返回空摘要', () => {
    const s = deriveSummary('c1');
    expect(s.hasData).toBe(false);
    expect(s.phase).toBe(null);
    expect(s.progress).toBe(0);
  });

  it('phase-change part 派生 phase', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DECOMPOSING' }));

    const s = deriveSummary('c1');
    expect(s.phase).toBe('DECOMPOSING');
    expect(s.isActive).toBe(true);
    expect(s.isDone).toBe(false);
  });

  it('subtask parts 派生 count + progress', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DECOMPOSING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_created', { content: 'GPT-4o', detail: 'task1', subTaskId: 'sub-1' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_created', { content: 'Claude', detail: 'task2', subTaskId: 'sub-2' }));

    const s = deriveSummary('c1');
    expect(s.subtaskCount).toBe(2);
    expect(s.doneCount).toBe(0);
    expect(s.progress).toBe(0);
  });

  it('subtask-done part 增加 doneCount + progress', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DECOMPOSING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_created', { content: 'A', detail: 't1', subTaskId: 'sub-1' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_created', { content: 'B', detail: 't2', subTaskId: 'sub-2' }));

    const subId = 'sub-2';
    dispatchStreamEvent(makeEvent('c1', task.id, 'subtask_done', {
      subTaskId: subId, content: 'done', progress: 100, status: 'success',
    }));

    const s = deriveSummary('c1');
    expect(s.doneCount).toBe(1);
    expect(s.subtaskCount).toBe(2);
    expect(s.progress).toBe(50);
  });

  it('DONE phase → isDone=true, isActive=false', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DECOMPOSING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DELIVERING' }));
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'DONE', status: 'success' }));

    const s = deriveSummary('c1');
    expect(s.isDone).toBe(true);
    expect(s.isActive).toBe(false);
    expect(s.phase).toBe('DONE');
  });

  it('ERROR phase → isError=true', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'ERROR', status: 'error' }));

    const s = deriveSummary('c1');
    expect(s.isError).toBe(true);
    expect(s.isActive).toBe(false);
  });

  it('无 subtask 但有 phase 时 progress=100', () => {
    const task = createTaskWithActor('c1', 'test', 'normal');
    dispatchStreamEvent(makeEvent('c1', task.id, 'phase_change', { content: 'SINGLE_MODEL' }));

    const s = deriveSummary('c1');
    expect(s.subtaskCount).toBe(0);
    expect(s.progress).toBe(100);
  });
});
