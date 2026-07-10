// ─────────────────────────────────────────────────────────────────
// Session-Level 工具结果缓存 (P2: 跨 Dispatch 持久化语义缓存)
// Path: src/core/agent/tools/session-tool-cache.ts
//
// 目标: 跨多次 dispatch 请求复用工具结果, 减少重复 IO
// 生命周期: 同一 chat session 内多次 dispatch
// 存储: 内存 Map (进程级单例)
// TTL: 10 分钟 (同一会话内短期有效)
//
// 设计原则:
//   - Level 1: In-Dispatch (function-calling-client.ts 内 Map, 已有)
//   - Level 2: Cross-Dispatch Session (本模块, 新增)
//   - Level 3: Persistent Experience (experience-cache.ts, 已有)
// ─────────────────────────────────────────────────────────────────

import { createHash } from 'crypto';
import { logger } from '../../../core/logger';

/** 缓存条目 */
interface SessionCacheEntry {
  /** SHA256(chatId + toolName + JSON.stringify(args)) */
  key: string;
  /** 工具名 */
  toolName: string;
  /** 参数哈希 SHA256(JSON.stringify(args)) */
  argsHash: string;
  /** 工具输出 */
  output: string;
  /** 创建时间戳 */
  timestamp: number;
  /** 命中次数 */
  hitCount: number;
  /** TTL (ms) */
  ttl: number;
}

/** 默认 TTL: 10 分钟 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 最大条目数 (防止内存无限增长) */
const MAX_ENTRIES = 500;

/** 过期清理间隔 (ms) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Session-Level 工具结果缓存
 *
 * 进程级单例, 跨多次 dispatch 请求共享工具结果。
 * 按 chatId 隔离, 不同对话的缓存互不干扰。
 */
class SessionToolCache {
  private cache = new Map<string, SessionCacheEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private hitCount = 0;
  private missCount = 0;

  constructor() {
    // 启动定期清理过期条目
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);
    // 不阻止进程退出
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * 生成缓存 key
   * @param chatId 会话 ID
   * @param toolName 工具名
   * @param args 工具参数
   */
  private buildKey(chatId: string, toolName: string, args: unknown): string {
    const argsJson = JSON.stringify(args);
    const argsHash = createHash('sha256').update(argsJson).digest('hex').slice(0, 16);
    return createHash('sha256')
      .update(`${chatId}:${toolName}:${argsHash}`)
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * 查询缓存
   * @param chatId 会话 ID
   * @param toolName 工具名
   * @param args 工具参数
   * @returns 命中时返回输出, 未命中返回 null
   */
  lookup(chatId: string, toolName: string, args: unknown): string | null {
    const key = this.buildKey(chatId, toolName, args);
    const entry = this.cache.get(key);

    if (!entry) {
      this.missCount++;
      return null;
    }

    // TTL 检查
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      this.missCount++;
      return null;
    }

    // 命中: 更新命中次数
    entry.hitCount++;
    this.hitCount++;
    return entry.output;
  }

  /**
   * 存储工具结果
   * @param chatId 会话 ID
   * @param toolName 工具名
   * @param args 工具参数
   * @param output 工具输出
   * @param ttl TTL (ms), 默认 10 分钟
   */
  store(chatId: string, toolName: string, args: unknown, output: string, ttl: number = DEFAULT_TTL_MS): void {
    const key = this.buildKey(chatId, toolName, args);
    const argsHash = createHash('sha256')
      .update(JSON.stringify(args))
      .digest('hex')
      .slice(0, 16);

    // 容量控制: 超过上限时删除最旧的条目
    if (this.cache.size >= MAX_ENTRIES) {
      this.evictOldest();
    }

    this.cache.set(key, {
      key,
      toolName,
      argsHash,
      output,
      timestamp: Date.now(),
      hitCount: 0,
      ttl,
    });
  }

  /**
   * 清理指定 chatId 的所有缓存
   * @param chatId 会话 ID
   */
  clearByChatId(chatId: string): void {
    const prefix = createHash('sha256').update(chatId).digest('hex').slice(0, 8);
    let cleared = 0;
    for (const [key, entry] of this.cache.entries()) {
      // 通过 key 前缀匹配 chatId (buildKey 生成的 key 包含 chatId 的哈希)
      if (key.startsWith(prefix) || entry.key.startsWith(prefix)) {
        this.cache.delete(key);
        cleared++;
      }
    }
    if (cleared > 0) {
      logger.debug('SessionToolCache', `Cleared ${cleared} entries for chatId=${chatId}`);
    }
  }

  /**
   * 清理所有过期条目
   */
  private cleanupExpired(): void {
    const now = Date.now();
    let cleared = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
        cleared++;
      }
    }
    if (cleared > 0) {
      logger.debug('SessionToolCache', `Cleaned up ${cleared} expired entries (remaining: ${this.cache.size})`);
    }
  }

  /**
   * 淘汰最旧的条目 (LRU 策略的简化版)
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * 获取缓存统计
   */
  getStats(): {
    size: number;
    hitCount: number;
    missCount: number;
    hitRate: number;
  } {
    const total = this.hitCount + this.missCount;
    return {
      size: this.cache.size,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: total > 0 ? this.hitCount / total : 0,
    };
  }

  /**
   * 销毁缓存 (进程退出时调用)
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cache.clear();
  }
}

/** 进程级单例 */
export const sessionToolCache = new SessionToolCache();

/**
 * 检查工具结果是否可缓存
 * 错误结果和动态查询结果不缓存
 */
export function isCacheableToolResult(toolName: string, output: string): boolean {
  // 错误结果不缓存
  if (output.startsWith('Error:') || output.startsWith('Tool error:')) {
    return false;
  }

  // 动态工具不缓存 (结果随时间变化)
  const nonCacheableTools = new Set([
    'execute_cmd',      // 命令执行有副作用
    'browser_screenshot', // 截图随时间变化
    'bu_screenshot',    // 同上
    'bu_state',         // 状态随时变化
    'win_perfmon',      // 性能计数器实时变化
    'win_event_log',    // 事件日志实时增长
    'browser_network',  // 网络请求实时变化
    'browser_console',  // 控制台日志实时变化
  ]);

  return !nonCacheableTools.has(toolName);
}
