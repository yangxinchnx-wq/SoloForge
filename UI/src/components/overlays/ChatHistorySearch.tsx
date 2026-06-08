// ─────────────────────────────────────────────────────────────────
// 对话历史搜索 (跨会话)
// - 全文搜索所有 sessions 的 messages
// - 支持: 关键词 / 正则 / 角色过滤 / 时间范围 / 会话过滤
// - 高亮匹配片段
// - 点击跳转到对应 session
// - 快捷键: Ctrl+H
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { ChatMessage } from '../../types';
import type { ChatSession } from '../../hooks/useChat';
import { exportSessionsAsMarkdown, exportSessionsAsHtml, exportSessionsAsJson, downloadFile, copyToClipboard } from '../../api/chatExport';
import { pushToast } from './Notifications';

export interface ChatHistorySearchProps {
  open: boolean;
  onClose: () => void;
  sessions: ChatSession[];
  activeId: string | null;
  onJumpToSession: (sessionId: string, messageId?: string) => void;
}

interface Hit {
  sessionId: string;
  sessionTitle: string;
  message: ChatMessage;
  /** 匹配到的片段 (高亮) */
  snippet: string;
  /** 全字段中所有 match 起始位置 */
  matches: Array<{ start: number; end: number }>;
}

type Mode = 'plain' | 'regex' | 'fuzzy';
type RoleFilter = 'all' | 'user' | 'assistant';
type TimeFilter = 'all' | '1d' | '7d' | '30d';

function buildSnippet(text: string, matches: Array<{ start: number; end: number }>, maxLen = 140): string {
  if (matches.length === 0) return text.slice(0, maxLen);
  const first = matches[0];
  const start = Math.max(0, first.start - 40);
  const end = Math.min(text.length, matches[matches.length - 1].end + 40);
  let s = text.slice(start, end);
  if (start > 0) s = '…' + s;
  if (end < text.length) s = s + '…';
  return s;
}

function highlightSnippet(snippet: string, matches: Array<{ start: number; end: number }>, offset: number, query: string): Array<{ text: string; hit: boolean }> {
  // 简化: 由于 snippet 已裁剪, 这里直接做关键词高亮 (大小写不敏感)
  const out: Array<{ text: string; hit: boolean }> = [];
  if (!query) return [{ text: snippet, hit: false }];
  const re = new RegExp(escapeRegExp(query), 'gi');
  let last = 0;
  let m: RegExpExecArray | null;
  const parts: Array<{ text: string; hit: boolean }> = [];
  while ((m = re.exec(snippet))) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), hit: false });
    parts.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fuzzyMatch(text: string, q: string): boolean {
  if (!q) return true;
  const t = text.toLowerCase();
  const p = q.toLowerCase();
  let ti = 0;
  for (let pi = 0; pi < p.length; pi++) {
    const ch = p[pi];
    const found = t.indexOf(ch, ti);
    if (found < 0) return false;
    ti = found + 1;
  }
  return true;
}

