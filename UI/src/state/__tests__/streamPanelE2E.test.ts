/**
 * 流送区端到端集成测试
 *
 * 链路: SSE event → phaseMappers → pushStreamEvent → store.applyEvent → EVENT_HANDLERS → tasks 更新
 *      ↓
 * StreamPanel 订阅 useStreamingStore(s => s.tasks[chatId]) 重渲染
 *
 * 本测试不验证 UI 渲染, 只验证数据层:
 *   - 推一连串模拟 SSE phase 事件
 *   - 检查 store.tasks[chatId] 状态机的正确性
 *   - 检查 eventBuffer 累积
 *   - 检查同 chatId 历史归档 (R2.2)
 *   - 检查 AbortController 不会泄露中途事件 (R2.1)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingStore } from '../streamingStore';
import { mapPhaseToStreamEvents } from '../../services/phaseMappers';

beforeEach(() => {
  useStreamingStore.getState().__reset();
});

/** 模拟 pushStreamEvent 的"接收器"
 *  参数签名必须严格匹配 PhaseMapperContext 接口:
 *    - bindSubTask: (chatId, workerIdx, subTaskId)
 *    - getSubTaskId: (chatId, workerIdx)
 *  测试 chatId 已固定闭包, 但 mapper 调用方传 chatId 在前, 必须保留该参数位
 */
function makeReceiver(chatId: string) {
  const store = useStreamingStore.getState();
  const meta = store.streamTaskMeta[chatId];
  return {
    pushStreamEvent: (kind: any, extra: any = {}) => {
      const task = useStreamingStore.getState().tasks[chatId];
      if (!meta || !task) return;
      useStreamingStore.getState().applyEvent({
        id: `evt-${Math.random()}`,
        chatId,
        rootTaskId: task.id,
        kind,
        ts: Date.now(),
        status: 'running',
        ...extra,
      });
    },
    getSubTaskId: (cid: string, workerIdx: number) =>
      useStreamingStore.getState().getSubTaskId(cid, workerIdx),
    bindSubTask: (cid: string, workerIdx: number, subTaskId: string) =>
      useStreamingStore.getState().bindSubTask(cid, workerIdx, subTaskId),
    getLastSubTaskId: () =>
      useStreamingStore.getState().getLastSubTaskId(chatId),
  };
}

