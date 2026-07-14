/**
 * ConversationSurrealStore — 对话温存储 (SurrealDB)
 *
 * 职责:
 *   - 持久化所有对话消息、配置、对话列表元数据
 *   - 跨重启恢复
 *   - 30 秒定时 flush (由 ConversationStore 驱动)
 *
 * SurrealDB 表:
 *   conversation  → { id, chatId, messages, updatedAt }
 *   chat_config   → { id, chatId, config, updatedAt }
 *   chat_meta     → { id, title, tag, permission, createdAt, updatedAt, ... }
 *
 * 连接: 复用与 SurrealStore.ts 相同的 embedded rocksdb
 *   URL: rocksdb://data/canvas_sessions_db
 *   NS:  soloforge_core
 *   DB:  canvas_state
 *
 * ★ 2026-07-14: 不再降级为 noop。任何失败都直接抛错,
 *   错误信息用中文说明具体原因和具体位置。
 */

import type { ChatMessage, ChatSettingsItem } from '../chat/ConversationStore';
import type { ChatItem, ChatLiveState } from '../chat/ChatStore';
import { getSharedSurrealDb } from './SurrealStore';

// ── 接口契约 ─────────────────────────────────────────────────

export interface IConversationWarmStore {
  init(): Promise<boolean>;
  isAvailable(): boolean;

  // 消息
  saveMessages(chatId: string, messages: ChatMessage[]): Promise<boolean>;
  loadMessages(chatId: string): Promise<ChatMessage[] | null>;
  deleteMessages(chatId: string): Promise<boolean>;
  loadAllMessages(): Promise<Record<string, ChatMessage[]>>;

  // 配置
  saveConfig(chatId: string, config: ChatSettingsItem): Promise<boolean>;
  loadConfig(chatId: string): Promise<ChatSettingsItem | null>;
  deleteConfig(chatId: string): Promise<boolean>;
  loadAllConfigs(): Promise<Record<string, ChatSettingsItem>>;

  // 对话列表
  saveChatList(chats: ChatItem[], selectedId: string | null, liveStates: Record<string, ChatLiveState>, counter: number): Promise<boolean>;
  loadChatList(): Promise<{ chats: ChatItem[]; selectedId: string | null; liveStates: Record<string, ChatLiveState>; counter: number } | null>;

  close(): Promise<void>;
}

// ── 真实 SurrealDB 实现 ──────────────────────────────────────

