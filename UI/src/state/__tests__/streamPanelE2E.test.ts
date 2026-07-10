/**
 * 流送区端到端集成测试 (重构后)
 *
 * 链路: SSE phase event → phaseMappers → pushStreamEvent → dispatchStreamEvent
 *      → uiMessageStore.parts 追加 (Data Parts 模式)
 *
 * 重构变更:
 *   - streamingStore 不再持有 tasks/taskHistory/applyEvent
 *   - 事件分发统一走 dispatchStreamEvent (actorIntegration.ts)
 *   - 显示数据从 uiMessageStore.parts 派生
 *   - PhaseMapperContext.getLastSubTaskId → newSubTaskId
 *
 * 本测试不验证 UI 渲染, 只验证数据层:
 *   - 推一连串模拟 SSE phase 事件
 *   - 从 uiMessageStore.parts 派生 phase / subTasks 状态做断言
 *   - 检查 chatId 无任务时的静默保护
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStreamingStore } from '../streamingStore';
import { uiMessageStore } from '../../services/uiMessageStore';
import { taskActorSystem } from '../../services/taskActor';
import { streamPersistence } from '../../services/streamPersistence';
import { createTaskWithActor, dispatchStreamEvent } from '../../services/actorIntegration';
import { mapPhaseToStreamEvents } from '../../services/phaseMappers';
import type { TaskPhase } from '../../types/streaming';
import type {
  UIPhaseChangePart,
  UISubTaskCreatedPart,
  UISubTaskProgressPart,
  UISubTaskDonePart,
} from '../../types/messages';

// ── Mock persistence (避免 localStorage / IndexedDB / timer 副作用) ──
vi.spyOn(streamPersistence, 'init').mockResolvedValue(undefined);
vi.spyOn(streamPersistence, 'restoreHotState').mockReturnValue(null);
vi.spyOn(streamPersistence, 'scheduleFlush').mockImplementation(() => {});
vi.spyOn(streamPersistence, 'appendEvents').mockResolvedValue(undefined);
vi.spyOn(streamPersistence, 'flushNow').mockImplementation(() => {});
vi.spyOn(streamPersistence, 'clearChat').mockResolvedValue(undefined);

let subIdCounter = 0;

beforeEach(() => {
  useStreamingStore.getState().__reset();
  uiMessageStore.__reset();
  taskActorSystem.reset();
  subIdCounter = 0;
});

/** 模拟 pushStreamEvent 的"接收器" — 适配新 PhaseMapperContext 接口 */
function makeReceiver(chatId: string) {
  return {
    pushStreamEvent: (kind: any, extra: any = {}) => {
      const meta = useStreamingStore.getState().getStreamTaskMeta(chatId);
      if (!meta) return;
      dispatchStreamEvent({
        id: `evt-${Math.random().toString(36).slice(2, 8)}`,
        chatId,
        rootTaskId: meta.rootTaskId,
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
    newSubTaskId: () => `sub-test-${++subIdCounter}`,
  };
}

interface DerivedSubTask {
  id: string;
  assigneeModel: string;
  status: 'pending' | 'done' | 'error';
  progress: number;
  result?: string;
  stepHistory: { step: string; progress: number; detail?: string }[];
  hasDonePart: boolean;
}

interface DerivedState {
  phase: TaskPhase | null;
  subTasks: DerivedSubTask[];
  hasData: boolean;
}

/** 从 uiMessageStore.parts 派生流送区状态 (复刻 useStreamSummary 派生逻辑) */
function deriveState(chatId: string): DerivedState {
  const msg = uiMessageStore.getLastAssistantMessage(chatId);
  if (!msg || msg.parts.length === 0) {
    return { phase: null, subTasks: [], hasData: false };
  }
  let phase: TaskPhase | null = null;
  const subs = new Map<string, DerivedSubTask>();
  for (const part of msg.parts) {
    if (part.type === 'phase-change') {
      phase = (part as UIPhaseChangePart).to as TaskPhase;
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
        sub.result = p.result;
        sub.progress = 100;
      }
    }
  }
  return { phase, subTasks: Array.from(subs.values()), hasData: true };
}

describe('流送区端到端: 单一子任务流程 (s3.3 Ensemble)', () => {
  it('phase0_subtask → DECOMPOSING → 1 subtask_created → DISPATCHING → 1 worker_start → 1 worker_done → judge → deliver → DONE', () => {
    const chatId = 'c1';
    createTaskWithActor(chatId, 'translate this', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({
      phase: 'phase0_subtask',
      subtasks: [
        { workerIdx: 0, modelName: 'GPT-4o', taskDesc: 'translate' },
      ],
    }, {
      activeChatId: chatId,
      ...recv,
    });

    // 此时: 最后一个 phase_change = DISPATCHING, 1 个子任务
    let state = deriveState(chatId);
    expect(state.phase).toBe('DISPATCHING');
    expect(state.subTasks).toHaveLength(1);
    // mapper 推的 modelName 落到 assigneeModel
    expect(state.subTasks[0].assigneeModel).toBe('GPT-4o');
    // 子任务初始状态: 无 done part → pending
    expect(state.subTasks[0].status).toBe('pending');

    // worker start: subtask_progress 推进 progress + stepHistory
    mapPhaseToStreamEvents({ phase: 'phase1_worker_start', workerIdx: 0 }, { activeChatId: chatId, ...recv });
    const afterStart = deriveState(chatId).subTasks[0];
    expect(afterStart.progress).toBe(10);
    expect(afterStart.stepHistory.length).toBeGreaterThan(0);

    // worker done
    mapPhaseToStreamEvents({ phase: 'phase1_worker_done', workerIdx: 0, content: '你好' }, { activeChatId: chatId, ...recv });
    state = deriveState(chatId);
    expect(state.subTasks[0].status).toBe('done');
    expect(state.subTasks[0].result).toBe('你好');

    // judge
    mapPhaseToStreamEvents({ phase: 'phase2_judge', chosen: ['GPT-4o'] }, { activeChatId: chatId, ...recv });
    expect(deriveState(chatId).phase).toBe('REVIEWING');

    // deliver start
    mapPhaseToStreamEvents({ phase: 'phase3_deliver_start' }, { activeChatId: chatId, ...recv });
    expect(deriveState(chatId).phase).toBe('DELIVERING');

    // deliver done
    mapPhaseToStreamEvents({ phase: 'phase3_deliver_done' }, { activeChatId: chatId, ...recv });
    expect(deriveState(chatId).phase).toBe('DONE');
  });

  it('phase0_skip (单模型模式) → SINGLE_MODEL → 直接走 deliver', () => {
    const chatId = 'c1';
    createTaskWithActor(chatId, 'q', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({ phase: 'phase0_skip' }, { activeChatId: chatId, ...recv });
    expect(deriveState(chatId).phase).toBe('SINGLE_MODEL');

    // 单模型直接进 deliver
    mapPhaseToStreamEvents({ phase: 'phase3_deliver_done' }, { activeChatId: chatId, ...recv });
    expect(deriveState(chatId).phase).toBe('DONE');
  });
});

describe('流送区端到端: 多子任务并行 (Ensemble)', () => {
  it('phase0_subtask 拆 3 个子任务 → 并行执行 → 全部 done', () => {
    const chatId = 'c1';
    createTaskWithActor(chatId, 'multi-question', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({
      phase: 'phase0_subtask',
      subtasks: [
        { workerIdx: 0, modelName: 'A', taskDesc: 'q1' },
        { workerIdx: 1, modelName: 'B', taskDesc: 'q2' },
        { workerIdx: 2, modelName: 'C', taskDesc: 'q3' },
      ],
    }, { activeChatId: chatId, ...recv });

    const state = deriveState(chatId);
    expect(state.subTasks).toHaveLength(3);
    expect(state.subTasks.map(s => s.assigneeModel)).toEqual(['A', 'B', 'C']);

    // 三个 worker 并行 start
    for (let i = 0; i < 3; i++) {
      mapPhaseToStreamEvents({ phase: 'phase1_worker_start', workerIdx: i }, { activeChatId: chatId, ...recv });
    }
    expect(deriveState(chatId).subTasks.every(s => s.progress === 10)).toBe(true);

    // 三个 worker 顺序 done
    mapPhaseToStreamEvents({ phase: 'phase1_worker_done', workerIdx: 1, content: 'B 答案' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'phase1_worker_done', workerIdx: 0, content: 'A 答案' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'phase1_worker_done', workerIdx: 2, content: 'C 答案' }, { activeChatId: chatId, ...recv });

    const finalState = deriveState(chatId);
    expect(finalState.subTasks.every(s => s.status === 'done')).toBe(true);
  });

  it('单个 worker 失败 → 不影响根任务 phase, 其他 worker 继续', () => {
    const chatId = 'c1';
    createTaskWithActor(chatId, 'q', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({
      phase: 'phase0_subtask',
      subtasks: [
        { workerIdx: 0, modelName: 'A' },
        { workerIdx: 1, modelName: 'B' },
      ],
    }, { activeChatId: chatId, ...recv });

    // worker 0 失败 (subtask_progress, progress=0, detail=error)
    mapPhaseToStreamEvents({ phase: 'phase1_worker_error', workerIdx: 0, error: 'rate limit' }, { activeChatId: chatId, ...recv });
    const state0 = deriveState(chatId);
    // 关键: 根任务 phase 仍为 DISPATCHING, 没有被 worker 失败拖垮
    expect(state0.phase).toBe('DISPATCHING');
    // 失败的子任务: 无 done part, progress=0, stepHistory 含 EXECUTE + 错误 detail
    expect(state0.subTasks[0].hasDonePart).toBe(false);
    expect(state0.subTasks[0].progress).toBe(0);
    const errStep = state0.subTasks[0].stepHistory.find(s => s.step === 'EXECUTE');
    expect(errStep?.detail).toBe('rate limit');

    // worker 1 正常完成
    mapPhaseToStreamEvents({ phase: 'phase1_worker_done', workerIdx: 1, content: 'B 答案' }, { activeChatId: chatId, ...recv });
    const state1 = deriveState(chatId);
    expect(state1.subTasks[1].status).toBe('done');
    expect(state1.subTasks[0].hasDonePart).toBe(false); // 0 仍无 done part
    expect(state1.phase).toBe('DISPATCHING'); // 仍未升 phase
  });
});

describe('流送区端到端: 旧版 phase 兼容', () => {
  it('dispatch (旧版: string[]) + worker_start/done + judge + deliver', () => {
    const chatId = 'c1';
    createTaskWithActor(chatId, 'q', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({ phase: 'dispatch', subtasks: ['GPT', 'Claude'] }, { activeChatId: chatId, ...recv });
    expect(deriveState(chatId).subTasks).toHaveLength(2);

    mapPhaseToStreamEvents({ phase: 'worker_start', workerIdx: 0 }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'worker_done', workerIdx: 0, content: 'ok' }, { activeChatId: chatId, ...recv });
    expect(deriveState(chatId).subTasks[0].status).toBe('done');

    mapPhaseToStreamEvents({ phase: 'judge', chosen: ['GPT'] }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'deliver' }, { activeChatId: chatId, ...recv });
    expect(deriveState(chatId).phase).toBe('DELIVERING');
  });

  it('error phase → 根任务 ERROR, 已开始的子任务 progress 保留', () => {
    const chatId = 'c1';
    createTaskWithActor(chatId, 'q', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({
      phase: 'dispatch', subtasks: ['A'],
    }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'worker_start', workerIdx: 0 }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'error', msg: 'fatal' }, { activeChatId: chatId, ...recv });

    const state = deriveState(chatId);
    expect(state.phase).toBe('ERROR');
    // 子任务 progress 保留 (worker_start 推过 progress=10)
    expect(state.subTasks[0].progress).toBe(10);
  });
});

describe('流送区端到端: 边界', () => {
  it('chatId 无 task 时, mapPhaseToStreamEvents 静默吞掉', () => {
    // 没有 createTask, 直接推 phase
    const chatId = 'c1';
    const recv = makeReceiver(chatId);
    // pushStreamEvent 内有 !meta 保护, dispatchStreamEvent 也会因无 rootTaskId 跳过 parts 写入
    mapPhaseToStreamEvents({
      phase: 'phase0_subtask', subtasks: [{ workerIdx: 0, modelName: 'A' }],
    }, {
      activeChatId: chatId,
      pushStreamEvent: recv.pushStreamEvent,
      getSubTaskId: recv.getSubTaskId,
      bindSubTask: recv.bindSubTask,
      newSubTaskId: recv.newSubTaskId,
    });
    // 静默: 没有任务时不会创建消息 / parts
    expect(uiMessageStore.getLastAssistantMessage(chatId)).toBeUndefined();
    // streamTaskMeta 也没创建
    expect(useStreamingStore.getState().getStreamTaskMeta(chatId)).toBeUndefined();
  });

  it('未注册的 phase (reply / audit_stream / score / tool_call / warn) → 静默', () => {
    const chatId = 'c1';
    createTaskWithActor(chatId, 'q', 'normal');
    const recv = makeReceiver(chatId);

    mapPhaseToStreamEvents({ phase: 'reply' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'audit_stream' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'score' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'tool_call' }, { activeChatId: chatId, ...recv });
    mapPhaseToStreamEvents({ phase: 'warn' }, { activeChatId: chatId, ...recv });

    // 未注册 phase 不产生任何 part, 派生 phase 为 null (无 phase-change part)
    const state = deriveState(chatId);
    expect(state.hasData).toBe(false);
    expect(state.phase).toBeNull();
  });
});