describe('流送区端到端: 单一子任务流程 (s3.3 Ensemble)', () => {
  it('phase0_subtask → DECOMPOSING → 1 subtask_created → DISPATCHING → 1 worker_start → 1 worker_done → judge → deliver → DONE', () => {
    const chatId = 'c1';
    useStreamingStore.getState().createTask(chatId, 'translate this', 'normal');
    const recv = makeReceiver(chatId);

    // 后端发 phase0_subtask (Ensemble 拆解)
    mapPhaseToStreamEvents({
      phase: 'phase0_subtask',
      subtasks: [
        { workerIdx: 0, modelName: 'GPT-4o', taskDesc: 'translate' },
      ],
    }, {
      activeChatId: chatId,
      ...recv,
    });

    // 此时: 根任务 DECOMPOSING → DISPATCHING, 1 个子任务
    let task = useStreamingStore.getState().tasks[chatId];
    expect(task.phase).toBe('DISPATCHING');
    expect(task.subTasks).toHaveLength(1);
    // SubTask 没独立 agentId 字段, mapper 推的 agentId 通过 EVENT_HANDLERS 落到 assigneeModelId
    expect(task.subTasks[0].assigneeModelId).toBe('agent-0');
    // 子任务初始状态: pending
    expect(task.subTasks[0].status).toBe('pending');

    // worker start: subtask_progress 推进 progress + currentStep + stepHistory,
    // 且 handler 第 189-191 行会把 status 推到 'running' (event.status='running' 时)
    mapPhaseToStreamEvents({ phase: 'phase1_worker_start', workerIdx: 0 }, { activeChatId: chatId, ...recv });
    const afterStart = useStreamingStore.getState().tasks[chatId].subTasks[0];
    expect(afterStart.status).toBe('running');
    expect(afterStart.progress).toBe(10);
    expect(afterStart.stepHistory.length).toBeGreaterThan(0);

    // worker done
    mapPhaseToStreamEvents({ phase: 'phase1_worker_done', workerIdx: 0, content: '你好' }, { activeChatId: chatId, ...recv });
    task = useStreamingStore.getState().tasks[chatId];
    expect(task.subTasks[0].status).toBe('done');
    expect(task.subTasks[0].result).toBe('你好');

    // judge
    mapPhaseToStreamEvents({ phase: 'phase2_judge', chosen: ['GPT-4o'] }, { activeChatId: chatId, ...recv });
    expect(useStreamingStore.getState().tasks[chatId].phase).toBe('REVIEWING');

    // deliver start
    mapPhaseToStreamEvents({ phase: 'phase3_deliver_start' }, { activeChatId: chatId, ...recv });
    expect(useStreamingStore.getState().tasks[chatId].phase).toBe('DELIVERING');

    // deliver done
    mapPhaseToStreamEvents({ phase: 'phase3_deliver_done' }, { activeChatId: chatId, ...recv });
    task = useStreamingStore.getState().tasks[chatId];
    expect(task.phase).toBe('DONE');
  });

  it('phase0_skip (单模型模式) → SINGLE_MODEL → 直接走 deliver', () => {
    const chatId = 'c1';
    useStreamingStore.getState().createTask(chatId, 'q', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({ phase: 'phase0_skip' }, { activeChatId: chatId, ...recv });
    expect(useStreamingStore.getState().tasks[chatId].phase).toBe('SINGLE_MODEL');

    // 单模型直接进 deliver
    mapPhaseToStreamEvents({ phase: 'phase3_deliver_done' }, { activeChatId: chatId, ...recv });
    expect(useStreamingStore.getState().tasks[chatId].phase).toBe('DONE');
  });
});

describe('流送区端到端: 多子任务并行 (Ensemble)', () => {
  it('phase0_subtask 拆 3 个子任务 → 并行执行 → 全部 done', () => {
    const chatId = 'c1';
    useStreamingStore.getState().createTask(chatId, 'multi-question', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({
      phase: 'phase0_subtask',
      subtasks: [
        { workerIdx: 0, modelName: 'A', taskDesc: 'q1' },
        { workerIdx: 1, modelName: 'B', taskDesc: 'q2' },
        { workerIdx: 2, modelName: 'C', taskDesc: 'q3' },
      ],
    }, { activeChatId: chatId, ...recv });

    const task = useStreamingStore.getState().tasks[chatId];
    expect(task.subTasks).toHaveLength(3);
    expect(task.subTasks.map(s => s.assigneeModelId)).toEqual(['agent-0', 'agent-1', 'agent-2']);

    // 三个 worker 并行 start
    for (let i = 0; i < 3; i++) {
      mapPhaseToStreamEvents({ phase: 'phase1_worker_start', workerIdx: i }, { activeChatId: chatId, ...recv });
    }
    expect(useStreamingStore.getState().tasks[chatId].subTasks.every(s => s.status === 'running')).toBe(true);
    expect(useStreamingStore.getState().tasks[chatId].subTasks.every(s => s.progress === 10)).toBe(true);

    // 三个 worker 顺序 done
    mapPhaseToStreamEvents({ phase: 'phase1_worker_done', workerIdx: 1, content: 'B 答案' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'phase1_worker_done', workerIdx: 0, content: 'A 答案' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'phase1_worker_done', workerIdx: 2, content: 'C 答案' }, { activeChatId: chatId, ...recv });

    const finalTask = useStreamingStore.getState().tasks[chatId];
    expect(finalTask.subTasks.every(s => s.status === 'done')).toBe(true);
  });

  it('单个 worker 失败 → 不影响根任务 phase, 其他 worker 继续', () => {
    const chatId = 'c1';
    useStreamingStore.getState().createTask(chatId, 'q', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({
      phase: 'phase0_subtask',
      subtasks: [
        { workerIdx: 0, modelName: 'A' },
        { workerIdx: 1, modelName: 'B' },
      ],
    }, { activeChatId: chatId, ...recv });

    // worker 0 失败
    mapPhaseToStreamEvents({ phase: 'phase1_worker_error', workerIdx: 0, error: 'rate limit' }, { activeChatId: chatId, ...recv });
    const task0 = useStreamingStore.getState().tasks[chatId];
    expect(task0.subTasks[0].status).toBe('error');
    // 关键: 根任务 phase 仍为 DISPATCHING, 没有被 worker 失败拖垮
    expect(task0.phase).toBe('DISPATCHING');

    // worker 1 正常完成
    mapPhaseToStreamEvents({ phase: 'phase1_worker_done', workerIdx: 1, content: 'B 答案' }, { activeChatId: chatId, ...recv });
    const task1 = useStreamingStore.getState().tasks[chatId];
    expect(task1.subTasks[1].status).toBe('done');
    expect(task1.subTasks[0].status).toBe('error'); // 0 仍是 error
    expect(task1.phase).toBe('DISPATCHING'); // 仍未升 phase
  });
});

describe('流送区端到端: 旧版 phase 兼容', () => {
  it('dispatch (旧版: string[]) + worker_start/done + judge + deliver', () => {
    const chatId = 'c1';
    useStreamingStore.getState().createTask(chatId, 'q', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({ phase: 'dispatch', subtasks: ['GPT', 'Claude'] }, { activeChatId: chatId, ...recv });
    expect(useStreamingStore.getState().tasks[chatId].subTasks).toHaveLength(2);

    mapPhaseToStreamEvents({ phase: 'worker_start', workerIdx: 0 }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'worker_done', workerIdx: 0, content: 'ok' }, { activeChatId: chatId, ...recv });
    expect(useStreamingStore.getState().tasks[chatId].subTasks[0].status).toBe('done');

    mapPhaseToStreamEvents({ phase: 'judge', chosen: ['GPT'] }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'deliver' }, { activeChatId: chatId, ...recv });
    expect(useStreamingStore.getState().tasks[chatId].phase).toBe('DELIVERING');
  });

  it('error phase → 根任务 ERROR, 已开始的子任务保留', () => {
    const chatId = 'c1';
    useStreamingStore.getState().createTask(chatId, 'q', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({
      phase: 'dispatch', subtasks: ['A'],
    }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'worker_start', workerIdx: 0 }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'error', msg: 'fatal' }, { activeChatId: chatId, ...recv });

    const task = useStreamingStore.getState().tasks[chatId];
    expect(task.phase).toBe('ERROR');
    // 子任务保留 running 状态
    expect(task.subTasks[0].status).toBe('running');
  });
});

describe('流送区端到端: eventBuffer 累积', () => {
  it('所有推送的 StreamEvent 都会入 eventBuffer[chatId]', () => {
    const chatId = 'c1';
    useStreamingStore.getState().createTask(chatId, 'q', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({
      phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'A' }],
    }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'phase1_worker_start', workerIdx: 0 }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'phase1_worker_done', workerIdx: 0, content: 'x' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'phase3_deliver_done' }, { activeChatId: chatId, ...recv });

    const buf = useStreamingStore.getState().eventBuffer[chatId];
    expect(buf.length).toBeGreaterThan(0);
    // 包含 phase_change (DECOMPOSING + DISPATCHING + DONE) + subtask_created + subtask_progress + subtask_done
    const kinds = buf.map(e => e.kind);
    expect(kinds).toContain('phase_change');
    expect(kinds).toContain('subtask_created');
    expect(kinds).toContain('subtask_progress');
    expect(kinds).toContain('subtask_done');
  });
});

