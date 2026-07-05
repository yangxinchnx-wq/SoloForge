/**
 * ConversationStore — 对话消息后端持久化
 *
 * 设计照抄 ChatStore 模式:
 *  - 内存 Map<chatId, ChatMessage[]> 持有所有对话消息
 *  - JSON 文件做冷持久化 (.soloforge/conversations.json)
 *  - 防抖 flush (800ms, 比对话列表 500ms 稍长, 因为消息体积更大)
 *  - 进程退出时同步 flush
 *
 * 此文件位于 src/server/ 下, 只能在 Node 进程加载。
 */

import fs from 'fs';
import path from 'path';

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

interface PersistShape {
  conversations: Record<string, ChatMessage[]>;
  configs: Record<string, ChatSettingsItem>;
}

// ── ConversationStore 类 ──────────────────────────────────────

export class ConversationStore {
  private conversations: Map<string, ChatMessage[]> = new Map();
  private configs: Map<string, ChatSettingsItem> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private persistPath: string;

  constructor(persistPath?: string) {
    this.persistPath = persistPath || path.join(process.cwd(), '.soloforge', 'conversations.json');
    this.loadFromDisk();
  }

  // ── 持久化 ──────────────────────────────────────────────────

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as PersistShape;
      if (data.conversations && typeof data.conversations === 'object') {
        for (const [chatId, msgs] of Object.entries(data.conversations)) {
          if (Array.isArray(msgs)) {
            this.conversations.set(chatId, msgs);
          }
        }
      }
      if (data.configs && typeof data.configs === 'object') {
        for (const [chatId, cfg] of Object.entries(data.configs)) {
          if (cfg && typeof cfg === 'object') {
            this.configs.set(chatId, cfg);
          }
        }
      }
      console.log(`[ConversationStore] 从磁盘加载 ${this.conversations.size} 条对话消息, ${this.configs.size} 条配置`);
    } catch (e) {
      console.warn('[ConversationStore] 加载失败, 从空状态开始:', (e as Error).message);
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushNow(), 800);
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
        conversations: Object.fromEntries(this.conversations),
        configs: Object.fromEntries(this.configs),
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.error('[ConversationStore] flush 失败:', (e as Error).message);
    }
  }

  // ── 读操作 ──────────────────────────────────────────────────

  getAllConversations(): Record<string, ChatMessage[]> {
    return Object.fromEntries(this.conversations);
  }

  getConversation(chatId: string): ChatMessage[] | null {
    return this.conversations.get(chatId) ?? null;
  }

  getAllConfigs(): Record<string, ChatSettingsItem> {
    return Object.fromEntries(this.configs);
  }

  getConfig(chatId: string): ChatSettingsItem | null {
    return this.configs.get(chatId) ?? null;
  }

  // ── 写操作 ──────────────────────────────────────────────────

  /** 全量替换某个对话的消息列表 */
  setConversation(chatId: string, messages: ChatMessage[]): void {
    this.conversations.set(chatId, messages);
    this.scheduleFlush();
  }

  /** 全量替换所有对话 (用于前端批量同步) */
  setAllConversations(convos: Record<string, ChatMessage[]>): void {
    this.conversations.clear();
    for (const [chatId, msgs] of Object.entries(convos)) {
      if (Array.isArray(msgs)) {
        this.conversations.set(chatId, msgs);
      }
    }
    this.scheduleFlush();
  }

  /** 删除某个对话的所有消息 */
  deleteConversation(chatId: string): boolean {
    const existed = this.conversations.delete(chatId);
    if (existed) this.scheduleFlush();
    return existed;
  }

  /** 设置某个对话的配置 */
  setConfig(chatId: string, config: ChatSettingsItem): void {
    this.configs.set(chatId, config);
    this.scheduleFlush();
  }

  /** 全量替换所有配置 */
  setAllConfigs(configs: Record<string, ChatSettingsItem>): void {
    this.configs.clear();
    for (const [chatId, cfg] of Object.entries(configs)) {
      if (cfg && typeof cfg === 'object') {
        this.configs.set(chatId, cfg);
      }
    }
    this.scheduleFlush();
  }

  /** 删除某个对话的配置 */
  deleteConfig(chatId: string): boolean {
    const existed = this.configs.delete(chatId);
    if (existed) this.scheduleFlush();
    return existed;
  }

  /** 级联删除: 删除对话的所有消息 + 配置 */
  deleteAllForChat(chatId: string): { deletedMessages: boolean; deletedConfig: boolean } {
    const deletedMessages = this.conversations.delete(chatId);
    const deletedConfig = this.configs.delete(chatId);
    if (deletedMessages || deletedConfig) this.scheduleFlush();
    return { deletedMessages, deletedConfig };
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
