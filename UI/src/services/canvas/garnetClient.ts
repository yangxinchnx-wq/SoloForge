/**
 * garnetClient.ts — Garnet (Redis-compatible) 客户端封装
 *
 * Garnet 是 SoloForge 用的 Redis 协议缓存层（端口 6379）
 * 项目规则：先启动 Garnet → 启动 3001 后端 → 后端自动连接
 *
 * 本客户端：
 *   - 优先尝试连接 Garnet（如果服务在跑）
 *   - 连接失败时自动降级到 null（调用方走内存 fallback）
 *   - 仅暴露 AST 缓存需要的 2 个操作：get/set with TTL
 *
 * 避免依赖 ioredis：
 *   - Garnet 协议兼容 Redis RESP3，最简实现只需 4 个命令
 *   - 用原生 fetch + SSE 也能跑（但太慢）
 *   - 推荐方案：动态 import ioredis（如果装了），否则降级
 *
 * 用法：
 *   const client = await getGarnetClient();
 *   if (client) {
 *     await client.set('key', 'value', 30);
 *     const v = await client.get('key');
 *   }
 */

import type { PreviewPayload } from './UniversalAST';

export interface GarnetLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface GarnetConfig {
  host: string;
  port: number;
  /** 连接超时（默认 1500ms — 失败要快速降级） */
  connectTimeoutMs?: number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 6379;

/**
 * RESP3 协议的最小客户端实现（不依赖 ioredis）
 *
 * 命令格式：
 *   *N\r\n$len\r\nARG\r\n...
 * 响应格式：
 *   +OK\r\n / $-1\r\n (nil) / $len\r\ndata\r\n / :N\r\n (integer)
 *
 * 用途：仅支持 GET / SET with EX / PING / QUIT
 */
class Resp3Client implements GarnetLike {
  private socket: WebSocket | null = null;
  private connPromise: Promise<void> | null = null;
  private closed = false;
  private pendingCommands: Array<{
    resolve: (v: any) => void;
    reject: (e: Error) => void;
  }> = [];
  private buffer = '';

  constructor(private config: GarnetConfig) {}

