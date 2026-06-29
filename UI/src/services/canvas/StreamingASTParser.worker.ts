/**
 * StreamingASTParser.worker.ts — Web Worker 版本的流式解析器
 *
 * 主线程调用方：
 *   import { parserWorkerClient } from './parserWorkerClient';
 *   const state = await parserWorkerClient.feedChunk(prevState, chunk);
 *
 * Worker 协议（message 双向）：
 *   主 → Worker: { type: 'feed', id, state, chunk }
 *          |     { type: 'end', id, state }
 *          |     { type: 'reset', id }
 *   Worker → 主: { type: 'result', id, state }
 *              | { type: 'error', id, error }
 */

import { feedChunk, markDone, resetStream, type StreamState, parseOnce } from './StreamingASTParser';

interface FeedRequest { type: 'feed'; id: number; state: StreamState; chunk: string }
interface EndRequest { type: 'end'; id: number; state: StreamState }
interface ResetRequest { type: 'reset'; id: number }
interface ParseRequest { type: 'parse'; id: number; raw: string }

type Request = FeedRequest | EndRequest | ResetRequest | ParseRequest;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx: DedicatedWorkerGlobalScope = self as any;

ctx.addEventListener('message', (ev: MessageEvent<Request>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'feed') {
      const next = feedChunk(msg.state, msg.chunk);
      ctx.postMessage({ type: 'result', id: msg.id, state: next });
    } else if (msg.type === 'end') {
      const next = markDone(msg.state);
      ctx.postMessage({ type: 'result', id: msg.id, state: next });
    } else if (msg.type === 'reset') {
      const next = resetStream();
      ctx.postMessage({ type: 'result', id: msg.id, state: next });
    } else if (msg.type === 'parse') {
      const r = parseOnce(msg.raw);
      ctx.postMessage({ type: 'result', id: msg.id, result: r });
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
