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
 * 如果 SurrealDB 不可用, 所有操作降级为 noop (不抛错)
 */

import type { ChatMessage, ChatSettingsItem } from '../chat/ConversationStore';
import type { ChatItem, ChatLiveState } from '../chat/ChatStore';

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

// ── Noop 实现 ────────────────────────────────────────────────

class NoopWarmStore implements IConversationWarmStore {
  async init(): Promise<boolean> { return false; }
  isAvailable(): boolean { return false; }
  async saveMessages(): Promise<boolean> { return false; }
  async loadMessages(): Promise<ChatMessage[] | null> { return null; }
  async deleteMessages(): Promise<boolean> { return false; }
  async loadAllMessages(): Promise<Record<string, ChatMessage[]>> { return {}; }
  async saveConfig(): Promise<boolean> { return false; }
  async loadConfig(): Promise<ChatSettingsItem | null> { return null; }
  async deleteConfig(): Promise<boolean> { return false; }
  async loadAllConfigs(): Promise<Record<string, ChatSettingsItem>> { return {}; }
  async saveChatList(): Promise<boolean> { return false; }
  async loadChatList(): Promise<null> { return null; }
  async close(): Promise<void> { /* noop */ }
}

// ── 真实 SurrealDB 实现 ──────────────────────────────────────

class SurrealWarmStoreImpl implements IConversationWarmStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  private connected: boolean = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(SurrealCtor: any, engines: any) {
    this.db = new SurrealCtor({ engines });
  }

  async init(): Promise<boolean> {
    try {
      const relPath = 'data/canvas_sessions_db';
      console.log(`[ConvSurreal] connecting to rocksdb://${relPath} ...`);
      await this.db.connect(`rocksdb://${relPath}`);
      await this.db.use({ namespace: 'soloforge_core', database: 'canvas_state' });

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
        console.warn('[ConvSurreal] DEFINE failed (continuing):', (e as Error).message);
      }

      this.connected = true;
      console.log('[ConvSurreal] ✅ connected (warm store for conversations)');
      return true;
    } catch (e) {
      console.warn('[ConvSurreal] init failed:', (e as Error).message);
      this.connected = false;
      return false;
    }
  }

  isAvailable(): boolean { return this.connected; }

  // ── 消息 ─────────────────────────────────────────────────

  async saveMessages(chatId: string, messages: ChatMessage[]): Promise<boolean> {
    if (!this.connected) return false;
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
      console.warn('[ConvSurreal] saveMessages failed:', (e as Error).message);
      return false;
    }
  }

  async loadMessages(chatId: string): Promise<ChatMessage[] | null> {
    if (!this.connected) return null;
    try {
      const result: any = await this.db.query(
        'SELECT messages FROM conversation WHERE chatId = $cid LIMIT 1',
        { cid: chatId },
      );
      const rows = Array.isArray(result) ? (result[0] as any[]) : [];
      if (!rows || rows.length === 0) return null;
      return rows[0].messages ?? null;
    } catch {
      return null;
    }
  }

  async deleteMessages(chatId: string): Promise<boolean> {
    if (!this.connected) return false;
    try {
      await this.db.query('DELETE FROM conversation WHERE chatId = $cid', { cid: chatId });
      return true;
    } catch {
      return false;
    }
  }

  async loadAllMessages(): Promise<Record<string, ChatMessage[]>> {
    if (!this.connected) return {};
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
    } catch {
      return {};
    }
  }

  // ── 配置 ─────────────────────────────────────────────────

  async saveConfig(chatId: string, config: ChatSettingsItem): Promise<boolean> {
    if (!this.connected) return false;
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
      console.warn('[ConvSurreal] saveConfig failed:', (e as Error).message);
      return false;
    }
  }

  async loadConfig(chatId: string): Promise<ChatSettingsItem | null> {
    if (!this.connected) return null;
    try {
      const result: any = await this.db.query(
        'SELECT config FROM chat_config WHERE chatId = $cid LIMIT 1',
        { cid: chatId },
      );
      const rows = Array.isArray(result) ? (result[0] as any[]) : [];
      if (!rows || rows.length === 0) return null;
      return rows[0].config ?? null;
    } catch {
      return null;
    }
  }

  async deleteConfig(chatId: string): Promise<boolean> {
    if (!this.connected) return false;
    try {
      await this.db.query('DELETE FROM chat_config WHERE chatId = $cid', { cid: chatId });
      return true;
    } catch {
      return false;
    }
  }

  async loadAllConfigs(): Promise<Record<string, ChatSettingsItem>> {
    if (!this.connected) return {};
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
    } catch {
      return {};
    }
  }

  // ── 对话列表 ─────────────────────────────────────────────

  async saveChatList(
    chats: ChatItem[],
    selectedId: string | null,
    liveStates: Record<string, ChatLiveState>,
    counter: number,
  ): Promise<boolean> {
    if (!this.connected) return false;
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
      console.warn('[ConvSurreal] saveChatList failed:', (e as Error).message);
      return false;
    }
  }

  async loadChatList(): Promise<{
    chats: ChatItem[];
    selectedId: string | null;
    liveStates: Record<string, ChatLiveState>;
    counter: number;
  } | null> {
    if (!this.connected) return null;
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
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      try { await this.db.close(); } catch { /* ignore */ }
    }
    this.connected = false;
  }
}

// ── 异步初始化单例 ───────────────────────────────────────────

let _instance: IConversationWarmStore | null = null;
let _initPromise: Promise<IConversationWarmStore> | null = null;

async function createWarmStore(): Promise<IConversationWarmStore> {
  let SurrealCtor: any = null;
  let engines: any = null;
  try {
    const mainMod = await import('surrealdb' as string);
    SurrealCtor = (mainMod as any).Surreal || (mainMod as any).default;
    if (!SurrealCtor) throw new Error('surrealdb has no Surreal export');
  } catch (e) {
    console.warn('[ConvSurreal] surrealdb unavailable, using noop:', (e as Error).message);
    return new NoopWarmStore();
  }
  try {
    const nodeMod = await import('@surrealdb/node' as string);
    const createNodeEngines = (nodeMod as any).createNodeEngines || (nodeMod as any).default?.createNodeEngines;
    if (!createNodeEngines) throw new Error('@surrealdb/node has no createNodeEngines');
    engines = createNodeEngines();
  } catch (e) {
    console.warn('[ConvSurreal] @surrealdb/node engines unavailable, using noop:', (e as Error).message);
    return new NoopWarmStore();
  }
  return new SurrealWarmStoreImpl(SurrealCtor, engines);
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

// 同步获取 (可能返回 noop, 如果异步 init 尚未完成)
let _syncFallback: IConversationWarmStore | null = null;
export function getConversationWarmStoreSync(): IConversationWarmStore {
  if (_instance) return _instance;
  if (!_syncFallback) _syncFallback = new NoopWarmStore();
  return _syncFallback;
}
