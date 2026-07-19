/**
 * SoloForge æ°æ®å½æ¡£æå¡
 * å·ç­æ°æ®åå±ç®¡ç
 *
 * è§åï¼
 * - æ°æ°æ® â SurrealDBï¼ä¸»å­å¨ï¼
 * - 24å°æ¶åè°ç¨æ¬¡æ° < 5 â å½æ¡£å° JSONL
 * - 24å°æ¶åè°ç¨æ¬¡æ° â¥ 5 â ä¿çå¨ SurrealDB
 * - ç¨æ·å é¤ â SurrealDB + JSONL åæ­¥å é¤
 */

import fs from 'fs';
import path from 'path';
import { counter, cache } from './garnet/cache';
import { SurrealPersistence } from './surreal_persistence';
import { jsonlWriter, jsonlReader } from './jsonl/index';
import { logger } from '../core/logger';

// ============================================================
// å¸¸ééç½®
// ============================================================

const CALL_COUNT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24å°æ¶çªå£
const COLD_THRESHOLD = 5; // å·æ°æ®éå¼ï¼24håè°ç¨ < 5 æ¬¡

// è®¡æ°å¨ Key åç¼
const COUNTER_PREFIX = 'archiver:';
const CALL_COUNT_KEY = (table: string, id: string) => `${COUNTER_PREFIX}call:${table}:${id}`;
const LAST_ACCESS_KEY = (table: string, id: string) => `${COUNTER_PREFIX}access:${table}:${id}`;

// JSONL å½æ¡£æä»¶
const ARCHIVE_DATA_DIR = 'data/jsonl/archive';
const COLD_DATA_FILE = 'cold_data.jsonl';

// ============================================================
// ç±»åå®ä¹
// ============================================================

/**
 * å½æ¡£è®°å½åä¿¡æ¯
 */
export interface ArchiveMeta {
  id: string;
  table: string;
  archivedAt: number;
  lastCallCount: number;
  originalData: Record<string, unknown>;
}

/**
 * æ°æ®è®°å½æ¥å£
 */
export interface DataRecord {
  id: string;
  table: string;
  data: Record<string, unknown>;
  callCount?: number;
  lastAccessTime?: number;
}

/**
 * å½æ¡£ç»è®¡
 */
export interface ArchiveStats {
  totalRecords: number;
  hotRecords: number;      // SurrealDB ä¸­
  coldRecords: number;     // JSONL ä¸­
  archivedThisRun: number;
  deletedThisRun: number;
}

// ============================================================
// æ°æ®å½æ¡£æå¡
// ============================================================

export class DataArchiverService {
  private surreal: SurrealPersistence;
  private running = false;
  private checkIntervalMs = 60 * 1000; // é»è®¤æ¯åéæ£æ¥ä¸æ¬¡
  private intervalId: NodeJS.Timeout | null = null;

  constructor(surreal: SurrealPersistence, checkIntervalMs?: number) {
    this.surreal = surreal;
    if (checkIntervalMs) {
      this.checkIntervalMs = checkIntervalMs;
    }
  }

  /**
   * å¯å¨å½æ¡£æå¡ï¼å®æ¶æ£æ¥ï¼
   */
  start(): void {
    if (this.running) {
      logger.warn('DataArchiver', 'å½æ¡£æå¡å·²å¨è¿è¡ä¸­');
      return;
    }

    this.running = true;
    this.intervalId = setInterval(() => {
      this.runArchiveCheck().catch(err => {
        logger.error('DataArchiver', `å½æ¡£æ£æ¥å¤±è´¥: ${err.message}`);
      });
    }, this.checkIntervalMs);

    logger.info('DataArchiver', `å½æ¡£æå¡å·²å¯å¨ï¼æ£æ¥é´é: ${this.checkIntervalMs / 1000}s`);
  }

  /**
   * åæ­¢å½æ¡£æå¡
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    logger.info('DataArchiver', 'å½æ¡£æå¡å·²åæ­¢');
  }

  /**
   * è®°å½æ°æ®è¢«è®¿é®ï¼è°ç¨æ¬¡æ° +1ï¼
   * å¨æ¯æ¬¡æ¥è¯¢æ°æ®æ¶è°ç¨
   */
  async recordAccess(table: string, id: string): Promise<number> {
    // æ£æ¥æ¯å¦å¨ 24 å°æ¶çªå£å
    const lastAccess = await this.getLastAccessTime(table, id);
    const now = Date.now();

    // å¦æä¸æ¬¡è®¿é®è¶è¿ 24 å°æ¶ï¼éç½®è®¡æ°å¨
    if (now - lastAccess > CALL_COUNT_WINDOW_MS) {
      await counter.reset(`call:${table}:${id}`);
    }

    // è®¡æ°å¨ +1
    const newCount = await counter.incr(`call:${table}:${id}`);

    // æ´æ°æåè®¿é®æ¶é´
    await cache.set(`access:${table}:${id}`, now.toString(), Math.ceil(CALL_COUNT_WINDOW_MS / 1000));

    return newCount;
  }

