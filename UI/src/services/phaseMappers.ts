/**
 * phaseMappers.ts — 后端 SSE phase 事件 → 流送 StreamEvent 的翻译层
 *
 * 替代原 ChatPanel 内的 pushStreamEventForPhase switch (200+ 行),
 * 拆为可测试、可配置、可扩展的纯函数模块。
 *
 * 设计:
 *   - 不依赖 React, 不依赖 ChatPanel 闭包
 *   - 依赖通过 PhaseMapperContext 注入 (activeChatId + store actions)
 *   - phase 名 → 调 pushStreamEvent 列表
 *   - 兼容 Ensemble s3.3 phase (phase0_*) + 旧版 phase (dispatch/worker_*)
 */
import type { StreamEvent, StreamEventKind } from '../types/streaming';

export interface PhaseMapperContext {
  activeChatId: string;
  /** 推送单个流送事件到 store */
  pushStreamEvent: (kind: StreamEventKind, extra?: Partial<StreamEvent>) => void;
  /** 取 workerIdx 对应的 subTaskId */
  getSubTaskId: (chatId: string, workerIdx: number) => string | undefined;
  /** 把 workerIdx → subTaskId 反向绑定 (新子任务创建时调用) */
  bindSubTask: (chatId: string, workerIdx: number, subTaskId: string) => void;
  /** 生成新的 subTaskId (替代 getLastSubTaskId 反查) */
  newSubTaskId: () => string;
}

/**
 * SSE phase → 流送事件的翻译入口
 * 行为: 无 phase 字段的事件直接 return, 其他按 type 派发到对应 mapper
 */
export function mapPhaseToStreamEvents(evt: any, ctx: PhaseMapperContext): void {
  if (!evt?.phase) return;
  const handler = PHASE_MAPPERS[evt.phase];
  if (handler) {
    handler(evt, ctx);
  }
  // 未注册的 phase 静默忽略 (reply / audit_stream / score / tool_call / warn 等非关键事件)
}

/**
 * 取最新一个 subtask 进度事件 (workerIdx 对应的)
 */
function pushWorkerProgress(ctx: PhaseMapperContext, workerIdx: number, content: string, progress: number, status: 'running' | 'success' | 'error', detail?: string) {
  ctx.pushStreamEvent('subtask_progress', {
    subTaskId: ctx.getSubTaskId(ctx.activeChatId, workerIdx),
    content,
    progress,
    status,
    detail,
  });
}

/**
 * 拆解 + 分发阶段 (新协议 / 旧协议共用)
 * @param subtasks 旧协议: string[] (model 名); 新协议: Array<{modelName, taskDesc, workerIdx}>
 */
function decomposeAndDispatch(subtasks: any[], ctx: PhaseMapperContext, detailSuffix = '') {
  ctx.pushStreamEvent('phase_change', {
    content: 'DECOMPOSING',
    detail: `拆解为 ${subtasks.length} 个子任务${detailSuffix}`,
    status: 'running',
  });
  for (let i = 0; i < subtasks.length; i++) {
    const s = subtasks[i];
    // 兼容旧版 (string[]) + 新版 (object[])
    const modelName: string = typeof s === 'string' ? s : (s.modelName ?? `worker-${s.workerIdx ?? i}`);
    const taskDesc: string = typeof s === 'string' ? `Worker ${i}` : (s.taskDesc ?? `Worker ${s.workerIdx ?? i}`);
    const workerIdx: number = typeof s === 'string' ? i : (s.workerIdx ?? i);

    // 生成 subTaskId 放入 event, 不再反查 store
    const subId = ctx.newSubTaskId();
    // 从后端事件读取真实 agentId (后端 phase0_subtask 生成), 回退到占位符
    const agentId: string | undefined = typeof s === 'object' ? s.agentId : undefined;
    ctx.pushStreamEvent('subtask_created', {
      agentId: agentId ?? `agent-${workerIdx}`,
      content: modelName,
      detail: taskDesc,
      status: 'pending',
      subTaskId: subId,
    });
    ctx.bindSubTask(ctx.activeChatId, workerIdx, subId);
  }
  ctx.pushStreamEvent('phase_change', {
    content: 'DISPATCHING',
    detail: '分发给子任务',
    status: 'running',
  });
}

/**
 * 全部 phase mapper 字典
 * 加新 phase: 加一行 key + handler 函数
 */
