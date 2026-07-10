/**
 * multiModelStream.ts — 多模型协商流式协议
 *
 * 设计:
 *   - pickStreamMode: 基于 prompt 长度的启发式判定 (single vs multi)
 *   - runMultiModelStream: 异步生成器, yield phase/text 事件
 *
 * Phase 协议:
 *   single: phase0_skip → text → phase3_deliver_done
 *   multi:  phase0_subtask → 3×(phase1_worker_start + text + phase1_worker_done)
 *           → phase2_judge_start → phase2_judge
 *           → phase3_deliver_start → phase3_deliver_done
 *
 * 注: 此模块从 server.ts 抽取, 避免测试导入 server.ts 时启动 Express
 */

export type StreamMode = 'single' | 'multi' | 'auto';

export interface MultiModelStreamEvent {
  kind: 'phase' | 'text';
  phase?: string;
  text?: string;
  subtasks?: SubTaskSpec[];
  workerIdx?: number;
  [k: string]: any;
}

export interface SubTaskSpec {
  modelName: string;
  taskDesc: string;
  workerIdx: number;
}

export interface RunMultiModelStreamOptions {
  prompt: string;
  mode?: StreamMode;
}

/** prompt 长度阈值: >= 此值触发 multi 路径 */
const MULTI_PROMPT_THRESHOLD = 20;

/**
 * 启发式判定: prompt 长度 → single / multi
 *   - 空 / 极短 (< 20 字符) → single (直接单模型回复)
 *   - >= 20 字符 → multi (分解 → 并行 worker → judge → deliver)
 */
export function pickStreamMode(prompt: string): 'single' | 'multi' {
  if (!prompt || prompt.length < MULTI_PROMPT_THRESHOLD) return 'single';
  return 'multi';
}

/** 内置默认 subtask 分配 (无 LLM 依赖, 供测试和 fallback) */
const DEFAULT_SUBTASKS: SubTaskSpec[] = [
  { modelName: 'worker-alpha', taskDesc: '分析需求并生成初始方案', workerIdx: 0 },
  { modelName: 'worker-beta', taskDesc: '验证可行性并优化实现', workerIdx: 1 },
  { modelName: 'worker-gamma', taskDesc: '审查代码质量并提供改进建议', workerIdx: 2 },
];

/**
 * 多模型协商流式生成器
 *
 * 用法:
 *   for await (const event of runMultiModelStream({ prompt, mode: 'auto' })) {
 *     handle(event);
 *   }
 *
 * mode:
 *   - 'single': 强制单模型路径
 *   - 'multi':  强制多模型路径
 *   - 'auto':   由 pickStreamMode(prompt) 决定
 *
 * 注: multi 路径中的 text 事件使用模拟数据 (不调用真实 LLM),
 *     生产环境应替换为真实 LLM 调用结果
 */
export async function* runMultiModelStream(
  opts: RunMultiModelStreamOptions,
): AsyncGenerator<MultiModelStreamEvent> {
  const mode = opts.mode ?? 'auto';
  const effectiveMode = mode === 'auto' ? pickStreamMode(opts.prompt) : mode;

  if (effectiveMode === 'single') {
    // ── 单模型路径: skip decomposition, direct deliver ──
    yield { kind: 'phase', phase: 'phase0_skip' };
    yield { kind: 'text', text: opts.prompt || '(empty)' };
    yield { kind: 'phase', phase: 'phase3_deliver_done' };
    return;
  }

  // ── 多模型路径: decompose → parallel workers → judge → deliver ──
  yield { kind: 'phase', phase: 'phase0_subtask', subtasks: DEFAULT_SUBTASKS };

  for (let i = 0; i < DEFAULT_SUBTASKS.length; i++) {
    const sub = DEFAULT_SUBTASKS[i];
    yield { kind: 'phase', phase: 'phase1_worker_start', workerIdx: i, modelName: sub.modelName };
    yield { kind: 'text', text: `[${sub.modelName}] ${sub.taskDesc} 完成` };
    yield { kind: 'phase', phase: 'phase1_worker_done', workerIdx: i, modelName: sub.modelName };
  }

  yield { kind: 'phase', phase: 'phase2_judge_start' };
  yield { kind: 'text', text: 'judge: 所有 worker 已完成, 综合评判中...' };
  yield { kind: 'phase', phase: 'phase2_judge' };

  yield { kind: 'phase', phase: 'phase3_deliver_start' };
  yield { kind: 'text', text: 'delivery: 结果整合完成' };
  yield { kind: 'phase', phase: 'phase3_deliver_done' };
}
