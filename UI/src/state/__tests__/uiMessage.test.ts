/**
 * uiMessage.test.ts — UIMessage 类型 + 转换 + uiMessageStore 测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  uiMessageToModelMessage,
  uiMessagesToModelMessages,
  extractTextFromUIMessage,
  hasPartType,
  getPartsByType,
  type UIMessage,
  type UIPart,
} from '../../types/messages';
import { streamEventToUIPart, streamEventsToUIParts } from '../../services/eventToUIPart';
import { uiMessageStore } from '../../services/uiMessageStore';
import type { StreamEvent } from '../../types/streaming';

function makeEvent(
  chatId: string,
  kind: StreamEvent['kind'],
  content: string,
  extra?: Partial<StreamEvent>,
): StreamEvent {
  return {
    id: `test-${Math.random().toString(36).slice(2, 8)}`,
    chatId,
    rootTaskId: 'task-test',
    kind,
    content,
    ts: Date.now(),
    status: 'running',
    ...extra,
  };
}

describe('UIMessage 类型转换', () => {
  it('应该将 UIMessage 转换为 ModelMessage (只保留 text/delivery/clarify response)', () => {
    const msg: UIMessage = {
      id: 'msg-1',
      role: 'assistant',
      chatId: 'chat-1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'done',
      parts: [
        { type: 'text', text: 'Hello' },
        { type: 'phase-change', from: 'CLARIFY', to: 'PLANNING', timestamp: Date.now() },
        { type: 'subtask-progress', subTaskId: 'sub-1', progress: 50 },
        { type: 'delivery', result: '最终结果', timestamp: Date.now() },
        { type: 'error', message: '出错了', timestamp: Date.now() },
      ],
    };

    const modelMsg = uiMessageToModelMessage(msg);
    expect(modelMsg.role).toBe('assistant');
    expect(modelMsg.content).toBe('Hello\n最终结果');
    expect(modelMsg.toolCalls).toBeUndefined();
  });

  it('应该过滤掉空内容消息', () => {
    const messages: UIMessage[] = [
      {
        id: 'msg-1', role: 'user', chatId: 'chat-1',
        createdAt: Date.now(), updatedAt: Date.now(), status: 'done',
        parts: [{ type: 'text', text: '用户问题' }],
      },
      {
        id: 'msg-2', role: 'assistant', chatId: 'chat-1',
        createdAt: Date.now(), updatedAt: Date.now(), status: 'done',
        parts: [{ type: 'phase-change', from: 'CLARIFY', to: 'PLANNING', timestamp: Date.now() }],
      },
    ];

    const modelMsgs = uiMessagesToModelMessages(messages);
    expect(modelMsgs).toHaveLength(1);
    expect(modelMsgs[0].content).toBe('用户问题');
  });

  it('应该从 UIMessage 提取纯文本', () => {
    const msg: UIMessage = {
      id: 'msg-1', role: 'assistant', chatId: 'chat-1',
      createdAt: Date.now(), updatedAt: Date.now(), status: 'done',
      parts: [
        { type: 'text', text: '第一段' },
        { type: 'error', message: 'error', timestamp: Date.now() },
        { type: 'text', text: '第二段' },
      ],
    };

    expect(extractTextFromUIMessage(msg)).toBe('第一段第二段');
  });

  it('应该判断是否包含指定类型的 part', () => {
    const msg: UIMessage = {
      id: 'msg-1', role: 'assistant', chatId: 'chat-1',
      createdAt: Date.now(), updatedAt: Date.now(), status: 'done',
      parts: [{ type: 'text', text: 'hello' }],
    };

    expect(hasPartType(msg, 'text')).toBe(true);
    expect(hasPartType(msg, 'error')).toBe(false);
  });

  it('应该获取指定类型的所有 parts', () => {
    const msg: UIMessage = {
      id: 'msg-1', role: 'assistant', chatId: 'chat-1',
      createdAt: Date.now(), updatedAt: Date.now(), status: 'done',
      parts: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
        { type: 'error', message: 'err', timestamp: Date.now() },
      ],
    };

    const textParts = getPartsByType<UIPart>(msg, 'text');
    expect(textParts).toHaveLength(2);
  });
});

describe('streamEventToUIPart', () => {
  it('应该转换 text_chunk 为 UITextPart', () => {
    const event = makeEvent('chat-1', 'text_chunk', 'hello world', { status: 'running' });
    const part = streamEventToUIPart(event);

    expect(part).not.toBeNull();
    expect(part!.type).toBe('text');
    if (part!.type === 'text') {
      expect(part!.text).toBe('hello world');
      expect(part!.streaming).toBe(true);
    }
  });

  it('应该转换 phase_change 为 UIPhaseChangePart', () => {
    const event = makeEvent('chat-1', 'phase_change', 'PLANNING', { detail: '开始规划' });
    const part = streamEventToUIPart(event, 'CLARIFY');

    expect(part).not.toBeNull();
    expect(part!.type).toBe('phase-change');
    if (part!.type === 'phase-change') {
      expect(part!.from).toBe('CLARIFY');
      expect(part!.to).toBe('PLANNING');
      expect(part!.detail).toBe('开始规划');
    }
  });

  it('应该转换 subtask_created', () => {
    const event = makeEvent('chat-1', 'subtask_created', 'gpt-4', {
      subTaskId: 'sub-1',
      detail: '执行搜索',
    });
    const part = streamEventToUIPart(event);

    expect(part).not.toBeNull();
    expect(part!.type).toBe('subtask-created');
  });

  it('应该转换 delivery', () => {
    const event = makeEvent('chat-1', 'delivery', '最终交付内容', { status: 'success' });
    const part = streamEventToUIPart(event);

    expect(part).not.toBeNull();
    expect(part!.type).toBe('delivery');
  });

  it('应该转换 error', () => {
    const event = makeEvent('chat-1', 'error', '出错了', { detail: '连接超时', status: 'error' });
    const part = streamEventToUIPart(event);

    expect(part).not.toBeNull();
    expect(part!.type).toBe('error');
  });

  it('应该对 task_created 返回 null', () => {
    const event = makeEvent('chat-1', 'task_created', '新任务');
    const part = streamEventToUIPart(event);

    expect(part).toBeNull();
  });

  it('应该批量转换并跟踪 phase', () => {
    const events: StreamEvent[] = [
      makeEvent('chat-1', 'phase_change', 'PLANNING'),
      makeEvent('chat-1', 'phase_change', 'DECOMPOSING'),
      makeEvent('chat-1', 'error', '出错了', { status: 'error' }),
    ];

    const parts = streamEventsToUIParts(events, 'CLARIFY');
    expect(parts).toHaveLength(3);
    expect(parts[0].type).toBe('phase-change');
    expect(parts[1].type).toBe('phase-change');
    expect(parts[2].type).toBe('error');
  });
});

describe('uiMessageStore', () => {
  beforeEach(() => {
    uiMessageStore.__reset();
  });

  it('应该创建消息并获取快照', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'user');
    expect(msg.role).toBe('user');
    expect(msg.parts).toHaveLength(0);

    const snapshot = uiMessageStore.getSnapshot('chat-1');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].id).toBe(msg.id);
  });

  it('应该追加 part 到消息', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'task-1');
    uiMessageStore.appendPart('chat-1', msg.id, { type: 'text', text: 'hello' });

    const messages = uiMessageStore.getMessages('chat-1');
    expect(messages[0].parts).toHaveLength(1);
    expect(messages[0].parts[0].type).toBe('text');
  });

  it('应该累积 text_chunk 到最后的 streaming text part', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'task-1');
    uiMessageStore.appendTextChunk('chat-1', msg.id, 'Hello ', true);
    uiMessageStore.appendTextChunk('chat-1', msg.id, 'World', true);

    const messages = uiMessageStore.getMessages('chat-1');
    expect(messages[0].parts).toHaveLength(1);
    if (messages[0].parts[0].type === 'text') {
      expect(messages[0].parts[0].text).toBe('Hello World');
    }
  });

  it('应该完成消息并停止 streaming', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'task-1');
    uiMessageStore.appendTextChunk('chat-1', msg.id, 'hello', true);
    uiMessageStore.completeMessage('chat-1', msg.id, 'done');

    const messages = uiMessageStore.getMessages('chat-1');
    expect(messages[0].status).toBe('done');
    if (messages[0].parts[0].type === 'text') {
      expect(messages[0].parts[0].streaming).toBe(false);
    }
  });

  it('应该获取最后一条 assistant 消息', () => {
    uiMessageStore.createMessage('chat-1', 'user');
    const assistantMsg = uiMessageStore.createMessage('chat-1', 'assistant');

    const last = uiMessageStore.getLastAssistantMessage('chat-1');
    expect(last).toBeDefined();
    expect(last!.id).toBe(assistantMsg.id);
  });

  it('应该序列化和反序列化', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'task-1');
    uiMessageStore.appendPart('chat-1', msg.id, { type: 'text', text: 'test' });

    const serialized = uiMessageStore.serialize('chat-1');
    expect(serialized).toContain('test');

    uiMessageStore.clearChat('chat-1');
    expect(uiMessageStore.getMessages('chat-1')).toHaveLength(0);

    uiMessageStore.deserialize('chat-1', serialized);
    const messages = uiMessageStore.getMessages('chat-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toHaveLength(1);
  });

  it('应该通过 appendEventAsPart 从 StreamEvent 追加 part', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'task-1');
    const event = makeEvent('chat-1', 'phase_change', 'PLANNING');
    uiMessageStore.appendEventAsPart('chat-1', msg.id, event, 'CLARIFY');

    const messages = uiMessageStore.getMessages('chat-1');
    expect(messages[0].parts).toHaveLength(1);
    expect(messages[0].parts[0].type).toBe('phase-change');
  });

  it('应该提供稳定的快照引用 (不变时返回同一引用)', () => {
    uiMessageStore.createMessage('chat-1', 'user');
    const snap1 = uiMessageStore.getSnapshot('chat-1');
    const snap2 = uiMessageStore.getSnapshot('chat-1');
    expect(snap1).toBe(snap2); // 同一引用
  });
});
