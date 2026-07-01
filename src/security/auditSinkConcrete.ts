/**
 * auditSinkConcrete.ts — 具体 sink 实现: stdout / file / http
 *
 * 位置: 这部分不依赖 kafkajs / SurrealPersistence, 可独立测试
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { AuditEvent } from './auth';
import { AbstractAuditSink } from './auditSinkBase';

// ============================================================
// Stdout Sink (调试用, tag=AUDIT)
// ============================================================

export class StdoutAuditSink extends AbstractAuditSink {
  public readonly name = 'stdout';
  constructor(mirror = true) {
    super();
    this.mirrorToStdout = mirror;
  }
  protected async write(_events: AuditEvent[]): Promise<void> {
    // stdout mirror 已在 invoke() 里做了, write() 实际是 noop
    return;
  }
}

// ============================================================
// File Sink (JSONL 本地持久化 + 轮转)
//
// 设计:
//   - 追加写, 一行一个 JSON (JSONL)
//   - 文件超过 rotateBytes (默认 50MB) 时轮转: foo.jsonl → foo.jsonl.1.gz
//   - 失败时抛错, 由 AbstractAuditSink fallback 到 stdout
// ============================================================

export interface FileAuditSinkOptions {
  path: string;
  rotateBytes?: number;        // 默认 50 * 1024 * 1024
  compressRotated?: boolean;   // 默认 true
  maxRotatedFiles?: number;    // 默认 10
}

export class FileAuditSink extends AbstractAuditSink {
  public readonly name = 'file';
  private stream: fs.WriteStream;
  private bytesWritten = 0;
  private readonly opts: Required<FileAuditSinkOptions>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: FileAuditSinkOptions) {
    super();
    this.opts = {
      path: opts.path,
      rotateBytes: opts.rotateBytes ?? 50 * 1024 * 1024,
      compressRotated: opts.compressRotated ?? true,
      maxRotatedFiles: opts.maxRotatedFiles ?? 10,
    };
    // 确保目录存在
    fs.mkdirSync(path.dirname(this.opts.path), { recursive: true });
    this.stream = fs.createWriteStream(this.opts.path, { flags: 'a' });
    // 估算已有大小
    try {
      this.bytesWritten = fs.statSync(this.opts.path).size;
    } catch { /* 文件不存在 */ }
    this.mirrorToStdout = false; // 文件 sink 默认不 mirror (避免重复)
  }

  /**
   * 串行化 write: rotate 不是线程安全的, 多个并发 write 会破坏流状态
   * 用 Promise chain 把所有 write 串起来, 每次只处理一个
   */
  protected async write(events: AuditEvent[]): Promise<void> {
    const next = this.writeQueue.then(() => this.doWrite(events));
    this.writeQueue = next.catch(() => { /* 错误由调用方处理 */ });
    return next;
  }

  private async doWrite(events: AuditEvent[]): Promise<void> {
    if (events.length === 0) return;
    const lines = events.map((e) => JSON.stringify({ ...e, _sink: this.name })).join('\n') + '\n';
    const buf = Buffer.from(lines, 'utf8');
    await new Promise<void>((resolve, reject) => {
      this.stream.write(buf, (err) => err ? reject(err) : resolve());
    });
    this.bytesWritten += buf.length;
    if (this.bytesWritten >= this.opts.rotateBytes) {
      await this.rotate();
    }
  }

  private async rotate(): Promise<void> {
    // 1. 等待 stream 完全结束 + 关闭 (end → finish → close)
    await new Promise<void>((resolve) => {
      if (this.stream.destroyed) return resolve();
      this.stream.end(() => resolve());
    });
    // 2. 备份当前文件 (用 rename 比 read+unlink 更安全, 避免 open 句柄竞争)
    const tmpPath = this.opts.path + '.rotating';
    try {
      if (fs.existsSync(this.opts.path)) {
        fs.renameSync(this.opts.path, tmpPath);
      }
    } catch (e) {
      // rename 失败 (例如目标已存在) 退化成 read+unlink
      try {
        const data = fs.readFileSync(this.opts.path);
        fs.writeFileSync(tmpPath, data);
        fs.unlinkSync(this.opts.path);
      } catch { /* 不可恢复, 让后续 write 失败兜底 */ }
    }
    // 3. shift 旧轮转 (从最大到最小, 避免覆盖)
    for (let i = this.opts.maxRotatedFiles; i >= 1; i--) {
      const oldPath = this.opts.path + '.' + i + (this.opts.compressRotated ? '.gz' : '');
      try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
    }
    for (let i = this.opts.maxRotatedFiles - 1; i >= 1; i--) {
      const src = this.opts.path + '.' + i + (this.opts.compressRotated ? '.gz' : '');
      const dst = this.opts.path + '.' + (i + 1) + (this.opts.compressRotated ? '.gz' : '');
      try { fs.renameSync(src, dst); } catch { /* ignore */ }
    }
    // 4. 压缩 backup
    try {
      const data = fs.readFileSync(tmpPath);
      const gz = this.opts.path + '.1' + (this.opts.compressRotated ? '.gz' : '');
      if (this.opts.compressRotated) {
        const compressed = zlib.gzipSync(data);
        fs.writeFileSync(gz, compressed);
      } else {
        fs.writeFileSync(gz, data);
      }
      fs.unlinkSync(tmpPath);
    } catch { /* 压缩失败不致命, 留着 .rotating 备份 */ }
    // 5. 新开一个流 (用 'a' 模式, 文件不存在会自动创建)
    this.stream = fs.createWriteStream(this.opts.path, { flags: 'a' });
    this.bytesWritten = 0;
  }

  public async close(): Promise<void> {
    await super.close();
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }
}

// ============================================================
// HTTP Sink (推送到远端 SIEM webhook)
//
// 设计:
//   - POST JSON 到 url
//   - 失败重试 3 次, 指数退避
//   - 单条发送 (不适合批量, 远端 SIEM 通常一行一条)
// ============================================================

export interface HttpAuditSinkOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
}

export class HttpAuditSink extends AbstractAuditSink {
  public readonly name = 'http';
  private readonly opts: Required<HttpAuditSinkOptions>;

  constructor(opts: HttpAuditSinkOptions) {
    super();
    this.opts = {
      url: opts.url,
      headers: opts.headers ?? {},
      timeoutMs: opts.timeoutMs ?? 5000,
      maxRetries: opts.maxRetries ?? 3,
    };
    this.mirrorToStdout = false; // HTTP sink 默认不 mirror
  }

  protected async write(events: AuditEvent[]): Promise<void> {
    for (const ev of events) {
      await this.sendOne(ev);
    }
  }

  private async sendOne(ev: AuditEvent, attempt = 0): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(this.opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.opts.headers },
        body: JSON.stringify(ev),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      if (attempt < this.opts.maxRetries - 1) {
        const backoff = 100 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
        return this.sendOne(ev, attempt + 1);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ============================================================
// Noop Sink (用于测试 / 关闭某个 sink 的运行时)
// ============================================================

export class NoopAuditSink extends AbstractAuditSink {
  public readonly name = 'noop';
  protected async write(_events: AuditEvent[]): Promise<void> { /* noop */ }
}
