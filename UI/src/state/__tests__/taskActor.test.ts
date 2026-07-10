/**
 * taskActor.test.ts — TaskActor + waitFor 测试
 *
 * 覆盖:
 *   1. Mailbox 串行处理
 *   2. Actor 状态跟踪 (phase, progress)
 *   3. waitFor 超时降级
 *   4. Actor 错误隔离
 *   5. 生命周期 (stop, restart)
 *   6. TaskActorSystem 多 Actor 管理
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskActor, TaskActorSystem, taskActorSystem } from '../../services/taskActor';
import type { StreamEvent } from '../../types/streaming';

function makeEvent(
  chatId: string,
  kind: StreamEvent['kind'],
  content: string,
  extra?: Partial<StreamEvent>,
): StreamEvent {
  return {
    id: `test-${Math.random().toString(36).slice(2, 8)}`,
    chatId,
    rootTaskId: 'task-test',
    kind,
    content,
    ts: Date.now(),
    status: 'running',
    ...extra,
  };
}

/** 等待 microtask flush (兼容真实 timer) */
function flushMicrotasks(): Promise<void> {
  return new Promise(r => queueMicrotask(() => r()));
}

describe('TaskActor', () => {
  let actor: TaskActor;

  beforeEach(() => {
    actor = new TaskActor('task-1', 'chat-1', 'CLARIFY');
  });

  afterEach(() => {
    actor.stop();
  });

  it('应该正确初始化', () => {
    const snapshot = actor.getSnapshot();
    expect(snapshot.taskId).toBe('task-1');
    expect(snapshot.chatId).toBe('chat-1');
    expect(snapshot.phase).toBe('CLARIFY');
    expect(snapshot.status).toBe('active');
    expect(snapshot.processedCount).toBe(0);
  });

  it('应该通过 mailbox 串行处理事件', async () => {
    const events: StreamEvent[] = [
      makeEvent('chat-1', 'phase_change', 'PLANNING'),
      makeEvent('chat-1', 'phase_change', 'DECOMPOSING'),
      makeEvent('chat-1', 'phase_change', 'DISPATCHING'),
    ];

    for (const e of events) {
      actor.tell(e);
    }

    // 等待 microtask flush
    await flushMicrotasks();

    const snapshot = actor.getSnapshot();
    expect(snapshot.processedCount).toBe(3);
    expect(snapshot.phase).toBe('DISPATCHING');
    expect(snapshot.pendingCount).toBe(0);
  });

  it('应该在 stop 后丢弃新事件', async () => {
    actor.stop();
    actor.tell(makeEvent('chat-1', 'phase_change', 'PLANNING'));

    await flushMicrotasks();

    expect(actor.getSnapshot().processedCount).toBe(0);
    expect(actor.getSnapshot().status).toBe('stopped');
  });

  it('应该支持 restart 从 error 恢复', async () => {
    // 发送 error 事件
    actor.tell(makeEvent('chat-1', 'error', 'test error', { status: 'error' }));
    await flushMicrotasks();

    expect(actor.getSnapshot().status).toBe('error');

    // restart
    actor.restart();
    expect(actor.getSnapshot().status).toBe('active');
    expect(actor.getSnapshot().lastError).toBeUndefined();
  });

  it('应该正确跟踪 progress', async () => {
    actor.tell(makeEvent('chat-1', 'subtask_progress', 'EXECUTE', { progress: 50, subTaskId: 'sub-1' }));
    await flushMicrotasks();

    expect(actor.getSnapshot().progress).toBe(50);
  });

  it('应该在空闲时回到 idle 状态', async () => {
    actor.tell(makeEvent('chat-1', 'phase_change', 'PLANNING'));
    await flushMicrotasks();

    expect(actor.getSnapshot().status).toBe('idle');
  });
});

