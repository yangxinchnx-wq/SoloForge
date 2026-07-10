/**
 * uiMessageOpLog.test.ts — uiMessageStore op log + replay 时间旅行回放测试
 *
 * 覆盖:
 *   1. op log 记录: 每个写操作生成 OpLogEntry
 *   2. getOpLog: 按 chatId 隔离
 *   3. replay: 从 op log 重建状态, 不影响当前 store
 *   4. replay(untilTimestamp): 时间旅行到指定时刻
 *   5. appendParts: 批量追加只生成一条 op log
 *   6. clearChat: op log 记录清空, replay 正确处理
 *   7. op log 容量限制: 超出丢弃最早
 *   8. __reset 清理 op log
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { uiMessageStore, type OpLogEntry } from '../uiMessageStore';
import type { UIPart } from '../../types/messages';

describe('uiMessageStore — op log 记录', () => {
  beforeEach(() => {
    uiMessageStore.__reset();
  });

  it('createMessage 生成 createMessage op log', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    const log = uiMessageStore.getOpLog('chat-1');
    expect(log.length).toBe(1);
    expect(log[0].op).toBe('createMessage');
    expect(log[0].chatId).toBe('chat-1');
    expect(log[0].messageId).toBe(msg.id);
    expect(log[0].role).toBe('assistant');
    expect(log[0].rootTaskId).toBe('root-1');
    expect(log[0].partIndex).toBe(1);
  });

  it('appendPart 生成 appendPart op log', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    const part: UIPart = { type: 'phase-change', from: 'CLARIFY', to: 'PLANNING', timestamp: Date.now() };
    uiMessageStore.appendPart('chat-1', msg.id, part);

    const log = uiMessageStore.getOpLog('chat-1');
    expect(log.length).toBe(2);
    expect(log[1].op).toBe('appendPart');
    expect(log[1].part).toEqual(part);
  });

  it('appendParts 批量追加只生成一条 op log', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    const parts: UIPart[] = [
      { type: 'phase-change', from: 'CLARIFY', to: 'PLANNING', timestamp: Date.now() },
      { type: 'subtask-created', subTaskId: 'sub-1', assigneeModel: 'gpt-4', description: '任务1', source: 'llm' },
    ];
    uiMessageStore.appendParts('chat-1', msg.id, parts);

    const log = uiMessageStore.getOpLog('chat-1');
    expect(log.length).toBe(2); // 1 createMessage + 1 appendParts
    expect(log[1].op).toBe('appendParts');
    expect(log[1].parts).toEqual(parts);
  });

  it('appendTextChunk 生成 appendTextChunk op log', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.appendTextChunk('chat-1', msg.id, 'Hello', true);

    const log = uiMessageStore.getOpLog('chat-1');
    expect(log[1].op).toBe('appendTextChunk');
    expect(log[1].text).toBe('Hello');
    expect(log[1].streaming).toBe(true);
  });

  it('completeMessage 生成 completeMessage op log', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.completeMessage('chat-1', msg.id, 'done');

    const log = uiMessageStore.getOpLog('chat-1');
    expect(log[1].op).toBe('completeMessage');
    expect(log[1].status).toBe('done');
  });

  it('clearChat 生成 clearChat op log', () => {
    uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.clearChat('chat-1');

    const log = uiMessageStore.getOpLog('chat-1');
    expect(log[1].op).toBe('clearChat');
  });

  it('op log 按 chatId 隔离', () => {
    uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.createMessage('chat-2', 'assistant', 'root-2');

    expect(uiMessageStore.getOpLog('chat-1').length).toBe(1);
    expect(uiMessageStore.getOpLog('chat-2').length).toBe(1);
    expect(uiMessageStore.getOpLog('chat-3').length).toBe(0);
  });

  it('partIndex 全局递增 (跨 chatId)', () => {
    uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.createMessage('chat-2', 'assistant', 'root-2');

    const log1 = uiMessageStore.getOpLog('chat-1');
    const log2 = uiMessageStore.getOpLog('chat-2');
    expect(log1[0].partIndex).toBe(1);
    expect(log2[0].partIndex).toBe(2);
  });
});

describe('uiMessageStore — replay 时间旅行回放', () => {
  beforeEach(() => {
    uiMessageStore.__reset();
  });

  it('replay 从空 op log 返回空数组', () => {
    expect(uiMessageStore.replay('chat-1')).toEqual([]);
  });

  it('replay 重建完整状态 (createMessage + appendPart)', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    const part: UIPart = { type: 'phase-change', from: 'CLARIFY', to: 'PLANNING', timestamp: Date.now() };
    uiMessageStore.appendPart('chat-1', msg.id, part);

    const rebuilt = uiMessageStore.replay('chat-1');
    expect(rebuilt.length).toBe(1);
    expect(rebuilt[0].id).toBe(msg.id);
    expect(rebuilt[0].role).toBe('assistant');
    expect(rebuilt[0].parts.length).toBe(1);
    expect(rebuilt[0].parts[0]).toEqual(part);
  });

  it('replay 不影响当前 store 状态', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.appendTextChunk('chat-1', msg.id, 'Hello', true);

    const rebuilt = uiMessageStore.replay('chat-1');
    // 修改 rebuilt 不应影响 store
    rebuilt[0].parts = [];
    rebuilt[0].role = 'user';

    const current = uiMessageStore.getMessages('chat-1');
    expect(current[0].role).toBe('assistant');
    expect(current[0].parts.length).toBe(1);
  });

  it('replay 重建 appendTextChunk 累积逻辑', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.appendTextChunk('chat-1', msg.id, 'Hello', true);
    uiMessageStore.appendTextChunk('chat-1', msg.id, ' World', true);
    uiMessageStore.appendTextChunk('chat-1', msg.id, '!', false);

    const rebuilt = uiMessageStore.replay('chat-1');
    expect(rebuilt[0].parts.length).toBe(1); // 累积到同一个 text part
    expect(rebuilt[0].parts[0].type).toBe('text');
    expect((rebuilt[0].parts[0] as any).text).toBe('Hello World!');
    expect((rebuilt[0].parts[0] as any).streaming).toBe(false);
  });

  it('replay(untilTimestamp) 时间旅行到指定时刻', async () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');

    // 记录时间戳 T1
    const t1 = Date.now();
    await new Promise(r => setTimeout(r, 10)); // 确保 t2 > t1

    uiMessageStore.appendPart('chat-1', msg.id, {
      type: 'phase-change', from: 'CLARIFY', to: 'PLANNING', timestamp: Date.now(),
    });

    const t2 = Date.now();
    await new Promise(r => setTimeout(r, 10));

    uiMessageStore.appendPart('chat-1', msg.id, {
      type: 'phase-change', from: 'PLANNING', to: 'EXECUTING', timestamp: Date.now(),
    });

    // 回放到 T1: 只有 createMessage
    const atT1 = uiMessageStore.replay('chat-1', t1);
    expect(atT1.length).toBe(1);
    expect(atT1[0].parts.length).toBe(0);

    // 回放到 T2: 有 createMessage + 第一个 phase-change
    const atT2 = uiMessageStore.replay('chat-1', t2);
    expect(atT2[0].parts.length).toBe(1);
    expect((atT2[0].parts[0] as any).to).toBe('PLANNING');

    // 回放全部: 有 2 个 phase-change
    const atEnd = uiMessageStore.replay('chat-1');
    expect(atEnd[0].parts.length).toBe(2);
  });

  it('replay 重建 appendParts 批量追加', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    const parts: UIPart[] = [
      { type: 'phase-change', from: 'CLARIFY', to: 'PLANNING', timestamp: Date.now() },
      { type: 'subtask-created', subTaskId: 'sub-1', assigneeModel: 'gpt-4', description: '任务1', source: 'llm' },
    ];
    uiMessageStore.appendParts('chat-1', msg.id, parts);

    const rebuilt = uiMessageStore.replay('chat-1');
    expect(rebuilt[0].parts.length).toBe(2);
    expect(rebuilt[0].parts).toEqual(parts);
  });

  it('replay 重建 completeMessage', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.appendTextChunk('chat-1', msg.id, 'Hi', true);
    uiMessageStore.completeMessage('chat-1', msg.id, 'done');

    const rebuilt = uiMessageStore.replay('chat-1');
    expect(rebuilt[0].status).toBe('done');
    // streaming 应被 completeMessage 置为 false
    expect((rebuilt[0].parts[0] as any).streaming).toBe(false);
  });

  it('replay 重建 clearChat (清空后后续 op 继续重建)', () => {
    const msg1 = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.appendTextChunk('chat-1', msg1.id, '旧内容', true);
    uiMessageStore.clearChat('chat-1');

    // clearChat 后再创建新消息
    const msg2 = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.appendTextChunk('chat-1', msg2.id, '新内容', true);

    const rebuilt = uiMessageStore.replay('chat-1');
    // clearChat 后 rebuilt 清空, 只剩 clearChat 之后创建的消息
    expect(rebuilt.length).toBe(1);
    expect(rebuilt[0].id).toBe(msg2.id);
    expect((rebuilt[0].parts[0] as any).text).toBe('新内容');
  });

  it('replay 返回深拷贝 (修改不影响再次 replay)', () => {
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.appendTextChunk('chat-1', msg.id, 'Hello', true);

    const rebuilt1 = uiMessageStore.replay('chat-1');
    (rebuilt1[0].parts[0] as any).text = 'TAMPERED';

    const rebuilt2 = uiMessageStore.replay('chat-1');
    expect((rebuilt2[0].parts[0] as any).text).toBe('Hello');
  });
});

describe('uiMessageStore — op log 容量与清理', () => {
  beforeEach(() => {
    uiMessageStore.__reset();
  });

  it('op log 超出容量丢弃最早', () => {
    // setMaxOpLogSize 最小值 10, 设 15
    uiMessageStore.setMaxOpLogSize(15);
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    // 写 20 个 part, op log 容量 15 (1 createMessage + 14 appendPart)
    for (let i = 0; i < 20; i++) {
      uiMessageStore.appendPart('chat-1', msg.id, {
        type: 'text', text: `chunk-${i}`,
      } as any);
    }

    const log = uiMessageStore.getOpLog('chat-1');
    expect(log.length).toBe(15); // 容量 15
    // 最早被丢弃: createMessage 和前 6 个 appendPart 被丢
    expect(log[0].op).toBe('appendPart');
    expect(log[14].op).toBe('appendPart');
  });

  it('clearOpLog 清除指定 chatId 的 op log', () => {
    uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.createMessage('chat-2', 'assistant', 'root-2');

    uiMessageStore.clearOpLog('chat-1');
    expect(uiMessageStore.getOpLog('chat-1').length).toBe(0);
    expect(uiMessageStore.getOpLog('chat-2').length).toBe(1);
  });

  it('__reset 清理所有 op log', () => {
    uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    uiMessageStore.createMessage('chat-2', 'assistant', 'root-2');

    uiMessageStore.__reset();
    expect(uiMessageStore.getOpLog('chat-1').length).toBe(0);
    expect(uiMessageStore.getOpLog('chat-2').length).toBe(0);
  });

  it('setMaxOpLogSize 最小值 10', () => {
    uiMessageStore.setMaxOpLogSize(1);
    const msg = uiMessageStore.createMessage('chat-1', 'assistant', 'root-1');
    for (let i = 0; i < 15; i++) {
      uiMessageStore.appendPart('chat-1', msg.id, { type: 'text', text: `${i}` } as any);
    }
    const log = uiMessageStore.getOpLog('chat-1');
    expect(log.length).toBe(10); // 最小 10
  });
});
