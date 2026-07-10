/**
 * uiMessageStore — Data Parts 模式的消息存储
 *
 * 设计参考: Vercel AI SDK 5 UIMessage + React useSyncExternalStore
 *
 * 核心理念:
 *   旧模式: StreamEvent → streamingStore (flat state) → 组件手动映射渲染
 *   新模式: StreamEvent → UIPart → uiMessageStore (messages with parts) → 组件按 part 类型渲染
 *
 * 优势:
 *   1. 消息是完整的故事线 (parts 按时间排列), 不是零散的状态片段
 *   2. 组件只需 `parts.filter(p => p.type === 'text')` 即可获取所需数据
 *   3. 流式更新 = append part / update last part, 不需要全量替换
 *   4. 持久化 = JSON.stringify(messages), 天然可序列化
 *   5. 回放 = 按顺序 apply parts, 可重建任意时刻的 UI 状态
 *
 * 2026-07-10: P3-1 实现
 */

import { useSyncExternalStore } from 'react';
import type { StreamEvent, TaskPhase } from '../types/streaming';
import type { UIMessage, UIPart, UITextPart } from '../types/messages';
import { streamEventToUIPart } from './eventToUIPart';

// ==================== Store 核心 ====================

class UIMessageStore {
  /** chatId → messages */
  private messages = new Map<string, UIMessage[]>();
  /** 订阅者 */
  private listeners = new Set<() => void>();
  /** chatId → 快照缓存 (引用稳定, 避免不必要的重渲染) */
  private snapshots = new Map<string, UIMessage[]>();
  private version = 0;

  // ============== 订阅 ==============

  subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  };

  /** 获取指定 chatId 的消息快照 (引用稳定) */
  getSnapshot = (chatId: string): UIMessage[] => {
    const cached = this.snapshots.get(chatId);
    if (cached) return cached;
    const snapshot = this.messages.get(chatId) ?? [];
    this.snapshots.set(chatId, snapshot);
    return snapshot;
  };

  /** 获取所有 chatId 的消息 (无缓存, 仅供测试) */
  getAllMessages(): Map<string, UIMessage[]> {
    return new Map(this.messages);
  }

  private notify(): void {
    this.snapshots.clear();
    this.version++;
    this.listeners.forEach(l => l());
  }

  // ============== 消息管理 ==============

  /** 确保 chatId 有消息数组 */
  private ensureChat(chatId: string): UIMessage[] {
    let msgs = this.messages.get(chatId);
    if (!msgs) {
      msgs = [];
      this.messages.set(chatId, msgs);
    }
    return msgs;
  }

  /**
   * 创建新的 UIMessage (用户消息或 assistant 消息)
   */
  createMessage(
    chatId: string,
    role: UIMessage['role'],
    rootTaskId?: string,
    initialParts?: UIPart[],
  ): UIMessage {
    const msgs = this.ensureChat(chatId);
    const msg: UIMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      parts: initialParts ?? [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      chatId,
      rootTaskId,
      status: role === 'assistant' ? 'streaming' : 'done',
    };
    msgs.push(msg);
    this.notify();
    return msg;
  }

  /**
   * 向指定消息追加 part
   */
  appendPart(chatId: string, messageId: string, part: UIPart): void {
    const msgs = this.messages.get(chatId);
    if (!msgs) return;
    const msg = msgs.find(m => m.id === messageId);
    if (!msg) return;
    msg.parts.push(part);
    msg.updatedAt = Date.now();
    this.notify();
  }

  /**
   * 更新指定消息的最后一个指定类型 part
   * 用于流式 text 更新 (text part 累积而非追加)
   */
  updateLastPart(chatId: string, messageId: string, partType: UIPart['type'], updater: (part: UIPart) => UIPart): void {
    const msgs = this.messages.get(chatId);
    if (!msgs) return;
    const msg = msgs.find(m => m.id === messageId);
    if (!msg) return;

    // 从后往前找最后一个指定类型的 part
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      if (msg.parts[i].type === partType) {
        msg.parts[i] = updater(msg.parts[i]);
        msg.updatedAt = Date.now();
        this.notify();
        return;
      }
    }
  }

  /**
   * 处理流式 text_chunk: 追加到最后的 text part, 或新建 text part
   */
  appendTextChunk(chatId: string, messageId: string, text: string, streaming: boolean): void {
    const msgs = this.messages.get(chatId);
    if (!msgs) return;
    const msg = msgs.find(m => m.id === messageId);
    if (!msg) return;

    const lastPart = msg.parts[msg.parts.length - 1];
    if (lastPart && lastPart.type === 'text' && (lastPart as UITextPart).streaming) {
      // 追加到最后一个 streaming text part
      (lastPart as UITextPart).text += text;
      (lastPart as UITextPart).streaming = streaming;
    } else {
      // 新建 text part
      msg.parts.push({ type: 'text', text, streaming } as UITextPart);
    }
    msg.updatedAt = Date.now();
    this.notify();
  }

  /**
   * 标记消息为完成 (停止 streaming)
   */
  completeMessage(chatId: string, messageId: string, status: UIMessage['status'] = 'done'): void {
    const msgs = this.messages.get(chatId);
    if (!msgs) return;
    const msg = msgs.find(m => m.id === messageId);
    if (!msg) return;

    msg.status = status;
    // 将所有 streaming text parts 标记为非 streaming
    for (const part of msg.parts) {
      if (part.type === 'text' && (part as UITextPart).streaming) {
        (part as UITextPart).streaming = false;
      }
    }
    msg.updatedAt = Date.now();
    this.notify();
  }

  /**
   * 从 StreamEvent 批量构建 parts 并追加到消息
   * 这是旧事件系统 → 新 parts 模式的桥接入口
   */
  appendEventAsPart(chatId: string, messageId: string, event: StreamEvent, prevPhase?: TaskPhase): void {
    const part = streamEventToUIPart(event, prevPhase);
    if (part) {
      this.appendPart(chatId, messageId, part);
    }
  }

  /**
   * 获取指定 chatId 的所有消息
   */
  getMessages(chatId: string): UIMessage[] {
    return this.messages.get(chatId) ?? [];
  }

  /**
   * 获取指定 chatId 最后一条 assistant 消息
   */
  getLastAssistantMessage(chatId: string): UIMessage | undefined {
    const msgs = this.messages.get(chatId);
    if (!msgs) return undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') return msgs[i];
    }
    return undefined;
  }

  /**
   * 清空指定 chatId 的所有消息
   */
  clearChat(chatId: string): void {
    if (!this.messages.has(chatId)) return;
    this.messages.delete(chatId);
    this.notify();
  }

  /**
   * 序列化指定 chatId 的消息 (用于持久化)
   */
  serialize(chatId: string): string {
    return JSON.stringify(this.messages.get(chatId) ?? []);
  }

  /**
   * 从序列化数据恢复消息 (用于崩溃恢复)
   */
  deserialize(chatId: string, data: string): void {
    try {
      const parsed = JSON.parse(data) as UIMessage[];
      if (Array.isArray(parsed)) {
        this.messages.set(chatId, parsed);
        this.notify();
      }
    } catch {
      // 反序列化失败, 静默忽略
    }
  }

  /** 测试用: 重置所有状态 */
  __reset(): void {
    this.messages.clear();
    this.snapshots.clear();
    this.notify();
  }
}

