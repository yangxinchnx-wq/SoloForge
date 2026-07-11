/**
 * 对话流程端到端模拟测试 (重构后)
 *
 * 模拟真实多轮对话场景:
 *   - 1st turn: 完整 happy path (decomposing → workers → judge → deliver → done)
 *   - 2nd turn: 单 worker 失败 + 后端 ERROR 事件, 验证错误状态机
 *   - 3rd turn: 不同 chatId 并行, 验证隔离
 *   - 4th turn: 顺序级联 worker_progress, 验证 stepHistory 累积顺序
 *
 * 重构变更:
 *   - store.applyEvent → dispatchStreamEvent (actorIntegration.ts)
 *   - store.tasks[chatId] 断言 → 从 uiMessageStore.parts 派生
 *   - store.taskHistory → 已删除 (相关测试块移除)
 *   - userInput 断言 → getStreamTaskMeta(chatId)?.userInput
 *   - subTask.id → getSubTaskId(chatId, workerIdx)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStreamingStore } from '../streamingStore';
import { uiMessageStore } from '../../services/uiMessageStore';
import { taskActorSystem } from '../../services/taskActor';
import { createTaskWithActor, dispatchStreamEvent } from '../../services/actorIntegration';
import type { StreamEvent, StreamEventKind, TaskPhase } from '../../types/streaming';
import type {
  UIPhaseChangePart,
  UISubTaskCreatedPart,
  UISubTaskProgressPart,
  UISubTaskDonePart,
} from '../../types/messages';

let subIdCounter = 0;

beforeEach(() => {
  useStreamingStore.getState().__reset();
  uiMessageStore.__reset();
  taskActorSystem.reset();
  subIdCounter = 0;
});

function makeEvt(chatId: string, rootTaskId: string, partial: Partial<StreamEvent>): StreamEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    chatId,
    rootTaskId,
    kind: 'phase_change',
    content: '',
    ts: Date.now(),
    status: 'running',
    ...partial,
  };
}

/** 投递事件到 dispatchStreamEvent (rootTaskId 从 streamTaskMeta 取) */
function dispatch(chatId: string, kind: StreamEventKind, extra: Partial<StreamEvent> = {}) {
  const meta = useStreamingStore.getState().getStreamTaskMeta(chatId);
  if (!meta) return;
  dispatchStreamEvent(makeEvt(chatId, meta.rootTaskId, { kind, ...extra }));
}

/**
 * 模拟 pushStreamEventForPhase 的翻译 (复刻旧 applySsePhase 行为):
 *   SSE phase 事件 → StreamEvent → dispatchStreamEvent
 */