  /**
   * è·åæåè®¿é®æ¶é´
   */
  async getLastAccessTime(table: string, id: string): Promise<number> {
    const lastAccess = await cache.get(`access:${table}:${id}`);
    return lastAccess ? parseInt(lastAccess, 10) : 0;
  }

  /**
   * è·å 24 å°æ¶åçè°ç¨æ¬¡æ°
   */
  async getCallCount(table: string, id: string): Promise<number> {
    const lastAccess = await this.getLastAccessTime(table, id);
    const now = Date.now();

    // å¦æè¶è¿ 24 å°æ¶ï¼è°ç¨æ¬¡æ°è§ä¸º 0
    if (now - lastAccess > CALL_COUNT_WINDOW_MS) {
      return 0;
    }

    return await counter.get(`call:${table}:${id}`);
  }

  /**
   * è¿è¡ä¸æ¬¡å½æ¡£æ£æ¥
   * æ£æ¥ SurrealDB ä¸­çè®°å½ï¼å°å·æ°æ®å½æ¡£å° JSONL
   */
  async runArchiveCheck(): Promise<ArchiveStats> {
    logger.info('DataArchiver', 'å¼å§å½æ¡£æ£æ¥...');

    const stats: ArchiveStats = {
      totalRecords: 0,
      hotRecords: 0,
      coldRecords: 0,
      archivedThisRun: 0,
      deletedThisRun: 0
    };

    // éè¦æ£æ¥çè¡¨
    const tables = ['conversation', 'message', 'chat_config', 'chat_meta', 'decision', 'courtSubmission', 'courtVerdict', 'eventLog'];

    for (const table of tables) {
      try {
        const tableStats = await this.checkTable(table);
        stats.totalRecords += tableStats.total;
        stats.hotRecords += tableStats.hot;
        stats.coldRecords += tableStats.cold;
        stats.archivedThisRun += tableStats.archived;
      } catch (err: any) {
        logger.error('DataArchiver', `æ£æ¥è¡¨ ${table} å¤±è´¥: ${err.message}`);
      }
    }

    logger.info('DataArchiver', `å½æ¡£æ£æ¥å®æ: æ»è®°å½=${stats.totalRecords}, ç­æ°æ®=${stats.hotRecords}, å·æ°æ®=${stats.coldRecords}, æ¬æ¬¡å½æ¡£=${stats.archivedThisRun}`);

    return stats;
  }

  /**
   * æ£æ¥åä¸ªè¡¨
   */
  private async checkTable(table: string): Promise<{ total: number; hot: number; cold: number; archived: number }> {
    const result = { total: 0, hot: 0, cold: 0, archived: 0 };

    try {
      // æ¥è¯¢è¡¨ä¸­ææè®°å½
      const queryResult = await this.surreal.query(`SELECT * FROM ${table} LIMIT 10000`, {});
      const records = queryResult[0] || [];

      result.total = records.length;

      for (const record of records) {
        const id = record.id || record;
        const callCount = await this.getCallCount(table, id);

        if (callCount >= COLD_THRESHOLD) {
          // ç­æ°æ®ï¼ä¿çå¨ SurrealDB
          result.hot++;
        } else {
          // å·æ°æ®ï¼å½æ¡£å° JSONL
          await this.archiveRecord(table, id, record, callCount);
          // ä» SurrealDB å é¤
          await this.deleteFromSurreal(table, id);
          result.cold++;
          result.archived++;
        }
      }
    } catch (err: any) {
      // è¡¨å¯è½ä¸ºç©ºæä¸å­å¨
      if (!err.message.includes('empty results') && !err.message.includes('not found')) {
        throw err;
      }
    }

    return result;
  }

