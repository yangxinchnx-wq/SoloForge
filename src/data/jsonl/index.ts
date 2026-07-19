/**
 * JSONL 事件日志（冷数据层）
 * 文档设计：JSONL 作为真相源，所有事件先落 JSONL
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';

// ============================================================
// 类型定义
// ============================================================

/**
 * 事件记录
 */
export interface JsonlEvent {
  id: string;
  type: string;
  traceId: string;
  timestamp: number;
  payload: Record<string, unknown>;
  source?: string;
}

/**
 * 事件查询选项
 */
export interface QueryEventsOptions {
  traceId?: string;
  type?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

/**
 * 归档配置
 */
export interface ArchiveConfig {
  enabled: boolean;
  retentionDays: number;
  archivePath: string;
  compressed: boolean;
}

// ============================================================
// 常量
// ============================================================

const DEFAULT_EVENT_FILE = 'events.jsonl';
const DEFAULT_AUDIT_FILE = 'audit.jsonl';
const DEFAULT_LOG_FILE = 'system.log';
const DEFAULT_DATA_DIR = 'data/jsonl';

// ============================================================
// JSONL Writer
// ============================================================

export class JsonlWriter {
  private eventStream: fs.WriteStream | null = null;
  private auditStream: fs.WriteStream | null = null;
  private dataDir: string;

  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
  }

  /**
   * 初始化目录和文件流
   */
  async initialize(): Promise<void> {
    const fsPath = this.dataDir.replace(/\//g, path.sep);
    if (!fs.existsSync(fsPath)) {
      fs.mkdirSync(fsPath, { recursive: true });
    }

    const eventPath = path.join(fsPath, DEFAULT_EVENT_FILE);
    const auditPath = path.join(fsPath, DEFAULT_AUDIT_FILE);

    this.eventStream = fs.createWriteStream(eventPath, { flags: 'a', encoding: 'utf8' });
    this.auditStream = fs.createWriteStream(auditPath, { flags: 'a', encoding: 'utf8' });
  }

  /**
   * 写入事件（真相源）
   * @param event 事件对象
   */
  async writeEvent(event: Omit<JsonlEvent, 'id' | 'timestamp'>): Promise<string> {
    if (!this.eventStream) {
      await this.initialize();
    }

    const id = generateId();
    const record: JsonlEvent = {
      ...event,
      id,
      timestamp: Date.now(),
    };

    const line = JSON.stringify(record) + '\n';
    await this.writeToStream(this.eventStream!, line);

    return id;
  }

  /**
   * 写入审计日志
   */
  async writeAudit(record: Record<string, unknown>): Promise<void> {
    if (!this.auditStream) {
      await this.initialize();
    }

    const line = JSON.stringify({
      ...record,
      timestamp: Date.now(),
    }) + '\n';

    await this.writeToStream(this.auditStream!, line);
  }

  /**
   * 写入到流
   */
  private writeToStream(stream: fs.WriteStream, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      stream.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * 刷新缓冲区（等待写入完成）
   */
  async flush(): Promise<void> {
    // WriteStream 没有 flush 方法，write 后等待 drain 事件
    // 由于我们使用 flags: 'a'，数据会立即追加
    return Promise.resolve();
  }

  /**
   * 关闭流
   */
  async close(): Promise<void> {
    if (this.eventStream) {
      this.eventStream.end();
      this.eventStream = null;
    }
    if (this.auditStream) {
      this.auditStream.end();
      this.auditStream = null;
    }
  }
}

// ============================================================
// JSONL Reader
// ============================================================

export class JsonlReader {
  private dataDir: string;

  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
  }

  /**
   * 查询事件
   */
  async queryEvents(options: QueryEventsOptions = {}): Promise<JsonlEvent[]> {
    const fsPath = this.dataDir.replace(/\//g, path.sep);
    const eventPath = path.join(fsPath, DEFAULT_EVENT_FILE);

    if (!fs.existsSync(eventPath)) {
      return [];
    }

    const events: JsonlEvent[] = [];
    const content = fs.readFileSync(eventPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    let offset = 0;
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line) as JsonlEvent;

        // 应用过滤条件
        if (options.traceId && event.traceId !== options.traceId) {
          continue;
        }
        if (options.type && event.type !== options.type) {
          continue;
        }
        if (options.startTime && event.timestamp < options.startTime) {
          continue;
        }
        if (options.endTime && event.timestamp > options.endTime) {
          continue;
        }

        // 应用分页
        if (options.offset && offset < options.offset) {
          offset++;
          continue;
        }
        if (options.limit && events.length >= options.limit) {
          break;
        }

        events.push(event);
      } catch (e) {
        // 跳过无效行
      }
    }

    return events;
  }

  /**
   * 按 traceId 查询
   */
  async findByTraceId(traceId: string): Promise<JsonlEvent[]> {
    return this.queryEvents({ traceId });
  }

