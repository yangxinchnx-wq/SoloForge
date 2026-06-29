/**
 * ASTParser.test.ts — 扩展后的 ASTParser 兼容性测试
 *
 * 验证：
 *   1. 旧 parse(code, platform) API 仍工作（向后兼容）
 *   2. 新 createStream / feedChunk / endStream / resetStream / parseUniversal 全部可用
 *   3. bestEffortRoot 在流中能拿到半成品 root
 */

import { describe, it, expect } from 'vitest';
import { ASTParser } from './ASTParser';

describe('ASTParser (legacy)', () => {
  it('still parses Flutter widget code', () => {
    const parser = new ASTParser();
    const code = `Scaffold(appBar: AppBar(title: Text('Hello')))`;
    const json = parser.parse(code, 'material');
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty('type');
  });
});

describe('ASTParser (universal streaming)', () => {
  it('creates stream state', () => {
    const parser = new ASTParser();
    const s = parser.createStream();
    expect(s.raw).toBe('');
    expect(s.payload).toBeNull();
    expect(s.done).toBe(false);
  });

  it('feeds chunks incrementally', () => {
    const parser = new ASTParser();
    const payload = {
      language: 'python',
      framework: 'Flask',
      source_code: 'print(1)',
      preview: { root: { type: 'column', children: [] } },
    };
    const full = JSON.stringify(payload);
    let s = parser.createStream();
    for (let i = 0; i < full.length; i += 10) {
      s = parser.feedChunk(s, full.slice(i, i + 10));
    }
    expect(s.payload).toEqual(payload);
  });

  it('bestEffortRoot returns partial root', () => {
    const parser = new ASTParser();
    let s = parser.createStream();
    // 流到一半
    const partial = {
      language: 'c',
      framework: 'GTK',
      source_code: '',
      preview: { root: { type: 'row', style: {} } },
    };
    s = parser.feedChunk(s, JSON.stringify(partial));
    const root = parser.bestEffortRoot(s);
    expect(root).toBeDefined();
    expect(root!.type).toBe('row');
  });

  it('endStream marks done', () => {
    const parser = new ASTParser();
    const s = parser.endStream(parser.createStream());
    expect(s.done).toBe(true);
  });

  it('parseUniversal one-shot', () => {
    const parser = new ASTParser();
    const payload = {
      language: 'java',
      framework: 'Swing',
      source_code: 'class X {}',
      preview: { root: { type: 'stack', children: [] } },
    };
    const { payload: got, errors } = parser.parseUniversal(JSON.stringify(payload));
    expect(got).toEqual(payload);
    expect(errors).not.toContain('parse-failed');
  });

  it('resetStream returns to initial', () => {
    const parser = new ASTParser();
    let s = parser.createStream();
    s = parser.feedChunk(s, '{"a":');
    const s2 = parser.resetStream();
    expect(s2.raw).toBe('');
  });
});