  private async ensureConn(): Promise<void> {
    if (this.connPromise) return this.connPromise;
    if (this.closed) throw new Error('Garnet client closed');
    this.connPromise = new Promise<void>((resolve, reject) => {
      // 注意：浏览器端 WebSocket 不支持 raw TCP
      // 这里假设宿主环境提供 WebSocket-to-TCP 代理
      // 实际生产建议：动态 import('ioredis')，或在 Node/Electron 主进程连接
      try {
        this.socket = new WebSocket(`ws://${this.config.host}:${this.config.port + 1}`); // +1 = proxy port
      } catch (e) {
        reject(e as Error);
        return;
      }
      const timeoutMs = this.config.connectTimeoutMs ?? 1500;
      const timer = setTimeout(() => {
        reject(new Error(`Garnet connect timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      this.socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Garnet connect failed'));
      };
      this.socket.onclose = () => {
        this.closed = true;
        this.pendingCommands.forEach(({ reject }) => reject(new Error('Garnet closed')));
        this.pendingCommands = [];
      };
      this.socket.onmessage = (ev) => {
        this.buffer += ev.data as string;
        this.handleBuffer();
      };
    });
    return this.connPromise;
  }

  private handleBuffer(): void {
    while (this.buffer.length > 0) {
      const c = this.pendingCommands[0];
      if (!c) break;
      const result = this.parseOne();
      if (result === undefined) break; // 还在等更多数据
      this.pendingCommands.shift();
      c.resolve(result);
    }
  }

  private parseOne(): any {
    if (this.buffer.length === 0) return undefined;
    const type = this.buffer[0];
    if (type === '+') {
      // Simple String
      const end = this.buffer.indexOf('\r\n');
      if (end < 0) return undefined;
      const value = this.buffer.slice(1, end);
      this.buffer = this.buffer.slice(end + 2);
      return value;
    }
    if (type === '-') {
      // Error
      const end = this.buffer.indexOf('\r\n');
      if (end < 0) return undefined;
      const value = this.buffer.slice(1, end);
      this.buffer = this.buffer.slice(end + 2);
      throw new Error(`Garnet error: ${value}`);
    }
    if (type === ':') {
      // Integer
      const end = this.buffer.indexOf('\r\n');
      if (end < 0) return undefined;
      const value = parseInt(this.buffer.slice(1, end), 10);
      this.buffer = this.buffer.slice(end + 2);
      return value;
    }
    if (type === '$') {
      // Bulk String: $len\r\ndata\r\n
      const crlf = this.buffer.indexOf('\r\n');
      if (crlf < 0) return undefined;
      const lenStr = this.buffer.slice(1, crlf);
      const len = parseInt(lenStr, 10);
      if (len === -1) {
        this.buffer = this.buffer.slice(crlf + 2);
        return null;
      }
      const start = crlf + 2;
      const end = start + len;
      if (this.buffer.length < end + 2) return undefined;
      const value = this.buffer.slice(start, end);
      this.buffer = this.buffer.slice(end + 2);
      return value;
    }
    return undefined;
  }

  private async cmd(...args: string[]): Promise<any> {
    await this.ensureConn();
    if (!this.socket) throw new Error('Garnet not connected');
    const encoded = this.encode(args);
    return new Promise((resolve, reject) => {
      this.pendingCommands.push({ resolve, reject });
      this.socket!.send(encoded);
    });
  }

  private encode(args: string[]): string {
    let s = `*${args.length}\r\n`;
    for (const a of args) {
      s += `$${a.length}\r\n${a}\r\n`;
    }
    return s;
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.cmd('PING');
      return r === 'PONG';
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.cmd('GET', key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.cmd('SET', key, value, 'EX', String(ttlSeconds));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.socket) {
      try {
        await this.cmd('QUIT');
      } catch {
        /* ignore */
      }
      this.socket.close();
      this.socket = null;
    }
  }
}

/** 单例缓存（连接一次复用） */
let clientInstance: GarnetLike | null = null;
let clientAttemptedAt = 0;
const CLIENT_RETRY_INTERVAL_MS = 30_000; // 30s 内不重试连接

/**
 * 获取 Garnet 客户端（异步）
 * - 连接成功：返回客户端
 * - 连接失败 / 服务未启：返回 null（调用方降级到内存）
 * - 节流：30s 内最多尝试一次新连接
 */
export async function getGarnetClient(): Promise<GarnetLike | null> {
  const now = Date.now();
  if (clientInstance) return clientInstance;
  if (now - clientAttemptedAt < CLIENT_RETRY_INTERVAL_MS) return null;

  clientAttemptedAt = now;
  const host = (typeof process !== 'undefined' ? process.env?.GARNET_HOST : undefined) ?? DEFAULT_HOST;
  const port = parseInt(
    (typeof process !== 'undefined' ? process.env?.GARNET_PORT : undefined) ?? String(DEFAULT_PORT),
    10,
  );

  try {
    const c = new Resp3Client({ host, port, connectTimeoutMs: 1500 });
    const ok = await c.ping();
    if (!ok) {
      await c.close();
      return null;
    }
    clientInstance = c;
    return c;
  } catch {
    return null;
  }
}

/** 重置客户端（测试用） */
export function _resetGarnetClient(): void {
  clientInstance = null;
  clientAttemptedAt = 0;
}

/** 关闭并清理 */
export async function closeGarnetClient(): Promise<void> {
  if (clientInstance) {
    await clientInstance.close();
    clientInstance = null;
  }
  clientAttemptedAt = 0;
}

/**
 * 把 PreviewPayload 序列化（用于 Redis 存储）
 * Redis 只能存字符串，所以 JSON.stringify 一次
 */
export function serializePayload(p: PreviewPayload): string {
  return JSON.stringify(p);
}

/** 反序列化（带 try-catch 防 corrupt 数据） */
export function deserializePayload(s: string | null): PreviewPayload | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as PreviewPayload;
  } catch {
    return null;
  }
}
