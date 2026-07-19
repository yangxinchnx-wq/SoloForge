/**
 * phaseMappers 测试
 * 验证:
 *   - Ensemble s3.3 phase 名 → 正确的事件序列
 *   - 旧版 phase 名 (dispatch / worker_start / worker_done / judge / deliver) 仍兼容
 *   - 未注册的 phase 静默忽略
 *   - workerIdx → subTaskId 绑定正确触发
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mapPhaseToStreamEvents } from '../phaseMappers';
import type { PhaseMapperContext } from '../phaseMappers';
import type { StreamEvent, StreamEventKind } from '../../types/streaming';

let pushed: Array<{ kind: StreamEventKind; extra: Partial<StreamEvent> }>;
let subTaskBindings: Array<{ chatId: string; workerIdx: number; subTaskId: string }>;
let subTaskById: Map<string, string>;
let subIdCounter: number;

function makeCtx(chatId: string): PhaseMapperContext {
  subTaskById = new Map();
  subIdCounter = 0;
  return {
    activeChatId: chatId,
    pushStreamEvent: (kind, extra) => { pushed.push({ kind, extra: extra ?? {} }); },
    getSubTaskId: (_chatId, workerIdx) => subTaskById.get(`w${workerIdx}`),
    bindSubTask: (chatId, workerIdx, subTaskId) => {
      subTaskBindings.push({ chatId, workerIdx, subTaskId });
      subTaskById.set(`w${workerIdx}`, subTaskId);
    },
    newSubTaskId: () => `sub-${++subIdCounter}`,
  };
}

beforeEach(() => {
  pushed = [];
  subTaskBindings = [];
  subTaskById = new Map();
  subIdCounter = 0;
});

describe('phaseMappers — 边界', () => {
  it('无 phase 字段: 静默', () => {
    const ctx = makeCtx('c1');
    mapPhaseToStreamEvents({ content: 'hello' }, ctx);
    mapPhaseToStreamEvents(null, ctx);
    mapPhaseToStreamEvents(undefined, ctx);
    expect(pushed).toEqual([]);
  });

  it('未知 phase 名: 静默', () => {
    const ctx = makeCtx('c1');
    mapPhaseToStreamEvents({ phase: 'reply' }, ctx);
    mapPhaseToStreamEvents({ phase: 'audit_stream' }, ctx);
    mapPhaseToStreamEvents({ phase: 'score' }, ctx);
    expect(pushed).toEqual([]);
  });
});

describe('phaseMappers — Ensemble s3.3 phase', () => {
  it('phase0_skip → SINGLE_MODEL + subtask_created + subtask_step', () => {
    const ctx = makeCtx('c1');
    mapPhaseToStreamEvents({ phase: 'phase0_skip' }, ctx);
    // ★ 2026-07-19: phase0_skip 现在也创建 subtask + step, 让单模型模式过程有内容
    expect(pushed).toEqual([
      { kind: 'phase_change', extra: { content: 'SINGLE_MODEL', detail: '单模型模式: 直接推理', status: 'running' } },
      { kind: 'subtask_created', extra: { agentId: 'main-model', content: '主模型', detail: '直接推理', status: 'running', subTaskId: 'sub-1' } },
      { kind: 'subtask_step', extra: { subTaskId: 'sub-1', content: 'EXECUTE', status: 'running' } },
    ]);
    // 验证 workerIdx=0 绑定
    expect(subTaskBindings).toEqual([{ chatId: 'c1', workerIdx: 0, subTaskId: 'sub-1' }]);
  });

  it('phase0_subtask → DECOMPOSING + N 个 subtask_created + 绑定 + DISPATCHING', () => {
    const ctx = makeCtx('c1');
    // newSubTaskId 在 makeCtx 中用计数器实现, 每次调用返回 sub-1, sub-2, ...
    mapPhaseToStreamEvents({
      phase: 'phase0_subtask',
      subtasks: [
        { workerIdx: 0, modelName: 'Qwen 2.5', taskDesc: 'collect facts' },
        { workerIdx: 1, modelName: 'Kimi K2', taskDesc: 'search history' },
      ],
    }, ctx);
    // 期望: 1 phase_change (DECOMPOSING) + 2 subtask_created + 2 bindSubTask + 1 phase_change (DISPATCHING)
    expect(pushed.filter(p => p.kind === 'phase_change').map(p => p.extra.content)).toEqual(['DECOMPOSING', 'DISPATCHING']);
    expect(pushed.filter(p => p.kind === 'subtask_created')).toHaveLength(2);
    expect(subTaskBindings).toEqual([
      { chatId: 'c1', workerIdx: 0, subTaskId: 'sub-1' },
      { chatId: 'c1', workerIdx: 1, subTaskId: 'sub-2' },
    ]);
  });

  it('phase1_worker_start → subtask_progress (progress=10)', () => {
    const ctx = makeCtx('c1');
    subTaskById.set('w0', 'sub-0');
    mapPhaseToStreamEvents({ phase: 'phase1_worker_start', workerIdx: 0 }, ctx);
    expect(pushed).toEqual([
      { kind: 'subtask_progress', extra: { subTaskId: 'sub-0', content: 'started', progress: 10, status: 'running' } },
    ]);
  });

  it('phase1_worker_done → subtask_done (progress=100)', () => {
    const ctx = makeCtx('c1');
    subTaskById.set('w0', 'sub-0');
    mapPhaseToStreamEvents({ phase: 'phase1_worker_done', workerIdx: 0, content: 'result text' }, ctx);
    expect(pushed).toEqual([
      { kind: 'subtask_done', extra: { subTaskId: 'sub-0', content: 'result text', progress: 100, status: 'success', detail: '完成' } },
    ]);
  });

  it('phase1_worker_error → subtask_progress (status=error, 不动根任务)', () => {
    const ctx = makeCtx('c1');
    subTaskById.set('w0', 'sub-0');
    mapPhaseToStreamEvents({ phase: 'phase1_worker_error', workerIdx: 0, error: 'rate limit' }, ctx);
    // 关键: 只有 1 个 subtask_progress, 没有 phase_change
    expect(pushed).toEqual([
      { kind: 'subtask_progress', extra: { subTaskId: 'sub-0', content: 'EXECUTE', progress: 0, status: 'error', detail: 'rate limit' } },
    ]);
    expect(pushed.filter(p => p.kind === 'phase_change')).toEqual([]);
  });

  it('phase2_judge → REVIEWING 含 chosen', () => {
    const ctx = makeCtx('c1');
    mapPhaseToStreamEvents({ phase: 'phase2_judge', chosen: ['Qwen 2.5', 'Kimi K2'] }, ctx);
    expect(pushed[0].extra.content).toBe('REVIEWING');
    expect(pushed[0].extra.detail).toContain('Qwen 2.5, Kimi K2');
  });

  it('phase2_judge_start/fallback → REVIEWING', () => {
    const ctx = makeCtx('c1');
    mapPhaseToStreamEvents({ phase: 'phase2_judge_start' }, ctx);
    mapPhaseToStreamEvents({ phase: 'phase2_judge_fallback' }, ctx);
    expect(pushed).toHaveLength(2);
    expect(pushed[0].extra.content).toBe('REVIEWING');
    expect(pushed[1].extra.content).toBe('REVIEWING');
  });

  it('phase3_deliver_done → DONE', () => {
    const ctx = makeCtx('c1');
    mapPhaseToStreamEvents({ phase: 'phase3_deliver_done' }, ctx);
    expect(pushed[0].extra).toEqual({ content: 'DONE', detail: '任务完成', status: 'success' });
  });
});

describe('phaseMappers — 旧版 phase 兼容', () => {
  it('dispatch (旧版: subtasks=string[]) → 拆解+绑定', () => {
    const ctx = makeCtx('c1');
    mapPhaseToStreamEvents({ phase: 'dispatch', subtasks: ['Qwen 2.5', 'Kimi K2'] }, ctx);
    expect(pushed.filter(p => p.kind === 'subtask_created')).toHaveLength(2);
    expect(subTaskBindings).toEqual([
      { chatId: 'c1', workerIdx: 0, subTaskId: 'sub-1' },
      { chatId: 'c1', workerIdx: 1, subTaskId: 'sub-2' },
    ]);
  });

  it('worker_done (旧版) ⚠️ 开头 → 标 error', () => {
    const ctx = makeCtx('c1');
    subTaskById.set('w0', 'sub-0');
    mapPhaseToStreamEvents({ phase: 'worker_done', workerIdx: 0, content: '⚠️ 调用失败' }, ctx);
    expect(pushed[0].extra.status).toBe('error');
  });

  it('worker_done (旧版) 正常 → 标 success', () => {
    const ctx = makeCtx('c1');
    subTaskById.set('w0', 'sub-0');
    mapPhaseToStreamEvents({ phase: 'worker_done', workerIdx: 0, content: 'OK' }, ctx);
    expect(pushed[0].extra.status).toBe('success');
  });

  it('judge → REVIEWING', () => {
    const ctx = makeCtx('c1');
    mapPhaseToStreamEvents({ phase: 'judge', chosen: ['A'] }, ctx);
    expect(pushed[0].extra.content).toBe('REVIEWING');
  });

  it('deliver → DELIVERING', () => {
    const ctx = makeCtx('c1');
    mapPhaseToStreamEvents({ phase: 'deliver' }, ctx);
    expect(pushed[0].extra.content).toBe('DELIVERING');
  });

  it('error phase → ERROR', () => {
    const ctx = makeCtx('c1');
    mapPhaseToStreamEvents({ phase: 'error', msg: 'fatal' }, ctx);
    expect(pushed[0].extra).toEqual({ content: 'ERROR', status: 'error', detail: 'fatal' });
  });
});