class SurrealWarmStoreImpl implements IConversationWarmStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  private connected: boolean = false;

  /**
   * ★ 2026-07-14: 接收共享的 db 实例 (来自 SurrealStore), 不再自己创建 Surreal 实例。
   * 避免两个 Surreal 实例争抢同一个 rocksdb 文件锁。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(db: any) {
    this.db = db;
  }

  async init(): Promise<boolean> {
    try {
      // ★ 2026-07-14: db 已由 SurrealStore 初始化完成, 这里只需定义表结构
      // 定义 schemaless 表 + 索引
      try {
        await this.db.query('DEFINE TABLE IF NOT EXISTS conversation SCHEMALESS;');
        await this.db.query('DEFINE INDEX IF NOT EXISTS idx_conv_chatId ON TABLE conversation COLUMNS chatId UNIQUE;');

        await this.db.query('DEFINE TABLE IF NOT EXISTS chat_config SCHEMALESS;');
        await this.db.query('DEFINE INDEX IF NOT EXISTS idx_cfg_chatId ON TABLE chat_config COLUMNS chatId UNIQUE;');

        await this.db.query('DEFINE TABLE IF NOT EXISTS chat_meta SCHEMALESS;');
        await this.db.query('DEFINE INDEX IF NOT EXISTS idx_meta_id ON TABLE chat_meta COLUMNS id UNIQUE;');

        console.log('[ConvSurreal] schema: conversation + chat_config + chat_meta (SCHEMALESS)');
      } catch (e) {
        throw new Error(
          `[ConvSurreal] init() 定义表结构失败: ${(e as Error).message}。` +
          `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.init() → DEFINE TABLE/INDEX。` +
          `原因: SurrealDB rocksdb 可能损坏或路径不可写。`,
        );
      }

      this.connected = true;
      console.log('[ConvSurreal] ✅ connected (warm store for conversations, shared db)');
      return true;
    } catch (e) {
      this.connected = false;
      throw new Error(
        `[ConvSurreal] init() 失败: ${(e as Error).message}。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.init()。` +
        `原因: 共享 db 实例不可用或表定义失败。`,
      );
    }
  }

  isAvailable(): boolean { return this.connected; }

  // ── 消息 ─────────────────────────────────────────────────

  async saveMessages(chatId: string, messages: ChatMessage[]): Promise<boolean> {
    if (!this.connected) {
      throw new Error(
        `[ConvSurreal] saveMessages() 失败: SurrealDB 未连接。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.saveMessages(${chatId})。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
    try {
      const data = { chatId, messages, updatedAt: Date.now() };
      // UPDATE WHERE 命中则返, 没命中则 INSERT
      const upd: any = await this.db.query(
        'UPDATE conversation CONTENT $data WHERE chatId = $cid',
        { data, cid: chatId },
      );
      const rows = Array.isArray(upd) ? (upd[0] as any[]) : [];
      if (Array.isArray(rows) && rows.length > 0) return true;
      try {
        await this.db.query(
          'INSERT INTO conversation (chatId, messages, updatedAt) VALUES ($cid, $msgs, $ts)',
          { cid: chatId, msgs: messages, ts: Date.now() },
        );
        return true;
      } catch (insertErr) {
        const msg = (insertErr as Error).message || '';
        if (msg.includes('already contains')) return true; // 幂等
        throw insertErr;
      }
    } catch (e) {
      throw new Error(
        `[ConvSurreal] saveMessages() 失败: ${(e as Error).message}。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.saveMessages(${chatId})。` +
        `原因: SurrealDB 写入异常。`,
      );
    }
  }

  async loadMessages(chatId: string): Promise<ChatMessage[] | null> {
    if (!this.connected) {
      throw new Error(
        `[ConvSurreal] loadMessages() 失败: SurrealDB 未连接。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.loadMessages(${chatId})。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
    try {
      const result: any = await this.db.query(
        'SELECT messages FROM conversation WHERE chatId = $cid LIMIT 1',
        { cid: chatId },
      );
      const rows = Array.isArray(result) ? (result[0] as any[]) : [];
      if (!rows || rows.length === 0) return null;
      return rows[0].messages ?? null;
    } catch (e) {
      throw new Error(
        `[ConvSurreal] loadMessages() 失败: ${(e as Error).message}。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.loadMessages(${chatId})。` +
        `原因: SurrealDB 查询异常。`,
      );
    }
  }

  async deleteMessages(chatId: string): Promise<boolean> {
    if (!this.connected) {
      throw new Error(
        `[ConvSurreal] deleteMessages() 失败: SurrealDB 未连接。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.deleteMessages(${chatId})。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
    try {
      await this.db.query('DELETE FROM conversation WHERE chatId = $cid', { cid: chatId });
      return true;
    } catch (e) {
      throw new Error(
        `[ConvSurreal] deleteMessages() 失败: ${(e as Error).message}。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.deleteMessages(${chatId})。` +
        `原因: SurrealDB 删除异常。`,
      );
    }
  }

  async loadAllMessages(): Promise<Record<string, ChatMessage[]>> {
    if (!this.connected) {
      throw new Error(
        `[ConvSurreal] loadAllMessages() 失败: SurrealDB 未连接。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.loadAllMessages()。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
    try {
      const result: any = await this.db.query('SELECT chatId, messages FROM conversation', {});
      const rows = Array.isArray(result) ? (result[0] as any[]) : [];
      const out: Record<string, ChatMessage[]> = {};
      for (const row of rows) {
        if (row.chatId && Array.isArray(row.messages)) {
          out[row.chatId] = row.messages;
        }
      }
      return out;
    } catch (e) {
      throw new Error(
        `[ConvSurreal] loadAllMessages() 失败: ${(e as Error).message}。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.loadAllMessages()。` +
        `原因: SurrealDB 查询异常。`,
      );
    }
  }

  // ── 配置 ─────────────────────────────────────────────────

  async saveConfig(chatId: string, config: ChatSettingsItem): Promise<boolean> {
    if (!this.connected) {
      throw new Error(
        `[ConvSurreal] saveConfig() 失败: SurrealDB 未连接。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.saveConfig(${chatId})。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
    try {
      const data = { chatId, config, updatedAt: Date.now() };
      const upd: any = await this.db.query(
        'UPDATE chat_config CONTENT $data WHERE chatId = $cid',
        { data, cid: chatId },
      );
      const rows = Array.isArray(upd) ? (upd[0] as any[]) : [];
      if (Array.isArray(rows) && rows.length > 0) return true;
      try {
        await this.db.query(
          'INSERT INTO chat_config (chatId, config, updatedAt) VALUES ($cid, $cfg, $ts)',
          { cid: chatId, cfg: config, ts: Date.now() },
        );
        return true;
      } catch (insertErr) {
        const msg = (insertErr as Error).message || '';
        if (msg.includes('already contains')) return true;
        throw insertErr;
      }
    } catch (e) {
      throw new Error(
        `[ConvSurreal] saveConfig() 失败: ${(e as Error).message}。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.saveConfig(${chatId})。` +
        `原因: SurrealDB 写入异常。`,
      );
    }
  }

  async loadConfig(chatId: string): Promise<ChatSettingsItem | null> {
    if (!this.connected) {
      throw new Error(
        `[ConvSurreal] loadConfig() 失败: SurrealDB 未连接。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.loadConfig(${chatId})。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
    try {
      const result: any = await this.db.query(
        'SELECT config FROM chat_config WHERE chatId = $cid LIMIT 1',
        { cid: chatId },
      );
      const rows = Array.isArray(result) ? (result[0] as any[]) : [];
      if (!rows || rows.length === 0) return null;
      return rows[0].config ?? null;
    } catch (e) {
      throw new Error(
        `[ConvSurreal] loadConfig() 失败: ${(e as Error).message}。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.loadConfig(${chatId})。` +
        `原因: SurrealDB 查询异常。`,
      );
    }
  }

  async deleteConfig(chatId: string): Promise<boolean> {
    if (!this.connected) {
      throw new Error(
        `[ConvSurreal] deleteConfig() 失败: SurrealDB 未连接。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.deleteConfig(${chatId})。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
    try {
      await this.db.query('DELETE FROM chat_config WHERE chatId = $cid', { cid: chatId });
      return true;
    } catch (e) {
      throw new Error(
        `[ConvSurreal] deleteConfig() 失败: ${(e as Error).message}。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.deleteConfig(${chatId})。` +
        `原因: SurrealDB 删除异常。`,
      );
    }
  }

  async loadAllConfigs(): Promise<Record<string, ChatSettingsItem>> {
    if (!this.connected) {
      throw new Error(
        `[ConvSurreal] loadAllConfigs() 失败: SurrealDB 未连接。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.loadAllConfigs()。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
    try {
      const result: any = await this.db.query('SELECT chatId, config FROM chat_config', {});
      const rows = Array.isArray(result) ? (result[0] as any[]) : [];
      const out: Record<string, ChatSettingsItem> = {};
      for (const row of rows) {
        if (row.chatId && row.config) {
          out[row.chatId] = row.config;
        }
      }
      return out;
    } catch (e) {
      throw new Error(
        `[ConvSurreal] loadAllConfigs() 失败: ${(e as Error).message}。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.loadAllConfigs()。` +
        `原因: SurrealDB 查询异常。`,
      );
    }
  }

  // ── 对话列表 ─────────────────────────────────────────────

  async saveChatList(
    chats: ChatItem[],
    selectedId: string | null,
    liveStates: Record<string, ChatLiveState>,
    counter: number,
  ): Promise<boolean> {
    if (!this.connected) {
      throw new Error(
        `[ConvSurreal] saveChatList() 失败: SurrealDB 未连接。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.saveChatList()。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
    try {
      const data = { id: 'chatlist', chats, selectedId, liveStates, counter, updatedAt: Date.now() };
      // 单行记录, id 固定为 'chatlist'
      const upd: any = await this.db.query(
        'UPDATE chat_meta CONTENT $data WHERE id = $rid',
        { data, rid: 'chat_meta:chatlist' },
      );
      const rows = Array.isArray(upd) ? (upd[0] as any[]) : [];
      if (Array.isArray(rows) && rows.length > 0) return true;
      try {
        await this.db.query(
          'INSERT INTO chat_meta (id, chats, selectedId, liveStates, counter, updatedAt) VALUES ($rid, $chats, $sel, $ls, $ctr, $ts)',
          { rid: 'chat_meta:chatlist', chats, sel: selectedId, ls: liveStates, ctr: counter, ts: Date.now() },
        );
        return true;
      } catch (insertErr) {
        const msg = (insertErr as Error).message || '';
        if (msg.includes('already contains')) return true;
        throw insertErr;
      }
    } catch (e) {
      throw new Error(
        `[ConvSurreal] saveChatList() 失败: ${(e as Error).message}。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.saveChatList()。` +
        `原因: SurrealDB 写入异常。`,
      );
    }
  }

  async loadChatList(): Promise<{
    chats: ChatItem[];
    selectedId: string | null;
    liveStates: Record<string, ChatLiveState>;
    counter: number;
  } | null> {
    if (!this.connected) {
      throw new Error(
        `[ConvSurreal] loadChatList() 失败: SurrealDB 未连接。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.loadChatList()。` +
        `原因: init() 未成功完成或连接已断开。`,
      );
    }
    try {
      const result: any = await this.db.query(
        'SELECT * FROM chat_meta WHERE id = $rid LIMIT 1',
        { rid: 'chat_meta:chatlist' },
      );
      const rows = Array.isArray(result) ? (result[0] as any[]) : [];
      if (!rows || rows.length === 0) return null;
      const row = rows[0];
      return {
        chats: Array.isArray(row.chats) ? row.chats : [],
        selectedId: row.selectedId ?? null,
        liveStates: row.liveStates && typeof row.liveStates === 'object' ? row.liveStates : {},
        counter: typeof row.counter === 'number' ? row.counter : 0,
      };
    } catch (e) {
      throw new Error(
        `[ConvSurreal] loadChatList() 失败: ${(e as Error).message}。` +
        `位置: ConversationSurrealStore.ts → SurrealWarmStoreImpl.loadChatList()。` +
        `原因: SurrealDB 查询异常。`,
      );
    }
  }

  async close(): Promise<void> {
    // ★ 2026-07-14: 不关闭 db — 这是 SurrealStore 共享的连接, 由 SurrealStore 负责关闭
    this.connected = false;
  }
}

// ── 异步初始化单例 ───────────────────────────────────────────

let _instance: IConversationWarmStore | null = null;
let _initPromise: Promise<IConversationWarmStore> | null = null;

async function createWarmStore(): Promise<IConversationWarmStore> {
  // ★ 2026-07-14: 不再创建独立 Surreal 实例, 而是共享 SurrealStore 的 db 连接
  // 避免两个 Surreal 实例争抢同一个 rocksdb 文件锁导致超时
  const db = getSharedSurrealDb();
  return new SurrealWarmStoreImpl(db);
}

export async function getConversationWarmStore(): Promise<IConversationWarmStore> {
  if (_instance) return _instance;
  if (_initPromise) return _initPromise;
  _initPromise = createWarmStore().then(async (store) => {
    await store.init();
    _instance = store;
    return store;
  });
  return _initPromise;
}

/**
 * ★ 2026-07-14: 同步获取不再返回 fallback noop。
 * 如果异步初始化尚未完成, 直接抛错。
 */
export function getConversationWarmStoreSync(): IConversationWarmStore {
  if (_instance) return _instance;
  throw new Error(
    `[ConvSurreal] getConversationWarmStoreSync() 同步获取失败: SurrealDB 异步初始化尚未完成。` +
    `位置: ConversationSurrealStore.ts → getConversationWarmStoreSync()。` +
    `原因: 调用方在 SurrealDB init() 完成前同步访问了温存储。` +
    `请改用 await getConversationWarmStore(), 或确保 bootstrap 已完成后再调用。`,
  );
}
