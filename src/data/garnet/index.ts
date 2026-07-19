/**
 * Garnet 数据层导出
 * 热数据存储: Garnet
 *
 * 按文档设计:
 * - Garnet 作为运行态缓存和队列，不存持久数据
 * - JSONL 作为真相源
 * - SurrealDB 负责 AI 结构化/向量数据
 */

export { getClient, getCompensationClient, connect, disconnect, healthCheck } from './client';
export { sessionCache, taskCache, counter, cache, wsState } from './cache';
export type { TaskItem, EventItem } from './queue';
export { taskQueue, eventStream } from './queue';
export { lock, withLock } from './lock';
export type { CompensationItem } from './compensation';
export { compensationQueue, withCompensation } from './compensation';

// 导出客户端默认实例
export { default as garnet } from './client';
