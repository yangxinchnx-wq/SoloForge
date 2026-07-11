/**
 * 流送区可视化烟雾测试 (E2E 链路模拟, 重构后)
 *
 * 目标: 在 Node 环境下完整跑一遍 runChatSse 的代码路径,
 *       把每步状态打出来, 让"看效果"成为可能 (无需浏览器).
 *
 * 链路: mock backend stream → runStreamFlow → dispatchStreamEvent → uiMessageStore.parts
 *
 * 重构变更:
 *   - applyEvent → dispatchStreamEvent
 *   - getLastSubTaskId → newSubTaskId + bindSubTask + getSubTaskId
 *   - tasks[chatId] 断言 → 从 uiMessageStore.parts 派生
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStreamingStore } from '../streamingStore';
import { uiMessageStore } from '../../services/uiMessageStore';
import { taskActorSystem } from '../../services/taskActor';
import { createTaskWithActor, dispatchStreamEvent } from '../../services/actorIntegration';
import type { PhaseMapperContext } from '../../services/phaseMappers';
import type { TaskPhase } from '../../types/streaming';
import type {
  UIPhaseChangePart,
  UISubTaskCreatedPart,
  UISubTaskDonePart,
  UISubTaskStepPart,
  UIDeliveryPart,
  UITextPart,
} from '../../types/messages';

let subIdCounter = 0;

beforeEach(() => {
  useStreamingStore.getState().__reset();
  uiMessageStore.__reset();
  taskActorSystem.reset();
  subIdCounter = 0;
});

// 模拟后端逐块 yield 文本
function mockBackendStream(prompt: string, chunks: string[], opts: {
  finalError?: string;
} = {}) {
  return async (req: any, onEvent: (e: any) => void) => {
    for (const text of chunks) {
      await new Promise(r => setTimeout(r, 1));
      onEvent({ kind: 'text', text, taskId: 'mock-1' });
    }
    if (opts.finalError) {
      onEvent({ kind: 'error', error: opts.finalError, taskId: 'mock-1' });
    } else {
      onEvent({ kind: 'done', taskId: 'mock-1' });
    }
  };
}

// 复刻 ChatPanel.runChatSse 的核心逻辑 (用 dispatchStreamEvent 替换 applyEvent)
async function runStreamFlow(opts: {
  prompt: string;
  mainModel: string;
  mockStream: (req: any, onEvent: (e: any) => void) => Promise<any>;
  chatId: string;
}) {
  const { prompt, mainModel, mockStream, chatId } = opts;
  // 复刻原 runStreamFlow: 若无 task 自动创建 (createTaskWithActor 同步建 Actor + UIMessage)
  if (!useStreamingStore.getState().getStreamTaskMeta(chatId)) {
    createTaskWithActor(chatId, prompt, 'normal');
  }
  const meta = useStreamingStore.getState().getStreamTaskMeta(chatId);
  if (!meta) return;

  const ctx: PhaseMapperContext = {
    activeChatId: chatId,
    pushStreamEvent: (kind, extra = {}) => {
      const m = useStreamingStore.getState().getStreamTaskMeta(chatId);
      if (!m) return;
      dispatchStreamEvent({
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatId,
        rootTaskId: m.rootTaskId,
        kind,
        ts: Date.now(),
        status: 'running',
        content: '',
        ...extra,
      } as any);
    },
    getSubTaskId: (cid, wIdx) => useStreamingStore.getState().getSubTaskId(cid, wIdx),
    bindSubTask: (cid, wIdx, subId) => useStreamingStore.getState().bindSubTask(cid, wIdx, subId),
    newSubTaskId: () => `sub-smoke-${++subIdCounter}`,
  };

  let isFirstChunk = true;
  let textAccumulated = '';
  let subId: string | undefined;

  await mockStream({ prompt, mainModel }, async (evt) => {
    if (evt.kind === 'text' && evt.text) {
      textAccumulated += evt.text;
      if (isFirstChunk) {
        isFirstChunk = false;
        subId = ctx.newSubTaskId();
        ctx.bindSubTask(chatId, 0, subId);
        ctx.pushStreamEvent('phase_change', {
          content: 'SINGLE_MODEL',
          detail: '单模型直接生成',
          status: 'running',
        });
        ctx.pushStreamEvent('subtask_created', {
          subTaskId: subId,
          agentId: 'main-model',
          content: mainModel,
          detail: '生成回复',
          status: 'pending',
        });
        ctx.pushStreamEvent('subtask_step', {
          subTaskId: subId,
          content: 'EXECUTE',
          status: 'running',
        });
      }
      ctx.pushStreamEvent('text_chunk', {
        subTaskId: subId,
        content: evt.text,
        status: 'running',
      });
    } else if (evt.kind === 'done') {
      if (subId) {
        ctx.pushStreamEvent('subtask_done', {
          subTaskId: subId,
          content: textAccumulated,
          progress: 100,
          status: 'success',
        });
      }
      ctx.pushStreamEvent('delivery', { content: textAccumulated });
      ctx.pushStreamEvent('phase_change', {
        content: 'DONE',
        detail: '生成完成',
        status: 'success',
      });
    } else if (evt.kind === 'error') {
      ctx.pushStreamEvent('phase_change', {
        content: 'ERROR',
        detail: evt.error,
        status: 'error',
      });
    }
  });
}

// ── 从 parts 派生状态 (用于 snapshot / 断言) ──
function deriveFromParts(chatId: string) {
  const msg = uiMessageStore.getLastAssistantMessage(chatId);
  if (!msg) return { phase: null as TaskPhase | null, subTaskCount: 0, doneStatus: null as string | null, progress: 0, deliverResult: undefined as string | undefined, stepHistory: [] as string[], textLength: 0 };
  let phase: TaskPhase | null = null;
  let subTaskCount = 0;
  let doneStatus: string | null = null;
  let progress = 0;
  let deliverResult: string | undefined;
  const stepHistory: string[] = [];
  let textLength = 0;
  for (const part of msg.parts) {
    if (part.type === 'phase-change') {
      phase = (part as UIPhaseChangePart).to as TaskPhase;
    } else if (part.type === 'subtask-created') {
      subTaskCount++;
    } else if (part.type === 'subtask-done') {
      doneStatus = (part as UISubTaskDonePart).status;
      progress = 100;
    } else if (part.type === 'subtask-step') {
      stepHistory.push((part as UISubTaskStepPart).step);
    } else if (part.type === 'delivery') {
      deliverResult = (part as UIDeliveryPart).result;
    } else if (part.type === 'text') {
      textLength += (part as UITextPart).text.length;
    }
  }
  return { phase, subTaskCount, doneStatus, progress, deliverResult, stepHistory, textLength };
}

function snapshot(label: string, chatId: string) {
  const s = deriveFromParts(chatId);
  console.log(`  [${label}]`);
  console.log(`    phase:        ${s.phase}`);
  console.log(`    subTaskCount: ${s.subTaskCount}`);
  console.log(`    doneStatus:   ${s.doneStatus}`);
  console.log(`    progress:     ${s.progress}%`);
  console.log(`    stepHistory:  ${s.stepHistory.join(', ') || '(无)'}`);
  if (s.deliverResult !== undefined) {
    const r = s.deliverResult;
    console.log(`    deliverResult: ${JSON.stringify(r.slice(0, 80))}${r.length > 80 ? '...' : ''}`);
  }
  console.log(`    textLength:   ${s.textLength}`);
}

describe('流送区 E2E 烟雾测试 — 看效果', () => {
  it('场景 1: 真实文本流 (5 块) → 流送区打字机 → 完成', async () => {
    const chatId = 'e2e-1';
    console.log('\n━━━ 场景 1: 单模型 5 块文本流 ━━━\n');
    createTaskWithActor(chatId, '帮我设计一个登录页', 'normal');

    const mockStream = mockBackendStream('帮我设计一个登录页', [
      '好的，',
      '我来帮你设计一个登录页。\n',
      '首先需要确定 UI 风格，',
      '然后考虑响应式断点，',
      '最后实现表单提交。',
    ]);

    snapshot('初始', chatId);

    await runStreamFlow({
      prompt: '帮我设计一个登录页',
      mainModel: 'Claude Opus 4.7',
      mockStream,
      chatId,
    });

    snapshot('完成', chatId);

    // 验证最终状态 (从 parts 派生)
    const s = deriveFromParts(chatId);
    expect(s.phase).toBe('DONE');
    expect(s.subTaskCount).toBe(1);
    expect(s.doneStatus).toBe('done');
    expect(s.progress).toBe(100);
    expect(s.deliverResult).toBe('好的，我来帮你设计一个登录页。\n首先需要确定 UI 风格，然后考虑响应式断点，最后实现表单提交。');
    expect(s.stepHistory.length).toBeGreaterThan(0);
    expect(s.stepHistory[0]).toBe('EXECUTE');
  });

  it('场景 2: 后端报错 → 流送区显示 ERROR', async () => {
    const chatId = 'e2e-2';
    console.log('\n━━━ 场景 2: 后端报错 ━━━\n');

    const mockStream = mockBackendStream('hi', ['hel'], { finalError: 'rate limit exceeded' });

    await runStreamFlow({
      prompt: 'hi',
      mainModel: 'GPT-4o',
      mockStream,
      chatId,
    });

    snapshot('错误后', chatId);
    expect(deriveFromParts(chatId).phase).toBe('ERROR');
  });

  it('场景 3: 真实文本流 (10 块) → 验证流式累积完成', async () => {
    const chatId = 'e2e-3';
    console.log('\n━━━ 场景 3: 10 块流式累积 ━━━\n');

    const chunks: string[] = [];
    for (let i = 0; i < 10; i++) {
      chunks.push(`块${i + 1}：` + 'x'.repeat(20) + '\n');
    }
    const mockStream = mockBackendStream('q', chunks);

    await runStreamFlow({ prompt: 'q', mainModel: 'Gemini', mockStream, chatId });

    const s = deriveFromParts(chatId);
    expect(s.phase).toBe('DONE');
    expect(s.doneStatus).toBe('done');
    expect(s.textLength).toBe(chunks.join('').length);
  });

  it('场景 4: 空流（0 块直接 done）→ 只有 delivery + DONE part', async () => {
    const chatId = 'e2e-4';
    console.log('\n━━━ 场景 4: 空流 ━━━\n');

    const mockStream = mockBackendStream('q', []);

    await runStreamFlow({ prompt: 'q', mainModel: 'M', mockStream, chatId });

    snapshot('空流后', chatId);
    const s = deriveFromParts(chatId);
    // 空流: 没有 text 块, 不会创建子任务 (isFirstChunk 未触发)
    // done 事件仍推 delivery + phase_change(DONE), dispatchStreamEvent 直接落 part (无跃迁校验)
    expect(s.subTaskCount).toBe(0);
    expect(s.phase).toBe('DONE');
    expect(s.deliverResult).toBe('');
  });
});
