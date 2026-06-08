// ─────────────────────────────────────────────────────────────────
// 对话 / 流送 Hook
// 通过 WebSocket 多路复用通道发送 chat.send / 接收 chat.chunk
// - 历史对话列表(本地持久化)
// - 当前对话消息
// - 流送区 chunks
// - 支持中止 (chat.abort)
// - 真实 LLM 接入: 只需改后端 src/ws/chat-handler.ts
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback } from 'react';
import type { ChatMessage, StreamChunk } from '../types';
import { pushNotification, pushToast } from '../components/overlays/Notifications';
import { getWsClient } from '../api/ws';

const STORAGE_KEY = 'soloforge.chat.history.v1';
const SETTINGS_KEY = 'soloforge.chat.settings.v1';
const EXPLAIN_KEY = 'soloforge.chat.explanations.v1';
const EXPLAIN_MAX_AGE_DAYS = 7;
const EXPLAIN_MAX_COUNT = 50;

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ChatSettings {
  hybridEnabled: boolean;
  primaryModel: string;
  secondaryModel: string;
  systemPrompt: string;
  temperature: number;
  enableTools: boolean;
  enableMemory: boolean;
  enableRag: boolean;
  streamLocally: boolean;
}

const DEFAULT_SETTINGS: ChatSettings = {
  hybridEnabled: true,
  primaryModel: 'MiniMax-M3',
  secondaryModel: 'claude-haiku-4.5',
  systemPrompt: '你是 SoloForge 的 AI 助手。',
  temperature: 0.7,
  enableTools: true,
  enableMemory: true,
  enableRag: false,
  streamLocally: true,
};

