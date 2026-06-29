/**
 * C + D fix 专项测试
 * C: streamTaskMeta[chatId] 隔离 (替代组件级 streamTaskRef)
 * D: eventBuffer[chatId] 累积流送事件 (StreamPanel.events 数据源)
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

describe('D fix: eventBuffer — StreamPanel.events 数据源', () => {
  it('createTask 时清空旧 eventBuffer[chatId]', () => {
    // 第 1 轮: 推一些事件
    useStreamingStore.getState().createTask('c1', 'round 1', 'normal');
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'EXECUTING' }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'DONE' }));
    expect(useStreamingStore.getState().eventBuffer['c1']).toHaveLength(2);

    // 第 2 轮: createTask 应清空旧缓冲
    useStreamingStore.getState().createTask('c1', 'round 2', 'normal');
    expect(useStreamingStore.getState().eventBuffer['c1']).toEqual([]);
  });

  it('applyEvent 推入 eventBuffer[chatId], 顺序按 ts', () => {
    useStreamingStore.getState().createTask('c1', 'task', 'normal');
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'EXECUTING' }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'REVIEWING' }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'DONE' }));
    const buf = useStreamingStore.getState().eventBuffer['c1'];
    expect(buf).toHaveLength(3);
    expect(buf.map(e => e.content)).toEqual(['EXECUTING', 'REVIEWING', 'DONE']);
  });

  it('eventBuffer 不同 chatId 互不干扰', () => {
    useStreamingStore.getState().createTask('chatA', 'A', 'normal');
    useStreamingStore.getState().createTask('chatB', 'B', 'normal');
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'chatA', kind: 'phase_change', content: 'EXECUTING' }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'chatB', kind: 'phase_change', content: 'DONE' }));
    expect(useStreamingStore.getState().eventBuffer['chatA']).toHaveLength(1);
    expect(useStreamingStore.getState().eventBuffer['chatB']).toHaveLength(1);
  });

  it('eventBuffer 超过 500 时丢弃最早 (容量上限)', () => {
    useStreamingStore.getState().createTask('c1', 'task', 'normal');
    // 推 600 条
    for (let i = 0; i < 600; i++) {
      useStreamingStore.getState().applyEvent(makeEvt({
        chatId: 'c1', kind: 'phase_change', content: `EVT-${i}`, ts: i,
      }));
    }
    const buf = useStreamingStore.getState().eventBuffer['c1'];
    expect(buf.length).toBeLessThanOrEqual(500);
    // 应该是后 500 条 (100~599)
    expect(buf[0].content).toBe('EVT-100');
    expect(buf[buf.length - 1].content).toBe('EVT-599');
  });

  it('applyEvent 即使没有 task 也入缓冲 (后端可能先发 phase0_skip)', () => {
    // 没有 createTask, 直接 applyEvent
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'phase_change', content: 'EXECUTING',
    }));
    expect(useStreamingStore.getState().eventBuffer['c1']).toHaveLength(1);
    // task 不存在, 不抛错
    expect(useStreamingStore.getState().tasks['c1']).toBeUndefined();
  });

  it('drainEventBuffer 原子取出并清空', () => {
    useStreamingStore.getState().createTask('c1', 'task', 'normal');
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'EXECUTING' }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'DONE' }));

    const drained = useStreamingStore.getState().drainEventBuffer('c1');
    expect(drained).toHaveLength(2);
    // 取走后缓冲应清空
    expect(useStreamingStore.getState().eventBuffer['c1']).toBeUndefined();

    // 二次 drain 应返回空
    const drained2 = useStreamingStore.getState().drainEventBuffer('c1');
    expect(drained2).toEqual([]);
  });

  it('clearEventBuffer 只清缓冲, 不动 task 树', () => {
    useStreamingStore.getState().createTask('c1', 'task', 'normal');
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'EXECUTING' }));
    useStreamingStore.getState().clearEventBuffer('c1');
    expect(useStreamingStore.getState().eventBuffer['c1']).toBeUndefined();
    // task 还在
    expect(useStreamingStore.getState().tasks['c1']).toBeDefined();
  });

  it('clearChat 同时清理 eventBuffer[chatId]', () => {
    useStreamingStore.getState().createTask('c1', 'task', 'normal');
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'EXECUTING' }));
    useStreamingStore.getState().clearChat('c1');
    expect(useStreamingStore.getState().eventBuffer['c1']).toBeUndefined();
  });
});

describe('C + D 联调: 双 chat 并发场景', () => {
  it('chatA 和 chatB 同时跑, eventBuffer 和 streamTaskMeta 都互不干扰', () => {
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

    // eventBuffer 各自独立
    expect(useStreamingStore.getState().eventBuffer.chatA).toHaveLength(2);  // 1 created + 1 progress
    expect(useStreamingStore.getState().eventBuffer.chatB).toHaveLength(2);

    // streamTaskMeta 互不干扰
    expect(useStreamingStore.getState().streamTaskMeta.chatA.rootTaskId).not.toBe(
      useStreamingStore.getState().streamTaskMeta.chatB.rootTaskId
    );
  });
});
