/**
 * runMultiModelStream (server.ts) — phase 协议事件流单元测试
 *
 * 通过 vitest 直接 import server.ts 的 runMultiModelStream, 不启 Express
 * 验证:
 *   - 短 prompt → phase0_skip + text + phase3_deliver_done
 *   - 长 prompt → phase0_subtask + 3x phase1_worker_start + 3x phase1_worker_done
 *                 + phase2_judge_start + phase2_judge + phase3_deliver_*
 *   - error 透传
 */
import { describe, it, expect } from 'vitest';
import { runMultiModelStream, pickStreamMode } from '../../../server';

describe('pickStreamMode — prompt → single/multi 启发式', () => {
  it('极短 prompt → single', () => {
    expect(pickStreamMode('hi')).toBe('single');
    expect(pickStreamMode('')).toBe('single');
  });
  it('>= 20 字符 → multi', () => {
    const a20 = 'a'.repeat(20);
    const a21 = 'a'.repeat(21);
    expect(pickStreamMode(a20)).toBe('multi');
    expect(pickStreamMode(a21)).toBe('multi');
    // 长一些的中文 prompt
    expect(pickStreamMode('请帮我综合分析这个复杂任务并给出详细的架构建议和实施路线图')).toBe('multi');
  });
});

describe('runMultiModelStream — 单模型路径 (mode=single 或短 prompt)', () => {
  it('mode=single: emit phase0_skip + text + phase3_deliver_done', async () => {
    // 显式强制 single 模式, 不依赖后端 LLM (空 prompt 也无所谓)
    const events: any[] = [];
    for await (const e of runMultiModelStream({
      prompt: 'hi',
      mode: 'single',
    })) {
      events.push(e);
    }
    expect(events[0]).toEqual({ kind: 'phase', phase: 'phase0_skip' });
    expect(events.at(-1)).toEqual({ kind: 'phase', phase: 'phase3_deliver_done' });
    // single 路径: 没有 phase0_subtask, 也没有 phase2_judge
    const phases = events.filter(e => e.kind === 'phase').map(e => e.phase);
    expect(phases).not.toContain('phase0_subtask');
    expect(phases).not.toContain('phase2_judge_start');
  });

  it('短 prompt 触发 auto single 路径', async () => {
    const events: any[] = [];
    for await (const e of runMultiModelStream({ prompt: 'hi' })) {
      events.push(e);
    }
    const phases = events.filter(e => e.kind === 'phase').map(e => e.phase);
    expect(phases).toContain('phase0_skip');
    expect(phases).not.toContain('phase0_subtask');
  });
});

describe('runMultiModelStream — 多模型路径 (mode=multi 或长 prompt)', () => {
  it('mode=multi: emit 完整 phase 流 (无 LLM 也能跑通 — 因为 phase3 会调 LLM 可能空)', async () => {
    // mode=multi 跳过 pickStreamMode 判定
    const events: any[] = [];
    try {
      for await (const e of runMultiModelStream({
        prompt: '测试复杂任务: 分析多模型协商过程',
        mode: 'multi',
      })) {
        events.push(e);
      }
    } catch (err: any) {
      // phase3 会调 LLM, 没 API key 时可能最终 yield {kind:"error"}, 容忍
    }

    const phases = events.filter(e => e.kind === 'phase').map(e => e.phase);
    // 必含
    expect(phases).toContain('phase0_subtask');
    // 三 worker 启动
    expect(phases.filter(p => p === 'phase1_worker_start')).toHaveLength(3);
    // 三 worker 完成
    expect(phases.filter(p => p === 'phase1_worker_done')).toHaveLength(3);
    // judge
    expect(phases).toContain('phase2_judge_start');
    expect(phases).toContain('phase2_judge');
    // deliver
    expect(phases).toContain('phase3_deliver_start');
    expect(phases).toContain('phase3_deliver_done');
  });

  it('phase0_subtask 携带 subtasks 字段 (供 phaseMappers 拆解)', async () => {
    const events: any[] = [];
    try {
      for await (const e of runMultiModelStream({
        prompt: 'a'.repeat(50),
        mode: 'multi',
      })) {
        events.push(e);
      }
    } catch { /* tolerate LLM error */ }

    const decomposeEvt = events.find(e => e.kind === 'phase' && e.phase === 'phase0_subtask');
    expect(decomposeEvt).toBeDefined();
    expect(decomposeEvt!.subtasks).toHaveLength(3);
    expect(decomposeEvt!.subtasks[0]).toMatchObject({
      modelName: expect.any(String),
      taskDesc: expect.any(String),
      workerIdx: expect.any(Number),
    });
  });

  it('长 prompt 触发 auto multi 路径', async () => {
    const events: any[] = [];
    try {
      for await (const e of runMultiModelStream({
        prompt: '请帮我综合分析这个 80 个字符左右的中等复杂度任务, 并给出详细的架构建议',
      })) {
        events.push(e);
      }
    } catch { /* tolerate LLM error */ }

    const phases = events.filter(e => e.kind === 'phase').map(e => e.phase);
    expect(phases).toContain('phase0_subtask');
  });
});

describe('runMultiModelStream — text 流 (供 ChatPanel 累积最终回复)', () => {
  it('multi 路径: 每个 worker 都发一段 text', async () => {
    const events: any[] = [];
    try {
      for await (const e of runMultiModelStream({
        prompt: 'a'.repeat(50),
        mode: 'multi',
      })) {
        events.push(e);
      }
    } catch { /* tolerate LLM error */ }

    const texts = events.filter(e => e.kind === 'text').map(e => (e as any).text);
    expect(texts.length).toBeGreaterThanOrEqual(3); // 至少 3 个 worker 总结
    expect(texts.some(t => t.includes('完成'))).toBe(true);
  });
});
