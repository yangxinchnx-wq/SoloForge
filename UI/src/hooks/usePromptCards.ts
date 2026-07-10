/**
 * usePromptCards — 使用 useSyncExternalStore 订阅 promptCardPool
 *
 * 2026-07-10: 替代 StreamPanel 中的 promptCardPool.getActive(chatId) 手动调用
 * 通过 React 19 的 useSyncExternalStore 实现响应式订阅, 解决非 React 原生数据源的撕裂问题
 *
 * 参考: React 官方文档 useSyncExternalStore
 *       https://react.dev/reference/react/useSyncExternalStore
 */
import { useSyncExternalStore } from 'react';
import { promptCardPool } from '../services/promptCardPool';
import type { PromptCardInstance } from '../types/streaming';

/**
 * 订阅指定 chatId 的活跃 PromptCard 实例
 *
 * 内部使用 useSyncExternalStore, 保证:
 * 1. 快照引用稳定 (不变时返回同一引用, 不触发重渲染)
 * 2. concurrent mode 下无撕裂 (tearing)
 * 3. 自动订阅/退订 (组件卸载时清理)
 */
export function usePromptCards(chatId: string): PromptCardInstance[] {
  const subscribe = promptCardPool.subscribe;
  const getSnapshot = () => promptCardPool.getSnapshotForChat(chatId);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
