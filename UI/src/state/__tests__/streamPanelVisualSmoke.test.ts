/**
 * 流送区可视化烟雾测试 (E2E 链路模拟)
 *
 * 目标: 在 Node 环境下完整跑一遍 runChatSse 的代码路径,
 *       把每步状态打出来, 让"看效果"成为可能 (无需浏览器).
 *
 * 链路: mock aiStartChat → runChatSse-like logic → applyEvent → store 状态变更
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingStore } from '../streamingStore';
import { mapPhaseToStreamEvents, type PhaseMapperContext } from '../../services/phaseMappers';

beforeEach(() => {
  useStreamingStore.getState().__reset();
});

// 模拟后端逐块 yield 文本
function mockBackendStream(prompt: string, chunks: string[], opts: {
  finalError?: string;
  onPhaseEvent?: (evt: any) => void;
} = {}) {
  return async (req: any, onEvent: (e: any) => void) => {
    // 模拟 SSE 协议
    for (const text of chunks) {
      // 模拟网络延迟
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

// 复刻 ChatPanel.runChatSse 的核心逻辑 (用 mock 替换 aiStartChat)
async function runStreamFlow(opts: {
  prompt: string;
  mainModel: string;
  mockStream: (req: any, onEvent: (e: any) => void) => Promise<any>;
  chatId: string;
}) {
  const { prompt, mainModel, mockStream, chatId } = opts;
  const store = useStreamingStore.getState();
  if (!store.tasks[chatId]) {
    store.createTask(chatId, prompt, 'normal');
  }
  const task = useStreamingStore.getState().tasks[chatId];

  const ctx: PhaseMapperContext = {
    activeChatId: chatId,
    pushStreamEvent: (kind, extra = {}) => {
      const t = useStreamingStore.getState().tasks[chatId];
      if (!t) return;
      useStreamingStore.getState().applyEvent({
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatId,
        rootTaskId: t.id,
        kind,
        ts: Date.now(),
        status: 'running',
        content: '',
        ...extra,
      } as any);
    },
    getSubTaskId: (cid, wIdx) => useStreamingStore.getState().getSubTaskId(cid, wIdx),
    bindSubTask: (cid, wIdx, subId) => useStreamingStore.getState().bindSubTask(cid, wIdx, subId),
    getLastSubTaskId: () => useStreamingStore.getState().getLastSubTaskId(chatId),
  };

  let isFirstChunk = true;
  let textAccumulated = '';

  await mockStream({ prompt, mainModel }, async (evt) => {
    if (evt.kind === 'text' && evt.text) {
      textAccumulated += evt.text;
      if (isFirstChunk) {
        isFirstChunk = false;
        ctx.pushStreamEvent('phase_change', {
          content: 'SINGLE_MODEL',
          detail: '单模型直接生成',
          status: 'running',
        });
        ctx.pushStreamEvent('subtask_created', {
          agentId: 'main-model',
          content: mainModel,
          detail: '生成回复',
          status: 'pending',
        });
        const subId = useStreamingStore.getState().getLastSubTaskId(chatId);
        if (subId) {
          ctx.pushStreamEvent('subtask_step', {
            subTaskId: subId,
            content: 'EXECUTE',
            status: 'running',
          });
        }
      }
      ctx.pushStreamEvent('text_chunk', {
        subTaskId: useStreamingStore.getState().getLastSubTaskId(chatId),
        content: evt.text,
        status: 'running',
      });
    } else if (evt.kind === 'done') {
      const subId = useStreamingStore.getState().getLastSubTaskId(chatId);
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

function snapshot(label: string, chatId: string) {
  const task = useStreamingStore.getState().tasks[chatId];
  if (!task) {
    console.log(`  [${label}] task=undefined`);
    return;
  }
  const sub = task.subTasks[0];
  console.log(`  [${label}]`);
  console.log(`    phase:        ${task.phase}`);
  console.log(`    progress:     ${task.progress}%`);
  console.log(`    subTasks:     ${task.subTasks.length}`);
  if (sub) {
    console.log(`    subTask[0]:   status=${sub.status}, progress=${sub.progress}%`);
    console.log(`    description:  "${sub.description}"`);
    console.log(`    assignee:     ${sub.assigneeModel}`);
    console.log(`    textBuffer:   ${JSON.stringify((useStreamingStore.getState().textBuffers[sub.id] ?? '').slice(0, 80))}${(useStreamingStore.getState().textBuffers[sub.id] ?? '').length > 80 ? '...' : ''} (${(useStreamingStore.getState().textBuffers[sub.id] ?? '').length} 字符)`);
    console.log(`    stepHistory:  ${sub.stepHistory.length} 条`);
    sub.stepHistory.forEach((s, i) => {
      console.log(`      [${i}] ${s.step} (${s.status}) - ${s.detail}`);
    });
  }
  if (task.deliverResult) {
    console.log(`    deliverResult: ${JSON.stringify(task.deliverResult.slice(0, 80))}${task.deliverResult.length > 80 ? '...' : ''}`);
  }
}

describe('流送区 E2E 烟雾测试 — 看效果', () => {
  it('场景 1: 真实文本流 (5 块) → 流送区打字机 → 完成', async () => {
    const chatId = 'e2e-1';
    console.log('\n━━━ 场景 1: 单模型 5 块文本流 ━━━\n');

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

    // 验证最终状态
    const task = useStreamingStore.getState().tasks[chatId];
    expect(task.phase).toBe('DONE');
    expect(task.subTasks).toHaveLength(1);
    expect(task.subTasks[0].status).toBe('done');
    expect(task.subTasks[0].progress).toBe(100);
    const sub0 = task.subTasks[0];
    const sub0Id = sub0.id;
    expect(useStreamingStore.getState().textBuffers[sub0Id]).toBe('好的，我来帮你设计一个登录页。\n首先需要确定 UI 风格，然后考虑响应式断点，最后实现表单提交。');
    expect(task.deliverResult).toBe('好的，我来帮你设计一个登录页。\n首先需要确定 UI 风格，然后考虑响应式断点，最后实现表单提交。');
    expect(task.subTasks[0].stepHistory.length).toBeGreaterThan(0);
    expect(task.subTasks[0].stepHistory[0].step).toBe('EXECUTE');
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
    const task = useStreamingStore.getState().tasks[chatId];
    expect(task.phase).toBe('ERROR');
  });

  it('场景 3: 真实文本流 (10 块) → 验证 textBuffers 完整累积', async () => {
    const chatId = 'e2e-3';
    console.log('\n━━━ 场景 3: 10 块流式累积 ━━━\n');

    const chunks: string[] = [];
    for (let i = 0; i < 10; i++) {
      chunks.push(`块${i + 1}：` + 'x'.repeat(20) + '\n');
    }
    const mockStream = mockBackendStream('q', chunks);

    await runStreamFlow({ prompt: 'q', mainModel: 'Gemini', mockStream, chatId });

    const task = useStreamingStore.getState().tasks[chatId];
    const sub0Id = task.subTasks[0].id;
    const finalText = useStreamingStore.getState().textBuffers[sub0Id] ?? '';
    console.log(`\n  最终 textBuffer 长度: ${finalText.length} 字符`);
    console.log(`  预期长度:           ${chunks.join('').length} 字符`);
    expect(finalText).toBe(chunks.join(''));
    expect(task.phase).toBe('DONE');
  });

  it('场景 4: 空流（0 块直接 done）→ 只有 SINGLE_MODEL phase', async () => {
    const chatId = 'e2e-4';
    console.log('\n━━━ 场景 4: 空流 ━━━\n');

    const mockStream = mockBackendStream('q', []);

    await runStreamFlow({ prompt: 'q', mainModel: 'M', mockStream, chatId });

    snapshot('空流后', chatId);
    const task = useStreamingStore.getState().tasks[chatId];
    // 空流: 没有 text 块, 不会进入 SINGLE_MODEL 单模型分支
    // done 事件的 phase_change(DONE) 在 CLARIFY 下不合法 (PHASE_TRANSITIONS), 静默忽略
    // delivery 的 transitionTaskPhase(DONE) 同样被拒
    // → 任务停留在初始 CLARIFY 态
    expect(task.phase).toBe('CLARIFY');  // 仍在初始态
    expect(task.subTasks).toHaveLength(0);  // 没创建子任务
  });
});