const PHASE_MAPPERS: Record<string, (evt: any, ctx: PhaseMapperContext) => void> = {
  // ── Ensemble s3.3 phase ──
  phase0_skip: (_, ctx) => {
    ctx.pushStreamEvent('phase_change', {
      content: 'SINGLE_MODEL',
      detail: '单模型模式: 直接推理',
      status: 'running',
    });
  },

  phase0_subtask: (evt, ctx) => {
    decomposeAndDispatch(evt.subtasks ?? [], ctx);
  },

  phase1_worker_start: (evt, ctx) => {
    pushWorkerProgress(ctx, evt.workerIdx, 'started', 10, 'running');
  },

  phase1_worker_done: (evt, ctx) => {
    pushStreamEventDone(ctx, evt.workerIdx, evt.content ?? '', 'success', '完成');
  },

  phase1_worker_error: (evt, ctx) => {
    // R1.1 fix: 单 worker 失败只标子任务, 不动根任务 phase
    pushWorkerProgress(ctx, evt.workerIdx, 'EXECUTE', 0, 'error', evt.error || '调用失败');
  },

  phase1_tool_start: (evt, ctx) => {
    const toolName = evt.toolName ?? 'unknown';
    pushWorkerProgress(ctx, evt.workerIdx, `工具调用: ${toolName}`, 30, 'running', `执行 ${toolName}`);
  },

  phase1_tool_done: (evt, ctx) => {
    const toolName = evt.toolName ?? 'unknown';
    const result = evt.result ?? '';
    const preview = result.length > 100 ? result.slice(0, 100) + '...' : result;
    pushWorkerProgress(ctx, evt.workerIdx, `工具完成: ${toolName}`, 50, 'running', preview);
  },

  phase2_judge_start: (_, ctx) => {
    ctx.pushStreamEvent('phase_change', {
      content: 'REVIEWING',
      detail: '多模型投票审议',
      status: 'running',
    });
  },

  phase2_judge_fallback: (_, ctx) => {
    ctx.pushStreamEvent('phase_change', {
      content: 'REVIEWING',
      detail: '多模型投票审议 (降级到单模型)',
      status: 'running',
    });
  },

  phase2_judge: (evt, ctx) => {
    const chosen = (evt.chosen ?? []).join(', ') || '(无)';
    ctx.pushStreamEvent('phase_change', {
      content: 'REVIEWING',
      detail: `审议: 选中 ${chosen}`,
      status: 'running',
    });
  },

  phase2_judge_error: (evt, ctx) => {
    ctx.pushStreamEvent('phase_change', {
      content: 'REVIEWING',
      status: 'error',
      detail: evt.error || '审议失败',
    });
  },

  phase3_deliver_start: (_, ctx) => {
    ctx.pushStreamEvent('phase_change', {
      content: 'DELIVERING',
      detail: '汇总输出最终答复',
      status: 'running',
    });
  },

  phase3_deliver_done: (_, ctx) => {
    ctx.pushStreamEvent('phase_change', {
      content: 'DONE',
      detail: '任务完成',
      status: 'success',
    });
  },

  // ── 旧版 phase 兼容 ──
  dispatch: (evt, ctx) => {
    // 旧版: subtasks 是 string[] (model 名)
    decomposeAndDispatch(evt.subtasks ?? [], ctx);
  },

  worker_start: (evt, ctx) => {
    pushWorkerProgress(ctx, evt.workerIdx, 'started', 10, 'running');
  },

  worker_done: (evt, ctx) => {
    const isError = (evt.content ?? '').startsWith('⚠️');
    pushStreamEventDone(
      ctx,
      evt.workerIdx,
      evt.content ?? '',
      isError ? 'error' : 'success',
      isError ? evt.content : '完成',
    );
  },

  judge: (evt, ctx) => {
    const chosen = (evt.chosen ?? []).join(', ') || '(无)';
    ctx.pushStreamEvent('phase_change', {
      content: 'REVIEWING',
      detail: `审议: 选中 ${chosen}`,
      status: 'running',
    });
  },

  deliver: (_, ctx) => {
    ctx.pushStreamEvent('phase_change', {
      content: 'DELIVERING',
      detail: '汇总输出',
      status: 'running',
    });
  },

  audit: (_, ctx) => {
    ctx.pushStreamEvent('phase_change', {
      content: 'AUDITING',
      detail: '审计检查',
      status: 'running',
    });
  },

  error: (evt, ctx) => {
    ctx.pushStreamEvent('phase_change', {
      content: 'ERROR',
      status: 'error',
      detail: evt.msg ?? 'Unknown error',
    });
  },
};

function pushStreamEventDone(
  ctx: PhaseMapperContext,
  workerIdx: number,
  content: string,
  status: 'success' | 'error',
  detail: string,
) {
  ctx.pushStreamEvent('subtask_done', {
    subTaskId: ctx.getSubTaskId(ctx.activeChatId, workerIdx),
    content,
    progress: 100,
    status,
    detail,
  });
}
