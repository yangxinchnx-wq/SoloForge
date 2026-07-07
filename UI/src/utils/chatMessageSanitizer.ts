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
 * 判断一条 assistant 消息是否是旧格式的错误消息。
 *
 * 旧格式示例:
 *   ❌ **AI 调用失败**：HTTP 500 {"error":"LLM_EXECUTION_FAILED..."}
 *   ❌ **主模型未配置**：请在「设置 → 模型」中...
 *
 * 这些消息在错误处理逻辑升级前生成, 已持久化到后端。
 * 加载时自动清除, 避免用户反复看到过时错误。
 */
function isStaleErrorMessage(msg: SanitizedChatMessage): boolean {
  if (msg.sender !== 'assistant') return false;
  const c = msg.content?.trim() ?? '';
  if (!c) return true; // 空内容也是无效消息
  // 旧格式错误消息特征: 以 ❌ 开头
  if (c.startsWith('❌')) return true;
  // 残留的 "请检查后端" 提示行
  if (c.startsWith('请检查后端')) return true;
  return false;
}

/**
 * 把整段会话记录（Record<chatId, ChatMessage[]>）归一化。
 * - 跳过非法条目
 * - 清除旧格式错误消息 (❌ 开头的 assistant 消息 + 空消息)
 * - 如果清理后对话中没有有效的 assistant 回复 (全是 user 消息),
 *   则清空整个对话 — 让闪电空状态显示出来
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
      if (!s) continue;
      // 跳过旧格式错误消息
      if (isStaleErrorMessage(s)) continue;
      sanitized.push(s);
    }
    // 如果清理后只剩 user 消息 (没有任何有效 assistant 回复),
    // 清空对话 — 比显示一堆没有回复的用户消息更干净
    const hasValidAssistant = sanitized.some(m => m.sender === 'assistant' && m.content.trim().length > 0);
    if (!hasValidAssistant) {
      out[chatId] = [];
    } else {
      out[chatId] = sanitized;
    }
  }
  return out;
}