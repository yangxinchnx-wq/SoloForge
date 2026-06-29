/**
 * 对话流程端到端模拟测试
 *
 * 模拟真实多轮对话场景:
 *   - 1st turn: 完整 happy path (decomposing → workers → judge → deliver → done)
 *   - 2nd turn: 同一 chatId 二次发起, 验证 taskHistory 入库
 *   - 3rd turn: 单 worker 失败 + 后端 ERROR 事件, 验证错误状态机
 *   - 4th turn: 不同 chatId 并行, 验证隔离
 *   - 5th turn: 顺序级联 worker_progress, 验证 stepHistory 累积顺序
 *
 * 模拟 pushStreamEventForPhase 的翻译逻辑, 不依赖 React/ChatPanel 组件。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingStore } from '../streamingStore';
import type { StreamEvent, StreamEventKind, TaskPhase, SubTask } from '../../types/streaming';

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

/**
 * 模拟 pushStreamEvent + pushStreamEventForPhase 的行为:
 *   - 当 events 含 phase_change 翻译到 phase_change
 *   - 当 SSE phase 事件 (phase0_subtask / phase1_worker_* 等) 翻译到 subtask_created/progress/done
 *
 * 这里直接合成 store 期望的 StreamEvent, 避免把 ChatPanel 整套 React 拖进来。
 */
function applySsePhase(chatId: string, evt: any) {
  const store = useStreamingStore.getState();
  const task = store.tasks[chatId];
  if (!task) return;
  // 模拟 pushStreamEventForPhase 的翻译
  const phase = evt.phase;
  if (phase === 'phase0_subtask') {
    store.applyEvent(makeEvt({ chatId, rootTaskId: task.id, kind: 'phase_change', content: 'DECOMPOSING' }));
    for (const s of (evt.subtasks || [])) {
      store.applyEvent(makeEvt({
        chatId, rootTaskId: task.id, kind: 'subtask_created',
        content: s.modelName ?? `worker-${s.workerIdx}`,
        detail: s.taskDesc ?? `Worker ${s.workerIdx}`,
        agentId: `agent-${s.workerIdx}`,
      }));
    }
    store.applyEvent(makeEvt({ chatId, rootTaskId: task.id, kind: 'phase_change', content: 'DISPATCHING' }));
    store.applyEvent(makeEvt({ chatId, rootTaskId: task.id, kind: 'phase_change', content: 'EXECUTING' }));
  } else if (phase === 'phase1_worker_start') {
    const subs = task.subTasks;
    const target = subs[evt.workerIdx];
    if (target) {
      store.applyEvent(makeEvt({
        chatId, rootTaskId: task.id, kind: 'subtask_progress',
        subTaskId: target.id, content: 'EXECUTE', progress: 10, status: 'running',
      }));
    }
  } else if (phase === 'phase1_worker_done') {
    const subs = task.subTasks;
    const target = subs[evt.workerIdx];
    if (target) {
      store.applyEvent(makeEvt({
        chatId, rootTaskId: task.id, kind: 'subtask_progress',
        subTaskId: target.id, content: 'SUBMIT_TO_JUDGE', progress: 100, status: 'success',
      }));
      store.applyEvent(makeEvt({
        chatId, rootTaskId: task.id, kind: 'subtask_done',
        subTaskId: target.id, content: evt.content ?? '', status: 'success',
      }));
    }
  } else if (phase === 'phase1_worker_error') {
    // 修复后: 改用 subtask_progress, 不动根任务
    const subs = task.subTasks;
    const target = subs[evt.workerIdx];
    if (target) {
      store.applyEvent(makeEvt({
        chatId, rootTaskId: task.id, kind: 'subtask_progress',
        subTaskId: target.id, content: 'EXECUTE', progress: 0, status: 'error',
        detail: evt.error || '调用失败',
      }));
    }
  } else if (phase === 'phase2_judge') {
    store.applyEvent(makeEvt({ chatId, rootTaskId: task.id, kind: 'phase_change', content: 'REVIEWING',
      detail: `审议: 选中 ${(evt.chosen || []).join(', ') || '(无)'}` }));
  } else if (phase === 'phase3_deliver_start') {
    store.applyEvent(makeEvt({ chatId, rootTaskId: task.id, kind: 'phase_change', content: 'DELIVERING' }));
  } else if (phase === 'phase3_deliver_done') {
    store.applyEvent(makeEvt({ chatId, rootTaskId: task.id, kind: 'phase_change', content: 'DONE', status: 'success' }));
  } else if (phase === 'error') {
    store.applyEvent(makeEvt({ chatId, rootTaskId: task.id, kind: 'error', content: 'ERROR', status: 'error',
      detail: evt.msg || 'Unknown error' }));
  }
}