  /**
   * 按 ID 查询
   */
  async findById(id: string): Promise<JsonlEvent | null> {
    const events = await this.queryEvents({ limit: 100000 });
    return events.find(e => e.id === id) || null;
  }

  /**
   * 获取事件数量
   */
  async count(): Promise<number> {
    const fsPath = this.dataDir.replace(/\//g, path.sep);
    const eventPath = path.join(fsPath, DEFAULT_EVENT_FILE);

    if (!fs.existsSync(eventPath)) {
      return 0;
    }

    const content = fs.readFileSync(eventPath, 'utf8');
    return content.split('\n').filter(line => line.trim()).length;
  }

  /**
   * 从指定偏移读取事件（用于回放）
   */
  async readFromOffset(offset: number, limit: number = 1000): Promise<JsonlEvent[]> {
    const fsPath = this.dataDir.replace(/\//g, path.sep);
    const eventPath = path.join(fsPath, DEFAULT_EVENT_FILE);

    if (!fs.existsSync(eventPath)) {
      return [];
    }

    const events: JsonlEvent[] = [];
    const content = fs.readFileSync(eventPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    let lineIndex = 0;
    let bytesRead = 0;

    // 找到指定字节偏移
    const bytes = Buffer.from(content, 'utf8');
    let currentLine = 0;
    let currentByte = 0;

    for (let i = 0; i < lines.length && currentByte < offset; i++) {
      currentByte += Buffer.byteLength(lines[i], 'utf8') + 1; // +1 for newline
      currentLine++;
    }

    // 从偏移位置读取
    for (let i = currentLine; i < lines.length && events.length < limit; i++) {
      if (!lines[i].trim()) continue;
      try {
        events.push(JSON.parse(lines[i]));
      } catch (e) {
        // 跳过无效行
      }
    }

    return events;
  }
}

// ============================================================
// JSONL Archiver（归档）
// ============================================================

export class JsonlArchiver {
  private reader: JsonlReader;
  private archiveDir: string;
  private retentionDays: number;

  constructor(
    dataDir: string = DEFAULT_DATA_DIR,
    archiveDir: string = 'data/jsonl/archive',
    retentionDays: number = 90
  ) {
    this.reader = new JsonlReader(dataDir);
    this.archiveDir = archiveDir;
    this.retentionDays = retentionDays;
  }

  /**
   * 归档旧事件（压缩）
   */
  async archiveOldEvents(): Promise<{ archived: number; files: string[] }> {
    const fsArchivePath = this.archiveDir.replace(/\//g, path.sep);
    if (!fs.existsSync(fsArchivePath)) {
      fs.mkdirSync(fsArchivePath, { recursive: true });
    }

    const cutoffTime = Date.now() - (this.retentionDays * 24 * 60 * 60 * 1000);
    const events = await this.reader.queryEvents({
      startTime: 0,
      endTime: cutoffTime,
      limit: 1000000,
    });

    if (events.length === 0) {
      return { archived: 0, files: [] };
    }

    // 创建归档文件名（按日期）
    const date = new Date();
    const archiveFile = `events_${date.toISOString().slice(0, 10)}.jsonl.gz`;
    const archivePath = path.join(fsArchivePath, archiveFile);

    // 压缩写入
    const gzip = zlib.createGzip();
    const writeStream = fs.createWriteStream(archivePath);
    const input = Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n');

    await new Promise<void>((resolve, reject) => {
      gzip.pipe(writeStream);
      gzip.write(input, (err) => {
        if (err) reject(err);
        else {
          gzip.end(() => {
            writeStream.end();
            resolve();
          });
        }
      });
    });

    return { archived: events.length, files: [archiveFile] };
  }

  /**
   * 解压归档文件
   */
  async readArchive(archiveFile: string): Promise<JsonlEvent[]> {
    const fsArchivePath = this.archiveDir.replace(/\//g, path.sep);
    const archivePath = path.join(fsArchivePath, archiveFile);

    if (!fs.existsSync(archivePath)) {
      return [];
    }

    const gunzip = zlib.createGunzip();
    const readStream = fs.createReadStream(archivePath);

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      readStream.pipe(gunzip);
      gunzip.on('data', (chunk) => chunks.push(chunk));
      gunzip.on('end', () => {
        const content = Buffer.concat(chunks).toString('utf8');
        const events = content.split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line) as JsonlEvent);
        resolve(events);
      });
      gunzip.on('error', reject);
    });
  }
}

// ============================================================
// 工具函数
// ============================================================

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 11);
  return `${timestamp}_${random}`;
}

// ============================================================
// 默认实例导出
// ============================================================

export const jsonlWriter = new JsonlWriter();
export const jsonlReader = new JsonlReader();
export const jsonlArchiver = new JsonlArchiver();

export default { jsonlWriter, jsonlReader, jsonlArchiver, JsonlWriter, JsonlReader, JsonlArchiver };
