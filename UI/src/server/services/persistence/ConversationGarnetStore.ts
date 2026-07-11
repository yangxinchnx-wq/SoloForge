/**
 * ConversationGarnetStore — 对话热存储 (Garnet/Redis)
 *
 * 职责:
 *   - 缓存当前活跃对话的消息列表和配置
 *   - 24h TTL, 非活跃对话自动过期
 *   - 写入立即生效, 读取 ms 级延迟
 *
 * Key 规范:
 *   hot:sf:conv:{chatId}:messages  → ChatMessage[] (JSON)
 *   hot:sf:conv:{chatId}:config    → ChatSettingsItem (JSON)
 *   hot:sf:chat:list               → { chats, selectedId, liveStates, counter } (JSON)
 *
 * 与 ConversationSurrealStore (温层) 配合:
 *   写: 先写 Garnet (热), 异步 flush 到 SurrealDB (温)
 *   读: 先查 Garnet, miss 时查 SurrealDB, 命中后回填 Garnet
 */

import Redis from 'ioredis';
import type { ChatMessage, ChatSettingsItem } from '../chat/ConversationStore';
import type { ChatItem, ChatLiveState } from '../chat/ChatStore';

const GARNET_HOST = process.env.GARNET_HOST || '127.0.0.1';
const GARNET_PORT = parseInt(process.env.GARNET_PORT || '6379', 10);
const TTL_SECONDS = 86400; // 24h

// Key builders
const kMsg = (chatId: string) => `hot:sf:conv:${chatId}:messages`;
const kCfg = (chatId: string) => `hot:sf:conv:${chatId}:config`;
const kChatList = 'hot:sf:chat:list';

// ── ChatList 序列化形状 ──────────────────────────────────────

interface ChatListShape {
  chats: ChatItem[];
  selectedId: string | null;
  liveStates: Record<string, ChatLiveState>;
  counter: number;
}

// ── Garnet 单例 ──────────────────────────────────────────────

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      host: GARNET_HOST,
      port: GARNET_PORT,
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      retryStrategy: (times: number) => {
        if (times > 10) return null;
        return Math.min(times * 100, 3000);
      },
    });
    _redis.on('error', (err: Error) => {
      console.warn('[ConvGarnet] error:', err.message);
    });
    _redis.on('connect', () => {
      console.log('[ConvGarnet] connected to Garnet:', `${GARNET_HOST}:${GARNET_PORT}`);
    });
  }
  return _redis;
}

async function safePing(): Promise<boolean> {
  try {
    const r = await getRedis().ping();
    return r === 'PONG';
  } catch {
    return false;
  }
}

// ── 消息热存储 ───────────────────────────────────────────────

export async function hotSetMessages(chatId: string, messages: ChatMessage[]): Promise<boolean> {
  try {
    await getRedis().set(kMsg(chatId), JSON.stringify(messages), 'EX', TTL_SECONDS);
    return true;
  } catch (e) {
    console.warn('[ConvGarnet] setMessages failed:', (e as Error).message);
    return false;
  }
}

export async function hotGetMessages(chatId: string): Promise<ChatMessage[] | null> {
  try {
    const raw = await getRedis().get(kMsg(chatId));
    if (!raw) return null;
    return JSON.parse(raw) as ChatMessage[];
  } catch {
    return null;
  }
}

export async function hotDelMessages(chatId: string): Promise<boolean> {
  try {
    await getRedis().del(kMsg(chatId));
    return true;
  } catch {
    return false;
  }
}

// ── 配置热存储 ───────────────────────────────────────────────

export async function hotSetConfig(chatId: string, config: ChatSettingsItem): Promise<boolean> {
  try {
    await getRedis().set(kCfg(chatId), JSON.stringify(config), 'EX', TTL_SECONDS);
    return true;
  } catch {
    return false;
  }
}

export async function hotGetConfig(chatId: string): Promise<ChatSettingsItem | null> {
  try {
    const raw = await getRedis().get(kCfg(chatId));
    if (!raw) return null;
    return JSON.parse(raw) as ChatSettingsItem;
  } catch {
    return null;
  }
}

export async function hotDelConfig(chatId: string): Promise<boolean> {
  try {
    await getRedis().del(kCfg(chatId));
    return true;
  } catch {
    return false;
  }
}

// ── ChatList 热存储 ──────────────────────────────────────────

export async function hotSetChatList(data: ChatListShape): Promise<boolean> {
  try {
    await getRedis().set(kChatList, JSON.stringify(data), 'EX', TTL_SECONDS);
    return true;
  } catch {
    return false;
  }
}

export async function hotGetChatList(): Promise<ChatListShape | null> {
  try {
    const raw = await getRedis().get(kChatList);
    if (!raw) return null;
    return JSON.parse(raw) as ChatListShape;
  } catch {
    return null;
  }
}

export async function hotDelChatList(): Promise<boolean> {
  try {
    await getRedis().del(kChatList);
    return true;
  } catch {
    return false;
  }
}

// ── 批量清理 ─────────────────────────────────────────────────

export async function hotClearChat(chatId: string): Promise<void> {
  await Promise.all([hotDelMessages(chatId), hotDelConfig(chatId)]);
}

export async function hotClearAll(): Promise<void> {
  try {
    const keys = await getRedis().keys('hot:sf:conv:*');
    if (keys.length > 0) await getRedis().del(...keys);
    await getRedis().del(kChatList);
  } catch {
    // ignore
  }
}

// ── 诊断 ─────────────────────────────────────────────────────

export async function hotStats(): Promise<{
  connected: boolean;
  messageKeys: number;
  configKeys: number;
  hasChatList: boolean;
}> {
  const connected = await safePing();
  if (!connected) {
    return { connected: false, messageKeys: 0, configKeys: 0, hasChatList: false };
  }
  try {
    const keys = await getRedis().keys('hot:sf:conv:*');
    const messageKeys = keys.filter((k) => k.endsWith(':messages')).length;
    const configKeys = keys.filter((k) => k.endsWith(':config')).length;
    const hasChatList = (await getRedis().exists(kChatList)) === 1;
    return { connected, messageKeys, configKeys, hasChatList };
  } catch {
    return { connected: false, messageKeys: 0, configKeys: 0, hasChatList: false };
  }
}
