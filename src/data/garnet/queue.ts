/**
 * Garnet 队列
 * 任务队列: Garnet (使用 Redis Streams)
 * 事件流: Garnet (使用 Redis Streams)
 */

import { getClient } from './client';

// 任务队列 Stream
const TASK_STREAM = 'stream:tasks';
const TASK_CONSUMER_GROUP = 'task-processors';

// 事件流 Stream
const EVENT_STREAM = 'stream:events';
const EVENT_CONSUMER_GROUP = 'event-consumers';

// 任务项结构
export interface TaskItem {
  id: string;
  type: string;
  payload: object;
  priority?: number;
  retryCount: number;
  createdAt: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

/**
 * 任务队列
 */
class TaskQueue {
  /**
   * 添加任务
   */
  async add(task: Omit<TaskItem, 'id' | 'retryCount' | 'createdAt' | 'status'>): Promise<string> {
    const client = getClient();
    const taskId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const taskData: TaskItem = {
      ...task,
      id: taskId,
      retryCount: 0,
      createdAt: Date.now(),
      status: 'pending',
    };

    await client.xadd(TASK_STREAM, '*', 'data', JSON.stringify(taskData));
    return taskId;
  }

  /**
   * 消费任务（BRPOP 方式）
   */
  async consume(timeout: number = 0): Promise<TaskItem | null> {
    const client = getClient();
    const result = await client.xreadgroup(
      'GROUP',
      TASK_CONSUMER_GROUP,
      'consumer-1',
      'COUNT',
      '1',
      'BLOCK',
      timeout.toString(),
      'STREAMS',
      TASK_STREAM,
      '>'
    );

    if (!result || !result[0] || !result[0][1] || (result[0][1] as any[]).length === 0) {
      return null;
    }

    const [, messages] = result[0] as [string, any[]];
    const [id, fields] = messages[0] as [string, string[]];
    const dataStr = fields[1];
    const task: TaskItem = JSON.parse(dataStr);

    // 确认处理
    await client.xack(TASK_STREAM, TASK_CONSUMER_GROUP, id);

    return task;
  }

  /**
   * 获取队列长度
   */
  async length(): Promise<number> {
    const client = getClient();
    const info = await (client as any).xinfo('STREAM', TASK_STREAM) as any[];
    return info[1] as number;
  }

  /**
   * 获取待处理任务数
   */
  async pendingCount(): Promise<number> {
    const client = getClient();
    try {
      const info = await client.xpending(TASK_STREAM, TASK_CONSUMER_GROUP);
      return info[0] as number;
    } catch {
      return 0;
    }
  }

  /**
   * 重新处理失败任务
   */
  async reprocessFailed(limit: number = 100): Promise<number> {
    const client = getClient();
    let count = 0;

    try {
      const pending = await client.xpending(TASK_STREAM, TASK_CONSUMER_GROUP, '-', '+', limit);
      for (const [id, , , [, action]] of pending as any[]) {
        if (action === 'claimed') {
          await client.xack(TASK_STREAM, TASK_CONSUMER_GROUP, id);
          count++;
        }
      }
    } catch {
      // Stream 不存在
    }

    return count;
  }

  /**
   * 初始化消费者组
   */
  async initConsumerGroup(): Promise<void> {
    const client = getClient();
    try {
      await (client as any).xgroup('CREATE', TASK_STREAM, TASK_CONSUMER_GROUP, '0', 'MKSTREAM');
    } catch (error: any) {
      if (!error.message.includes('BUSYGROUP')) {
        throw error;
      }
    }
  }
}

/**
 * 事件流
 */
class EventStream {
  /**
   * 发布事件
   */
  async publish(event: { type: string; payload: object; source?: string }): Promise<string> {
    const client = getClient();
    const eventId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const eventData = {
      id: eventId,
      type: event.type,
      payload: event.payload,
      source: event.source || 'unknown',
      timestamp: Date.now(),
    };

    await client.xadd(EVENT_STREAM, '*', 'data', JSON.stringify(eventData));
    return eventId;
  }

  /**
   * 订阅事件（XREAD 方式）
   */
  async subscribe(
    callback: (event: { id: string; type: string; payload: object; timestamp: number }) => void,
    lastId: string = '$'
  ): Promise<void> {
    const client = getClient();

    while (true) {
      try {
        const result = await client.xread('COUNT', '100', 'BLOCK', '5000', 'STREAMS', EVENT_STREAM, lastId);
        if (result && result[0] && result[0][1]) {
          for (const [id, fields] of result[0][1]) {
            lastId = id;
            const dataStr = fields[1];
            const event = JSON.parse(dataStr);
            callback(event);
          }
        }
      } catch (error: any) {
        if (error.message.includes('no such key')) {
          // Stream 不存在，等待创建
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        console.error('[EventStream] Subscribe error:', error.message);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * 获取事件数量
   */
  async count(type?: string): Promise<number> {
    const client = getClient();
    try {
      if (type) {
        let count = 0;
        let lastId = '0';
        while (true) {
          const result = await client.xrange(EVENT_STREAM, lastId, '+', 'COUNT', '1000');
          if (!result || result.length === 0) break;
          for (const [, fields] of result) {
            const dataStr = fields[1];
            const event = JSON.parse(dataStr);
            if (event.type === type) count++;
            lastId = (result[result.length - 1][0] as string) || lastId;
          }
          if (result.length < 1000) break;
        }
        return count;
      } else {
        const info = await (client as any).xinfo('STREAM', EVENT_STREAM) as any[];
        return info[1] as number;
      }
    } catch {
      return 0;
    }
  }

  /**
   * 读取历史事件
   */
  async readHistory(limit: number = 100, startId: string = '-'): Promise<object[]> {
    const client = getClient();
    try {
      const result = await client.xrange(EVENT_STREAM, startId, '+', 'COUNT', limit.toString());
      const events: object[] = [];
      for (const [, fields] of result) {
        const dataStr = fields[1];
        events.push(JSON.parse(dataStr));
      }
      return events;
    } catch {
      return [];
    }
  }

  /**
   * 初始化消费者组
   */
  async initConsumerGroup(): Promise<void> {
    const client = getClient();
    try {
      await (client as any).xgroup('CREATE', EVENT_STREAM, EVENT_CONSUMER_GROUP, '0', 'MKSTREAM');
    } catch (error: any) {
      if (!error.message.includes('BUSYGROUP')) {
        throw error;
      }
    }
  }
}

// 事件项类型（用于订阅时）
export interface EventItem {
  id: string;
  type: string;
  payload: object;
  source: string;
  timestamp: number;
}

export const taskQueue = new TaskQueue();
export const eventStream = new EventStream();

export default { taskQueue, eventStream };
