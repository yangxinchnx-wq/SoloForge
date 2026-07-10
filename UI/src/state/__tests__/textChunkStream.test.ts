/**
 * text_chunk 流式事件单元测试
 *
 * 覆盖 R-fix: 单模型直跑时, 后端只发 text 事件 (没有 phase 事件)
 * 流送区应能通过 text_chunk 事件正确显示文本累积
 *
 * 链路 (2026-07-10 解耦缓冲优化):
 *   pushStreamEvent('text_chunk', { content, subTaskId })
 *   → applyEvent → EVENT_HANDLERS.text_chunk
 *   → textBuffers[subTaskId] += content (解耦于 RootTask, 不触发全树重渲染)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingStore } from '../streamingStore';

beforeEach(() => {
  useStreamingStore.getState().__reset();
});

describe('R-fix: text_chunk 事件处理', () => {
  it('text_chunk 应累积到对应 textBuffers[subTaskId]', () => {
    const chatId = 'c1';
    useStreamingStore.getState().createTask(chatId, '翻译这句话', 'normal');
    const task = useStreamingStore.getState().tasks[chatId];

    // 1) 切到 SINGLE_MODEL
    useStreamingStore.getState().applyEvent({
      id: 'e1', chatId, rootTaskId: task.id, kind: 'phase_change',
      content: 'SINGLE_MODEL', ts: Date.now(), status: 'running',
    });
    expect(useStreamingStore.getState().tasks[chatId].phase).toBe('SINGLE_MODEL');

    // 2) 创建合成 sub-task
    useStreamingStore.getState().applyEvent({
      id: 'e2', chatId, rootTaskId: task.id, kind: 'subtask_created',
      agentId: 'main-model', content: 'GPT-4o', detail: '生成回复',
      ts: Date.now(), status: 'pending',
    });
    const subId = useStreamingStore.getState().getLastSubTaskId(chatId)!;
    expect(subId).toBeTruthy();
    expect(useStreamingStore.getState().tasks[chatId].subTasks).toHaveLength(1);

    // 3) 推 text_chunk 1
    useStreamingStore.getState().applyEvent({
      id: 'e3', chatId, rootTaskId: task.id, kind: 'text_chunk',
      subTaskId: subId, content: '你好', ts: Date.now(), status: 'running',
    });
    let st = useStreamingStore.getState().tasks[chatId].subTasks[0];
    expect(useStreamingStore.getState().textBuffers[subId]).toBe('你好');
    expect(st.status).toBe('running');

    // 4) 推 text_chunk 2
    useStreamingStore.getState().applyEvent({
      id: 'e4', chatId, rootTaskId: task.id, kind: 'text_chunk',
      subTaskId: subId, content: '，世界', ts: Date.now(), status: 'running',
    });
    st = useStreamingStore.getState().tasks[chatId].subTasks[0];
    expect(useStreamingStore.getState().textBuffers[subId]).toBe('你好，世界');

    // 5) 推 text_chunk 3
    useStreamingStore.getState().applyEvent({
      id: 'e5', chatId, rootTaskId: task.id, kind: 'text_chunk',
      subTaskId: subId, content: '！', ts: Date.now(), status: 'running',
    });
    st = useStreamingStore.getState().tasks[chatId].subTasks[0];
    expect(useStreamingStore.getState().textBuffers[subId]).toBe('你好，世界！');
  });

  it('text_chunk 没指定 subTaskId 时, 写入最后一个 subTask', () => {
    const chatId = 'c1';
    useStreamingStore.getState().createTask(chatId, 'q', 'normal');
    const task = useStreamingStore.getState().tasks[chatId];

    useStreamingStore.getState().applyEvent({
      id: 'e1', chatId, rootTaskId: task.id, kind: 'subtask_created',
      agentId: 'main', content: 'M', detail: '生成', ts: Date.now(), status: 'pending',
    });
    const subId = useStreamingStore.getState().getLastSubTaskId(chatId)!;

    // 不传 subTaskId
    useStreamingStore.getState().applyEvent({
      id: 'e2', chatId, rootTaskId: task.id, kind: 'text_chunk',
      content: 'fallback', ts: Date.now(), status: 'running',
    });
    const st = useStreamingStore.getState().tasks[chatId].subTasks[0];
    expect(st.id).toBe(subId);
    expect(useStreamingStore.getState().textBuffers[subId]).toBe('fallback');
  });

  it('text_chunk content 为空时, 不变更 textBuffers', () => {
    const chatId = 'c1';
    useStreamingStore.getState().createTask(chatId, 'q', 'normal');
    const task = useStreamingStore.getState().tasks[chatId];

    useStreamingStore.getState().applyEvent({
      id: 'e1', chatId, rootTaskId: task.id, kind: 'subtask_created',
      content: 'M', detail: '生成', ts: Date.now(), status: 'pending',
    });
    const subId = useStreamingStore.getState().getLastSubTaskId(chatId)!;

    useStreamingStore.getState().applyEvent({
      id: 'e2', chatId, rootTaskId: task.id, kind: 'text_chunk',
      subTaskId: subId, content: 'Hello', ts: Date.now(), status: 'running',
    });
    // 空 content 的 text_chunk — 应被忽略
    useStreamingStore.getState().applyEvent({
      id: 'e3', chatId, rootTaskId: task.id, kind: 'text_chunk',
      subTaskId: subId, content: '', ts: Date.now(), status: 'running',
    });
    const st = useStreamingStore.getState().tasks[chatId].subTasks[0];
    expect(useStreamingStore.getState().textBuffers[subId]).toBe('Hello');
  });

  it('完整流程: SINGLE_MODEL → text_chunk × N → subtask_done → delivery → DONE', () => {
    const chatId = 'c1';
    useStreamingStore.getState().createTask(chatId, 'q', 'normal');
    const task = useStreamingStore.getState().tasks[chatId];

    // SINGLE_MODEL
    useStreamingStore.getState().applyEvent({
      id: 'e1', chatId, rootTaskId: task.id, kind: 'phase_change',
      content: 'SINGLE_MODEL', ts: Date.now(), status: 'running',
    });
    // 创建 sub-task
    useStreamingStore.getState().applyEvent({
      id: 'e2', chatId, rootTaskId: task.id, kind: 'subtask_created',
      content: 'GPT-4o', detail: '生成', ts: Date.now(), status: 'pending',
    });
    const subId = useStreamingStore.getState().getLastSubTaskId(chatId)!;

    // 3 个 text chunk
    for (const txt of ['I', ' am', ' AI']) {
      useStreamingStore.getState().applyEvent({
        id: `e-${txt}`, chatId, rootTaskId: task.id, kind: 'text_chunk',
        subTaskId: subId, content: txt, ts: Date.now(), status: 'running',
      });
    }
    expect(useStreamingStore.getState().textBuffers[subId]).toBe('I am AI');

    // 结束: subtask_done
    useStreamingStore.getState().applyEvent({
      id: 'e-done', chatId, rootTaskId: task.id, kind: 'subtask_done',
      subTaskId: subId, content: 'I am AI', progress: 100, ts: Date.now(), status: 'success',
    });
    // delivery
    useStreamingStore.getState().applyEvent({
      id: 'e-del', chatId, rootTaskId: task.id, kind: 'delivery',
      content: 'I am AI', ts: Date.now(), status: 'success',
    });
    // phase DONE
    useStreamingStore.getState().applyEvent({
      id: 'e-fin', chatId, rootTaskId: task.id, kind: 'phase_change',
      content: 'DONE', ts: Date.now(), status: 'success',
    });

    const final = useStreamingStore.getState().tasks[chatId];
    expect(final.phase).toBe('DONE');
    expect(final.subTasks[0].status).toBe('done');
    expect(useStreamingStore.getState().textBuffers[subId]).toBe('I am AI');
    expect(final.deliverResult).toBe('I am AI');
  });
});
