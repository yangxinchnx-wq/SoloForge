/**
 * streamingStore 单元测试 + 端到端流程模拟
 *
 * 覆盖：
 *   - 任务状态机 (createTask / applyEvent / transitionPhase)
 *   - 子任务生命周期 (subtask_created / progress / done)
 *   - 步骤历史 (stepHistory 应随 progress 事件写入)
 *   - 错误处理 (EXECUTING → ERROR 跃迁必须可达)
 *   - 进度计算 (calcRootProgress 权重正确)
 *   - 多轮对话隔离 (chatA / chatB 互不串扰)
 *   - clearChat 应保留历史
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingStore } from '../streamingStore';
import { calcRootProgress, transitionPhase, PHASE_TRANSITIONS } from '../../types/streaming';
import type { StreamEvent } from '../../types/streaming';

function evt(partial: Partial<StreamEvent>): StreamEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'c1',
    rootTaskId: 'task-x',
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

describe('streamingStore — 任务创建', () => {
  it('createTask: 初始化根任务, phase=CLARIFY, progress=0', () => {
    const task = useStreamingStore.getState().createTask('c1', 'hello', 'normal');
    expect(task.chatId).toBe('c1');
    expect(task.phase).toBe('CLARIFY');
    expect(task.progress).toBe(0);
    expect(task.subTasks).toEqual([]);
    expect(useStreamingStore.getState().tasks.c1?.id).toBe(task.id);
  });

  it('createTask: 同 chatId 二次创建 (旧任务 CLARIFY) 时, 旧任务自动入 history', () => {
    const t1 = useStreamingStore.getState().createTask('c1', 'first', 'normal');
    const t2 = useStreamingStore.getState().createTask('c1', 'second', 'normal');
    // 新任务覆盖 active
    expect(useStreamingStore.getState().tasks.c1?.id).toBe(t2.id);
    expect(useStreamingStore.getState().tasks.c1?.userInput).toBe('second');
    // 旧任务入 history (R2.2 fix)
    expect(useStreamingStore.getState().taskHistory.c1).toHaveLength(1);
    expect(useStreamingStore.getState().taskHistory.c1![0].id).toBe(t1.id);
  });

  it('createTask: 旧任务 DONE 时不归档, 直接覆盖', () => {
    const t1 = useStreamingStore.getState().createTask('c1', 'first', 'normal');
    // 推进到 DONE
    useStreamingStore.getState().applyEvent({
      id: 'e1', chatId: 'c1', rootTaskId: t1.id, kind: 'phase_change',
      content: 'EXECUTING', ts: Date.now(), status: 'running',
    });
    useStreamingStore.getState().applyEvent({
      id: 'e2', chatId: 'c1', rootTaskId: t1.id, kind: 'phase_change',
      content: 'REVIEWING', ts: Date.now(), status: 'running',
    });
    useStreamingStore.getState().applyEvent({
      id: 'e3', chatId: 'c1', rootTaskId: t1.id, kind: 'phase_change',
      content: 'DELIVERING', ts: Date.now(), status: 'running',
    });
    useStreamingStore.getState().applyEvent({
      id: 'e4', chatId: 'c1', rootTaskId: t1.id, kind: 'phase_change',
      content: 'DONE', ts: Date.now(), status: 'success',
    });
    // 旧任务 DONE → 不归档
    const t2 = useStreamingStore.getState().createTask('c1', 'second', 'normal');
    expect(useStreamingStore.getState().tasks.c1?.id).toBe(t2.id);
    expect(useStreamingStore.getState().taskHistory.c1).toBeUndefined();
  });

  it('createTask: 旧任务 EXECUTING 时归档到 history', () => {
    const t1 = useStreamingStore.getState().createTask('c1', 'first', 'normal');
    useStreamingStore.getState().applyEvent({
      id: 'e1', chatId: 'c1', rootTaskId: t1.id, kind: 'phase_change',
      content: 'EXECUTING', ts: Date.now(), status: 'running',
    });
    // 在 EXECUTING 中再发
    const t2 = useStreamingStore.getState().createTask('c1', 'second', 'normal');
    expect(useStreamingStore.getState().tasks.c1?.id).toBe(t2.id);
    expect(useStreamingStore.getState().taskHistory.c1).toHaveLength(1);
    // 旧任务保留其 phase
    expect(useStreamingStore.getState().taskHistory.c1![0].phase).toBe('EXECUTING');
  });
});

describe('streamingStore — 状态机跃迁', () => {
  it('CLARIFY → DECOMPOSING 合法', () => {
    expect(transitionPhase('CLARIFY', 'DECOMPOSING')).toBe('DECOMPOSING');
  });

  it('CLARIFY → DONE 非法', () => {
    expect(transitionPhase('CLARIFY', 'DONE')).toBeNull();
  });

  it('【关键】EXECUTING → ERROR 跃迁当前被拒绝 (BUG)', () => {
    // 当前 PHASE_TRANSITIONS 表格: EXECUTING: ['REVIEWING', 'EXECUTING']
    // 单 worker 失败时任务无法切到 ERROR, 现象: 流送区卡在 EXECUTING 不动
    const result = transitionPhase('EXECUTING', 'ERROR');
    // 这个断言在修复前会失败 - 暴露 bug
    expect(result).toBe('ERROR');
  });

  it('ERROR → CLARIFY 应允许 (重试)', () => {
    expect(transitionPhase('ERROR', 'CLARIFY')).toBe('CLARIFY');
  });

  it('DONE 是终态, 任何跃迁都拒绝', () => {
    expect(transitionPhase('DONE', 'EXECUTING')).toBeNull();
    expect(transitionPhase('DONE', 'DONE')).toBeNull();
  });
});

describe('streamingStore — applyEvent 子任务生命周期', () => {
  beforeEach(() => {
    useStreamingStore.getState().__reset();
    useStreamingStore.getState().createTask('c1', 'task', 'normal');
  });

  it('subtask_created: 追加子任务到 subTasks 末尾', () => {
    const task = useStreamingStore.getState().tasks.c1!;
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', kind: 'subtask_created',
      content: 'Qwen 2.5', detail: '检索资料', agentId: 'agent-0',
    }));
    const subs = useStreamingStore.getState().tasks.c1!.subTasks;
    expect(subs).toHaveLength(1);
    expect(subs[0].assigneeModel).toBe('Qwen 2.5');
    expect(subs[0].description).toBe('检索资料');
    expect(subs[0].status).toBe('pending');
    expect(subs[0].source).toBe('llm');
    void task;
  });

  it('subtask_progress: 更新 progress + 触发 calcRootProgress', () => {
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', kind: 'subtask_created',
      content: 'A', detail: 'A 任务', agentId: 'a-0',
    }));
    const subId = useStreamingStore.getState().tasks.c1!.subTasks[0].id;
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', kind: 'subtask_progress',
      subTaskId: subId, progress: 50, status: 'running',
    }));
    const sub = useStreamingStore.getState().tasks.c1!.subTasks[0];
    expect(sub.progress).toBe(50);
    expect(sub.status).toBe('running');
    expect(useStreamingStore.getState().tasks.c1!.progress).toBeGreaterThan(0);
  });

  it('【关键 BUG】subtask_progress 未写入 stepHistory, 步骤时间线永远空', () => {
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', kind: 'subtask_created',
      content: 'A', detail: 'A 任务', agentId: 'a-0',
    }));
    const subId = useStreamingStore.getState().tasks.c1!.subTasks[0].id;
    // 模拟真实流: 多次 progress 事件, 应填充 stepHistory
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', kind: 'subtask_progress',
      subTaskId: subId, progress: 15, status: 'running', content: 'READ_TASK',
    }));
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', kind: 'subtask_progress',
      subTaskId: subId, progress: 30, status: 'running', content: 'UNDERSTAND',
    }));
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', kind: 'subtask_progress',
      subTaskId: subId, progress: 90, status: 'running', content: 'EXECUTE',
    }));
    const sub = useStreamingStore.getState().tasks.c1!.subTasks[0];
    // 期望 stepHistory 有 3 条 StepRecord (READ_TASK / UNDERSTAND / EXECUTE)
    // 当前实现: stepHistory 永远空数组, SubTaskNode 会显示"等待步骤信息..."
    expect(sub.stepHistory.length).toBeGreaterThan(0);
    // 更精确: 应包含三种 step
    const stepNames = sub.stepHistory.map(s => s.step);
    expect(stepNames).toContain('READ_TASK');
    expect(stepNames).toContain('UNDERSTAND');
    expect(stepNames).toContain('EXECUTE');
  });

  it('subtask_done: 标 done, progress=100, completedAt 有值', () => {
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', kind: 'subtask_created',
      content: 'A', detail: 'A 任务', agentId: 'a-0',
    }));
    const subId = useStreamingStore.getState().tasks.c1!.subTasks[0].id;
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', kind: 'subtask_done',
      subTaskId: subId, content: 'OK', status: 'success',
    }));
    const sub = useStreamingStore.getState().tasks.c1!.subTasks[0];
    expect(sub.status).toBe('done');
    expect(sub.progress).toBe(100);
    expect(sub.completedAt).toBeGreaterThan(0);
    expect(sub.result).toBe('OK');
  });
});

describe('streamingStore — 根任务进度计算', () => {
  it('calcRootProgress: 0 子任务时返回 0', () => {
    const task = useStreamingStore.getState().createTask('c1', 'x', 'normal');
    expect(calcRootProgress(task)).toBe(0);
  });

  it('calcRootProgress: 子任务按长度加权', () => {
    const task = useStreamingStore.getState().createTask('c1', 'x', 'normal');
    task.subTasks = [
      { id: 'a', rootTaskId: 't', assigneeModel: 'A', assigneeModelId: 'a',
        description: 'a'.repeat(50), currentStep: 'EXECUTE', progress: 100,
        stepHistory: [], source: 'llm', status: 'done' },
      { id: 'b', rootTaskId: 't', assigneeModel: 'B', assigneeModelId: 'b',
        description: 'b'.repeat(150), currentStep: 'EXECUTE', progress: 0,
        stepHistory: [], source: 'llm', status: 'pending' },
    ];
    // 权重: 50/50=1.0, 150/50=3, 总权重=4
    // 贡献: 1*1.0 + 0*3 = 1.0, 1.0/4 = 25%
    expect(calcRootProgress(task)).toBe(25);
  });
});

describe('streamingStore — 多轮对话隔离', () => {
  it('不同 chatId 的 task 互不干扰', () => {
    useStreamingStore.getState().createTask('chatA', 'A', 'normal');
    useStreamingStore.getState().createTask('chatB', 'B', 'normal');
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'chatA', kind: 'subtask_created',
      content: 'A1', detail: 'A1 desc', agentId: 'a-0',
    }));
    expect(useStreamingStore.getState().tasks.chatA?.subTasks).toHaveLength(1);
    expect(useStreamingStore.getState().tasks.chatB?.subTasks).toHaveLength(0);
  });

  it('applyEvent 对不存在的 chatId 静默丢弃 (不抛错)', () => {
    expect(() => {
      useStreamingStore.getState().applyEvent(evt({
        chatId: 'nonexistent', kind: 'phase_change', content: 'EXECUTING',
      }));
    }).not.toThrow();
  });
});

describe('streamingStore — clearChat', () => {
  it('【期望】clearChat 后旧任务应进入 taskHistory (当前未实现)', () => {
    useStreamingStore.getState().createTask('c1', 'x', 'normal');
    useStreamingStore.getState().clearChat('c1');
    expect(useStreamingStore.getState().tasks.c1).toBeUndefined();
    // 期望: 旧任务进入 history
    expect(useStreamingStore.getState().taskHistory.c1).toBeDefined();
    expect(useStreamingStore.getState().taskHistory.c1?.[0]?.userInput).toBe('x');
  });
});

describe('streamingStore — 多轮 SSE 端到端模拟 (regression)', () => {
  it('完整流: phase0_subtask → phase1_worker_start → done → phase2_judge → deliver → done', () => {
    const task = useStreamingStore.getState().createTask('c1', 'multi-round test', 'normal');

    // 模拟后端推 phase0_subtask + 3 个 worker
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', rootTaskId: task.id, kind: 'phase_change', content: 'DECOMPOSING',
    }));
    for (let i = 0; i < 3; i++) {
      useStreamingStore.getState().applyEvent(evt({
        chatId: 'c1', rootTaskId: task.id, kind: 'subtask_created',
        content: `model-${i}`, detail: `task ${i}`, agentId: `a-${i}`,
      }));
    }
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', rootTaskId: task.id, kind: 'phase_change', content: 'DISPATCHING',
    }));
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', rootTaskId: task.id, kind: 'phase_change', content: 'EXECUTING',
    }));

    expect(useStreamingStore.getState().tasks.c1!.subTasks).toHaveLength(3);
    expect(useStreamingStore.getState().tasks.c1!.phase).toBe('EXECUTING');

    // 模拟每个 worker 跑完
    for (const sub of useStreamingStore.getState().tasks.c1!.subTasks) {
      useStreamingStore.getState().applyEvent(evt({
        chatId: 'c1', rootTaskId: task.id, kind: 'subtask_progress',
        subTaskId: sub.id, progress: 50, status: 'running',
      }));
      useStreamingStore.getState().applyEvent(evt({
        chatId: 'c1', rootTaskId: task.id, kind: 'subtask_done',
        subTaskId: sub.id, content: 'completed', status: 'success',
      }));
    }

    // 所有 worker 完成 → phase_change REVIEWING → DELIVERING → DONE
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', rootTaskId: task.id, kind: 'phase_change', content: 'REVIEWING',
    }));
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', rootTaskId: task.id, kind: 'phase_change', content: 'DELIVERING',
    }));
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', rootTaskId: task.id, kind: 'phase_change', content: 'DONE',
    }));

    const final = useStreamingStore.getState().tasks.c1!;
    expect(final.phase).toBe('DONE');
    expect(final.subTasks.every(s => s.status === 'done')).toBe(true);
    expect(final.progress).toBe(100);
  });

  it('【关键】单 worker 错误时, 根任务应能进 ERROR 状态 (但当前被锁住)', () => {
    const task = useStreamingStore.getState().createTask('c1', 'err test', 'normal');
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', rootTaskId: task.id, kind: 'subtask_created',
      content: 'model-0', detail: 'task 0', agentId: 'a-0',
    }));
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', rootTaskId: task.id, kind: 'phase_change', content: 'EXECUTING',
    }));
    expect(useStreamingStore.getState().tasks.c1!.phase).toBe('EXECUTING');

    // 模拟 worker 错误: phase_change → ERROR
    useStreamingStore.getState().applyEvent(evt({
      chatId: 'c1', rootTaskId: task.id, kind: 'phase_change',
      content: 'ERROR', status: 'error', detail: 'rate limit',
    }));

    // 期望: 任务进 ERROR
    // 当前实现: transitionPhase('EXECUTING','ERROR') 返回 null, 静默不更新
    expect(useStreamingStore.getState().tasks.c1!.phase).toBe('ERROR');
  });
});
