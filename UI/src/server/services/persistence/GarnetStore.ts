/**
 * Garnet 热存储客户端
 * - ioredis 连接到 Microsoft Garnet (Redis 兼容)
 * - 存储当前活跃会话状态
 * - 24 小时 TTL
 * - Key 规范: hot:sf:session:{id}:state
 * - 读取时做类型守卫, 损坏数据不崩溃
 */

import Redis from 'ioredis';
import type { SessionState } from '../canvas/types';
import { DEFAULT_SESSION_CONFIG, type SessionStoreConfig } from '../canvas/types';
import { isSessionState, repairSessionState } from '../canvas/validators';

export class GarnetStore {
  private client: Redis;
  private config: SessionStoreConfig;
  private corruptKeys: Set<string> = new Set();

  constructor(config: Partial<SessionStoreConfig> = {}) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };
    this.client = new Redis({
      host: this.config.garnetHost,
      port: this.config.garnetPort,
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    });

    this.client.on('error', (err: Error) => {
      console.warn('[GarnetStore] connection error:', err.message);
    });

    this.client.on('connect', () => {
      console.log('[GarnetStore] connected to Garnet:', `${this.config.garnetHost}:${this.config.garnetPort}`);
    });
  }

  /**
   * 写入会话状态 (覆盖)
   */
  async setSessionState(state: SessionState): Promise<boolean> {
    try {
      const key = this._buildKey(state.sessionId);
      const value = JSON.stringify({
        ...state,
        lastUpdated: Date.now(),
      });
      await this.client.set(key, value, 'EX', this.config.ttlSeconds);
      this.corruptKeys.delete(key);
      return true;
    } catch (e) {
      console.warn('[GarnetStore] setSessionState failed:', (e as Error).message);
      return false;
    }
  }

  /**
   * 读取会话状态
   *
   * 三段式校验:
   * 1. JSON 解析失败 → 返回 null
   * 2. 严格类型守卫失败 → 尝试软修复
   * 3. 软修复失败 → 记录 corrupt key, 返回 null
   */
  async getSessionState(sessionId: string): Promise<SessionState | null> {
    const key = this._buildKey(sessionId);

    // 已知损坏, 不再读
    if (this.corruptKeys.has(key)) {
      return null;
    }

    try {
      const value = await this.client.get(key);
      if (!value) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch (e) {
        console.warn(`[GarnetStore] corrupt JSON at ${key}:`, (e as Error).message);
        this.corruptKeys.add(key);
        return null;
      }

      // 严格校验通过
      if (isSessionState(parsed)) {
        return parsed;
      }

      // 尝试软修复
      const repaired = repairSessionState(parsed);
      if (repaired) {
        console.warn(`[GarnetStore] repaired session ${sessionId} (data was partial)`);
        // 写回修复后的版本, 避免下次再走修复
        this.setSessionState(repaired).catch(() => {});
        return repaired;
      }

      // 无法修复, 标记为损坏
      console.warn(`[GarnetStore] unrepairable session ${sessionId}, marking corrupt`);
      this.corruptKeys.add(key);
      return null;
    } catch (e) {
      console.warn('[GarnetStore] getSessionState failed:', (e as Error).message);
      return null;
    }
  }

  /**
   * 删除会话状态
   */
  async deleteSessionState(sessionId: string): Promise<boolean> {
    try {
      const key = this._buildKey(sessionId);
      await this.client.del(key);
      this.corruptKeys.delete(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 列出所有活跃 session ID
   */
  async listActiveSessions(): Promise<string[]> {
    try {
      const pattern = 'hot:sf:session:*:state';
      const keys = await this.client.keys(pattern);
      return keys
        .map((k: string) => {
          const match = k.match(/hot:sf:session:([^:]+):state/);
          return match ? match[1] : '';
        })
        .filter((id: string) => id.length > 0);
    } catch (e) {
      return [];
    }
  }

  /**
   * 健康检查
   */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.client.ping();
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    await this.client.quit();
  }

  /**
   * 获取已知损坏 key 数量 (诊断用)
   */
  getCorruptKeyCount(): number {
    return this.corruptKeys.size;
  }

  private _buildKey(sessionId: string): string {
    return `hot:sf:session:${sessionId}:state`;
  }
}

// 单例
let _instance: GarnetStore | null = null;
export function getGarnetStore(): GarnetStore {
  if (!_instance) {
    _instance = new GarnetStore();
  }
  return _instance;
}