function applySsePhase(chatId: string, evt: any) {
  const meta = useStreamingStore.getState().getStreamTaskMeta(chatId);
  if (!meta) return;
  const phase = evt.phase;

  if (phase === 'phase0_subtask') {
    dispatch(chatId, 'phase_change', { content: 'DECOMPOSING' });
    for (const s of (evt.subtasks || [])) {
      const workerIdx: number = s.workerIdx ?? 0;
      const modelName: string = s.modelName ?? `worker-${workerIdx}`;
      const taskDesc: string = s.taskDesc ?? `Worker ${workerIdx}`;
      const subId = `sub-flow-${++subIdCounter}`;
      dispatch(chatId, 'subtask_created', {
        subTaskId: subId,
        content: modelName,
        detail: taskDesc,
        agentId: `agent-${workerIdx}`,
      });
      useStreamingStore.getState().bindSubTask(chatId, workerIdx, subId);
    }
    dispatch(chatId, 'phase_change', { content: 'DISPATCHING' });
    dispatch(chatId, 'phase_change', { content: 'EXECUTING' });
  } else if (phase === 'phase1_worker_start') {
    const subId = useStreamingStore.getState().getSubTaskId(chatId, evt.workerIdx);
    if (subId) {
      dispatch(chatId, 'subtask_progress', {
        subTaskId: subId, content: 'EXECUTE', progress: 10, status: 'running',
      });
    }
  } else if (phase === 'phase1_worker_done') {
    const subId = useStreamingStore.getState().getSubTaskId(chatId, evt.workerIdx);
    if (subId) {
      dispatch(chatId, 'subtask_progress', {
        subTaskId: subId, content: 'SUBMIT_TO_JUDGE', progress: 100, status: 'success',
      });
      dispatch(chatId, 'subtask_done', {
        subTaskId: subId, content: evt.content ?? '', status: 'success',
      });
    }
  } else if (phase === 'phase1_worker_error') {
    const subId = useStreamingStore.getState().getSubTaskId(chatId, evt.workerIdx);
    if (subId) {
      dispatch(chatId, 'subtask_progress', {
        subTaskId: subId, content: 'EXECUTE', progress: 0, status: 'error',
        detail: evt.error || '调用失败',
      });
    }
  } else if (phase === 'phase2_judge') {
    dispatch(chatId, 'phase_change', {
      content: 'REVIEWING',
      detail: `审议: 选中 ${(evt.chosen || []).join(', ') || '(无)'}`,
    });
  } else if (phase === 'phase3_deliver_start') {
    dispatch(chatId, 'phase_change', { content: 'DELIVERING' });
  } else if (phase === 'phase3_deliver_done') {
    dispatch(chatId, 'phase_change', { content: 'DONE', status: 'success' });
  } else if (phase === 'error') {
    // 对齐 phaseMappers: error phase → phase_change(ERROR)
    dispatch(chatId, 'phase_change', {
      content: 'ERROR', status: 'error', detail: evt.msg || 'Unknown error',
    });
  }
}

// ── 从 parts 派生状态 ──
interface DerivedSub {
  id: string;
  assigneeModel: string;
  status: 'pending' | 'done' | 'error';
  progress: number;
  stepHistory: { step: string; progress: number; detail?: string }[];
  hasDonePart: boolean;
}
interface DerivedState {
  phase: TaskPhase | null;
  subTasks: DerivedSub[];
  progress: number;
  hasErrorPart: boolean;
}

function deriveState(chatId: string): DerivedState {
  const msg = uiMessageStore.getLastAssistantMessage(chatId);
  if (!msg) return { phase: null, subTasks: [], progress: 0, hasErrorPart: false };
  let phase: TaskPhase | null = null;
  let hasErrorPart = false;
  const subs = new Map<string, DerivedSub>();
  for (const part of msg.parts) {
    if (part.type === 'phase-change') {
      phase = (part as UIPhaseChangePart).to as TaskPhase;
    } else if (part.type === 'error') {
      hasErrorPart = true;
    } else if (part.type === 'subtask-created') {
      const p = part as UISubTaskCreatedPart;
      subs.set(p.subTaskId, {
        id: p.subTaskId,
        assigneeModel: p.assigneeModel,
        status: 'pending',
        progress: 0,
        stepHistory: [],
        hasDonePart: false,
      });
    } else if (part.type === 'subtask-progress') {
      const p = part as UISubTaskProgressPart;
      const sub = subs.get(p.subTaskId);
      if (sub) {
        sub.progress = p.progress;
        if (p.step) {
          const idx = sub.stepHistory.findIndex(s => s.step === p.step);
          const entry = { step: p.step, progress: p.progress, detail: p.detail };
          if (idx >= 0) sub.stepHistory[idx] = entry;
          else sub.stepHistory.push(entry);
        }
      }
    } else if (part.type === 'subtask-done') {
      const p = part as UISubTaskDonePart;
      const sub = subs.get(p.subTaskId);
      if (sub) {
        sub.hasDonePart = true;
        sub.status = p.status === 'error' ? 'error' : 'done';
        sub.progress = 100;
      }
    }
  }
  const subTasks = Array.from(subs.values());
  const doneCount = subTasks.filter(s => s.hasDonePart).length;
  const progress = subTasks.length > 0
    ? Math.round((doneCount / subTasks.length) * 100)
    : phase ? 100 : 0;
  return { phase, subTasks, progress, hasErrorPart };
}

