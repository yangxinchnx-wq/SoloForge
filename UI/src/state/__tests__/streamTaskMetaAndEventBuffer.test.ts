/**
 * C fix 专项测试
 * C: streamTaskMeta[chatId] 隔离 (替代组件级 streamTaskRef)
 * (D fix eventBuffer 已随死代码清理移除)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingStore } from '../streamingStore';
import type { StreamEvent } from '../../types/streaming';

function makeEvt(partial: Partial<StreamEvent>): StreamEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'c1',
    rootTaskId: 't',
    kind: 'phase_change',
    content: '',
    ts: Date.now(),
    status: 'running',
    ...partial,
  };
}

beforeEach(() => {
  useStreamingStore.getState().__reset();
});

describe('C fix: streamTaskMeta — 多 chat 隔离', () => {
  it('createTask 时自动绑定 streamTaskMeta[chatId]', () => {
    useStreamingStore.getState().createTask('c1', 'task1', 'normal');
    const meta = useStreamingStore.getState().streamTaskMeta['c1'];
    expect(meta).toBeDefined();
    expect(meta!.rootTaskId).toBeTruthy();
    expect(meta!.subTaskIds).toBeInstanceOf(Map);
    expect(meta!.subTaskIds.size).toBe(0);
  });

  it('bindSubTask 写入 workerIdx → subTaskId, getSubTaskId 反查正确', () => {
    useStreamingStore.getState().createTask('c1', 'task', 'normal');
    useStreamingStore.getState().bindSubTask('c1', 0, 'sub-A');
    useStreamingStore.getState().bindSubTask('c1', 1, 'sub-B');
    expect(useStreamingStore.getState().getSubTaskId('c1', 0)).toBe('sub-A');
    expect(useStreamingStore.getState().getSubTaskId('c1', 1)).toBe('sub-B');
    expect(useStreamingStore.getState().getSubTaskId('c1', 2)).toBeUndefined();
  });

  it('bindSubTask 同 workerIdx 后写覆盖前写 (SSE 重发时幂等)', () => {
    useStreamingStore.getState().createTask('c1', 'task', 'normal');
    useStreamingStore.getState().bindSubTask('c1', 0, 'sub-old');
    useStreamingStore.getState().bindSubTask('c1', 0, 'sub-new');
    expect(useStreamingStore.getState().getSubTaskId('c1', 0)).toBe('sub-new');
  });

  it('【关键】两个 chat 并发, subTaskId 不会串台', () => {
    // 模拟 "双 chat 同时跑" 的场景
    useStreamingStore.getState().createTask('chatA', 'A', 'normal');
    useStreamingStore.getState().createTask('chatB', 'B', 'normal');

    useStreamingStore.getState().bindSubTask('chatA', 0, 'A-sub-0');
    useStreamingStore.getState().bindSubTask('chatA', 1, 'A-sub-1');
    useStreamingStore.getState().bindSubTask('chatB', 0, 'B-sub-0');

    // chatA 自己的索引不受 chatB 干扰
    expect(useStreamingStore.getState().getSubTaskId('chatA', 0)).toBe('A-sub-0');
    expect(useStreamingStore.getState().getSubTaskId('chatA', 1)).toBe('A-sub-1');
    expect(useStreamingStore.getState().getSubTaskId('chatA', 0)).not.toBe('B-sub-0');

    // 反之亦然
    expect(useStreamingStore.getState().getSubTaskId('chatB', 0)).toBe('B-sub-0');
    expect(useStreamingStore.getState().getSubTaskId('chatB', 1)).toBeUndefined();
  });

  it('【关键】getSubTaskId 对不存在的 chatId 返回 undefined (不抛错)', () => {
    expect(useStreamingStore.getState().getSubTaskId('nonexistent', 0)).toBeUndefined();
  });

  it('bindSubTask 对不存在的 chatId 静默忽略', () => {
    expect(() => {
      useStreamingStore.getState().bindSubTask('nonexistent', 0, 'sub-0');
    }).not.toThrow();
  });

  it('getStreamTaskMeta 返回该 chatId 的完整元数据', () => {
    const task = useStreamingStore.getState().createTask('c1', 'task', 'normal');
    useStreamingStore.getState().bindSubTask('c1', 0, 'sub-0');
    const meta = useStreamingStore.getState().getStreamTaskMeta('c1');
    expect(meta?.rootTaskId).toBe(task.id);
    expect(meta?.subTaskIds.get(0)).toBe('sub-0');
  });

  it('clearChat 同时清理 streamTaskMeta[chatId]', () => {
    useStreamingStore.getState().createTask('c1', 'task', 'normal');
    useStreamingStore.getState().bindSubTask('c1', 0, 'sub-0');
    useStreamingStore.getState().clearChat('c1');
    expect(useStreamingStore.getState().streamTaskMeta['c1']).toBeUndefined();
    expect(useStreamingStore.getState().getSubTaskId('c1', 0)).toBeUndefined();
  });
});

describe('C 联调: 双 chat 并发场景', () => {
  it('chatA 和 chatB 同时跑, streamTaskMeta 互不干扰', () => {
    useStreamingStore.getState().createTask('chatA', 'A', 'normal');
    useStreamingStore.getState().createTask('chatB', 'B', 'normal');

    // 模拟两个 chat 同时创建子任务 (subtask_created 真正建 SubTask)
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'chatA', kind: 'subtask_created',
      content: 'model-A', detail: 'A task', agentId: 'a-0',
    }));
    const subIdA = useStreamingStore.getState().tasks.chatA.subTasks[0].id;
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'chatB', kind: 'subtask_created',
      content: 'model-B', detail: 'B task', agentId: 'b-0',
    }));
    const subIdB = useStreamingStore.getState().tasks.chatB.subTasks[0].id;

    // 模拟 SSE 推送: 各 chat 的 worker 进度独立
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'chatA', kind: 'subtask_progress', subTaskId: subIdA, progress: 50, status: 'running',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'chatB', kind: 'subtask_progress', subTaskId: subIdB, progress: 30, status: 'running',
    }));

    // chatA 的子任务进度是 50, chatB 的子任务进度是 30
    const subA = useStreamingStore.getState().tasks.chatA.subTasks[0];
    const subB = useStreamingStore.getState().tasks.chatB.subTasks[0];
    expect(subA.progress).toBe(50);
    expect(subB.progress).toBe(30);

    // streamTaskMeta 互不干扰
    expect(useStreamingStore.getState().streamTaskMeta.chatA.rootTaskId).not.toBe(
      useStreamingStore.getState().streamTaskMeta.chatB.rootTaskId
    );
  });
});