// ==================== 单例导出 ====================

export const uiMessageStore = new UIMessageStore();

// ==================== React Hooks ====================

/**
 * 订阅指定 chatId 的 UIMessage 列表
 * 使用 useSyncExternalStore 保证 concurrent mode 下无撕裂
 */
export function useUIMessages(chatId: string | null | undefined): UIMessage[] {
  return useSyncExternalStore(
    uiMessageStore.subscribe,
    () => chatId ? uiMessageStore.getSnapshot(chatId) : EMPTY_MESSAGES,
    () => chatId ? uiMessageStore.getSnapshot(chatId) : EMPTY_MESSAGES,
  );
}

/**
 * 订阅指定 chatId 最后一条 assistant 消息
 * 用于 StreamPanel 渲染当前任务的消息流
 */
export function useLastAssistantMessage(chatId: string | null | undefined): UIMessage | undefined {
  const messages = useUIMessages(chatId);
  if (!chatId || messages.length === 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i];
  }
  return undefined;
}

/**
 * 订阅指定消息的指定类型 parts
 * 用于组件按需获取 parts (如只取 text parts, 只取 audit findings)
 */
export function usePartsByType<T extends UIPart>(
  chatId: string | null | undefined,
  messageId: string | undefined,
  partType: UIPart['type'],
): T[] {
  const messages = useUIMessages(chatId);
  if (!chatId || !messageId) return EMPTY_ARRAY as T[];
  const msg = messages.find(m => m.id === messageId);
  if (!msg) return EMPTY_ARRAY as T[];
  return msg.parts.filter(p => p.type === partType) as T[];
}

const EMPTY_MESSAGES: UIMessage[] = [];
const EMPTY_ARRAY: UIPart[] = [];