beforeEach(() => {
  useStreamingStore.getState().__reset();
});

describe('E2E — 单轮 happy path', () => {
  it('decomposing → 3 workers → judge → deliver → done', () => {
    const task = useStreamingStore.getState().createTask('c1', 'test happy path', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [
      { workerIdx: 0, modelName: 'Qwen 2.5', taskDesc: 'collect facts' },
      { workerIdx: 1, modelName: 'Kimi K2',  taskDesc: 'search history' },
      { workerIdx: 2, modelName: 'GLM-4',    taskDesc: 'cross-validate' },
    ]});
    for (let i = 0; i < 3; i++) {
      applySsePhase('c1', { phase: 'phase1_worker_start', workerIdx: i });
      applySsePhase('c1', { phase: 'phase1_worker_done',  workerIdx: i, content: `out-${i}` });
    }
    applySsePhase('c1', { phase: 'phase2_judge', chosen: ['Qwen 2.5'] });
    applySsePhase('c1', { phase: 'phase3_deliver_start' });
    applySsePhase('c1', { phase: 'phase3_deliver_done' });

    const final = useStreamingStore.getState().tasks.c1!;
    expect(final.phase).toBe('DONE');
    expect(final.subTasks).toHaveLength(3);
    expect(final.subTasks.every(s => s.status === 'done')).toBe(true);
    expect(final.progress).toBe(100);
  });
});

describe('E2E — 多轮对话 (history 累积)', () => {
  it('第 1 轮完成 → 第 2 轮发起 → 旧任务进 history', () => {
    // 第 1 轮
    useStreamingStore.getState().createTask('c1', 'round 1', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'A', taskDesc: 'a' }] });
    applySsePhase('c1', { phase: 'phase1_worker_start', workerIdx: 0 });
    applySsePhase('c1', { phase: 'phase1_worker_done', workerIdx: 0, content: 'ok' });
    applySsePhase('c1', { phase: 'phase2_judge' });
    applySsePhase('c1', { phase: 'phase3_deliver_start' });
    applySsePhase('c1', { phase: 'phase3_deliver_done' });
    expect(useStreamingStore.getState().tasks.c1!.phase).toBe('DONE');

    // 第 2 轮: clearChat → 旧任务入 history, 然后 createTask
    useStreamingStore.getState().clearChat('c1');
    expect(useStreamingStore.getState().tasks.c1).toBeUndefined();
    expect(useStreamingStore.getState().taskHistory.c1).toHaveLength(1);
    expect(useStreamingStore.getState().taskHistory.c1![0].userInput).toBe('round 1');

    useStreamingStore.getState().createTask('c1', 'round 2', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'B', taskDesc: 'b' }] });
    applySsePhase('c1', { phase: 'phase1_worker_start', workerIdx: 0 });
    applySsePhase('c1', { phase: 'phase1_worker_done', workerIdx: 0, content: 'ok2' });
    applySsePhase('c1', { phase: 'phase2_judge' });
    applySsePhase('c1', { phase: 'phase3_deliver_start' });
    applySsePhase('c1', { phase: 'phase3_deliver_done' });

    expect(useStreamingStore.getState().tasks.c1!.userInput).toBe('round 2');
    expect(useStreamingStore.getState().tasks.c1!.phase).toBe('DONE');
    // 历史此时只有 round 1 (round 2 还在 active tasks 里)
    expect(useStreamingStore.getState().taskHistory.c1).toHaveLength(1);
    // 关闭 round 2 → 入 history
    useStreamingStore.getState().clearChat('c1');
    expect(useStreamingStore.getState().taskHistory.c1).toHaveLength(2);
    expect(useStreamingStore.getState().taskHistory.c1![1].userInput).toBe('round 2');
  });
});