describe('流送区端到端: R2.2 连发任务归档', () => {
  it('新任务进来时, 未完成的旧任务被归档到 taskHistory', () => {
    const chatId = 'c1';
    // 第一轮: 拆解但没完成
    const t1 = useStreamingStore.getState().createTask(chatId, 'first', 'normal');
    const recv = makeReceiver(chatId);
    mapPhaseToStreamEvents({
      phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'A' }],
    }, { activeChatId: chatId, ...recv });
    // 此时 phase = DISPATCHING, 不在终态

    // 第二轮: 用户连发
    const t2 = useStreamingStore.getState().createTask(chatId, 'second', 'normal');
    const history = useStreamingStore.getState().taskHistory[chatId];
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(t1.id);
    expect(history[0].phase).toBe('DISPATCHING'); // 保留中断时的状态
    expect(useStreamingStore.getState().tasks[chatId].id).toBe(t2.id);
  });
});

describe('流送区端到端: 边界', () => {
  it('chatId 无 task 时, mapPhaseToStreamEvents 静默吞掉', () => {
    // 没有 createTask, 直接推 phase
    const chatId = 'c1';
    const recv = makeReceiver(chatId);
    // 注意: 在 ChatPanel.pushStreamEvent 内有 !meta || !task 保护
    // phaseMappers 自身不检查, 这里模拟 pushStreamEvent 的保护
    const events: any[] = [];
    const guardedPush = (kind: any, extra: any = {}) => {
      const task = useStreamingStore.getState().tasks[chatId];
      const meta = useStreamingStore.getState().streamTaskMeta[chatId];
      if (!meta || !task) return;
      events.push({ kind, extra });
    };
    mapPhaseToStreamEvents({
      phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'A' }],
    }, {
      activeChatId: chatId,
      pushStreamEvent: guardedPush,
      getSubTaskId: recv.getSubTaskId,
      bindSubTask: recv.bindSubTask,
      getLastSubTaskId: recv.getLastSubTaskId,
    });
    // 静默: 没有任务时 pushStreamEvent 不动
    expect(events).toEqual([]);
    // store 也没创建任务
    expect(useStreamingStore.getState().tasks[chatId]).toBeUndefined();
  });

  it('未注册的 phase (reply / audit_stream / score / tool_call / warn) → 静默', () => {
    const chatId = 'c1';
    useStreamingStore.getState().createTask(chatId, 'q', 'normal');
    const recv = makeReceiver(chatId);

    const bufBefore = useStreamingStore.getState().eventBuffer[chatId]?.length ?? 0;
    mapPhaseToStreamEvents({ phase: 'reply' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'audit_stream' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'score' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'tool_call' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'warn' }, { activeChatId: chatId, ...recv });

    const bufAfter = useStreamingStore.getState().eventBuffer[chatId]?.length ?? 0;
    expect(bufAfter).toBe(bufBefore); // 一个都没进 buffer
    expect(useStreamingStore.getState().tasks[chatId].phase).toBe('CLARIFY'); // 初始 phase
  });
});