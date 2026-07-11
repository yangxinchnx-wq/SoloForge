/**
 * ConversationStore — 对话消息三层持久化
 *
 * ★ 2026-07-11: 从 JSON 文件迁移到热/温/冷三层架构
 *
 * 架构:
 *   内存 Map (L0)  →  Garnet 热存储 (L1, ms 级, 24h TTL)
 *                  →  SurrealDB 温存储 (L2, s 级, 持久)
 *                  →  JSONL 冷归档 (L3, 归档不活跃数据)
 *
 * 写入流程:
 *   1. setConversation() → 立即写内存 + Garnet (热)
 *   2. 防抖 800ms → 异步 flush 到 SurrealDB (温)
 *   3. DataArchiver 定期扫描 → 不活跃的归档到 JSONL (冷)
 *
 * 读取流程:
 *   1. getConversation() → 先查内存, 命中则返
 *   2. miss → 查 Garnet (热), 命中则回填内存
 *   3. miss → 查 SurrealDB (温), 命中则回填内存 + Garnet
 *   4. miss → 返回 null
 *
 * 冷启动恢复:
 *   启动时从 SurrealDB 批量加载到内存
 *
 * 此文件位于 src/server/ 下, 只能在 Node 进程加载。
 */

import fs from 'fs';
import path from 'path';
import {
  hotSetMessages, hotGetMessages, hotDelMessages,
  hotSetConfig, hotGetConfig, hotDelConfig,
  hotClearChat,
} from '../persistence/ConversationGarnetStore';
import {
  getConversationWarmStore,
  getConversationWarmStoreSync,
  type IConversationWarmStore,
} from '../persistence/ConversationSurrealStore';

// ── 类型 (与前端 types/chat.ts 对齐) ──────────────────────────

export interface ChatMessage {
  sender: 'user' | 'assistant';
  content: string;
  time: string;
  avatar: string;
  attachment?: {
    fileName: string;
    text: string;
  };
  toolCalls?: unknown[];
}

export interface ChatSettingsItem {
  enabledSkills: string[];
  contextSize: number;
  personality: 'professional' | 'sarcastic' | 'zen' | 'geek';
  tone: 'detailed' | 'concise' | 'humorous';
  emojiEnabled: boolean;
  emojiType: 'standard' | 'kaomoji' | 'mixed';
}

// ── ConversationStore 类 ──────────────────────────────────────

export class ConversationStore {
  // L0: 内存
  private conversations: Map<string, ChatMessage[]> = new Map();
  private configs: Map<string, ChatSettingsItem> = new Map();

  // 防抖 flush 到温存储
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirtyMessages: Set<string> = new Set();
  private dirtyConfigs: Set<string> = new Set();
  private dirtyAllMessages = false;
  private dirtyAllConfigs = false;

  // 旧的 JSON 文件路径 (仅用于一次性迁移)
  private legacyPath: string;
  private migrated = false;

  constructor(legacyPath?: string) {
    this.legacyPath = legacyPath || path.join(process.cwd(), '.soloforge', 'conversations.json');
  }

  // ── 冷启动恢复 ──────────────────────────────────────────────

