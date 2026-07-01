/**
 * chatMessageSanitizer.ts — 消息归一化层
 *
 * 目标：项目策略是「不下载任何外链头像」，但历史 localStorage 中可能残留
 *       旧版本写入的 avatar URL（典型案例：Unsplash 头像）。这些 URL
 *       一旦渲染就会触发 CSP img-src 违规警告。
 *
 * 归一化职责：
 *   1. 把 ChatMessage.avatar 强制置空（不渲染 <img>，统一走本地渐变兜底）
 *   2. 裁掉不是 ChatMessage 形状的脏数据（不是数组 / 不是对象）
 *   3. 保留未知字段透传，避免破坏既有 UI
 *
 * 应用入口：
 *   - localStorage hydration 边界（ChatPanel 启动时）
 *   - 每次 setConversations 之前（防御后端 / agent 系统注入外链）
 */
export interface RawChatMessage {
  sender?: unknown;
  content?: unknown;
  time?: unknown;
  avatar?: unknown;
  attachment?: unknown;
  toolCalls?: unknown;
  [k: string]: unknown;
}

export interface SanitizedChatMessage {
  sender: 'user' | 'assistant';
  content: string;
  time: string;
  avatar: '';
  attachment?: { fileName: string; text: string };
  toolCalls?: unknown[];
  [k: string]: unknown;
}

/**
 * 把单条消息归一化为 ChatMessage 形状，avatar 永远置空。
 * 不属于 ChatMessage 的对象会被丢弃（返回 null）。
 */
export function sanitizeChatMessage(input: unknown): SanitizedChatMessage | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as RawChatMessage;
  const sender = raw.sender === 'user' || raw.sender === 'assistant' ? raw.sender : null;
  if (!sender) return null;
  if (typeof raw.content !== 'string') return null;

  const out: SanitizedChatMessage = {
    sender,
    content: raw.content,
    time: typeof raw.time === 'string' ? raw.time : '',
    avatar: '',
  };
  if (
    raw.attachment &&
    typeof raw.attachment === 'object' &&
    typeof (raw.attachment as { fileName?: unknown }).fileName === 'string' &&
    typeof (raw.attachment as { text?: unknown }).text === 'string'
  ) {
    out.attachment = {
      fileName: (raw.attachment as { fileName: string }).fileName,
      text: (raw.attachment as { text: string }).text,
    };
  }
  if (Array.isArray(raw.toolCalls)) {
    out.toolCalls = raw.toolCalls;
  }
  return out;
}

/**
 * 把整段会话记录（Record<chatId, ChatMessage[]>）归一化。
 * 跳过非法条目；空数组保留 key（避免切走对话时被吞掉）。
 */
export function sanitizeConversations(
  input: unknown,
): Record<string, SanitizedChatMessage[]> {
  const out: Record<string, SanitizedChatMessage[]> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [chatId, msgs] of Object.entries(input as Record<string, unknown>)) {
    if (!Array.isArray(msgs)) continue;
    const sanitized: SanitizedChatMessage[] = [];
    for (const m of msgs) {
      const s = sanitizeChatMessage(m);
      if (s) sanitized.push(s);
    }
    out[chatId] = sanitized;
  }
  return out;
}