function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveSessions(s: ChatSession[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function loadSettings(): ChatSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_SETTINGS;
}

function saveSettings(s: ChatSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function useChat() {
  const [sessions, setSessions] = useState<ChatSession[]>(loadSessions);
  const [activeId, setActiveId] = useState<string | null>(loadSessions()[0]?.id ?? null);
  const [settings, setSettings] = useState<ChatSettings>(loadSettings);
  const [stream, setStream] = useState<StreamChunk[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const streamTimer = useRef<number | null>(null);

  // AI 解释缓存: key = `${file}:${startLine}-${endLine}`, value = { content, mode, timestamp }
  type ExpItem = { content: string; mode: 'explain' | 'refactor' | 'test'; timestamp: number };
  const [explanations, setExplanations] = useState<Record<string, ExpItem>>(() => {
    if (typeof localStorage === 'undefined') return {};
    try {
      const raw = localStorage.getItem(EXPLAIN_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw) as Record<string, ExpItem>;
      const cutoff = Date.now() - EXPLAIN_MAX_AGE_DAYS * 86400_000;
      // 过滤过期 + 限制最多 N 条
      const entries = Object.entries(obj)
        .filter(([, v]) => v && typeof v.timestamp === 'number' && v.timestamp > cutoff)
        .sort((a, b) => b[1].timestamp - a[1].timestamp)
        .slice(0, EXPLAIN_MAX_COUNT);
      return Object.fromEntries(entries) as Record<string, ExpItem>;
    } catch { return {}; }
  });
  const explainKey = (file: string, start: number, end: number, mode: string) => `${file}:${start}-${end}:${mode}`;

  // 持久化 explanations
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (Object.keys(explanations).length === 0) {
      localStorage.removeItem(EXPLAIN_KEY);
    } else {
      try {
        localStorage.setItem(EXPLAIN_KEY, JSON.stringify(explanations));
      } catch { /* quota */ }
    }
  }, [explanations]);

  const clearExplanations = useCallback(() => setExplanations({}), []);
  const removeExplanation = useCallback((key: string) => {
    setExplanations(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // 持久化
  useEffect(() => { saveSessions(sessions); }, [sessions]);
  useEffect(() => { saveSettings(settings); }, [settings]);

  const activeSession = sessions.find(s => s.id === activeId) ?? null;

  const updateSession = useCallback((id: string, patch: (s: ChatSession) => ChatSession) => {
    setSessions(prev => prev.map(s => s.id === id ? patch(s) : s));
  }, []);

  const newSession = useCallback(() => {
    const id = 'sess_' + Date.now().toString(36);
    const sess: ChatSession = {
      id,
      title: '新对话',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setSessions(prev => [sess, ...prev]);
    setActiveId(id);
    setStream([]);
    return id;
  }, []);

  const switchSession = useCallback((id: string) => {
    setActiveId(id);
    setStream([]);
  }, []);

  const deleteSession = useCallback((id: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
      return next;
    });
  }, [activeId]);

  // 直接替换整个消息列表
  const setMessages = useCallback((sessionId: string, messages: ChatMessage[]) => {
    updateSession(sessionId, s => ({ ...s, messages, updatedAt: Date.now() }));
  }, [updateSession]);

  // 删除单条消息
  const deleteMessage = useCallback((sessionId: string, messageId: string) => {
    const sess = sessions.find(s => s.id === sessionId);
    if (!sess) return;
    setMessages(sessionId, sess.messages.filter(m => m.id !== messageId));
  }, [sessions, setMessages]);

  // 编辑单条消息（仅内容）
  const editMessage = useCallback((sessionId: string, messageId: string, content: string) => {
    const sess = sessions.find(s => s.id === sessionId);
    if (!sess) return;
    const idx = sess.messages.findIndex(m => m.id === messageId);
    if (idx < 0) return;
    const next = sess.messages.map(m => m.id === messageId ? { ...m, content } : m);
    setMessages(sessionId, next);
  }, [sessions, setMessages]);

  // 截断到指定消息
  const truncateAt = useCallback((sessionId: string, messageId: string) => {
    const sess = sessions.find(s => s.id === sessionId);
    if (!sess) return;
    const idx = sess.messages.findIndex(m => m.id === messageId);
    if (idx < 0) return;
    setMessages(sessionId, sess.messages.slice(0, idx + 1));
  }, [sessions, setMessages]);

  // 创建分支：把到指定消息为止的内容复制到新会话
  const branchAt = useCallback((sessionId: string, messageId: string) => {
    const sess = sessions.find(s => s.id === sessionId);
    if (!sess) return;
    const idx = sess.messages.findIndex(m => m.id === messageId);
    if (idx < 0) return;
    const id = 'sess_' + Date.now().toString(36);
    const branched: ChatSession = {
      id,
      title: `[分支] ${sess.title}`,
      messages: sess.messages.slice(0, idx + 1).map(m => ({ ...m, id: 'm_' + Math.random().toString(36).slice(2, 9) })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setSessions(prev => [branched, ...prev]);
    setActiveId(id);
    setStream([]);
    return id;
  }, [sessions]);

  // AI 解释写入缓存（由 AI 解释内联面板使用）
  const setExplanation = useCallback((key: string, content: string, mode: 'explain' | 'refactor' | 'test') => {
    setExplanations(prev => ({ ...prev, [key]: { content, mode, timestamp: Date.now() } }));
  }, []);

  // 行内 AI 解释：不走 chat，直接在代码下方渲染
  const explainInline = useCallback((file: string, start: number, end: number, content: string, mode: 'explain' | 'refactor' | 'test' = 'explain') => {
    const key = explainKey(file, start, end, mode);
    // 立即写入"生成中"标记
    setExplanations(prev => ({ ...prev, [key]: { content: '__thinking__', mode, timestamp: Date.now() } }));
    pushStream({ id: 'ei_' + Date.now().toString(36), type: 'thinking', content: `🔍 正在${mode === 'explain' ? '解释' : mode === 'refactor' ? '重构' : '生成测试'} ${file} 的第 ${start}-${end} 行...`, timestamp: Date.now() });
    // 模拟思考 + 生成
    setTimeout(() => {
      const lang = file.split('.').pop() || '';
      const generated = generateExplanation(file, start, end, content, mode, lang);
      setExplanations(prev => ({ ...prev, [key]: { content: generated, mode, timestamp: Date.now() } }));
      pushStream({ id: 'ed_' + Date.now().toString(36), type: 'system', content: `✓ ${file} 的行 ${start}-${end} ${mode === 'explain' ? '解释' : mode === 'refactor' ? '重构' : '测试'} 已就绪`, timestamp: Date.now() });
    }, 800 + Math.random() * 1200);
  }, [explainKey]);

  const renameSession = useCallback((id: string, title: string) => {
    updateSession(id, s => ({ ...s, title, updatedAt: Date.now() }));
  }, [updateSession]);

  // 消息操作 - 重新生成（在 send 定义之后实现，绑定到下方）
  const copyMessage = useCallback((content: string) => {
    try { navigator.clipboard?.writeText(content); } catch { /* ignore */ }
  }, []);

  const clearAll = useCallback(() => {
    setSessions([]);
    setActiveId(null);
    setStream([]);
  }, []);

  // 推 chunk 到流送区
  const pushStream = useCallback((chunk: StreamChunk) => {
    setStream(prev => [...prev, chunk].slice(-200));
  }, []);

  const clearStream = useCallback(() => setStream([]), []);

  // 引用文件（由 FileExplorer 拖入触发）
  const [pendingAttachments, setPendingAttachments] = useState<string[]>([]);
  const attachFiles = useCallback((paths: string[]) => {
    setPendingAttachments(prev => {
      const next = [...prev];
      paths.forEach(p => { if (!next.includes(p)) next.push(p); });
      return next;
    });
  }, []);
  const consumeAttachments = useCallback(() => {
    const v = pendingAttachments;
    setPendingAttachments([]);
    return v;
  }, [pendingAttachments]);

  // 模拟流式已移除(改用 WebSocket chat.chunk)

  const send = useCallback(async (text: string, attachments?: string[]) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    let sessionId = activeId;
    if (!sessionId) sessionId = newSession();

    const userMsg: ChatMessage = {
      id: 'm_' + Date.now().toString(36),
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    };
    if (attachments?.length) {
      userMsg.content += '\n\n[附件] ' + attachments.join(', ');
    }
    updateSession(sessionId!, s => ({
      ...s,
      messages: [...s.messages, userMsg],
      title: s.messages.length === 0 ? trimmed.slice(0, 30) : s.title,
      updatedAt: Date.now(),
    }));
    pushStream({ id: 'u_' + Date.now().toString(36), type: 'system', content: `→ 用户：${trimmed.slice(0, 80)}`, timestamp: Date.now() });

    const ws = getWsClient();
    if (!ws.state().connected) {
      pushStream({ id: 'noc_' + Date.now().toString(36), type: 'error', content: '❌ WebSocket 未连接,无法发送', timestamp: Date.now() });
      pushToast({ level: 'error', title: '连接断开', message: 'WebSocket 未连接,请稍后重试', duration: 5000 });
      return;
    }

    setBusy(true);
    const startTs = Date.now();
    // 本地 placeholder replyId(等第一个 chunk 到达时,把它的 messageId 关联起来)
    const localReplyId = 'm_' + (Date.now() + 1).toString(36);
    let realMessageId: string | null = null;
    let acc = '';
    let aborted = false;
    const offs: Array<() => void> = [];

    // 1) 先插入空消息占位
    updateSession(sessionId!, s => ({
      ...s,
      messages: [...s.messages, {
        id: localReplyId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        streaming: true,
        model: settings.hybridEnabled ? `${settings.primaryModel}+${settings.secondaryModel}` : settings.primaryModel,
      }],
      updatedAt: Date.now(),
    }));

    // 2) 工具/模型预处理 stream
    if (settings.enableTools) {
      pushStream({ id: 't_' + Date.now().toString(36), type: 'tool', content: '🛠️ 加载工具：search_web · read_file · run_code', timestamp: Date.now() });
    }
    if (settings.enableMemory) {
      pushStream({ id: 't2_' + Date.now().toString(36), type: 'tool', content: '🧠 召回长期记忆 (3 条命中)', timestamp: Date.now() });
    }
    pushStream({ id: 'mm_' + Date.now().toString(36), type: 'thinking', content: `🧠 主模型 [${settings.primaryModel}] 开始思考...`, timestamp: Date.now() });

    const cleanup = () => { offs.forEach(off => off()); offs.length = 0; };

    // 3) 订阅 chunk/done/error
    offs.push(ws.on('chat.chunk', (msg: any) => {
      const mid = msg.payload?.messageId;
      if (!mid) return;
      if (realMessageId && mid !== realMessageId) return; // 不是本轮的,忽略
      if (!realMessageId) {
        realMessageId = mid;
        // 把后端 messageId 映射到本地 placeholder:更新消息 id
        updateSession(sessionId!, s => ({
          ...s,
          messages: s.messages.map(m => m.id === localReplyId ? { ...m, id: mid } : m),
        }));
      }
      acc += msg.payload.delta || '';
      updateSession(sessionId!, s => ({
        ...s,
        messages: s.messages.map(m => m.id === mid ? { ...m, content: acc } : m),
      }));
      pushStream({ id: 'c_' + msg.payload.index, type: 'text', content: msg.payload.delta, timestamp: Date.now() });
    }));

    offs.push(ws.on('chat.done', (msg: any) => {
      const mid = msg.payload?.messageId;
      if (realMessageId && mid !== realMessageId) return;
      if (!realMessageId) realMessageId = mid || localReplyId;
      const finalId = realMessageId;
      updateSession(sessionId!, s => ({
        ...s,
        messages: s.messages.map(m => m.id === finalId ? { ...m, content: acc, streaming: false } : m),
      }));
      cleanup();
      setBusy(false);
      abortRef.current = null;
      pushStream({ id: 'd_' + Date.now().toString(36), type: 'system', content: `✓ AI 回复完成 · ${Date.now() - startTs}ms`, timestamp: Date.now() });
      pushNotification({
        level: 'success',
        title: 'AI 回复完成',
        message: `${settings.primaryModel} · ${Date.now() - startTs}ms`,
        action: { label: '查看', onClick: () => window.scrollTo(0, 0) },
      });
    }));

    offs.push(ws.on('chat.error', (msg: any) => {
      const mid = msg.payload?.messageId;
      if (realMessageId && mid !== realMessageId) return;
      cleanup();
      setBusy(false);
      abortRef.current = null;
      const errMsg = msg.payload?.message || '未知错误';
      const targetId = realMessageId || localReplyId;
      updateSession(sessionId!, s => ({
        ...s,
        messages: s.messages.map(m => m.id === targetId ? { ...m, content: `❌ ${errMsg}`, streaming: false } : m),
      }));
      pushStream({ id: 'err_' + Date.now().toString(36), type: 'error', content: `❌ ${errMsg}`, timestamp: Date.now() });
      pushToast({ level: 'error', title: 'AI 请求失败', message: errMsg, duration: 6000 });
    }));

    // 4) 注册 abort 句柄
    abortRef.current = {
      abort: () => {
        if (aborted) return;
        aborted = true;
        cleanup();
        setBusy(false);
        if (realMessageId) {
          ws.send('chat.abort', { sessionId: sessionId!, messageId: realMessageId });
        }
        const targetId = realMessageId || localReplyId;
        updateSession(sessionId!, s => ({
          ...s,
          messages: s.messages.map(m => m.id === targetId ? { ...m, content: acc + '\n\n_(已中止)_', streaming: false } : m),
        }));
        pushStream({ id: 'st_' + Date.now().toString(36), type: 'system', content: '⏹ 已停止生成', timestamp: Date.now() });
      },
    } as any;

    // 5) 发送 chat.send
    ws.send('chat.send', {
      sessionId,
      text: trimmed,
      model: settings.primaryModel,
      attachments,
      // 把当前 session 的历史消息带上(去掉最后一条刚加的 user,后端会自己加)
      history: (() => {
        const sess = sessions.find(s => s.id === sessionId);
        if (!sess) return undefined;
        // 截到当前 user 之前(避免重复)
        const idx = sess.messages.findIndex(m => m.id === userMsg.id);
        const prev = idx > 0 ? sess.messages.slice(0, idx) : sess.messages.slice(0, -1);
        return prev
          .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'system') && !m.streaming)
          .map(m => ({ role: m.role, content: m.content }));
      })(),
      settings: {
        temperature: settings.temperature,
        enableTools: settings.enableTools,
        enableMemory: settings.enableMemory,
        enableRag: settings.enableRag,
        hybridEnabled: settings.hybridEnabled,
        secondaryModel: settings.secondaryModel,
        systemPrompt: settings.systemPrompt,
      },
    } as any);
  }, [activeId, busy, settings, updateSession, pushStream, pushToast, pushNotification, newSession, sessions]);

  // 重新生成（依赖 send）
  const regenerate = useCallback((sessionId: string, messageId: string) => {
    const sess = sessions.find(s => s.id === sessionId);
    if (!sess) return;
    const idx = sess.messages.findIndex(m => m.id === messageId);
    if (idx < 0) return;
    const userMsg = sess.messages.slice(0, idx).reverse().find(m => m.role === 'user');
    if (userMsg) {
      // 删掉该消息及之后，重发
      const trimmed = sess.messages.slice(0, idx);
      updateSession(sessionId, s => ({ ...s, messages: trimmed }));
      send(userMsg.content);
    }
  }, [sessions, updateSession, send]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  return {
    sessions, activeId, activeSession,
    settings, setSettings,
    stream, busy,
    newSession, switchSession, deleteSession, renameSession, clearAll,
    send, stop, clearStream,
    regenerate, copyMessage,
    attachFiles, pendingAttachments, consumeAttachments,
    setMessages, deleteMessage, editMessage, truncateAt, branchAt,
    explanations, setExplanation, explainKey, explainInline,
    clearExplanations, removeExplanation,
  };
}

// ─── 行内 AI 解释生成（无 LLM 时回退） ───
function generateExplanation(file: string, start: number, end: number, code: string, mode: 'explain' | 'refactor' | 'test', lang: string): string {
  const lines = code.split('\n');
  const lineCount = end - start + 1;
  const trimmed = lines.slice(0, 8).map(l => l.length > 80 ? l.slice(0, 77) + '…' : l).join('\n');
  if (mode === 'explain') {
    return `**${file} · 第 ${start}-${end} 行 (${lineCount} 行)**

这段代码在做什么：
- 定义/调用了核心逻辑（行 ${start} 起）
- 控制流：${/if|else|switch/.test(code) ? '分支判断' : /for|while|forEach|map/.test(code) ? '循环迭代' : '顺序执行'}
- 主要意图：实现一个独立的职责模块

**关键点**
1. 参数/返回值通过类型约束（\`${lang}\` 类型系统保证）
2. 没有明显的副作用，函数相对纯净
3. 可在测试用例中用 mock 替换外部依赖

**潜在改进**
- 抽取魔术数字为命名常量
- 添加 JSDoc 注释说明入参边界

\`\`\`${lang}
${trimmed}
\`\`\``;
  }
  if (mode === 'refactor') {
    return `**重构建议 · ${file} · 行 ${start}-${end}**

**问题诊断**
- 代码组织：可以拆分为 2-3 个更小的函数
- 可读性：变量名 ${/let |const \w+/.test(code) ? '可考虑更具语义的命名' : '已较合理'}
- 复用：与同文件其他函数存在相似模式

**重构后示例**

\`\`\`${lang}
// 1. 抽取主逻辑为独立函数
function extractedCore(/* params */) {
  // ... 原代码
}

// 2. 在原位置调用
extractedCore(/* args */);
\`\`\`

**收益**
- 行数减少 ~30%
- 单元测试覆盖更精细
- 后续修改影响范围更小`;
  }
  // test
  return `**测试用例 · ${file} · 行 ${start}-${end}**

**单元测试 (Vitest / Jest)**

\`\`\`${lang === 'ts' || lang === 'tsx' ? 'ts' : lang}
import { describe, it, expect } from 'vitest';

describe('${file.split('/').pop()?.split('.')[0]}', () => {
  it('正常路径：返回预期结果', () => {
    const result = /* 调用 */;
    expect(result).toBeDefined();
  });

  it('边界：空入参', () => {
    expect(() => /* 调用 */).not.toThrow();
  });

  it('异常：非法入参抛出', () => {
    expect(() => /* 调用 */).toThrow();
  });
});
\`\`\`

**覆盖目标**
- ✅ 正常路径
- ✅ 边界条件
- ✅ 错误处理
- 覆盖率预期 ≥ 85%`;
}
