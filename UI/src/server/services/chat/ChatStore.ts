/**
 * ChatStore — 对话列表后端持久化
 *
 * 设计照抄 SessionStore 模式:
 *  - 内存 Map 持有所有 ChatItem, 读写 O(1)
 *  - JSON 文件做冷持久化 (.soloforge/chats.json), 防抖 flush
 *  - 进程退出时同步 flush
 *
 * 此文件位于 src/server/ 下, 只能在 Node 进程 (Express server.ts) 加载。
 * 前端组件绝对不能 import 此文件。
 */

import fs from 'fs';
import path from 'path';

// ── 类型 (与前端 chatsStore.ts 对齐) ──────────────────────────

export type ChatTag = 'VUE' | 'AUTH' | 'AI' | 'DB' | 'PAY' | 'HELP' | 'NEW' | 'WINDOWS' | 'HARMONY';
export type ChatPermission = 'normal' | 'performance' | 'ultimate' | 'expert';

export interface ChatItem {
  id: string;
  title: string;
  tag: ChatTag;
  tagBg: string;
  tagText: string;
  permission: ChatPermission;
  createdAt: number;
  updatedAt: number;
  time?: string;
  lastMessagePreview?: string;
  workspaceFolder?: string;
}

export interface ChatLiveState {
  chatId: string;
  isStreaming: boolean;
  phase?: string;
  progress?: number;
  modelName?: string;
  tokens?: number;
  lastActivityAt: number;
}

interface PersistShape {
  chats: ChatItem[];
  selectedChatId: string | null;
  liveStates: Record<string, ChatLiveState>;
  counter: number;
}

// ── 常量 ──────────────────────────────────────────────────────