  /**
   * 从 SurrealDB (温) 批量加载到内存
   * 在 server 启动时调用
   */
  async restoreFromWarm(): Promise<void> {
    try {
      const warm = await getConversationWarmStore();
      if (!warm.isAvailable()) {
        console.warn('[ConvStore] 温存储不可用, 尝试从旧 JSON 文件迁移');
        await this.migrateFromJson();
        return;
      }

      // 1. 从 SurrealDB 加载所有消息
      const allMsgs = await warm.loadAllMessages();
      for (const [chatId, msgs] of Object.entries(allMsgs)) {
        this.conversations.set(chatId, msgs);
      }

      // 2. 从 SurrealDB 加载所有配置
      const allCfgs = await warm.loadAllConfigs();
      for (const [chatId, cfg] of Object.entries(allCfgs)) {
        this.configs.set(chatId, cfg);
      }

      console.log(`[ConvStore] 从温存储恢复: ${this.conversations.size} 条对话, ${this.configs.size} 条配置`);

      // 3. 如果温存储为空, 尝试从旧 JSON 迁移
      if (this.conversations.size === 0 && this.configs.size === 0) {
        await this.migrateFromJson();
      } else {
        this.migrated = true;
      }
    } catch (e) {
      console.warn('[ConvStore] 冷启动恢复失败, 尝试从旧 JSON 迁移:', (e as Error).message);
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
        console.log('[ConvStore] 无旧 JSON 文件, 跳过迁移');
        return;
      }
      const raw = fs.readFileSync(this.legacyPath, 'utf-8');
      const data = JSON.parse(raw);
      const conversations = data.conversations || {};
      const configs = data.configs || {};

      console.log(`[ConvStore] 从旧 JSON 迁移: ${Object.keys(conversations).length} 条对话, ${Object.keys(configs).length} 条配置`);

      const warm = await getConversationWarmStore();
      if (!warm.isAvailable()) {
        // 温存储不可用, 只加载到内存 (降级模式)
        for (const [chatId, msgs] of Object.entries(conversations)) {
          if (Array.isArray(msgs)) this.conversations.set(chatId, msgs);
        }
        for (const [chatId, cfg] of Object.entries(configs)) {
          if (cfg && typeof cfg === 'object') this.configs.set(chatId, cfg);
        }
        console.warn('[ConvStore] 温存储不可用, 数据仅加载到内存 (降级模式)');
        return;
      }

      // 写入 SurrealDB
      for (const [chatId, msgs] of Object.entries(conversations)) {
        if (Array.isArray(msgs)) {
          this.conversations.set(chatId, msgs);
          await warm.saveMessages(chatId, msgs);
          // 同时写入 Garnet 热层
          await hotSetMessages(chatId, msgs);
        }
      }
      for (const [chatId, cfg] of Object.entries(configs)) {
        if (cfg && typeof cfg === 'object') {
          this.configs.set(chatId, cfg);
          await warm.saveConfig(chatId, cfg);
          await hotSetConfig(chatId, cfg);
        }
      }

      console.log('[ConvStore] ✅ 旧 JSON 数据已迁移到热+温存储');

      // 迁移完成后, 将旧 JSON 文件重命名 (不删除, 留作备份)
      const backupPath = this.legacyPath + '.migrated';
      try {
        fs.renameSync(this.legacyPath, backupPath);
        console.log(`[ConvStore] 旧 JSON 已重命名为 ${backupPath}`);
      } catch {
        // ignore
      }
    } catch (e) {
      console.warn('[ConvStore] 旧 JSON 迁移失败:', (e as Error).message);
    }
  }

  // ── 防抖 flush 到温存储 ─────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { void this.flushNow(); }, 800);
  }

  /**
   * 立即 flush 脏数据到温存储 (SurrealDB)
   * 同时写热存储 (Garnet)
   */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const warm: IConversationWarmStore = getConversationWarmStoreSync();

    // 全量 flush
    if (this.dirtyAllMessages) {
      this.dirtyAllMessages = false;
      this.dirtyMessages.clear();
      // 全量写入温存储
      if (warm.isAvailable()) {
        for (const [chatId, msgs] of this.conversations) {
          await warm.saveMessages(chatId, msgs);
        }
      }
      // 全量写入热存储
      for (const [chatId, msgs] of this.conversations) {
        await hotSetMessages(chatId, msgs);
      }
      return;
    }

    if (this.dirtyAllConfigs) {
      this.dirtyAllConfigs = false;
      this.dirtyConfigs.clear();
      if (warm.isAvailable()) {
        for (const [chatId, cfg] of this.configs) {
          await warm.saveConfig(chatId, cfg);
        }
      }
      for (const [chatId, cfg] of this.configs) {
        await hotSetConfig(chatId, cfg);
      }
      return;
    }

    // 增量 flush
    const msgTasks: Promise<void>[] = [];
    for (const chatId of this.dirtyMessages) {
      const msgs = this.conversations.get(chatId);
      if (msgs) {
        msgTasks.push(
          hotSetMessages(chatId, msgs).then(() => {}),
          warm.isAvailable() ? warm.saveMessages(chatId, msgs).then(() => {}) : Promise.resolve(),
        );
      }
    }
    this.dirtyMessages.clear();

    const cfgTasks: Promise<void>[] = [];
    for (const chatId of this.dirtyConfigs) {
      const cfg = this.configs.get(chatId);
      if (cfg) {
        cfgTasks.push(
          hotSetConfig(chatId, cfg).then(() => {}),
          warm.isAvailable() ? warm.saveConfig(chatId, cfg).then(() => {}) : Promise.resolve(),
        );
      }
    }
    this.dirtyConfigs.clear();

    await Promise.all([...msgTasks, ...cfgTasks]);
  }

  /** 同步 flush (进程退出时, 尽力写入) */
  flushSync(): void {
    // 同步只能写热存储 (Garnet 是异步的, 但至少触发)
    // 温存储的 flush 交给异步, 如果进程退出太快可能丢失最后一次 flush
    // 但因为每次写操作都会立即写 Garnet, 所以数据不会完全丢失
    void this.flushNow();
  }

  // ── 读操作 ──────────────────────────────────────────────────

  getAllConversations(): Record<string, ChatMessage[]> {
    return Object.fromEntries(this.conversations);
  }

  /**
   * 获取对话消息
   * L0 内存 → L1 Garnet (热) → L2 SurrealDB (温)
   */
  getConversation(chatId: string): ChatMessage[] | null {
    // L0: 内存
    const cached = this.conversations.get(chatId);
    if (cached) return cached;

    // L1/L2 异步查询 (不阻塞同步调用, 但触发后台回填)
    this._asyncLoadChat(chatId).catch(() => {});

    // 同步返回 null (调用方需要再次调 getConversation 或用 async 版本)
    return null;
  }

  /**
   * 异步获取对话消息 (确保穿透到温存储)
   */
  async getConversationAsync(chatId: string): Promise<ChatMessage[] | null> {
    // L0: 内存
    const cached = this.conversations.get(chatId);
    if (cached) return cached;

    // L1: Garnet (热)
    const hot = await hotGetMessages(chatId);
    if (hot) {
      this.conversations.set(chatId, hot); // 回填内存
      return hot;
    }

    // L2: SurrealDB (温)
    const warm = getConversationWarmStoreSync();
    if (warm.isAvailable()) {
      const warmMsgs = await warm.loadMessages(chatId);
      if (warmMsgs) {
        this.conversations.set(chatId, warmMsgs); // 回填内存
        await hotSetMessages(chatId, warmMsgs);   // 回填热层
        return warmMsgs;
      }
    }

    return null;
  }

  getAllConfigs(): Record<string, ChatSettingsItem> {
    return Object.fromEntries(this.configs);
  }

  getConfig(chatId: string): ChatSettingsItem | null {
    const cached = this.configs.get(chatId);
    if (cached) return cached;

    // 异步回填
    this._asyncLoadConfig(chatId).catch(() => {});
    return null;
  }

  async getConfigAsync(chatId: string): Promise<ChatSettingsItem | null> {
    const cached = this.configs.get(chatId);
    if (cached) return cached;

    const hot = await hotGetConfig(chatId);
    if (hot) {
      this.configs.set(chatId, hot);
      return hot;
    }

    const warm = getConversationWarmStoreSync();
    if (warm.isAvailable()) {
      const warmCfg = await warm.loadConfig(chatId);
      if (warmCfg) {
        this.configs.set(chatId, warmCfg);
        await hotSetConfig(chatId, warmCfg);
        return warmCfg;
      }
    }

    return null;
  }

  // ── 写操作 ──────────────────────────────────────────────────

  /** 全量替换某个对话的消息列表 */
  setConversation(chatId: string, messages: ChatMessage[]): void {
    this.conversations.set(chatId, messages);
    this.dirtyMessages.add(chatId);
    this.scheduleFlush();
    // 立即写热层 (不等防抖)
    void hotSetMessages(chatId, messages);
  }

  /** 全量替换所有对话 (用于前端批量同步) */
  setAllConversations(convos: Record<string, ChatMessage[]>): void {
    this.conversations.clear();
    for (const [chatId, msgs] of Object.entries(convos)) {
      if (Array.isArray(msgs)) {
        this.conversations.set(chatId, msgs);
      }
    }
    this.dirtyAllMessages = true;
    this.dirtyMessages.clear();
    this.scheduleFlush();
  }

  /** 删除某个对话的所有消息 */
  async deleteConversation(chatId: string): Promise<boolean> {
    const existed = this.conversations.delete(chatId);
    this.dirtyMessages.delete(chatId);

    // 同时清理热层和温层
    await hotDelMessages(chatId);
    const warm = getConversationWarmStoreSync();
    if (warm.isAvailable()) {
      await warm.deleteMessages(chatId);
    }

    if (existed) this.scheduleFlush();
    return existed;
  }

  /** 设置某个对话的配置 */
  setConfig(chatId: string, config: ChatSettingsItem): void {
    this.configs.set(chatId, config);
    this.dirtyConfigs.add(chatId);
    this.scheduleFlush();
    void hotSetConfig(chatId, config);
  }

  /** 全量替换所有配置 */
  setAllConfigs(configs: Record<string, ChatSettingsItem>): void {
    this.configs.clear();
    for (const [chatId, cfg] of Object.entries(configs)) {
      if (cfg && typeof cfg === 'object') {
        this.configs.set(chatId, cfg);
      }
    }
    this.dirtyAllConfigs = true;
    this.dirtyConfigs.clear();
    this.scheduleFlush();
  }

  /** 删除某个对话的配置 */
  async deleteConfig(chatId: string): Promise<boolean> {
    const existed = this.configs.delete(chatId);
    this.dirtyConfigs.delete(chatId);

    await hotDelConfig(chatId);
    const warm = getConversationWarmStoreSync();
    if (warm.isAvailable()) {
      await warm.deleteConfig(chatId);
    }

    if (existed) this.scheduleFlush();
    return existed;
  }

  /** 级联删除: 删除对话的所有消息 + 配置 */
  async deleteAllForChat(chatId: string): Promise<{ deletedMessages: boolean; deletedConfig: boolean }> {
    const deletedMessages = this.conversations.delete(chatId);
    const deletedConfig = this.configs.delete(chatId);
    this.dirtyMessages.delete(chatId);
    this.dirtyConfigs.delete(chatId);

    // 清理三层
    await hotClearChat(chatId);
    const warm = getConversationWarmStoreSync();
    if (warm.isAvailable()) {
      await Promise.all([warm.deleteMessages(chatId), warm.deleteConfig(chatId)]);
    }

    if (deletedMessages || deletedConfig) this.scheduleFlush();
    return { deletedMessages, deletedConfig };
  }

  // ── 内部辅助 ────────────────────────────────────────────────

  private async _asyncLoadChat(chatId: string): Promise<void> {
    // L1: Garnet
    const hot = await hotGetMessages(chatId);
    if (hot) {
      if (!this.conversations.has(chatId)) {
        this.conversations.set(chatId, hot);
      }
      return;
    }
    // L2: SurrealDB
    const warm = getConversationWarmStoreSync();
    if (warm.isAvailable()) {
      const warmMsgs = await warm.loadMessages(chatId);
      if (warmMsgs) {
        if (!this.conversations.has(chatId)) {
          this.conversations.set(chatId, warmMsgs);
        }
        await hotSetMessages(chatId, warmMsgs); // 回填热层
      }
    }
  }

  private async _asyncLoadConfig(chatId: string): Promise<void> {
    const hot = await hotGetConfig(chatId);
    if (hot) {
      if (!this.configs.has(chatId)) {
        this.configs.set(chatId, hot);
      }
      return;
    }
    const warm = getConversationWarmStoreSync();
    if (warm.isAvailable()) {
      const warmCfg = await warm.loadConfig(chatId);
      if (warmCfg) {
        if (!this.configs.has(chatId)) {
          this.configs.set(chatId, warmCfg);
        }
        await hotSetConfig(chatId, warmCfg);
      }
    }
  }
}

// ── 单例 ──────────────────────────────────────────────────────

let _instance: ConversationStore | null = null;

export function getConversationStore(): ConversationStore {
  if (!_instance) {
    _instance = new ConversationStore();
  }
  return _instance;
}