function getMatches(text: string, q: string, mode: Mode): Array<{ start: number; end: number }> {
  if (!q) return [];
  if (mode === 'regex') {
    try {
      const re = new RegExp(q, 'gi');
      const ms: Array<{ start: number; end: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        ms.push({ start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex++;
      }
      return ms;
    } catch { return []; }
  }
  // plain
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const ms: Array<{ start: number; end: number }> = [];
  let idx = lower.indexOf(ql);
  while (idx >= 0) {
    ms.push({ start: idx, end: idx + ql.length });
    idx = lower.indexOf(ql, idx + ql.length);
  }
  return ms;
}

export function ChatHistorySearch({ open, onClose, sessions, activeId, onJumpToSession }: ChatHistorySearchProps) {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<Mode>('plain');
  const [role, setRole] = useState<RoleFilter>('all');
  const [time, setTime] = useState<TimeFilter>('all');
  const [sessionFilter, setSessionFilter] = useState<string>('all');
  const [idx, setIdx] = useState(0);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportScope, setExportScope] = useState<'all' | 'filtered' | 'active'>('all');
  const inputRef = useRef<HTMLInputElement>(null);

  // 重置状态
  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setMode('plain');
      setRole('all');
      setTime('all');
      setSessionFilter('all');
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // 收集所有 hit
  const hits: Hit[] = useMemo(() => {
    if (!q.trim() && time === 'all' && role === 'all' && sessionFilter === 'all') return [];
    const now = Date.now();
    const cutoff =
      time === '1d' ? now - 86_400_000 :
      time === '7d' ? now - 7 * 86_400_000 :
      time === '30d' ? now - 30 * 86_400_000 : 0;
    const out: Hit[] = [];
    for (const sess of sessions) {
      if (sessionFilter !== 'all' && sess.id !== sessionFilter) continue;
      if (cutoff && sess.updatedAt < cutoff) continue;
      // 会话标题也算
      const titleMs = q.trim() ? getMatches(sess.title, q, mode) : [];
      if (titleMs.length && (mode === 'fuzzy' ? fuzzyMatch(sess.title, q) : true)) {
        out.push({
          sessionId: sess.id,
          sessionTitle: sess.title,
          message: {
            id: '__title__',
            role: 'user',
            content: sess.title,
            timestamp: sess.createdAt,
          } as ChatMessage,
          snippet: buildSnippet(sess.title, titleMs),
          matches: titleMs,
        });
      }
      for (const m of sess.messages) {
        if (role !== 'all' && m.role !== role) continue;
        if (m.streaming) continue;
        const text = m.content;
        let ms: Array<{ start: number; end: number }> = [];
        if (mode === 'fuzzy') {
          if (!fuzzyMatch(text, q)) continue;
        } else {
          ms = getMatches(text, q, mode);
          if (q.trim() && ms.length === 0) continue;
        }
        if (!q.trim() && (time === 'all' || sess.updatedAt >= cutoff)) {
          // 列出所有消息 (受时间过滤)
          ms = [{ start: 0, end: 0 }]; // placeholder
        }
        out.push({
          sessionId: sess.id,
          sessionTitle: sess.title,
          message: m,
          snippet: q.trim() ? buildSnippet(text, ms) : text.slice(0, 140),
          matches: ms,
        });
      }
    }
    // 排序: 时间倒序
    out.sort((a, b) => b.message.timestamp - a.message.timestamp);
    return out.slice(0, 200);
  }, [q, mode, role, time, sessionFilter, sessions]);

  useEffect(() => { setIdx(0); }, [q, mode, role, time, sessionFilter]);

  // 导出
  const doExport = (format: 'md' | 'html' | 'json' | 'copy-md', scope: typeof exportScope) => {
    let target: ChatSession[] = [];
    let scopeLabel = '';
    if (scope === 'all') {
      target = sessions;
      scopeLabel = '全部';
    } else if (scope === 'active') {
      target = sessions.filter(s => s.id === activeId);
      scopeLabel = '当前会话';
    } else {
      // filtered: 仅导出当前命中结果中涉及的 session
      const ids = new Set(hits.map(h => h.sessionId));
      target = sessions.filter(s => ids.has(s.id));
      scopeLabel = `筛选结果 (${ids.size})`;
    }
    if (target.length === 0) {
      pushToast({ level: 'warning', title: '无数据可导出', duration: 1500 });
      return;
    }
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (format === 'md') {
      const content = exportSessionsAsMarkdown(target);
      downloadFile(`soloforge-chat-${ts}.md`, content, 'text/markdown');
      pushToast({ level: 'success', title: '已导出 Markdown', message: `${target.length} 会话 · ${scopeLabel}`, duration: 2000 });
    } else if (format === 'html') {
      const content = exportSessionsAsHtml(target);
      downloadFile(`soloforge-chat-${ts}.html`, content, 'text/html');
      pushToast({ level: 'success', title: '已导出 HTML', message: `${target.length} 会话 · 包含内置搜索`, duration: 2000 });
    } else if (format === 'json') {
      const content = exportSessionsAsJson(target);
      downloadFile(`soloforge-chat-${ts}.json`, content, 'application/json');
      pushToast({ level: 'success', title: '已导出 JSON', message: `${target.length} 会话 · 可重新导入`, duration: 2000 });
    } else if (format === 'copy-md') {
      const content = exportSessionsAsMarkdown(target);
      copyToClipboard(content).then(ok => {
        pushToast({ level: ok ? 'success' : 'error', title: ok ? '已复制 Markdown' : '复制失败', message: `${content.length} 字符`, duration: 2000 });
      });
    }
    setExportMenuOpen(false);
  };

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const h = hits[idx];
      if (h) {
        onJumpToSession(h.sessionId, h.message.id === '__title__' ? undefined : h.message.id);
        onClose();
      }
    } else if (e.key === 'Escape') onClose();
  }, [hits, idx, onJumpToSession, onClose]);

  if (!open) return null;

  // 分组: 按 session 聚合
  const groupedHits: Record<string, { title: string; hits: Hit[] }> = {};
  hits.forEach(h => {
    if (!groupedHits[h.sessionId]) groupedHits[h.sessionId] = { title: h.sessionTitle, hits: [] };
    groupedHits[h.sessionId].hits.push(h);
  });

  // 统计
  const sessionCount = Object.keys(groupedHits).length;
  const messageCount = hits.length;
  const sessionsWithMsg = sessions.length;
  const totalMessages = sessions.reduce((s, sess) => s + sess.messages.length, 0);

  let runningIdx = -1;

  return (
    <div
      className="fixed inset-0 z-[210] flex items-start justify-center pt-[10vh] bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[760px] max-w-[92vw] bg-surface border border-border rounded-xl shadow-2xl overflow-hidden animate-slide-in-up flex flex-col max-h-[78vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* 搜索栏 */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-border shrink-0">
          <span className="material-symbols-outlined text-text-secondary">search</span>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="跨会话搜索消息内容、标题..."
            className="flex-1 bg-transparent outline-none text-sm text-text placeholder-text-secondary"
          />
          {/* 模式切换 */}
          <div className="flex items-center gap-0.5 p-0.5 rounded bg-bg-dim border border-border-light">
            {(['plain', 'regex', 'fuzzy'] as Mode[]).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2 h-6 text-[10px] rounded font-mono ${
                  mode === m ? 'bg-primary text-on-primary' : 'text-text-secondary hover:text-text'
                }`}
                title={m === 'plain' ? '纯文本' : m === 'regex' ? '正则表达式' : '模糊匹配'}
              >
                {m === 'plain' ? 'Aa' : m === 'regex' ? '.*' : '~='}
              </button>
            ))}
          </div>
          <kbd className="px-1.5 py-0.5 text-[10px] rounded bg-bg-dim text-text-secondary border border-border-light">ESC</kbd>
        </div>

        {/* 过滤栏 */}
        <div className="flex items-center gap-2 px-4 h-10 border-b border-border-light bg-bg-dim/40 shrink-0 overflow-x-auto scrollbar-hide">
          <span className="text-[10px] text-text-secondary shrink-0">角色</span>
          {(['all', 'user', 'assistant'] as RoleFilter[]).map(r => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={`px-2 h-6 text-[10px] rounded shrink-0 ${
                role === r ? 'bg-primary/20 text-primary border border-primary/40' : 'bg-surface text-text-secondary border border-border-light hover:text-text'
              }`}
            >
              {r === 'all' ? '全部' : r === 'user' ? '用户' : 'AI'}
            </button>
          ))}
          <span className="text-text-secondary/40 mx-1">·</span>
          <span className="text-[10px] text-text-secondary shrink-0">时间</span>
          {(['all', '1d', '7d', '30d'] as TimeFilter[]).map(t => (
            <button
              key={t}
              onClick={() => setTime(t)}
              className={`px-2 h-6 text-[10px] rounded shrink-0 ${
                time === t ? 'bg-primary/20 text-primary border border-primary/40' : 'bg-surface text-text-secondary border border-border-light hover:text-text'
              }`}
            >
              {t === 'all' ? '全部' : t === '1d' ? '24h' : t === '7d' ? '7d' : '30d'}
            </button>
          ))}
          <span className="text-text-secondary/40 mx-1">·</span>
          <span className="text-[10px] text-text-secondary shrink-0">会话</span>
          <select
            value={sessionFilter}
            onChange={e => setSessionFilter(e.target.value)}
            className="px-2 h-6 text-[10px] rounded bg-surface text-text-secondary border border-border-light shrink-0 max-w-[200px]"
          >
            <option value="all">全部会话 ({sessions.length})</option>
            {sessions.map(s => (
              <option key={s.id} value={s.id}>{s.title} · {s.messages.length}</option>
            ))}
          </select>
          <div className="flex-1" />
          <span className="text-[10px] text-text-secondary/70 font-mono shrink-0">
            {hits.length > 0 ? `${messageCount} 命中 / ${sessionCount} 会话` : '—'}
          </span>
        </div>

        {/* 结果列表 */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {q.trim() === '' && time === 'all' && role === 'all' && sessionFilter === 'all' ? (
            <Empty
              icon="manage_search"
              title="跨会话搜索"
              desc={`当前 ${sessionsWithMsg} 个会话 · ${totalMessages} 条消息。输入关键词开始搜索,或选择过滤条件浏览。`}
            />
          ) : hits.length === 0 ? (
            <Empty
              icon="search_off"
              title="无匹配结果"
              desc={`尝试切换模式（纯文本/正则/模糊）、扩大时间范围或调整角色过滤。`}
            />
          ) : (
            Object.entries(groupedHits).map(([sid, g]) => {
              const isActiveSess = sid === activeId;
              return (
                <div key={sid} className="border-b border-border-light last:border-0">
                  <div className="flex items-center gap-2 px-4 py-1.5 bg-bg-dim/30 text-[10px] text-text-secondary sticky top-0 z-10">
                    <span className="material-symbols-outlined text-xs">forum</span>
                    <span className="truncate flex-1 font-medium text-text">{g.title}</span>
                    {isActiveSess && (
                      <span className="px-1.5 rounded bg-primary/15 text-primary border border-primary/30 text-[9px] font-mono">当前</span>
                    )}
                    <span className="text-text-secondary/60 font-mono">{g.hits.length} 命中</span>
                  </div>
                  {g.hits.map(h => {
                    runningIdx++;
                    const active = runningIdx === idx;
                    const isTitle = h.message.id === '__title__';
                    const parts = q.trim() ? highlightSnippet(h.snippet, h.matches, 0, q) : [{ text: h.snippet, hit: false }];
                    return (
                      <button
                        key={`${sid}_${h.message.id}_${runningIdx}`}
                        onClick={() => {
                          onJumpToSession(sid, isTitle ? undefined : h.message.id);
                          onClose();
                        }}
                        onMouseEnter={() => setIdx(runningIdx)}
                        className={`group w-full flex items-start gap-3 px-4 py-2 text-left transition-colors ${
                          active ? 'bg-primary-container/40' : 'hover:bg-surface-high'
                        }`}
                      >
                        <span className={`shrink-0 mt-0.5 w-5 h-5 rounded flex items-center justify-center text-[10px] font-mono ${
                          isTitle ? 'bg-accent/20 text-accent' :
                          h.message.role === 'user' ? 'bg-primary/20 text-primary' : 'bg-success/20 text-success'
                        }`}>
                          {isTitle ? <span className="material-symbols-outlined text-[10px]">title</span> :
                            h.message.role === 'user' ? 'U' : 'AI'}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-text leading-relaxed break-words line-clamp-2">
                            {parts.map((p, pi) => p.hit ? (
                              <mark key={pi} className="bg-warning/40 text-text font-semibold px-0.5 rounded-sm">{p.text}</mark>
                            ) : (
                              <span key={pi}>{p.text}</span>
                            ))}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5 text-[9px] text-text-secondary/70 font-mono">
                            <span>{new Date(h.message.timestamp).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                            {h.message.model && <span>· {h.message.model}</span>}
                            {isTitle && <span className="text-accent">· 会话标题</span>}
                          </div>
                        </div>
                        <span className="material-symbols-outlined text-sm text-text-secondary opacity-0 group-hover:opacity-100 shrink-0">north_east</span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* 底栏 */}
        <div className="flex items-center justify-between px-4 h-9 bg-bg-dim border-t border-border text-[10px] text-text-secondary shrink-0 relative">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light">↑↓</kbd>
              移动
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light">↵</kbd>
              跳转
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light">ESC</kbd>
              关闭
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light">Ctrl</kbd>
              +
              <kbd className="px-1 py-0.5 rounded bg-surface border border-border-light">H</kbd>
              快捷键
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* 导出按钮 */}
            <div className="relative">
              <button
                onClick={() => setExportMenuOpen(o => !o)}
                className={`flex items-center gap-1 px-2 h-6 rounded text-[10px] border transition-colors ${
                  exportMenuOpen
                    ? 'bg-primary/15 text-primary border-primary/40'
                    : 'bg-surface text-text-secondary border-border-light hover:text-text'
                }`}
              >
                <span className="material-symbols-outlined text-xs">download</span>
                导出
                <span className="material-symbols-outlined text-[10px]">expand_more</span>
              </button>
              {exportMenuOpen && (
                <div
                  className="absolute right-0 bottom-7 z-50 w-[260px] bg-surface border border-border rounded-lg shadow-2xl py-1 animate-fade-in"
                  onMouseLeave={() => setExportMenuOpen(false)}
                >
                  <div className="px-2 py-1 text-[9px] text-text-secondary uppercase tracking-wider font-semibold">范围</div>
                  <div className="px-2 pb-1.5 flex items-center gap-0.5">
                    {(['all', 'filtered', 'active'] as const).map(s => (
                      <button
                        key={s}
                        onClick={() => setExportScope(s)}
                        className={`flex-1 px-1.5 h-5 rounded text-[10px] ${
                          exportScope === s ? 'bg-primary text-on-primary' : 'bg-bg-dim text-text-secondary border border-border-light hover:text-text'
                        }`}
                      >
                        {s === 'all' ? '全部' : s === 'filtered' ? '筛选' : '当前'}
                      </button>
                    ))}
                  </div>
                  <div className="h-px bg-border-light mx-2 my-0.5" />
                  <ExportItem icon="description" label="Markdown (.md)" sub="纯文本,可读性最佳" onClick={() => doExport('md', exportScope)} />
                  <ExportItem icon="html" label="HTML 单文件" sub="包含搜索 + 高亮" onClick={() => doExport('html', exportScope)} />
                  <ExportItem icon="data_object" label="JSON" sub="可重新导入 SoloForge" onClick={() => doExport('json', exportScope)} />
                  <div className="h-px bg-border-light mx-2 my-0.5" />
                  <ExportItem icon="content_copy" label="复制 Markdown" sub="到剪贴板" onClick={() => doExport('copy-md', exportScope)} />
                </div>
              )}
            </div>
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-xs">manage_search</span>
              跨 {sessionsWithMsg} 会话 · {totalMessages} 消息
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Empty({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
      <span className="material-symbols-outlined text-4xl text-text-secondary/40 mb-2">{icon}</span>
      <p className="text-sm text-text mb-1">{title}</p>
      <p className="text-[11px] text-text-secondary/70 max-w-md leading-relaxed">{desc}</p>
    </div>
  );
}

function ExportItem({ icon, label, sub, onClick }: { icon: string; label: string; sub: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-start gap-2 px-2.5 py-1.5 text-left hover:bg-surface-high transition-colors"
    >
      <span className="material-symbols-outlined text-sm text-text-secondary mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-text">{label}</div>
        <div className="text-[9px] text-text-secondary/70">{sub}</div>
      </div>
    </button>
  );
}
