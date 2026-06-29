/**
 * G fix 专项测试
 * G: 统一 SSE 解析器 (utils/sseStream.ts)
 * 替代原 ChatPanel 内联解析 + handleAcceptEnable 里的 streamSse 函数
 */
import { describe, it, expect, vi } from 'vitest';
import { parseSseStream, parseSseFromStream } from '../sseStream';

/**
 * 构造一个能逐块产出 Uint8Array 的 ReadableStream
 * 模拟后端 SSE 流, 每个 chunk 故意切分在不同位置以测试 buffer 处理
 */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
      }
      controller.close();
    },
  });
}

describe('G: parseSseStream — 基础解析', () => {
  it('单 chunk 单事件, 解析成功', async () => {
    const events: any[] = [];
    await parseSseFromStream(makeStream(['data: {"a":1}\n\n']), (e) => events.push(e));
    expect(events).toEqual([{ a: 1 }]);
  });

  it('多 chunk 多事件按顺序产出', async () => {
    const events: any[] = [];
    await parseSseFromStream(
      makeStream(['data: {"i":0}\n', 'data: {"i":1}\n', 'data: {"i":2}\n\n']),
      (e) => events.push(e)
    );
    expect(events).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it('跨 chunk 边界的事件能正确拼接 (单字符分割)', async () => {
    const events: any[] = [];
    // 把 '{"x":"he|llo"}' 切成两段: '{"x":"he' 和 'llo"}\n'
    await parseSseFromStream(
      makeStream(['data: {"x":"he', 'llo"}\n\n']),
      (e) => events.push(e)
    );
    expect(events).toEqual([{ x: 'hello' }]);
  });

  it('多字节字符在 chunk 边界被切分也能正确拼接 (utf-8)', async () => {
    const events: any[] = [];
    // '中' 是 3 字节 (e4 b8 ad)
    const text = 'data: {"msg":"你好"}\n\n';
    // 在中文中间切
    const cut = text.indexOf('你') + 1; // '你' 是 3 字节 e4 bd a0
    await parseSseFromStream(
      makeStream([text.slice(0, cut), text.slice(cut)]),
      (e) => events.push(e)
    );
    expect(events).toEqual([{ msg: '你好' }]);
  });
});

describe('G: parseSseStream — 协议兼容', () => {
  it('接受 "data: " (带空格) 前缀', async () => {
    const events: any[] = [];
    await parseSseFromStream(makeStream(['data: {"a":1}\n\n']), (e) => events.push(e));
    expect(events).toEqual([{ a: 1 }]);
  });

  it('接受 "data:" (无空格) 前缀 (宽松兼容)', async () => {
    const events: any[] = [];
    await parseSseFromStream(makeStream(['data:{"a":1}\n\n']), (e) => events.push(e));
    expect(events).toEqual([{ a: 1 }]);
  });

  it('跳过 [DONE] 哨兵', async () => {
    const events: any[] = [];
    await parseSseFromStream(
      makeStream(['data: {"a":1}\n', 'data: [DONE]\n\n']),
      (e) => events.push(e)
    );
    expect(events).toEqual([{ a: 1 }]);
  });

  it('接受 CRLF 行终止', async () => {
    const events: any[] = [];
    await parseSseFromStream(
      makeStream(['data: {"a":1}\r\n', 'data: {"b":2}\r\n\r\n']),
      (e) => events.push(e)
    );
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('跳过空行和注释行', async () => {
    const events: any[] = [];
    await parseSseFromStream(
      makeStream(['\n', ': this is a comment\n', 'data: {"a":1}\n', '\n\n']),
      (e) => events.push(e)
    );
    expect(events).toEqual([{ a: 1 }]);
  });

  it('空行作为事件分隔符 (双换行)', async () => {
    const events: any[] = [];
    await parseSseFromStream(
      makeStream(['data: {"a":1}\n\ndata: {"b":2}\n\n']),
      (e) => events.push(e)
    );
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('G: parseSseStream — 错误处理', () => {
  it('非 JSON 行被忽略 (不抛错), 后续正常事件继续', async () => {
    const events: any[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await parseSseFromStream(
      makeStream(['data: not-json\n', 'data: {"a":1}\n\n']),
      (e) => events.push(e)
    );
    expect(events).toEqual([{ a: 1 }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('parse 错误警告只打一次 (避免刷屏)', async () => {
    const events: any[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await parseSseFromStream(
      makeStream([
        'data: bad1\n', 'data: bad2\n', 'data: bad3\n', 'data: bad4\n', 'data: {"ok":1}\n\n',
      ]),
      (e) => events.push(e)
    );
    expect(events).toEqual([{ ok: 1 }]);
    // 只 warn 一次
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('warnOnParseError: false 时静默忽略', async () => {
    const events: any[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await parseSseFromStream(
      makeStream(['data: bad\n', 'data: {"a":1}\n\n']),
      (e) => events.push(e),
      { warnOnParseError: false }
    );
    expect(events).toEqual([{ a: 1 }]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('G: parseSseStream — 流关闭收尾', () => {
  it('流关闭时残余的最后一段 (不带换行) 也能解析', async () => {
    const events: any[] = [];
    await parseSseFromStream(
      makeStream(['data: {"a":1}']),  // 没有 \n
      (e) => events.push(e)
    );
    expect(events).toEqual([{ a: 1 }]);
  });

  it('流关闭时最后一段是 [DONE] 则跳过', async () => {
    const events: any[] = [];
    await parseSseFromStream(
      makeStream(['data: {"a":1}\n', 'data: [DONE]']),  // 最后一段没 \n
      (e) => events.push(e)
    );
    expect(events).toEqual([{ a: 1 }]);
  });

  it('空流: 0 事件, 不抛错', async () => {
    const events: any[] = [];
    await parseSseFromStream(makeStream([]), (e) => events.push(e));
    expect(events).toEqual([]);
  });
});

describe('G: 与原实现对比 — 行为对齐', () => {
  it('支持 event/id/retry 等其他 SSE 字段 (忽略不解析)', async () => {
    const events: any[] = [];
    await parseSseFromStream(
      makeStream([
        'id: 1\n',
        'event: message\n',
        'retry: 3000\n',
        'data: {"a":1}\n\n',
      ]),
      (e) => events.push(e)
    );
    // 只 data: 行被解析
    expect(events).toEqual([{ a: 1 }]);
  });

  it('连续多个 data: 行作为多个独立事件 (浏览器标准行为, 与原实现一致)', async () => {
    const events: any[] = [];
    await parseSseFromStream(
      makeStream(['data: {"a":1}\ndata: {"b":2}\n\n']),
      (e) => events.push(e)
    );
    // 与原内联实现一致: 每行 data: 独立解析
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
