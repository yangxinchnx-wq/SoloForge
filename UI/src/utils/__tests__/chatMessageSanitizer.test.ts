/**
 * chatMessageSanitizer 单元测试
 * 覆盖：
 *   - avatar 字段强制清空（即使源数据是外链 URL）
 *   - sender / content 不合法时丢弃
 *   - sanitizeConversations 跳过非法条目但保留 key
 */
import { describe, it, expect } from 'vitest';
import { sanitizeChatMessage, sanitizeConversations } from '../chatMessageSanitizer';

describe('sanitizeChatMessage', () => {
  it('强制把 avatar 置空（即使源是 Unsplash URL）', () => {
    const r = sanitizeChatMessage({
      sender: 'user',
      content: 'hello',
      time: '12:00',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=80&fit=crop&q=80',
    });
    expect(r).not.toBeNull();
    expect(r!.avatar).toBe('');
  });

  it('保留 sender / content / time 字段', () => {
    const r = sanitizeChatMessage({
      sender: 'assistant',
      content: 'reply',
      time: '09:13:00',
      avatar: 'https://example.com/avatar.png',
    });
    expect(r).toEqual({
      sender: 'assistant',
      content: 'reply',
      time: '09:13:00',
      avatar: '',
    });
  });

  it('保留合法 attachment', () => {
    const r = sanitizeChatMessage({
      sender: 'user',
      content: 'see file',
      time: '12:00',
      avatar: '',
      attachment: { fileName: 'a.ts', text: 'code' },
    });
    expect(r?.attachment).toEqual({ fileName: 'a.ts', text: 'code' });
  });

  it('拒绝 sender 不是 user/assistant 的对象', () => {
    expect(sanitizeChatMessage({ sender: 'bot', content: 'x' })).toBeNull();
    expect(sanitizeChatMessage({ content: 'no sender' })).toBeNull();
  });

  it('拒绝 content 不是字符串的对象', () => {
    expect(sanitizeChatMessage({ sender: 'user', content: 123 })).toBeNull();
  });

  it('拒绝非对象输入', () => {
    expect(sanitizeChatMessage(null)).toBeNull();
    expect(sanitizeChatMessage(undefined)).toBeNull();
    expect(sanitizeChatMessage('string')).toBeNull();
    expect(sanitizeChatMessage(42)).toBeNull();
  });

  it('attachment 字段不合法时丢弃该字段（不抛错）', () => {
    const r = sanitizeChatMessage({
      sender: 'user',
      content: 'x',
      avatar: '',
      attachment: { fileName: 123, text: null },
    });
    expect(r?.attachment).toBeUndefined();
  });
});

describe('sanitizeConversations', () => {
  it('保留 key，对每条消息应用 sanitize', () => {
    const input = {
      '1': [
        { sender: 'user', content: 'hi', time: '12:00', avatar: 'https://images.unsplash.com/abc' },
        { sender: 'assistant', content: 'reply', time: '12:01', avatar: 'http://x.com/y.jpg' },
      ],
      '2': [],
    };
    const r = sanitizeConversations(input);
    expect(r['1']).toHaveLength(2);
    expect(r['1'][0].avatar).toBe('');
    expect(r['1'][1].avatar).toBe('');
    expect(r['2']).toEqual([]);
  });

  it('非法条目被丢弃，合法条目保留', () => {
    const input = {
      chat: [
        null,
        { sender: 'user', content: 'good', avatar: '' },
        { sender: 'bogus', content: 'bad' },
        { content: 'no sender' },
        'string',
      ],
    };
    const r = sanitizeConversations(input);
    expect(r.chat).toHaveLength(1);
    expect(r.chat[0].content).toBe('good');
  });

  it('非数组的 chat 桶被跳过', () => {
    const r = sanitizeConversations({ a: 'not-array', b: null, c: [{ sender: 'user', content: 'ok' }] });
    expect(r).toEqual({ c: [{ sender: 'user', content: 'ok', time: '', avatar: '' }] });
  });

  it('null / 非对象输入返回空对象', () => {
    expect(sanitizeConversations(null)).toEqual({});
    expect(sanitizeConversations('x')).toEqual({});
    expect(sanitizeConversations(42)).toEqual({});
  });
});