  /**
   * å½æ¡£è®°å½å° JSONL
   */
  private async archiveRecord(
    table: string,
    id: string,
    data: Record<string, unknown>,
    callCount: number
  ): Promise<void> {
    // ç¡®ä¿å½æ¡£ç®å½å­å¨
    const archiveDir = ARCHIVE_DATA_DIR.replace(/\//g, path.sep);
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    // åå¥å½æ¡£æä»¶
    const archivePath = path.join(archiveDir, COLD_DATA_FILE);
    const stream = fs.createWriteStream(archivePath, { flags: 'a', encoding: 'utf8' });

    const archiveMeta: ArchiveMeta = {
      id,
      table,
      archivedAt: Date.now(),
      lastCallCount: callCount,
      originalData: data
    };

    const line = JSON.stringify(archiveMeta) + '\n';
    await new Promise<void>((resolve, reject) => {
      stream.write(line, (err) => {
        stream.end();
        if (err) reject(err);
        else resolve();
      });
    });

    // æ¸ç Garnet è®¡æ°å¨
    await counter.delete(`call:${table}:${id}`);
    await counter.delete(`access:${table}:${id}`);

    logger.info('DataArchiver', `å·²å½æ¡£: ${table}:${id} (è°ç¨æ¬¡æ°: ${callCount})`);
  }

  /**
   * ä» SurrealDB å é¤è®°å½
   */
  private async deleteFromSurreal(table: string, id: string): Promise<void> {
    try {
      await this.surreal.query(`DELETE ${table} WHERE id = $id`, { id });
      logger.info('DataArchiver', `å·²ä» SurrealDB å é¤: ${table}:${id}`);
    } catch (err: any) {
      logger.error('DataArchiver', `ä» SurrealDB å é¤å¤±è´¥: ${table}:${id} - ${err.message}`);
    }
  }

  /**
   * åæ­¥å é¤ï¼SurrealDB + JSONLï¼
   * ç¨æ·å é¤å¯¹è¯æ¶è°ç¨
   */
  async syncDelete(table: string, id: string): Promise<void> {
    // 1. ä» SurrealDB å é¤
    await this.deleteFromSurreal(table, id);

    // 2. ä» JSONL å½æ¡£æä»¶å é¤
    await this.deleteFromJsonl(table, id);

    // 3. æ¸ç Garnet è®¡æ°å¨
    await counter.delete(`call:${table}:${id}`);
    await counter.delete(`access:${table}:${id}`);

    logger.info('DataArchiver', `åæ­¥å é¤å®æ: ${table}:${id}`);
  }

  /**
   * ä» JSONL å½æ¡£æä»¶ä¸­å é¤æå®è®°å½
   */
  private async deleteFromJsonl(table: string, id: string): Promise<void> {
    const archiveDir = ARCHIVE_DATA_DIR.replace(/\//g, path.sep);
    const archivePath = path.join(archiveDir, COLD_DATA_FILE);

    if (!fs.existsSync(archivePath)) {
      return;
    }

    try {
      // è¯»åææè¡ï¼è¿æ»¤æè¦å é¤çè®°å½
      const content = fs.readFileSync(archivePath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      const remainingLines: string[] = [];

      for (const line of lines) {
        try {
          const meta = JSON.parse(line) as ArchiveMeta;
          // ä¿çä¸å¹éçè¡
          if (!(meta.table === table && meta.id === id)) {
            remainingLines.push(line);
          }
        } catch {
          // è·³è¿æ æè¡
        }
      }

      // éåæä»¶
      fs.writeFileSync(archivePath, remainingLines.join('\n') + '\n', 'utf8');
      logger.info('DataArchiver', `å·²ä» JSONL å é¤: ${table}:${id}`);
    } catch (err: any) {
      logger.error('DataArchiver', `ä» JSONL å é¤å¤±è´¥: ${err.message}`);
    }
  }

  /**
   * ä» JSONL æ¢å¤è®°å½å° SurrealDB
   */
  async restoreRecord(table: string, id: string): Promise<Record<string, unknown> | null> {
    const archiveDir = ARCHIVE_DATA_DIR.replace(/\//g, path.sep);
    const archivePath = path.join(archiveDir, COLD_DATA_FILE);

    if (!fs.existsSync(archivePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(archivePath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      const remainingLines: string[] = [];
      let restored: Record<string, unknown> | null = null;

      for (const line of lines) {
        try {
          const meta = JSON.parse(line) as ArchiveMeta;
          if (meta.table === table && meta.id === id) {
            // æ¾å°ç®æ è®°å½ï¼æ¢å¤å° SurrealDB
            restored = meta.originalData;
            // éç½®è°ç¨æ¬¡æ°
            await counter.reset(`call:${table}:${id}`);
          } else {
            remainingLines.push(line);
          }
        } catch {
          // è·³è¿æ æè¡
          remainingLines.push(line);
        }
      }

      if (restored) {
        // åå SurrealDB
        await this.surreal.query(
          `CREATE type::thing($table, $id) CONTENT $data`,
          { table, id, data: restored }
        );

        // æ´æ° JSONL æä»¶
        fs.writeFileSync(archivePath, remainingLines.join('\n') + '\n', 'utf8');
        logger.info('DataArchiver', `å·²æ¢å¤: ${table}:${id}`);
      }

      return restored;
    } catch (err: any) {
      logger.error('DataArchiver', `æ¢å¤å¤±è´¥: ${err.message}`);
      return null;
    }
  }

  /**
   * æ¥è¯¢æ°æ®ï¼èªå¨ä» JSONL æ¢å¤ç­æ°æ®ï¼
   */
  async queryWithRestore(table: string, id: string): Promise<Record<string, unknown> | null> {
    // 1. åæ¥ SurrealDB
    try {
      const result = await this.surreal.query(
        `SELECT * FROM ${table} WHERE id = $id`,
        { id }
      );
      if (result[0] && result[0].length > 0) {
        // è®°å½è®¿é®
        await this.recordAccess(table, id);
        return result[0][0];
      }
    } catch {
      // SurrealDB æ¥è¯¢å¤±è´¥ï¼ç»§ç»­æ£æ¥ JSONL
    }

    // 2. SurrealDB æ²¡æï¼å°è¯ä» JSONL æ¢å¤
    const restored = await this.restoreRecord(table, id);
    if (restored) {
      // è®°å½è®¿é®
      await this.recordAccess(table, id);
    }

    return restored;
  }
}

// ============================================================
// å¯¼åºé»è®¤å®ä¾
// ============================================================

export const dataArchiver = new DataArchiverService(new SurrealPersistence());

export default DataArchiverService;