describe('TaskActor waitFor', () => {
  let actor: TaskActor;

  beforeEach(() => {
    actor = new TaskActor('task-wait', 'chat-wait', 'CLARIFY');
  });

  afterEach(() => {
    actor.stop();
  });

  it('应该在条件满足时立即 resolve', async () => {
    const result = await actor.waitFor(
      (s) => s.phase === 'CLARIFY',
      { timeout: 1000 },
    );

    expect(result.satisfied).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('应该在超时后 resolve with timedOut=true', async () => {
    const result = await actor.waitFor(
      (s) => s.phase === 'DONE',
      { timeout: 100, fallbackDescription: '超时降级' },
    );

    expect(result.satisfied).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.elapsed).toBeGreaterThanOrEqual(90);
  }, 5000);

  it('应该在超时后执行 fallbackEvent', async () => {
    const fallbackEvent = makeEvent('chat-wait', 'phase_change', 'DONE', { status: 'success' });
    const result = await actor.waitFor(
      (s) => s.phase === 'DONE',
      { timeout: 50, fallbackEvent: fallbackEvent },
    );

    expect(result.timedOut).toBe(true);

    // 等待 fallbackEvent 被 mailbox 处理
    await flushMicrotasks();
    await new Promise(r => setTimeout(r, 10));

    const snapshot = actor.getSnapshot();
    expect(snapshot.phase).toBe('DONE');
  }, 5000);

  it('应该在事件到来后满足条件', async () => {
    const waitPromise = actor.waitFor(
      (s) => s.phase === 'REVIEWING',
      { timeout: 5000 },
    );

    // 延迟发送事件
    setTimeout(() => {
      actor.tell(makeEvent('chat-wait', 'phase_change', 'PLANNING'));
      actor.tell(makeEvent('chat-wait', 'phase_change', 'DECOMPOSING'));
      actor.tell(makeEvent('chat-wait', 'phase_change', 'DISPATCHING'));
      actor.tell(makeEvent('chat-wait', 'phase_change', 'EXECUTING'));
      actor.tell(makeEvent('chat-wait', 'phase_change', 'REVIEWING'));
    }, 50);

    const result = await waitPromise;

    expect(result.satisfied).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(actor.getSnapshot().phase).toBe('REVIEWING');
  }, 10000);
});

describe('TaskActorSystem', () => {
  beforeEach(() => {
    taskActorSystem.reset();
  });

  afterEach(() => {
    taskActorSystem.reset();
  });

  it('应该创建和管理多个 Actor', () => {
    const actor1 = taskActorSystem.createActor('task-1', 'chat-1');
    const actor2 = taskActorSystem.createActor('task-2', 'chat-2');

    expect(taskActorSystem.getActor('task-1')).toBe(actor1);
    expect(taskActorSystem.getActor('task-2')).toBe(actor2);
    expect(taskActorSystem.getActorByChat('chat-1')).toBe(actor1);
    expect(taskActorSystem.getActorByChat('chat-2')).toBe(actor2);
  });

  it('应该为同 chatId 新建 Actor 时停止旧 Actor', () => {
    const actor1 = taskActorSystem.createActor('task-1', 'chat-1');
    const actor2 = taskActorSystem.createActor('task-2', 'chat-1');

    expect(actor1.getSnapshot().status).toBe('stopped');
    expect(taskActorSystem.getActor('task-1')).toBeUndefined();
    expect(taskActorSystem.getActorByChat('chat-1')).toBe(actor2);
  });

  it('应该通过 tell 投递事件到正确的 Actor', async () => {
    taskActorSystem.createActor('task-1', 'chat-1');
    taskActorSystem.createActor('task-2', 'chat-2');

    taskActorSystem.tell('chat-1', makeEvent('chat-1', 'phase_change', 'PLANNING'));
    taskActorSystem.tell('chat-2', makeEvent('chat-2', 'phase_change', 'EXECUTING'));

    await flushMicrotasks();

    expect(taskActorSystem.getActor('task-1')!.getSnapshot().phase).toBe('PLANNING');
    expect(taskActorSystem.getActor('task-2')!.getSnapshot().phase).toBe('EXECUTING');
  });

  it('应该返回 false 当 Actor 不存在时', () => {
    const result = taskActorSystem.tell('nonexistent', makeEvent('nonexistent', 'phase_change', 'PLANNING'));
    expect(result).toBe(false);
  });

  it('应该通过 stopActor 清理 Actor', () => {
    const actor = taskActorSystem.createActor('task-1', 'chat-1');
    taskActorSystem.stopActor('task-1');

    expect(taskActorSystem.getActor('task-1')).toBeUndefined();
    expect(actor.getSnapshot().status).toBe('stopped');
  });

  it('应该返回所有 Actor 的快照', () => {
    taskActorSystem.createActor('task-1', 'chat-1');
    taskActorSystem.createActor('task-2', 'chat-2');

    const snapshots = taskActorSystem.getAllSnapshots();
    expect(snapshots).toHaveLength(2);
  });
});