describe('E2E — 单轮 happy path', () => {
  it('decomposing → 3 workers → judge → deliver → done', () => {
    createTaskWithActor('c1', 'test happy path', 'normal');
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

    const final = deriveState('c1');
    expect(final.phase).toBe('DONE');
    expect(final.subTasks).toHaveLength(3);
    expect(final.subTasks.every(s => s.status === 'done')).toBe(true);
    expect(final.progress).toBe(100);
  });
});

describe('E2E — 错误处理', () => {
  it('单 worker error 不锁死根任务', () => {
    createTaskWithActor('c1', 'err case', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [
      { workerIdx: 0, modelName: 'A', taskDesc: 'a' },
      { workerIdx: 1, modelName: 'B', taskDesc: 'b' },
    ]});

    // worker 0 失败
    applySsePhase('c1', { phase: 'phase1_worker_start', workerIdx: 0 });
    applySsePhase('c1', { phase: 'phase1_worker_error', workerIdx: 0, error: 'rate limit' });

    const afterError = deriveState('c1');
    // 修复期望: 根任务仍是 EXECUTING, 子任务 0 无 done part + progress=0 + 错误 detail
    expect(afterError.phase).toBe('EXECUTING');
    expect(afterError.subTasks[0].hasDonePart).toBe(false);
    expect(afterError.subTasks[0].progress).toBe(0);
    const errStep = afterError.subTasks[0].stepHistory.find(s => s.step === 'EXECUTE');
    expect(errStep?.detail).toBe('rate limit');
    expect(afterError.subTasks[1].hasDonePart).toBe(false); // pending

    // worker 1 成功
    applySsePhase('c1', { phase: 'phase1_worker_start', workerIdx: 1 });
    applySsePhase('c1', { phase: 'phase1_worker_done',  workerIdx: 1, content: 'ok' });

    // 整任务级错误 (后端发 phase: error → phase_change ERROR)
    applySsePhase('c1', { phase: 'error', msg: 'fatal: worker 0 failed' });
    expect(deriveState('c1').phase).toBe('ERROR');
  });

  it('后端发 phase_change → ERROR 直接生效', () => {
    createTaskWithActor('c1', 'fatal', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'A', taskDesc: 'a' }] });
    dispatch('c1', 'phase_change', { content: 'EXECUTING' });
    dispatch('c1', 'phase_change', { content: 'ERROR', status: 'error', detail: 'crash' });
    expect(deriveState('c1').phase).toBe('ERROR');
  });
});

describe('E2E — 多 chat 隔离', () => {
  it('chatA 和 chatB 互不干扰', () => {
    createTaskWithActor('chatA', 'A', 'normal');
    createTaskWithActor('chatB', 'B', 'normal');
    applySsePhase('chatA', { phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'm1', taskDesc: 'a-task' }] });
    applySsePhase('chatB', { phase: 'phase0_subtask', subtasks: [
      { workerIdx: 0, modelName: 'm2', taskDesc: 'b-task-0' },
      { workerIdx: 1, modelName: 'm3', taskDesc: 'b-task-1' },
    ]});

    const a = deriveState('chatA');
    const b = deriveState('chatB');
    expect(a.subTasks).toHaveLength(1);
    expect(b.subTasks).toHaveLength(2);
    expect(a.subTasks[0].assigneeModel).toBe('m1');
    expect(b.subTasks[0].assigneeModel).toBe('m2');
  });
});