export const TAG_STYLES: Record<ChatTag, { bg: string; text: string }> = {
  VUE:     { bg: 'bg-blue-500/10 border-blue-500/20',       text: 'text-blue-400' },
  AUTH:    { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-400' },
  AI:      { bg: 'bg-purple-500/10 border-purple-500/20',   text: 'text-purple-400' },
  DB:      { bg: 'bg-yellow-500/10 border-yellow-500/20',   text: 'text-yellow-400' },
  PAY:     { bg: 'bg-indigo-500/10 border-indigo-500/20',   text: 'text-indigo-400' },
  HELP:    { bg: 'bg-pink-500/10 border-pink-500/20',       text: 'text-pink-400' },
  NEW:     { bg: 'bg-amber-500/10 border-amber-500/20',     text: 'text-amber-400' },
  WINDOWS: { bg: 'bg-sky-500/10 border-sky-500/20',         text: 'text-sky-400' },
  HARMONY: { bg: 'bg-red-500/10 border-red-500/20',         text: 'text-red-400' },
};

const DEFAULT_TAG: ChatTag = 'NEW';

// ── ChatStore 类 ──────────────────────────────────────────────

export class ChatStore {
  private chats: Map<string, ChatItem> = new Map();
  private order: string[] = [];  // 保持列表顺序
  private selectedChatId: string | null = null;
  private liveStates: Record<string, ChatLiveState> = {};
  private counter = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private persistPath: string;

  constructor(persistPath?: string) {
    // 默认存到 <cwd>/.soloforge/chats.json
    this.persistPath = persistPath || path.join(process.cwd(), '.soloforge', 'chats.json');
    this.loadFromDisk();
  }

  // ── 持久化 ──────────────────────────────────────────────────

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as PersistShape;
      if (Array.isArray(data.chats)) {
        for (const c of data.chats) {
          this.chats.set(c.id, c);
          this.order.push(c.id);
        }
      }
      this.selectedChatId = data.selectedChatId ?? null;
      this.liveStates = data.liveStates && typeof data.liveStates === 'object' ? data.liveStates : {};
      this.counter = data.counter || this.chats.size;
      console.log(`[ChatStore] 从磁盘加载 ${this.chats.size} 条对话`);
    } catch (e) {
      console.warn('[ChatStore] 加载失败, 从空状态开始:', (e as Error).message);
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushNow(), 500);
  }

  flushNow(): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data: PersistShape = {
        chats: this.order.map(id => this.chats.get(id)!).filter(Boolean),
        selectedChatId: this.selectedChatId,
        liveStates: this.liveStates,
        counter: this.counter,
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.error('[ChatStore] flush 失败:', (e as Error).message);
    }
  }

  // ── 读操作 ──────────────────────────────────────────────────

  list(): { chats: ChatItem[]; selectedId: string | null; liveStates: Record<string, ChatLiveState> } {
    return {
      chats: this.order.map(id => this.chats.get(id)!).filter(Boolean),
      selectedId: this.selectedChatId,
      liveStates: this.liveStates,
    };
  }

  getChat(id: string): ChatItem | undefined {
    return this.chats.get(id);
  }

  getSelectedId(): string | null {
    return this.selectedChatId;
  }

  // ── 写操作 ──────────────────────────────────────────────────

  createChat(title?: string, permission: ChatPermission = 'normal', workspaceFolder?: string): ChatItem {
    this.counter++;
    const id = `chat-${Date.now()}-${this.counter}`;
    const tag = DEFAULT_TAG;
    const now = Date.now();
    const chat: ChatItem = {
      id,
      title: title || `新对话${this.counter}`,
      tag,
      tagBg: TAG_STYLES[tag].bg,
      tagText: TAG_STYLES[tag].text,
      permission,
      createdAt: now,
      updatedAt: now,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      workspaceFolder,
    };
    this.chats.set(id, chat);
    this.order.unshift(id);
    this.selectedChatId = id;
    this.scheduleFlush();
    return chat;
  }

  updateChat(id: string, patch: Partial<Pick<ChatItem, 'title' | 'tag' | 'permission' | 'lastMessagePreview' | 'workspaceFolder'>>): ChatItem | null {
    const chat = this.chats.get(id);
    if (!chat) return null;
    const updated: ChatItem = {
      ...chat,
      ...patch,
      updatedAt: Date.now(),
    };
    if (patch.tag && patch.tag in TAG_STYLES) {
      updated.tagBg = TAG_STYLES[patch.tag].bg;
      updated.tagText = TAG_STYLES[patch.tag].text;
    }
    this.chats.set(id, updated);
    this.scheduleFlush();
    return updated;
  }

  deleteChat(id: string): { deleted: boolean; nextSelectedId: string | null } {
    if (!this.chats.has(id)) {
      return { deleted: false, nextSelectedId: this.selectedChatId };
    }
    this.chats.delete(id);
    this.order = this.order.filter(x => x !== id);
    delete this.liveStates[id];

    // 如果删的是当前选中的, 切到列表第一个
    let nextSelectedId = this.selectedChatId;
    if (this.selectedChatId === id) {
      nextSelectedId = this.order[0] ?? null;
      this.selectedChatId = nextSelectedId;
    }
    this.scheduleFlush();
    return { deleted: true, nextSelectedId };
  }

  reorder(orderedIds: string[]): void {
    const newOrder: string[] = [];
    const seen = new Set<string>();
    // 先按传入顺序排
    for (const id of orderedIds) {
      if (this.chats.has(id) && !seen.has(id)) {
        newOrder.push(id);
        seen.add(id);
      }
    }
    // 再补上没传的 (保持原顺序)
    for (const id of this.order) {
      if (!seen.has(id)) {
        newOrder.push(id);
        seen.add(id);
      }
    }
    this.order = newOrder;
    this.scheduleFlush();
  }

  selectChat(id: string | null): void {
    this.selectedChatId = id;
    this.scheduleFlush();
  }

  setLiveState(state: ChatLiveState): void {
    this.liveStates[state.chatId] = state;
    this.scheduleFlush();
  }

  clearLiveState(chatId: string): void {
    if (this.liveStates[chatId]) {
      delete this.liveStates[chatId];
      this.scheduleFlush();
    }
  }
}

// ── 单例 ──────────────────────────────────────────────────────

let _instance: ChatStore | null = null;

export function getChatStore(): ChatStore {
  if (!_instance) {
    _instance = new ChatStore();
  }
  return _instance;
}
