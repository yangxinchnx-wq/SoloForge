/**
 * Garnet 补偿队列
 * 用于处理 Garnet 写入失败的情况
 * 按文档设计: Garnet 允许最终一致，通过 Outbox + 补偿队列达到最终一致
 */

import { getCompensationClient } from './client';

// 补偿队列 Key
const COMPENSATION_QUEUE = 'compensation:queue';
const COMPENSATION_DLQ = 'compensation:dlq'; // 补偿失败的死信队列

// 最大重试次数
const MAX_RETRIES = 5;

/**
 * 补偿项结构
 */
export interface CompensationItem {
  id: string;
  type: 'cache' | 'queue' | 'lock' | 'counter';
  action: 'set' | 'delete' | 'incr' | 'decr';
  key: string;
  value?: string;
  ttl?: number;
  retryCount: number;
  createdAt: number;
  lastError?: string;
}

/**
 * 补偿队列管理器
 */
class CompensationQueue {
  private client = getCompensationClient();
  private isProcessing = false;
  private retryInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * 添加补偿项
   */
  async add(item: Omit<CompensationItem, 'id' | 'retryCount' | 'createdAt'>): Promise<void> {
    const compensation: CompensationItem = {
      ...item,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      retryCount: 0,
      createdAt: Date.now(),
    };

    await this.client.rpush(COMPENSATION_QUEUE, JSON.stringify(compensation));
  }

  /**
   * 获取补偿项（不删除）
   */
  async peek(): Promise<CompensationItem | null> {
    const data = await this.client.lindex(COMPENSATION_QUEUE, 0);
    return data ? JSON.parse(data) : null;
  }

  /**
   * 获取队列长度
   */
  async length(): Promise<number> {
    return await this.client.llen(COMPENSATION_QUEUE);
  }

  /**
   * 处理补偿队列
   */
  async process(): Promise<{ success: number; failed: number }> {
    if (this.isProcessing) {
      return { success: 0, failed: 0 };
    }

    this.isProcessing = true;
    let success = 0;
    let failed = 0;

    try {
      while (true) {
        const data = await this.client.lpop(COMPENSATION_QUEUE);
        if (!data) break;

        const item: CompensationItem = JSON.parse(data);

        try {
          await this.executeItem(item);
          success++;
        } catch (error) {
          item.retryCount++;
          item.lastError = error instanceof Error ? error.message : 'Unknown error';

          if (item.retryCount >= MAX_RETRIES) {
            // 移入死信队列
            await this.client.rpush(COMPENSATION_DLQ, JSON.stringify(item));
            failed++;
          } else {
            // 重新加入队列
            await this.client.rpush(COMPENSATION_QUEUE, JSON.stringify(item));
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return { success, failed };
  }

  /**
   * 执行单个补偿项
   */
  private async executeItem(item: CompensationItem): Promise<void> {
    const { type, action, key, value, ttl } = item;

    switch (type) {
      case 'cache':
        await this.executeCacheAction(action, key, value, ttl);
        break;
      case 'counter':
        await this.executeCounterAction(action, key, value);
        break;
      default:
        throw new Error(`Unknown compensation type: ${type}`);
    }
  }

  private async executeCacheAction(
    action: string,
    key: string,
    value?: string,
    ttl?: number
  ): Promise<void> {
    if (action === 'set' && value !== undefined) {
      if (ttl) {
        await this.client.setex(key, ttl, value);
      } else {
        await this.client.set(key, value);
      }
    } else if (action === 'delete') {
      await this.client.del(key);
    } else {
      throw new Error(`Unknown cache action: ${action}`);
    }
  }

  private async executeCounterAction(
    action: string,
    key: string,
    value?: string
  ): Promise<void> {
    const numValue = value ? parseInt(value, 10) : 1;
    if (action === 'incr') {
      await this.client.incrby(key, numValue);
    } else if (action === 'decr') {
      await this.client.decrby(key, numValue);
    } else {
      throw new Error(`Unknown counter action: ${action}`);
    }
  }

  /**
   * 启动定时处理（每 10 秒）
   */
  startRetryProcessor(intervalMs: number = 10000): void {
    if (this.retryInterval) return;

    this.retryInterval = setInterval(async () => {
      const length = await this.length();
      if (length > 0) {
        const result = await this.process();
        if (result.success > 0 || result.failed > 0) {
          console.log(`[Compensation] Processed: ${result.success} success, ${result.failed} failed`);
        }
      }
    }, intervalMs);
  }

  /**
   * 停止定时处理
   */
  stopRetryProcessor(): void {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }
  }

  /**
   * 获取死信队列长度
   */
  async dlqLength(): Promise<number> {
    return await this.client.llen(COMPENSATION_DLQ);
  }

  /**
   * 查看死信队列
   */
  async peekDLQ(limit: number = 10): Promise<CompensationItem[]> {
    const items: CompensationItem[] = [];
    const length = await this.client.llen(COMPENSATION_DLQ);
    const count = Math.min(length, limit);

    for (let i = 0; i < count; i++) {
      const data = await this.client.lindex(COMPENSATION_DLQ, i);
      if (data) {
        items.push(JSON.parse(data));
      }
    }

    return items;
  }

  /**
   * 清空死信队列（谨慎使用）
   */
  async clearDLQ(): Promise<void> {
    await this.client.del(COMPENSATION_DLQ);
  }
}

// 导出单例
export const compensationQueue = new CompensationQueue();

/**
 * 便捷函数：包装可能失败的 Garnet 操作
 */
export async function withCompensation<T>(
  fn: () => Promise<T>,
  compensation: Omit<CompensationItem, 'id' | 'retryCount' | 'createdAt'>
): Promise<{ result: T | null; compensated: boolean; error?: Error }> {
  try {
    const result = await fn();
    return { result, compensated: false };
  } catch (error) {
    // 操作失败，记录补偿
    await compensationQueue.add(compensation);
    return {
      result: null,
      compensated: true,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export default { compensationQueue, withCompensation };
