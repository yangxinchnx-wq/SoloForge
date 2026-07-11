/**
 * ChatStore — 对话列表三层持久化
 *
 * ★ 2026-07-11: 从 JSON 文件迁移到热/温/冷三层架构
 *
 * 架构:
 *   内存 Map (L0)  →  Garnet 热存储 (L1, ms 级, 24h TTL)
 *                  →  SurrealDB 温存储 (L2, s 级, 持久)
 *                  →  JSONL 冷归档 (L3)
 *
 * 写入流程:
 *   1. 写操作 → 立即写内存 + Garnet (热)
 *   2. 防抖 500ms → 异步 flush 到 SurrealDB (温)
 *
 * 读取流程:
 *   1. list() → 先查内存
 *   2. miss → 查 Garnet (热)
 *   3. miss → 查 SurrealDB (温)
 *
 * 冷启动恢复:
 *   启动时从 SurrealDB 加载到内存
 *
 * 此文件位于 src/server/ 下, 只能在 Node 进程 (Express server.ts) 加载。
 * 前端组件绝对不能 import 此文件。
 */

import fs from 'fs';
import path from 'path';
import { hotSetChatList, hotGetChatList } from '../persistence/ConversationGarnetStore';
import { getConversationWarmStore, getConversationWarmStoreSync } from '../persistence/ConversationSurrealStore';

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
  private order: string[] = [];
  private selectedChatId: string | null = null;
  private liveStates: Record<string, ChatLiveState> = {};
  private counter = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  // 旧 JSON 文件路径 (仅用于一次性迁移)
  private legacyPath: string;
  private migrated = false;

  constructor(legacyPath?: string) {
    this.legacyPath = legacyPath || path.join(process.cwd(), '.soloforge', 'chats.json');
  }

  // ── 冷启动恢复 ──────────────────────────────────────────────

  /**
   * 从 SurrealDB (温) 加载到内存
   * 在 server 启动时调用
   */
  async restoreFromWarm(): Promise<void> {
    try {
      const warm = await getConversationWarmStore();
      if (!warm.isAvailable()) {
        console.warn('[ChatStore] 温存储不可用, 尝试从旧 JSON 文件迁移');
        await this.migrateFromJson();
        return;
      }

      const data = await warm.loadChatList();
      if (data && data.chats.length > 0) {
        for (const c of data.chats) {
          this.chats.set(c.id, c);
          this.order.push(c.id);
        }
        this.selectedChatId = data.selectedId;
        this.liveStates = data.liveStates;
        this.counter = data.counter || this.chats.size;
        this.migrated = true;
        console.log(`[ChatStore] 从温存储恢复 ${this.chats.size} 条对话`);
      } else {
        // 温存储为空, 尝试从旧 JSON 迁移
        await this.migrateFromJson();
      }
    } catch (e) {
      console.warn('[ChatStore] 冷启动恢复失败, 尝试从旧 JSON 迁移:', (e as Error).message);
      await this.migrateFromJson();
    }
  }

  /**
   * 一次性迁移: 从旧 JSON 文件导入到 SurrealDB
   */
  private async migrateFromJson(): Promise<void> {
    if (this.migrated) return;
    this.migrated = true;

    try {
      if (!fs.existsSync(this.legacyPath)) {
        console.log('[ChatStore] 无旧 JSON 文件, 跳过迁移');
        return;
      }
      const raw = fs.readFileSync(this.legacyPath, 'utf-8');
      const data = JSON.parse(raw);

      if (Array.isArray(data.chats)) {
        for (const c of data.chats) {
          this.chats.set(c.id, c);
          this.order.push(c.id);
        }
      }
      this.selectedChatId = data.selectedChatId ?? null;
      this.liveStates = data.liveStates && typeof data.liveStates === 'object' ? data.liveStates : {};
      this.counter = data.counter || this.chats.size;

      console.log(`[ChatStore] 从旧 JSON 迁移 ${this.chats.size} 条对话`);

      // 写入温存储 + 热存储
      const warm = await getConversationWarmStore();
      const chatList = this.order.map(id => this.chats.get(id)!).filter(Boolean);
      if (warm.isAvailable()) {
        await warm.saveChatList(chatList, this.selectedChatId, this.liveStates, this.counter);
      }
      await hotSetChatList({
        chats: chatList,
        selectedId: this.selectedChatId,
        liveStates: this.liveStates,
        counter: this.counter,
      });

      console.log('[ChatStore] ✅ 旧 JSON 数据已迁移到热+温存储');

      // 重命名旧文件
      const backupPath = this.legacyPath + '.migrated';
      try {
        fs.renameSync(this.legacyPath, backupPath);
        console.log(`[ChatStore] 旧 JSON 已重命名为 ${backupPath}`);
      } catch { /* ignore */ }
    } catch (e) {
      console.warn('[ChatStore] 旧 JSON 迁移失败:', (e as Error).message);
    }
  }

  // ── 防抖 flush ──────────────────────────────────────────────

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { void this.flushNow(); }, 500);
  }

  /**
   * flush 到热层 (Garnet) + 温层 (SurrealDB)
   */
  async flushNow(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const chatList = this.order.map(id => this.chats.get(id)!).filter(Boolean);
    const data = {
      chats: chatList,
      selectedId: this.selectedChatId,
      liveStates: this.liveStates,
      counter: this.counter,
    };

    // 写热层
    await hotSetChatList(data);

    // 写温层
    const warm = getConversationWarmStoreSync();
    if (warm.isAvailable()) {
      await warm.saveChatList(chatList, this.selectedChatId, this.liveStates, this.counter);
    }
  }

  /** 同步 flush (进程退出时) */
  flushSync(): void {
    void this.flushNow();
  }

  // ── 读操作 ──────────────────────────────────────────────────

  list(): { chats: ChatItem[]; selectedId: string | null; liveStates: Record<string, ChatLiveState> } {
    // 如果内存为空, 尝试异步从热层加载 (不阻塞同步返回)
    if (this.chats.size === 0) {
      this._asyncLoadFromHot().catch(() => {});
    }
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

    let nextSelectedId = this.selectedChatId;
    if (this.selectedChatId === id) {
      nextSelectedId = this.order[0] ?? null;
      this.selectedChatId = nextSelectedId;
    }

    // ★ 2026-07-11: 删除操作立即 flush, 不走 500ms 防抖
    //   防止进程崩溃导致已删对话从 Garnet/SurrealDB 复活
    void this.flushNow();

    return { deleted: true, nextSelectedId };
  }

  reorder(orderedIds: string[]): void {
    const newOrder: string[] = [];
    const seen = new Set<string>();
    for (const id of orderedIds) {
      if (this.chats.has(id) && !seen.has(id)) {
        newOrder.push(id);
        seen.add(id);
      }
    }
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

  // ── 内部辅助 ────────────────────────────────────────────────

  private async _asyncLoadFromHot(): Promise<void> {
    const hot = await hotGetChatList();
    if (hot && hot.chats.length > 0) {
      if (this.chats.size === 0) {
        for (const c of hot.chats) {
          this.chats.set(c.id, c);
          this.order.push(c.id);
        }
        this.selectedChatId = hot.selectedId;
        this.liveStates = hot.liveStates;
        this.counter = hot.counter || this.chats.size;
      }
      return;
    }

    // 热层也空, 查温层
    const warm = getConversationWarmStoreSync();
    if (warm.isAvailable()) {
      const data = await warm.loadChatList();
      if (data && data.chats.length > 0 && this.chats.size === 0) {
        for (const c of data.chats) {
          this.chats.set(c.id, c);
          this.order.push(c.id);
        }
        this.selectedChatId = data.selectedId;
        this.liveStates = data.liveStates;
        this.counter = data.counter || this.chats.size;
        // 回填热层
        await hotSetChatList({
          chats: data.chats,
          selectedId: data.selectedId,
          liveStates: data.liveStates,
          counter: data.counter,
        });
      }
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
