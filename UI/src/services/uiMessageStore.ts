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

// ==================== Op Log (Checkpointer, P2.5) ====================
//
// 记录 uiMessageStore 的每个写操作, 用于时间旅行回放 (replay)。
// 设计参考: Erlang/OTP event log + Redux DevTools time-travel。
//
// 注意: op log 只记录可重建状态的最小信息:
//   - appendPart/appendParts: 记录完整 part(s)
//   - appendTextChunk: 记录 text + streaming (回放时复用累积逻辑)
//   - updateLastPart: 记录更新后的完整 part (updater 函数不可序列化)
//   - createMessage: 记录 role + rootTaskId + initialParts
//   - completeMessage: 记录 status
//   - clearChat: 标记清空

export type OpLogOp =
  | 'createMessage'
  | 'appendPart'
  | 'appendParts'
  | 'appendTextChunk'
  | 'updateLastPart'
  | 'completeMessage'
  | 'clearChat';

export interface OpLogEntry {
  op: OpLogOp;
  chatId: string;
  messageId?: string;
  timestamp: number;
  /** 全局递增的 part 序号 (调试/排序用) */
  partIndex: number;
  // 操作参数 (按 op 不同, 只填相关字段)
  part?: UIPart;
  parts?: UIPart[];
  text?: string;
  streaming?: boolean;
  role?: UIMessage['role'];
  rootTaskId?: string;
  initialParts?: UIPart[];
  status?: UIMessage['status'];
}

const DEFAULT_MAX_OP_LOG_SIZE = 2000;

// ==================== Store 核心 ====================

class UIMessageStore {
  /** chatId → messages */
  private messages = new Map<string, UIMessage[]>();
  /** 订阅者 */
  private listeners = new Set<() => void>();
  /** chatId → 快照缓存 (引用稳定, 避免不必要的重渲染) */
  private snapshots = new Map<string, UIMessage[]>();
  private version = 0;

  // P2.5: op log (按 chatId 隔离)
  private opLogs = new Map<string, OpLogEntry[]>();
  private maxOpLogSize = DEFAULT_MAX_OP_LOG_SIZE;
  /** 全局 part 计数器 (跨 chat, 用于 op log 排序) */
  private globalPartCounter = 0;

  // ============== 订阅 ==============

  subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  };

  /**
   * 获取指定 chatId 的消息快照
   *
   * ★ FIX 2026-07-12: 返回数组副本而非 Map 内部引用。
   *   原代码返回 this.messages.get(chatId) 的直接引用,
   *   appendPart 等方法 mutate 同一数组 → 引用不变 →
   *   useSyncExternalStore 用 Object.is 比较旧新快照, 认为没变化 →
   *   不触发重渲染 → StreamPanel 永远看到初始空 parts。
   *
   *   notify 清空 snapshots 缓存后, 下次 getSnapshot 创建新副本,
   *   引用不同 → useSyncExternalStore 检测到变化 → 触发重渲染。
   *   缓存保证同一 notify 周期内多次调用返回同一引用 (concurrent mode 安全)。
   */
  getSnapshot = (chatId: string): UIMessage[] => {
    const cached = this.snapshots.get(chatId);
    if (cached) return cached;
    const snapshot = [...(this.messages.get(chatId) ?? [])];
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

  // ============== Op Log (P2.5) ==============

  /** 记录一条 op log (内部调用) */
  private recordOp(entry: Omit<OpLogEntry, 'partIndex' | 'timestamp'> & { timestamp?: number }): void {
    const log = this.opLogs.get(entry.chatId) ?? [];
    const full: OpLogEntry = {
      ...entry,
      partIndex: ++this.globalPartCounter,
      timestamp: entry.timestamp ?? Date.now(),
    } as OpLogEntry;
    log.push(full);
    // 容量限制: 超出丢弃最早
    if (log.length > this.maxOpLogSize) {
      log.splice(0, log.length - this.maxOpLogSize);
    }
    this.opLogs.set(entry.chatId, log);
  }

  /** 获取指定 chatId 的 op log (回放/调试用) */
  getOpLog(chatId: string): OpLogEntry[] {
    return this.opLogs.get(chatId) ?? [];
  }

  /** 设置 op log 最大容量 (测试用) */
  setMaxOpLogSize(size: number): void {
    this.maxOpLogSize = Math.max(10, size);
  }

  /** 清除指定 chatId 的 op log */
  clearOpLog(chatId: string): void {
    this.opLogs.delete(chatId);
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
   *
   * ★ FIX 2026-07-12: 不可变更新 — 替换 Map 中的数组为新数组,
   *   而非 push 到同一数组, 确保 useSyncExternalStore 检测到引用变化。
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
    this.messages.set(chatId, [...msgs, msg]);
    this.recordOp({ op: 'createMessage', chatId, messageId: msg.id, role, rootTaskId, initialParts });
    this.notify();
    return msg;
  }

  /**
   * 向指定消息追加 part
   *
   * ★ FIX 2026-07-12: 不可变更新 — 创建新的 message 对象和新的 parts 数组,
   *   而非 mutate 原对象。否则依赖 message 的 useMemo 不会重新计算。
   */
  appendPart(chatId: string, messageId: string, part: UIPart): void {
    const msgs = this.messages.get(chatId);
    if (!msgs) return;
    const msgIndex = msgs.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return;
    const msg = msgs[msgIndex];
    const newMsg: UIMessage = { ...msg, parts: [...msg.parts, part], updatedAt: Date.now() };
    this.messages.set(chatId, msgs.map((m, i) => i === msgIndex ? newMsg : m));
    this.recordOp({ op: 'appendPart', chatId, messageId, part });
    this.notify();
  }

  /**
   * 批量追加 parts (单次 notify, 减少高频场景的重渲染次数)
   */
  appendParts(chatId: string, messageId: string, parts: UIPart[]): void {
    if (parts.length === 0) return;
    const msgs = this.messages.get(chatId);
    if (!msgs) return;
    const msgIndex = msgs.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return;
    const msg = msgs[msgIndex];
    const newMsg: UIMessage = { ...msg, parts: [...msg.parts, ...parts], updatedAt: Date.now() };
    this.messages.set(chatId, msgs.map((m, i) => i === msgIndex ? newMsg : m));
    this.recordOp({ op: 'appendParts', chatId, messageId, parts });
    this.notify();
  }

  /**
   * 更新指定消息的最后一个指定类型 part
   */
  updateLastPart(chatId: string, messageId: string, partType: UIPart['type'], updater: (part: UIPart) => UIPart): void {
    const msgs = this.messages.get(chatId);
    if (!msgs) return;
    const msgIndex = msgs.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return;
    const msg = msgs[msgIndex];

    // 从后往前找最后一个指定类型的 part
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      if (msg.parts[i].type === partType) {
        const newParts = [...msg.parts];
        newParts[i] = updater(newParts[i]);
        const newMsg: UIMessage = { ...msg, parts: newParts, updatedAt: Date.now() };
        this.messages.set(chatId, msgs.map((m, idx) => idx === msgIndex ? newMsg : m));
        this.recordOp({ op: 'updateLastPart', chatId, messageId, part: newParts[i] });
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
    const msgIndex = msgs.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return;
    const msg = msgs[msgIndex];

    const lastPart = msg.parts[msg.parts.length - 1];
    let newParts: UIPart[];
    if (lastPart && lastPart.type === 'text' && (lastPart as UITextPart).streaming) {
      // 追加到最后一个 streaming text part
      const updatedPart: UITextPart = {
        ...lastPart,
        text: (lastPart as UITextPart).text + text,
        streaming,
      };
      newParts = [...msg.parts.slice(0, -1), updatedPart];
    } else {
      // 新建 text part
      newParts = [...msg.parts, { type: 'text', text, streaming } as UITextPart];
    }
    const newMsg: UIMessage = { ...msg, parts: newParts, updatedAt: Date.now() };
    this.messages.set(chatId, msgs.map((m, idx) => idx === msgIndex ? newMsg : m));
    this.recordOp({ op: 'appendTextChunk', chatId, messageId, text, streaming });
    this.notify();
  }

  /**
   * 标记消息为完成 (停止 streaming)
   */
  completeMessage(chatId: string, messageId: string, status: UIMessage['status'] = 'done'): void {
    const msgs = this.messages.get(chatId);
    if (!msgs) return;
    const msgIndex = msgs.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return;
    const msg = msgs[msgIndex];

    // 将所有 streaming text parts 标记为非 streaming
    const newParts = msg.parts.map(part => {
      if (part.type === 'text' && (part as UITextPart).streaming) {
        return { ...part, streaming: false } as UITextPart;
      }
      return part;
    });
    const newMsg: UIMessage = { ...msg, status, parts: newParts, updatedAt: Date.now() };
    this.messages.set(chatId, msgs.map((m, idx) => idx === msgIndex ? newMsg : m));
    this.recordOp({ op: 'completeMessage', chatId, messageId, status });
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
    this.recordOp({ op: 'clearChat', chatId });
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

  // ============== 时间旅行回放 (P2.5) ==============

  /**
   * 从 op log 重建指定 chatId 在 untilTimestamp 时刻的消息状态
   *
   * 不修改当前 store 状态, 返回一个独立的 UIMessage[] 副本。
   * 用于: 调试 (查看历史某时刻的 UI)、崩溃恢复、状态对比。
   *
   * @param chatId 目标对话
   * @param untilTimestamp 回放到此时间戳为止 (含), 不传则回放全部 op log
   * @returns 重建的 UIMessage[] (独立副本, 不影响 store)
   */
  replay(chatId: string, untilTimestamp?: number): UIMessage[] {
    const log = this.opLogs.get(chatId);
    if (!log || log.length === 0) return [];

    // 过滤到指定时间戳
    const entries = untilTimestamp !== undefined
      ? log.filter(e => e.timestamp <= untilTimestamp)
      : log;

    // 在独立的临时状态上 apply op log
    const rebuilt: UIMessage[] = [];

    for (const entry of entries) {
      switch (entry.op) {
        case 'createMessage': {
          const msg: UIMessage = {
            id: entry.messageId!,
            role: entry.role!,
            parts: entry.initialParts ? [...entry.initialParts] : [],
            createdAt: entry.timestamp,
            updatedAt: entry.timestamp,
            chatId: entry.chatId,
            rootTaskId: entry.rootTaskId,
            status: entry.role === 'assistant' ? 'streaming' : 'done',
          };
          rebuilt.push(msg);
          break;
        }
        case 'appendPart': {
          const msg = rebuilt.find(m => m.id === entry.messageId);
          if (msg && entry.part) {
            msg.parts.push(entry.part);
            msg.updatedAt = entry.timestamp;
          }
          break;
        }
        case 'appendParts': {
          const msg = rebuilt.find(m => m.id === entry.messageId);
          if (msg && entry.parts) {
            for (const p of entry.parts) msg.parts.push(p);
            msg.updatedAt = entry.timestamp;
          }
          break;
        }
        case 'appendTextChunk': {
          const msg = rebuilt.find(m => m.id === entry.messageId);
          if (!msg || entry.text === undefined) break;
          const lastPart = msg.parts[msg.parts.length - 1];
          if (lastPart && lastPart.type === 'text' && (lastPart as UITextPart).streaming) {
            (lastPart as UITextPart).text += entry.text;
            (lastPart as UITextPart).streaming = entry.streaming ?? false;
          } else {
            msg.parts.push({ type: 'text', text: entry.text, streaming: entry.streaming } as UITextPart);
          }
          msg.updatedAt = entry.timestamp;
          break;
        }
        case 'updateLastPart': {
          const msg = rebuilt.find(m => m.id === entry.messageId);
          if (!msg || !entry.part) break;
          for (let i = msg.parts.length - 1; i >= 0; i--) {
            if (msg.parts[i].type === entry.part.type) {
              msg.parts[i] = entry.part;
              msg.updatedAt = entry.timestamp;
              break;
            }
          }
          break;
        }
        case 'completeMessage': {
          const msg = rebuilt.find(m => m.id === entry.messageId);
          if (!msg) break;
          msg.status = entry.status ?? 'done';
          for (const part of msg.parts) {
            if (part.type === 'text' && (part as UITextPart).streaming) {
              (part as UITextPart).streaming = false;
            }
          }
          msg.updatedAt = entry.timestamp;
          break;
        }
        case 'clearChat': {
          // clearChat 后 rebuilt 清空 (后续 op log 若有则继续重建)
          rebuilt.length = 0;
          break;
        }
      }
    }

    // 深拷贝, 确保返回独立副本
    return JSON.parse(JSON.stringify(rebuilt));
  }

  /** 测试用: 重置所有状态 */
  __reset(): void {
    this.messages.clear();
    this.snapshots.clear();
    this.opLogs.clear();
    this.globalPartCounter = 0;
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
