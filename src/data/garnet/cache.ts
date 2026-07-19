/**
 * Garnet 缓存层
 * 热数据缓存: Garnet
 * 按文档设计:
 * - Session 缓存: Garnet
 * - 任务缓存: Garnet
 * - 计数器: Garnet
 * - 通用缓存: Garnet
 */

import { getClient } from './client';

// Session 相关前缀
const SESSION_PREFIX = 'session:';
const SESSION_TTL = 3600; // 默认 1 小时

// Task 相关前缀
const TASK_PREFIX = 'task:';
const TASK_TTL = 7200; // 默认 2 小时

// Counter 前缀
const COUNTER_PREFIX = 'counter:';

// Cache 前缀
const CACHE_PREFIX = 'cache:';
const CACHE_TTL = 600; // 默认 10 分钟

// WebSocket 状态前缀
const WS_PREFIX = 'ws:';
const WS_TTL = 300; // 默认 5 分钟

/**
 * Session 缓存
 */
class SessionCache {
  private prefix = SESSION_PREFIX;
  private defaultTTL = SESSION_TTL;

  async set(sessionId: string, data: object, ttl?: number): Promise<void> {
    const client = getClient();
    const key = `${this.prefix}${sessionId}`;
    const value = JSON.stringify(data);
    if (ttl) {
      await client.setex(key, ttl, value);
    } else {
      await client.setex(key, this.defaultTTL, value);
    }
  }

  async get(sessionId: string): Promise<object | null> {
    const client = getClient();
    const key = `${this.prefix}${sessionId}`;
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async del(sessionId: string): Promise<void> {
    const client = getClient();
    const key = `${this.prefix}${sessionId}`;
    await client.del(key);
  }

  async exists(sessionId: string): Promise<boolean> {
    const client = getClient();
    const key = `${this.prefix}${sessionId}`;
    const result = await client.exists(key);
    return result === 1;
  }

  async ttl(sessionId: string): Promise<number> {
    const client = getClient();
    const key = `${this.prefix}${sessionId}`;
    return await client.ttl(key);
  }

  async refresh(sessionId: string, ttl?: number): Promise<void> {
    const client = getClient();
    const key = `${this.prefix}${sessionId}`;
    const expireTime = ttl || this.defaultTTL;
    await client.expire(key, expireTime);
  }
}

/**
 * 任务缓存
 */
class TaskCache {
  private prefix = TASK_PREFIX;
  private defaultTTL = TASK_TTL;

  async set(taskId: string, data: object, ttl?: number): Promise<void> {
    const client = getClient();
    const key = `${this.prefix}${taskId}`;
    const value = JSON.stringify(data);
    if (ttl) {
      await client.setex(key, ttl, value);
    } else {
      await client.setex(key, this.defaultTTL, value);
    }
  }

  async get(taskId: string): Promise<object | null> {
    const client = getClient();
    const key = `${this.prefix}${taskId}`;
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async del(taskId: string): Promise<void> {
    const client = getClient();
    const key = `${this.prefix}${taskId}`;
    await client.del(key);
  }

  async exists(taskId: string): Promise<boolean> {
    const client = getClient();
    const key = `${this.prefix}${taskId}`;
    const result = await client.exists(key);
    return result === 1;
  }

  async ttl(taskId: string): Promise<number> {
    const client = getClient();
    const key = `${this.prefix}${taskId}`;
    return await client.ttl(key);
  }
}

/**
 * 计数器
 */
class Counter {
  async incr(key: string, amount: number = 1): Promise<number> {
    const client = getClient();
    const fullKey = `${COUNTER_PREFIX}${key}`;
    return await client.incrby(fullKey, amount);
  }

  async decr(key: string, amount: number = 1): Promise<number> {
    const client = getClient();
    const fullKey = `${COUNTER_PREFIX}${key}`;
    return await client.decrby(fullKey, amount);
  }

  async get(key: string): Promise<number> {
    const client = getClient();
    const fullKey = `${COUNTER_PREFIX}${key}`;
    const value = await client.get(fullKey);
    return value ? parseInt(value, 10) : 0;
  }

  async reset(key: string): Promise<void> {
    const client = getClient();
    const fullKey = `${COUNTER_PREFIX}${key}`;
    await client.set(fullKey, '0');
  }

  async delete(key: string): Promise<void> {
    const client = getClient();
    const fullKey = `${COUNTER_PREFIX}${key}`;
    await client.del(fullKey);
  }
}

/**
 * 通用缓存
 */
class Cache {
  private prefix = CACHE_PREFIX;
  private defaultTTL = CACHE_TTL;

  async set(key: string, value: string, ttl?: number): Promise<void> {
    const client = getClient();
    const fullKey = `${this.prefix}${key}`;
    if (ttl) {
      await client.setex(fullKey, ttl, value);
    } else {
      await client.setex(fullKey, this.defaultTTL, value);
    }
  }

  async get(key: string): Promise<string | null> {
    const client = getClient();
    const fullKey = `${this.prefix}${key}`;
    return await client.get(fullKey);
  }

  async del(key: string): Promise<void> {
    const client = getClient();
    const fullKey = `${this.prefix}${key}`;
    await client.del(fullKey);
  }

  async exists(key: string): Promise<boolean> {
    const client = getClient();
    const fullKey = `${this.prefix}${key}`;
    const result = await client.exists(fullKey);
    return result === 1;
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    const client = getClient();
    const fullKeys = keys.map((k) => `${this.prefix}${k}`);
    return await client.mget(...fullKeys);
  }

  async mset(keyValues: Record<string, string>, ttl?: number): Promise<void> {
    const client = getClient();
    const pipeline = client.pipeline();
    for (const [key, value] of Object.entries(keyValues)) {
      const fullKey = `${this.prefix}${key}`;
      if (ttl) {
        pipeline.setex(fullKey, ttl, value);
      } else {
        pipeline.setex(fullKey, this.defaultTTL, value);
      }
    }
    await pipeline.exec();
  }
}

/**
 * WebSocket 状态
 */
class WsState {
  private prefix = WS_PREFIX;
  private defaultTTL = WS_TTL;

  async set(wsId: string, data: object, ttl?: number): Promise<void> {
    const client = getClient();
    const key = `${this.prefix}${wsId}`;
    const value = JSON.stringify(data);
    if (ttl) {
      await client.setex(key, ttl, value);
    } else {
      await client.setex(key, this.defaultTTL, value);
    }
  }

  async get(wsId: string): Promise<object | null> {
    const client = getClient();
    const key = `${this.prefix}${wsId}`;
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async del(wsId: string): Promise<void> {
    const client = getClient();
    const key = `${this.prefix}${wsId}`;
    await client.del(key);
  }

  async exists(wsId: string): Promise<boolean> {
    const client = getClient();
    const key = `${this.prefix}${wsId}`;
    const result = await client.exists(key);
    return result === 1;
  }
}

// 导出单例
export const sessionCache = new SessionCache();
export const taskCache = new TaskCache();
export const counter = new Counter();
export const cache = new Cache();
export const wsState = new WsState();

export default { sessionCache, taskCache, counter, cache, wsState };
