/**
 * sentryAdapter.ts — Sentry HTTP API 适配器（无需 SDK 安装）
 *
 * 设计动机：
 *   - 官方 @sentry/node 因 proxy 限制无法装
 *   - Sentry 提供 envelope HTTP endpoint（/api/{project_id}/store/）
 *   - 我们自己序列化 envelope，POST 出去
 *   - 网络不通时降级到 in-memory 缓冲（不丢信息）
 *
 * 用法：
 *   const sentry = new SentryAdapter({
 *     dsn: 'https://key@sentry.io/123',  // 或自托管 'https://key@host/2'
 *     environment: 'production',
 *     release: 'soloforge@1.2.3',
 *   });
 *   sentry.captureException(new Error('boom'));
 *   await sentry.flush();  // 优雅退出
 *
 * 协议参考：https://develop.sentry.dev/sdk/envelopes/
 */

import crypto from 'crypto';
import { logger } from '../core/logger';

export interface SentryConfig {
  /** DSN 格式：https://<publicKey>@<host>/<projectId> */
  dsn?: string;
  environment?: string;
  release?: string;
  /** 发送失败时的最大缓冲（默认 100） */
  maxBuffer?: number;
  /** fetch 超时（默认 5000） */
  timeoutMs?: number;
  /** 自定义 serverName */
  serverName?: string;
  /** 设为 true 强制关闭（不发送） */
  disabled?: boolean;
}

interface ParsedDSN {
  publicKey: string;
  host: string;
  projectId: string;
  protocol: 'http' | 'https';
}

function parseDsn(dsn: string): ParsedDSN | null {
  try {
    const m = dsn.match(/^(https?):\/\/([^@]+)@([^/]+)\/(\d+)$/);
    if (!m) return null;
    return {
      protocol: m[1] as 'http' | 'https',
      publicKey: m[2],
      host: m[3],
      projectId: m[4],
    };
  } catch {
    return null;
  }
}

function genEventId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    // 降级：Node < 19 或无 crypto
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
}

export interface SentryEvent {
  eventId?: string;
  message?: string;
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: { id?: string; username?: string; email?: string };
  /** 异常 */
  error?: Error;
  /** 错误堆栈（自填） */
  stack?: string;
  /** 调用位置 */
  source?: string;
}

export class SentryAdapter {
  private dsn: ParsedDSN | null;
  private config: Required<Omit<SentryConfig, 'dsn'>> & { dsn: string | null };
  private buffer: Array<{ event: any; envelope: string }> = [];
  private flushing = false;

  constructor(config: SentryConfig = {}) {
    this.config = {
      dsn: config.dsn ?? null,
      environment: config.environment ?? 'development',
      release: config.release ?? 'soloforge@unknown',
      maxBuffer: config.maxBuffer ?? 100,
      timeoutMs: config.timeoutMs ?? 5_000,
      serverName: config.serverName ?? 'soloforge-backend',
      disabled: config.disabled ?? false,
    };
    this.dsn = config.dsn ? parseDsn(config.dsn) : null;
  }

  isEnabled(): boolean {
    return !this.config.disabled && this.dsn !== null;
  }

  /** 上报异常 */
  captureException(err: Error, extra?: Record<string, unknown>): string {
    return this.capture({ error: err, level: 'error', extra, source: 'captureException' });
  }

  /** 上报消息 */
  captureMessage(message: string, level: SentryEvent['level'] = 'info', extra?: Record<string, unknown>): string {
    return this.capture({ message, level, extra, source: 'captureMessage' });
  }