describe('E2E — stepHistory 累积顺序', () => {
  it('同 subTask 多次 progress 事件, stepHistory 累积且按时间顺序', async () => {
    createTaskWithActor('c1', 'steps test', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'M', taskDesc: 'work' }] });
    const subId = useStreamingStore.getState().getSubTaskId('c1', 0)!;

    // 模拟 worker 跑过 5 个步骤
    const steps = [
      { name: 'READ_TASK',    progress: 10 },
      { name: 'UNDERSTAND',   progress: 25 },
      { name: 'DECIDE',       progress: 38 },
      { name: 'EXECUTE',      progress: 65 },
      { name: 'COMPLETE',     progress: 95 },
    ];
    for (const s of steps) {
      dispatch('c1', 'subtask_progress', {
        subTaskId: subId, content: s.name, progress: s.progress, status: 'running',
      });
      await new Promise(r => setTimeout(r, 2));
    }

    const sub = deriveState('c1').subTasks[0];
    expect(sub.stepHistory).toHaveLength(5);
    expect(sub.stepHistory.map(s => s.step)).toEqual([
      'READ_TASK', 'UNDERSTAND', 'DECIDE', 'EXECUTE', 'COMPLETE',
    ]);
    expect(sub.progress).toBe(95);
  });

  it('同 step 多次 progress 事件, 应合并 (而非重复)', () => {
    createTaskWithActor('c1', 'merge test', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'M', taskDesc: 'w' }] });
    const subId = useStreamingStore.getState().getSubTaskId('c1', 0)!;

    dispatch('c1', 'subtask_progress', {
      subTaskId: subId, content: 'EXECUTE', progress: 50, status: 'running',
    });
    dispatch('c1', 'subtask_progress', {
      subTaskId: subId, content: 'EXECUTE', progress: 70, status: 'running',
    });

    const sub = deriveState('c1').subTasks[0];
    // 同 step 只保留最新一条
    expect(sub.stepHistory).toHaveLength(1);
    expect(sub.stepHistory[0].step).toBe('EXECUTE');
    expect(sub.stepHistory[0].progress).toBe(70);
  });
});

describe('E2E — 异常输入不崩溃', () => {
  it('dispatchStreamEvent 对 28 个合法 kind 全部不抛错 (R1.2 字典穷尽性)', () => {
    createTaskWithActor('c1', 'x', 'normal');
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
        dispatch('c1', k, { content: 'x', detail: 'd' });
      }).not.toThrow();
    }
  });

  it('dispatchStreamEvent 对 progress=undefined 静默吞掉', () => {
    createTaskWithActor('c1', 'x', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'M', taskDesc: 'w' }] });
    const subId = useStreamingStore.getState().getSubTaskId('c1', 0)!;
    expect(() => {
      dispatch('c1', 'subtask_progress', {
        subTaskId: subId, content: 'EXECUTE',
        // progress 故意缺省
      });
    }).not.toThrow();
  });
});

describe('E2E — calcRootProgress 边界', () => {
  it('所有子任务 progress=0, 根任务 progress=0', () => {
    createTaskWithActor('c1', 'x', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [
      { workerIdx: 0, modelName: 'A', taskDesc: 'short' },
      { workerIdx: 1, modelName: 'B', taskDesc: 'a longer task desc' },
    ]});
    expect(deriveState('c1').progress).toBe(0);
  });

  it('所有子任务 progress=100, 根任务 progress=100', () => {
    createTaskWithActor('c1', 'x', 'normal');
    applySsePhase('c1', { phase: 'phase0_subtask', subtasks: [
      { workerIdx: 0, modelName: 'A', taskDesc: 'short' },
      { workerIdx: 1, modelName: 'B', taskDesc: 'a longer task desc' },
    ]});
    for (let i = 0; i < 2; i++) {
      applySsePhase('c1', { phase: 'phase1_worker_start', workerIdx: i });
      applySsePhase('c1', { phase: 'phase1_worker_done', workerIdx: i, content: 'ok' });
    }
    expect(deriveState('c1').progress).toBe(100);
  });
});
