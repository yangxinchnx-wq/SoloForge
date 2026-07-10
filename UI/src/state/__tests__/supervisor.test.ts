/**
 * supervisor.test.ts — 监督策略 + 错误隔离测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { taskActorSupervisor, formatActorErrorForUI, type ActorErrorEvent } from '../../services/supervisorStrategy';
import { TaskActor } from '../../services/taskActor';
import type { ActorStateSnapshot } from '../../services/taskActor';

function makeSnapshot(overrides: Partial<ActorStateSnapshot> = {}): ActorStateSnapshot {
  return {
    taskId: 'task-1',
    chatId: 'chat-1',
    phase: 'EXECUTING',
    progress: 50,
    status: 'error',
    pendingCount: 0,
    processedCount: 5,
    lastProcessedAt: Date.now(),
    ...overrides,
  };
}

describe('TaskActorSupervisor', () => {
  beforeEach(() => {
    taskActorSupervisor.reset();
  });

  it('应该在未超过 maxRestarts 时执行 restart', () => {
    const actor = new TaskActor('task-1', 'chat-1', 'EXECUTING');
    const snapshot = makeSnapshot();

    const decision = taskActorSupervisor.handleActorError(
      actor,
      new Error('test error'),
      snapshot,
    );

    expect(decision.action).toBe('restart');
    expect(actor.getSnapshot().status).toBe('active'); // restart 后恢复
    actor.stop();
  });

  it('应该在超过 maxRestarts 时执行 stop', () => {
    taskActorSupervisor.updateConfig({ maxRestarts: 2, timeWindow: 60000 });

    const actor = new TaskActor('task-1', 'chat-1', 'EXECUTING');
    const snapshot = makeSnapshot();

    // 模拟 3 次错误 (超过 maxRestarts=2)
    taskActorSupervisor.handleActorError(actor, new Error('err 1'), snapshot);
    taskActorSupervisor.handleActorError(actor, new Error('err 2'), snapshot);
    const decision = taskActorSupervisor.handleActorError(actor, new Error('err 3'), snapshot);

    expect(decision.action).toBe('stop');
    expect(actor.getSnapshot().status).toBe('stopped');
  });

  it('应该通知错误监听者', () => {
    const errors: ActorErrorEvent[] = [];
    taskActorSupervisor.onError(e => errors.push(e));

    const actor = new TaskActor('task-1', 'chat-1');
    taskActorSupervisor.handleActorError(actor, new Error('test'), makeSnapshot());

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('test');
    expect(errors[0].errorCount).toBe(1);

    actor.stop();
  });

  it('应该正确获取错误次数', () => {
    const actor = new TaskActor('task-1', 'chat-1');
    const snapshot = makeSnapshot();

    taskActorSupervisor.handleActorError(actor, new Error('err 1'), snapshot);
    taskActorSupervisor.handleActorError(actor, new Error('err 2'), snapshot);

    expect(taskActorSupervisor.getErrorCount('task-1')).toBe(2);

    actor.stop();
  });

  it('应该清理指定 Actor 的错误历史', () => {
    const actor = new TaskActor('task-1', 'chat-1');
    taskActorSupervisor.handleActorError(actor, new Error('err'), makeSnapshot());

    expect(taskActorSupervisor.getErrorCount('task-1')).toBe(1);

    taskActorSupervisor.clearErrorHistory('task-1');
    expect(taskActorSupervisor.getErrorCount('task-1')).toBe(0);

    actor.stop();
  });
});

describe('formatActorErrorForUI', () => {
  it('应该格式化 stop 决策为 error 严重度', () => {
    const event: ActorErrorEvent = {
      taskId: 'task-1',
      chatId: 'chat-1',
      message: '连接失败',
      timestamp: Date.now(),
      phase: 'EXECUTING',
      decision: { action: 'stop', reason: '超过最大重启次数' },
      errorCount: 4,
    };

    const formatted = formatActorErrorForUI(event);
    expect(formatted.severity).toBe('error');
    expect(formatted.isRecoverable).toBe(false);
    expect(formatted.title).toContain('已停止');
  });

  it('应该格式化 restart 决策为 warning 严重度', () => {
    const event: ActorErrorEvent = {
      taskId: 'task-1',
      chatId: 'chat-1',
      message: '临时错误',
      timestamp: Date.now(),
      phase: 'EXECUTING',
      decision: { action: 'restart', reason: '自动恢复中' },
      errorCount: 1,
    };

    const formatted = formatActorErrorForUI(event);
    expect(formatted.severity).toBe('warning');
    expect(formatted.isRecoverable).toBe(true);
    expect(formatted.title).toContain('自动恢复');
  });
});