describe('E2E — 错误处理', () => {
  it('单 worker error 不锁死根任务', () => {
    useStreamingStore.getState().createTask('c1', 'err case', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [
      { workerIdx: 0, modelName: 'A', taskDesc: 'a' },
      { workerIdx: 1, modelName: 'B', taskDesc: 'b' },
    ]});

    // worker 0 失败
    applySsePhase('c1', { phase: 'phase1_worker_start', workerIdx: 0 });
    applySsePhase('c1', { phase: 'phase1_worker_error', workerIdx: 0, error: 'rate limit' });

    const afterError = useStreamingStore.getState().tasks.c1!;
    // 修复期望: 根任务仍是 EXECUTING, 子任务 0 = error
    expect(afterError.phase).toBe('EXECUTING');
    expect(afterError.subTasks[0].status).toBe('error');
    expect(afterError.subTasks[1].status).toBe('pending');

    // worker 1 成功
    applySsePhase('c1', { phase: 'phase1_worker_start', workerIdx: 1 });
    applySsePhase('c1', { phase: 'phase1_worker_done',  workerIdx: 1, content: 'ok' });

    // 整任务级错误 (后端发 phase: error)
    applySsePhase('c1', { phase: 'error', msg: 'fatal: worker 0 failed' });
    expect(useStreamingStore.getState().tasks.c1!.phase).toBe('ERROR');
  });

  it('后端发 phase_change → ERROR 直接生效', () => {
    useStreamingStore.getState().createTask('c1', 'fatal', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'A', taskDesc: 'a' }] });
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'phase_change', content: 'EXECUTING',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'phase_change', content: 'ERROR', status: 'error', detail: 'crash',
    }));
    expect(useStreamingStore.getState().tasks.c1!.phase).toBe('ERROR');
  });
});

describe('E2E — 多 chat 隔离', () => {
  it('chatA 和 chatB 互不干扰', () => {
    useStreamingStore.getState().createTask('chatA', 'A', 'normal');
    useStreamingStore.getState().createTask('chatB', 'B', 'normal');
    applySsePhase('chatA', { phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'm1', taskDesc: 'a-task' }] });
    applySsePhase('chatB', { phase: 'phase0_subtask', subtasks: [
      { workerIdx: 0, modelName: 'm2', taskDesc: 'b-task-0' },
      { workerIdx: 1, modelName: 'm3', taskDesc: 'b-task-1' },
    ]});

    const a = useStreamingStore.getState().tasks.chatA!;
    const b = useStreamingStore.getState().tasks.chatB!;
    expect(a.subTasks).toHaveLength(1);
    expect(b.subTasks).toHaveLength(2);
    expect(a.subTasks[0].assigneeModel).toBe('m1');
    expect(b.subTasks[0].assigneeModel).toBe('m2');
  });
});

describe('E2E — stepHistory 累积顺序', () => {
  it('同 subTask 多次 progress 事件, stepHistory 累积且按时间顺序', async () => {
    useStreamingStore.getState().createTask('c1', 'steps test', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'M', taskDesc: 'work' }] });
    const subId = useStreamingStore.getState().tasks.c1!.subTasks[0].id;

    // 模拟 worker 跑过 5 个步骤
    const steps = [
      { name: 'READ_TASK',    progress: 10 },
      { name: 'UNDERSTAND',   progress: 25 },
      { name: 'DECIDE',       progress: 38 },
      { name: 'EXECUTE',      progress: 65 },
      { name: 'COMPLETE',     progress: 95 },
    ];
    for (const s of steps) {
      useStreamingStore.getState().applyEvent(makeEvt({
        chatId: 'c1', kind: 'subtask_progress',
        subTaskId: subId, content: s.name, progress: s.progress, status: 'running',
      }));
      // 加 1ms 间隔保证 ts 严格递增
      await new Promise(r => setTimeout(r, 2));
    }

    const sub = useStreamingStore.getState().tasks.c1!.subTasks[0];
    expect(sub.stepHistory).toHaveLength(5);
    expect(sub.stepHistory.map(s => s.step)).toEqual([
      'READ_TASK', 'UNDERSTAND', 'DECIDE', 'EXECUTE', 'COMPLETE',
    ]);
    expect(sub.progress).toBe(95);
  });

  it('同 step 多次 progress 事件, 应合并 (而非重复)', () => {
    useStreamingStore.getState().createTask('c1', 'merge test', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'M', taskDesc: 'w' }] });
    const subId = useStreamingStore.getState().tasks.c1!.subTasks[0].id;

    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'subtask_progress',
      subTaskId: subId, content: 'EXECUTE', progress: 50, status: 'running',
    }));
    useStreamingStore.getState().applyEvent(makeEvt({
      chatId: 'c1', kind: 'subtask_progress',
      subTaskId: subId, content: 'EXECUTE', progress: 70, status: 'running',
    }));

    const sub = useStreamingStore.getState().tasks.c1!.subTasks[0];
    // 同 step 只保留最新一条
    expect(sub.stepHistory).toHaveLength(1);
    expect(sub.stepHistory[0].step).toBe('EXECUTE');
    expect(sub.stepHistory[0].progress).toBe(70);
  });
});

