/**
 * parserWorkerClient.ts — 主线程侧的 Worker 客户端
 *
 * 自动 fallback：
 *   - 浏览器 + Worker 可用 → 真用 Worker
 *   - 浏览器 + Worker 不可用 / 失败 → 退到 in-thread
 *   - Node (test/SSR) → 直接 in-thread
 *
 * 用法（与直接 parser 完全兼容）：
 *   import { parserWorkerClient } from './parserWorkerClient';
 *   let state = createStreamState();
 *   state = await parserWorkerClient.feedChunk(state, chunk);
 *
 * 切换开关（feature flag）：
 *   parserWorkerClient.useWorker = false;   // 强制 in-thread
 *   parserWorkerClient.useWorker = true;    // 强制 Worker
 *   // 默认 = 'auto' (能 Worker 就用)
 */

import { feedChunk as feedChunkSync, markDone as markDoneSync, resetStream as resetStreamSync, parseOnce as parseOnceSync, type StreamState } from './StreamingASTParser';

export type WorkerMode = 'auto' | 'worker' | 'thread';

interface PendingRequest {
  resolve: (state: StreamState) => void;
  reject: (err: Error) => void;
}

export class ParserWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending: Map<number, PendingRequest> = new Map();
  private workerBroken = false;
  /** 'auto' = 能用 worker 就用；'worker' = 强制；'thread' = 强制 in-thread */
  public mode: WorkerMode = 'auto';

  /** 实际是否在使用 worker */
  get isUsingWorker(): boolean {
    if (this.mode === 'thread') return false;
    if (this.mode === 'worker') return true;
    // auto
    return this.worker !== null && !this.workerBroken;
  }

  /** 懒加载 worker */
  private ensureWorker(): Worker | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    if (this.mode === 'thread') return null;
    if (typeof Worker === 'undefined') return null; // Node / 非浏览器
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const url = new URL('./StreamingASTParser.worker.ts', import.meta.url);
      this.worker = new Worker(url, { type: 'module' });
      this.worker.addEventListener('message', (ev: MessageEvent) => {
        const msg = ev.data;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.type === 'result') {
          p.resolve(msg.state ?? msg.result);
        } else if (msg.type === 'error') {
          p.reject(new Error(msg.error));
        }
      });
      this.worker.addEventListener('error', (ev: ErrorEvent) => {
        // worker 启动失败 → 标记 broken + 解锁所有等待
        this.workerBroken = true;
        for (const [id, p] of this.pending) {
          p.reject(new Error(`Worker error: ${ev.message}`));
        }
        this.pending.clear();
      });
      return this.worker;
    } catch (err) {
      this.workerBroken = true;
      return null;
    }
  }

  private call<T = StreamState>(type: string, payload: Record<string, unknown>): Promise<T> {
    const w = this.ensureWorker();
    if (!w) {
      // fallback: 同步执行
      return Promise.resolve(this.runSync(type, payload) as T);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as any, reject });
      w.postMessage({ type, id, ...payload });
    });
  }

  /** 同步 fallback（Worker 不可用时执行） */
  private runSync(type: string, payload: Record<string, unknown>): unknown {
    if (type === 'feed') {
      return feedChunkSync(payload.state as StreamState, payload.chunk as string);
    }
    if (type === 'end') {
      return markDoneSync(payload.state as StreamState);
    }
    if (type === 'reset') {
      return resetStreamSync();
    }
    if (type === 'parse') {
      return parseOnceSync(payload.raw as string);
    }
    throw new Error(`ParserWorkerClient.runSync: unknown type ${type}`);
  }

  feedChunk(state: StreamState, chunk: string): Promise<StreamState> {
    return this.call('feed', { state, chunk });
  }

  end(state: StreamState): Promise<StreamState> {
    return this.call('end', { state });
  }

  reset(): Promise<StreamState> {
    return this.call('reset', {});
  }

  parseOnce(raw: string): Promise<{ payload: any; errors: string[] }> {
    return this.call('parse', { raw });
  }

  /** 主动销毁 worker（页面卸载时调用） */
  destroy(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const [, p] of this.pending) {
      p.reject(new Error('ParserWorkerClient destroyed'));
    }
    this.pending.clear();
  }
}

/** 全局默认实例 */
export const parserWorkerClient = new ParserWorkerClient();

/** 测试用：重置内部状态 */
export function _resetParserWorkerClient(): void {
  parserWorkerClient.destroy();
  parserWorkerClient.mode = 'auto';
  // 强制让下次 ensureWorker() 重新尝试
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (parserWorkerClient as any).workerBroken = false;
}