  /** 内部：构造 event + envelope + 发送（或缓冲） */
  capture(ev: SentryEvent): string {
    if (this.config.disabled) return '';
    const eventId = ev.eventId ?? genEventId();

    const event = {
      event_id: eventId,
      timestamp: new Date().toISOString(),
      platform: 'node',
      level: ev.level ?? 'info',
      logger: ev.source ?? 'app',
      environment: this.config.environment,
      release: this.config.release,
      server_name: this.config.serverName,
      ...(ev.message ? { message: { formatted: ev.message } } : {}),
      ...(ev.tags ? { tags: ev.tags } : {}),
      ...(ev.extra ? { extra: ev.extra } : {}),
      ...(ev.user ? { user: ev.user } : {}),
      ...(ev.error ? { exception: this.exceptionFromError(ev.error) } : {}),
      ...(ev.stack && !ev.error ? { stacktrace: { frames: this.parseStack(ev.stack) } } : {}),
    };

    // Envelope 格式：
    // {}\n
    // {"type":"event","content_type":"application/json", ...}\n
    // { ...event... }
    const envelopeHeader = JSON.stringify({});
    const itemHeader = JSON.stringify({ type: 'event', content_type: 'application/json', length: 0 });
    const itemBody = JSON.stringify(event);
    // length 字段要等于 body 字节数
    const bodyBytes = Buffer.byteLength(itemBody, 'utf8');
    const itemHeaderWithLen = JSON.stringify({ type: 'event', content_type: 'application/json', length: bodyBytes });
    const envelope = `${envelopeHeader}\n${itemHeaderWithLen}\n${itemBody}`;

    if (!this.isEnabled()) {
      // 没配 DSN，只记日志
      logger.warn('Sentry', `[disabled] eventId=${eventId} level=${event.level} message=${ev.message ?? ev.error?.message ?? '(no msg)'}`);
      return eventId;
    }

    // 异步发送（fire-and-forget）+ 失败时缓冲
    this.send(envelope, eventId).catch(() => {
      // 缓冲到内存，避免丢
      if (this.buffer.length >= this.config.maxBuffer) {
        this.buffer.shift(); // 丢最旧
      }
      this.buffer.push({ event, envelope });
    });
    return eventId;
  }

  /** 发送 envelope */
  private async send(envelope: string, eventId: string): Promise<void> {
    if (!this.dsn) return;
    const url = `${this.dsn.protocol}://${this.dsn.host}/api/${this.dsn.projectId}/store/?sentry_key=${this.dsn.publicKey}&sentry_version=7`;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort('timeout'), this.config.timeoutMs);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-sentry-envelope' },
        body: envelope,
        signal: controller.signal,
      });
      if (!r.ok) {
        throw new Error(`Sentry HTTP ${r.status}`);
      }
    } finally {
      clearTimeout(id);
    }
  }

  /** 强制刷新缓冲（graceful shutdown 调用） */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    this.flushing = true;
    const pending = this.buffer.slice();
    this.buffer = [];
    for (const item of pending) {
      try { await this.send(item.envelope, item.event.event_id); } catch { /* skip */ }
    }
    this.flushing = false;
  }

  /** 测试用：当前缓冲大小 */
  bufferSize(): number {
    return this.buffer.length;
  }

  private exceptionFromError(err: Error): { values: Array<{ type: string; value: string; stacktrace?: { frames: any[] } }> } {
    return {
      values: [{
        type: err.name || 'Error',
        value: err.message,
        ...(err.stack ? { stacktrace: { frames: this.parseStack(err.stack) } } : {}),
      }],
    };
  }

  private parseStack(stack: string): any[] {
    const lines = stack.split('\n').slice(0, 30).reverse();
    return lines.map(line => {
      const m = line.match(/at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)/);
      if (m) {
        return {
          function: m[1] || '<anonymous>',
          filename: m[2],
          lineno: parseInt(m[3], 10),
          colno: parseInt(m[4], 10),
        };
      }
      const m2 = line.match(/at\s+(.*?):(\d+):(\d+)/);
      if (m2) {
        return {
          function: '<anonymous>',
          filename: m2[1],
          lineno: parseInt(m2[2], 10),
          colno: parseInt(m2[3], 10),
        };
      }
      return { function: line.trim() };
    });
  }
}

// ============================================================
// 全局默认实例
// ============================================================

let _default: SentryAdapter | null = null;

export function getDefaultSentry(): SentryAdapter {
  if (!_default) {
    _default = new SentryAdapter({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV ?? 'development',
      release: process.env.SENTRY_RELEASE,
      disabled: !process.env.SENTRY_DSN,
    });
  }
  return _default;
}

export function setDefaultSentry(adapter: SentryAdapter): void {
  _default = adapter;
}