describe('E2E — 异常输入不崩溃', () => {
  it('applyEvent 对 28 个合法 kind 全部不抛错 (R1.2 字典穷尽性)', () => {
    useStreamingStore.getState().createTask('c1', 'x', 'normal');
    const allKinds: StreamEventKind[] = [
      'task_created', 'phase_change', 'subtask_created', 'subtask_step', 'subtask_progress', 'subtask_done',
      'model_delegation', 'model_action', 'audit_start', 'audit_finding', 'audit_done',
      'clarify_request', 'clarify_response', 'delivery',
      'agent_created', 'agent_dissolved',
      'browser_task_start', 'browser_task_step', 'browser_task_screenshot',
      'browser_task_done', 'browser_task_error', 'browser_task_cancelled',
      'browser_enable_request',
      'tool_suggestion', 'tool_enabled', 'tool_skipped', 'tool_timeout',
      'error',
    ];
    for (const k of allKinds) {
      expect(() => {
        useStreamingStore.getState().applyEvent(makeEvt({
          chatId: 'c1', kind: k, content: 'x', detail: 'd',
        }));
      }).not.toThrow();
    }
  });

  it('applyEvent 对 progress=undefined 静默吞掉', () => {
    useStreamingStore.getState().createTask('c1', 'x', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'M', taskDesc: 'w' }] });
    const subId = useStreamingStore.getState().tasks.c1!.subTasks[0].id;
    expect(() => {
      useStreamingStore.getState().applyEvent(makeEvt({
        chatId: 'c1', kind: 'subtask_progress', subTaskId: subId, content: 'EXECUTE',
        // progress 故意缺省
      }));
    }).not.toThrow();
  });

  it('不合法 phase 跃迁 (DONE → EXECUTING) 静默拒绝', () => {
    const task = useStreamingStore.getState().createTask('c1', 'x', 'normal');
    // 强行到 DONE
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'EXECUTING' }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'REVIEWING' }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'DELIVERING' }));
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'DONE' }));
    expect(useStreamingStore.getState().tasks.c1!.phase).toBe('DONE');

    // 试图回退到 EXECUTING
    useStreamingStore.getState().applyEvent(makeEvt({ chatId: 'c1', kind: 'phase_change', content: 'EXECUTING' }));
    expect(useStreamingStore.getState().tasks.c1!.phase).toBe('DONE');  // 拒绝, 保持 DONE
  });
});

describe('E2E — calcRootProgress 边界', () => {
  it('所有子任务 progress=0, 根任务 progress=0', () => {
    useStreamingStore.getState().createTask('c1', 'x', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [
      { workerIdx: 0, modelName: 'A', taskDesc: 'short' },
      { workerIdx: 1, modelName: 'B', taskDesc: 'a longer task desc' },
    ]});
    expect(useStreamingStore.getState().tasks.c1!.progress).toBe(0);
  });

  it('所有子任务 progress=100, 根任务 progress=100', () => {
    useStreamingStore.getState().createTask('c1', 'x', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [
      { workerIdx: 0, modelName: 'A', taskDesc: 'short' },
      { workerIdx: 1, modelName: 'B', taskDesc: 'a longer task desc' },
    ]});
    for (let i = 0; i < 2; i++) {
      applySsePhase('c1', { phase: 'phase1_worker_start', workerIdx: i });
      applySsePhase('c1', { phase: 'phase1_worker_done', workerIdx: i, content: 'ok' });
    }
    expect(useStreamingStore.getState().tasks.c1!.progress).toBe(100);
  });
});
