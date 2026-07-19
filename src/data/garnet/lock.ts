/**
 * Garnet 分布式锁
 * 按文档设计: 使用 Garnet 实现分布式锁
 */

import { getClient } from './client';

// 锁前缀
const LOCK_PREFIX = 'lock:';

// 默认锁超时时间（秒）
const DEFAULT_LOCK_TTL = 30;

// 默认锁重试间隔（毫秒）
const DEFAULT_RETRY_INTERVAL = 100;

// 默认最大重试次数
const DEFAULT_MAX_RETRIES = 0; // 0 表示无限重试

/**
 * 锁选项
 */
export interface LockOptions {
  /** 锁超时时间（秒） */
  ttl?: number;
  /** 重试间隔（毫秒） */
  retryInterval?: number;
  /** 最大重试次数，0 表示无限 */
  maxRetries?: number;
  /** 是否自动释放锁 */
  autoRelease?: boolean;
}

/**
 * 分布式锁
 */
class DistributedLock {
  /**
   * 获取锁
   * @param key 锁的 key
   * @param value 锁的值（通常为唯一标识）
   * @param options 锁选项
   * @returns 是否获取成功
   */
  async acquire(key: string, value: string, options: LockOptions = {}): Promise<boolean> {
    const client = getClient();
    const fullKey = `${LOCK_PREFIX}${key}`;
    const ttl = options.ttl || DEFAULT_LOCK_TTL;

    // 使用 SET NX EX 原子操作
    const result = await client.set(fullKey, value, 'EX', ttl, 'NX');
    return result === 'OK';
  }

  /**
   * 释放锁（Lua 脚本保证原子性）
   * @param key 锁的 key
   * @param value 锁的值
   * @returns 是否释放成功
   */
  async release(key: string, value: string): Promise<boolean> {
    const client = getClient();
    const fullKey = `${LOCK_PREFIX}${key}`;

    // Lua 脚本：只有值匹配时才删除
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await client.eval(script, 1, fullKey, value);
    return result === 1;
  }

  /**
   * 延长锁的过期时间
   * @param key 锁的 key
   * @param value 锁的值
   * @param ttl 新的超时时间（秒）
   * @returns 是否延长成功
   */
  async extend(key: string, value: string, ttl: number): Promise<boolean> {
    const client = getClient();
    const fullKey = `${LOCK_PREFIX}${key}`;

    // Lua 脚本：只有值匹配时才延长过期时间
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("expire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await client.eval(script, 1, fullKey, value, ttl.toString());
    return result === 1;
  }

  /**
   * 检查锁是否存在
   * @param key 锁的 key
   * @returns 锁是否存在
   */
  async isLocked(key: string): Promise<boolean> {
    const client = getClient();
    const fullKey = `${LOCK_PREFIX}${key}`;
    const result = await client.exists(fullKey);
    return result === 1;
  }

  /**
   * 获取锁的剩余时间
   * @param key 锁的 key
   * @returns 剩余时间（秒），-1 表示永久，-2 表示不存在
   */
  async ttl(key: string): Promise<number> {
    const client = getClient();
    const fullKey = `${LOCK_PREFIX}${key}`;
    return await client.ttl(fullKey);
  }

  /**
   * 带重试的获取锁
   * @param key 锁的 key
   * @param value 锁的值
   * @param options 锁选项
   * @returns 是否获取成功
   */
  async acquireWithRetry(key: string, value: string, options: LockOptions = {}): Promise<boolean> {
    const retryInterval = options.retryInterval || DEFAULT_RETRY_INTERVAL;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    let retries = 0;
    while (true) {
      const acquired = await this.acquire(key, value, options);
      if (acquired) {
        return true;
      }

      retries++;
      if (maxRetries > 0 && retries >= maxRetries) {
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, retryInterval));
    }
  }
}

// 导出单例
export const lock = new DistributedLock();

/**
 * 便捷函数：包装需要加锁的操作
 * @param key 锁的 key
 * @param fn 需要执行的操作
 * @param options 锁选项
 * @returns 操作结果
 */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const value = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const acquired = await lock.acquireWithRetry(key, value, options);

  if (!acquired) {
    throw new Error(`Failed to acquire lock for key: ${key}`);
  }

  try {
    return await fn();
  } finally {
    if (options.autoRelease !== false) {
      await lock.release(key, value);
    }
  }
}

export default { lock, withLock, DistributedLock };
