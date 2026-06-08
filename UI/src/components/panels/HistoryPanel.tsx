// ─────────────────────────────────────────────────────────────────
// 历史对话区
// - 会话列表 (搜索 / 置顶 / 重命名 / 删除)
// - 当前会话内容预览
// ─────────────────────────────────────────────────────────────────

import { useState, useMemo } from 'react';
import type { useChat } from '../../hooks/useChat';
import { PanelHeader, IconButton, Tooltip, Badge, Button } from '../ui/Button';
import { Markdown } from '../chat/Markdown';

interface Props {
  chat: ReturnType<typeof useChat>;
}

export function HistoryPanel({ chat }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [filter, setFilter] = useState('');
  const { activeSession } = chat;

  const filtered = useMemo(() => {
    if (!filter) return chat.sessions;
    const q = filter.toLowerCase();
    return chat.sessions.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.messages.some(m => m.content.toLowerCase().includes(q))
    );
  }, [chat.sessions, filter]);

  return (
    <div className="flex flex-col h-full bg-bg-dim">
      <PanelHeader
        icon="history"
        title="历史对话"
        count={`${chat.sessions.length} 个会话`}
        action={
          <>
            <Tooltip content="搜索对话">
              <IconButton icon="search" size="xs" onClick={() => {
                const el = document.getElementById('history-search');
                el?.focus();
              }} />
            </Tooltip>
            <Tooltip content="新建对话">
              <IconButton icon="add" size="xs" onClick={chat.newSession} />
            </Tooltip>
            {chat.sessions.length > 0 && (
              <Tooltip content="全部清空">
                <IconButton
                  icon="delete_sweep"
                  size="xs"
                  onClick={() => { if (confirm('清空所有历史？')) chat.clearAll(); }}
                />
              </Tooltip>
            )}
          </>
        }
      />

      <div className="flex-1 flex overflow-hidden">
        {/* 会话列表 */}
        <div className="w-60 border-r border-border bg-surface-low overflow-y-auto scrollbar-thin shrink-0 flex flex-col">
          {chat.sessions.length > 0 && (
            <div className="p-1.5 border-b border-border-light">
              <div className="relative">
                <span className="material-symbols-outlined absolute left-1.5 top-1/2 -translate-y-1/2 text-text-secondary text-xs pointer-events-none">search</span>
                <input
                  id="history-search"
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  placeholder="搜索..."
                  className="w-full pl-6 pr-2 h-6 bg-surface border border-border-light text-[10px] text-text rounded focus:outline-none focus:border-primary placeholder-text-secondary"
                />
              </div>
            </div>
          )}

          {filtered.length === 0 ? (
            <Empty chat={chat} hasFilter={!!filter} />
          ) : (
            <div className="flex-1">
              {filtered.map(s => {
                const active = s.id === chat.activeId;
                const lastMsg = s.messages[s.messages.length - 1];
                const preview = lastMsg?.content ?? '';
                const userCount = s.messages.filter(m => m.role === 'user').length;
                return (
                  <div
                    key={s.id}
                    onClick={() => chat.switchSession(s.id)}
                    className={`group cursor-pointer px-2.5 py-2 border-b border-border-light transition-all relative ${
                      active
                        ? 'bg-primary-container/40'
                        : 'hover:bg-surface-high'
                    }`}
                  >
                    {active && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary" />}
                    {editingId === s.id ? (
                      <input
                        autoFocus
                        value={editTitle}
                        onChange={e => setEditTitle(e.target.value)}
                        onBlur={() => { chat.renameSession(s.id, editTitle || s.title); setEditingId(null); }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { chat.renameSession(s.id, editTitle || s.title); setEditingId(null); }
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="w-full text-xs bg-surface border border-primary rounded px-1 py-0.5 focus:outline-none"
                      />
                    ) : (
                      <>
                        <div className="flex items-start justify-between gap-1 mb-0.5">
                          <div className={`text-xs font-medium truncate flex-1 ${active ? 'text-text' : 'text-text-secondary group-hover:text-text'}`}>
                            {s.title || '新对话'}
                          </div>
                          {s.messages.length > 0 && (
                            <Badge variant={active ? 'primary' : 'default'} className="text-[9px]">
                              {s.messages.length}
                            </Badge>
                          )}
                        </div>
                        <div className="text-[10px] text-text-secondary/80 truncate">
                          {preview || '空对话'}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-[9px] text-text-secondary/60 font-mono">
                          <span className="flex items-center gap-0.5">
                            <span className="material-symbols-outlined text-[9px]">schedule</span>
                            {new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </span>
                          {userCount > 0 && (
                            <span>· {userCount} 轮</span>
                          )}
                        </div>
                        <div className="hidden group-hover:flex items-center gap-0.5 mt-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditingId(s.id); setEditTitle(s.title); }}
                            className="p-0.5 hover:bg-surface rounded"
                            title="重命名"
                          ><span className="material-symbols-outlined text-xs text-text-secondary">edit</span></button>
                          <button
                            onClick={(e) => { e.stopPropagation(); alert('已置顶'); }}
                            className="p-0.5 hover:bg-surface rounded"
                            title="置顶"
                          ><span className="material-symbols-outlined text-xs text-text-secondary">push_pin</span></button>
                          <button
                            onClick={(e) => { e.stopPropagation(); if (confirm(`删除 "${s.title}"？`)) chat.deleteSession(s.id); }}
                            className="p-0.5 hover:bg-danger/20 rounded ml-auto"
                            title="删除"
                          ><span className="material-symbols-outlined text-xs text-danger">delete</span></button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 当前会话预览 */}
        <div className="flex-1 overflow-y-auto p-3 scrollbar-thin">
          {!activeSession ? (
            <Empty2 hasSessions={chat.sessions.length > 0} onNew={chat.newSession} />
          ) : activeSession.messages.length === 0 ? (
            <EmptyChat onNew={chat.newSession} />
          ) : (
            <div className="space-y-3 max-w-3xl">
              <div className="flex items-center gap-2 text-[10px] text-text-secondary mb-2 pb-2 border-b border-border-light">
                <span className="material-symbols-outlined text-xs">forum</span>
                <span className="font-medium text-text">{activeSession.title}</span>
                <span>·</span>
                <span>{activeSession.messages.length} 条消息</span>
                <span>·</span>
                <span>{new Date(activeSession.createdAt).toLocaleString('zh-CN')}</span>
                <div className="flex-1" />
                <button
                  onClick={() => {
                    const text = activeSession.messages.map(m => `## ${m.role === 'user' ? '我' : 'AI'}\n${m.content}`).join('\n\n');
                    navigator.clipboard?.writeText(text).catch(() => {});
                    alert('已复制到剪贴板');
                  }}
                  className="text-text-secondary hover:text-text"
                >
                  <span className="material-symbols-outlined text-xs">content_copy</span>
                </button>
                <button className="text-text-secondary hover:text-text">
                  <span className="material-symbols-outlined text-xs">download</span>
                </button>
              </div>
              {activeSession.messages.map(m => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  onCopy={() => chat.copyMessage(m.content)}
                  onRegenerate={() => chat.regenerate(chat.activeId!, m.id)}
                  onEdit={(newContent) => {
                    chat.editMessage(chat.activeId!, m.id, newContent);
                    chat.truncateAt(chat.activeId!, m.id);
                    chat.regenerate(chat.activeId!, m.id);
                  }}
                  onDelete={() => {
                    if (confirm('删除该消息？')) chat.deleteMessage(chat.activeId!, m.id);
                  }}
                  onBranch={() => chat.branchAt(chat.activeId!, m.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ msg, onCopy, onRegenerate, onEdit, onDelete, onBranch }: {
  msg: { id: string; role: string; content: string; timestamp: number; model?: string; streaming?: boolean };
  onCopy: () => void;
  onRegenerate: () => void;
  onEdit?: (newContent: string) => void;
  onDelete?: () => void;
  onBranch?: () => void;
}) {
  const isUser = msg.role === 'user';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.content);
  const [rating, setRating] = useState<'up' | 'down' | null>(null);

  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : ''} animate-slide-in-up`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
        isUser
          ? 'bg-primary text-on-primary'
          : 'bg-gradient-to-br from-accent to-primary text-white'
      }`}>
        <span className="material-symbols-outlined text-sm">{isUser ? 'person' : 'token'}</span>
      </div>
      <div className={`max-w-[80%] rounded-lg px-3 py-2 text-xs group relative ${
        isUser
          ? 'bg-primary-container text-on-primary-container'
          : 'bg-surface border border-border-light text-text'
      }`}>
        <div className="flex items-center gap-2 text-[10px] text-text-secondary mb-1">
          <span className="font-medium">{isUser ? '我' : (msg.model || 'AI 助手')}</span>
          <span>·</span>
          <span>{new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</span>
          {msg.streaming && (
            <span className="flex items-center gap-1 text-primary">
              <span className="flex gap-0.5">
                <span className="w-1 h-1 rounded-full bg-primary animate-typing" />
                <span className="w-1 h-1 rounded-full bg-primary animate-typing" />
                <span className="w-1 h-1 rounded-full bg-primary animate-typing" />
              </span>
              <span>生成中</span>
            </span>
          )}
        </div>
        {editing ? (
          <div className="space-y-1.5">
            <textarea
              autoFocus
              value={draft}
              onChange={e => setDraft(e.target.value)}
              className="w-full bg-bg-dim border border-primary rounded p-2 text-xs text-text focus:outline-none font-sans resize-y min-h-[60px]"
            />
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => { onEdit?.(draft); setEditing(false); }}
                className="px-2 h-6 bg-primary text-on-primary rounded text-[10px]"
              >保存并重新生成</button>
              <button
                onClick={() => { setDraft(msg.content); setEditing(false); }}
                className="px-2 h-6 bg-surface border border-border-light text-text rounded text-[10px]"
              >取消</button>
              <span className="text-[9px] text-text-secondary ml-auto font-mono">Esc 取消</span>
            </div>
          </div>
        ) : (
          <>
            {isUser ? (
              <div className="whitespace-pre-wrap break-words leading-relaxed">
                {msg.content}
                {msg.streaming && <span className="inline-block w-1.5 h-3 bg-primary ml-0.5 animate-blink align-middle" />}
              </div>
            ) : (
              <Markdown source={msg.content} streaming={msg.streaming} />
            )}
            {!msg.streaming && (
              <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 mt-1.5 pt-1.5 border-t border-border-light">
                <button onClick={onCopy} className="text-[10px] text-text-secondary hover:text-text flex items-center gap-0.5" title="复制">
                  <span className="material-symbols-outlined text-xs">content_copy</span>
                </button>
                {isUser && onEdit && (
                  <button onClick={() => { setEditing(true); setDraft(msg.content); }} className="text-[10px] text-text-secondary hover:text-text flex items-center gap-0.5" title="编辑">
                    <span className="material-symbols-outlined text-xs">edit</span>
                  </button>
                )}
                {!isUser && (
                  <>
                    <button onClick={() => setRating(r => r === 'up' ? null : 'up')} className={`text-[10px] flex items-center gap-0.5 ${rating === 'up' ? 'text-success' : 'text-text-secondary hover:text-text'}`} title="点赞">
                      <span className={`material-symbols-outlined text-xs ${rating === 'up' ? 'filled' : ''}`}>thumb_up</span>
                    </button>
                    <button onClick={() => setRating(r => r === 'down' ? null : 'down')} className={`text-[10px] flex items-center gap-0.5 ${rating === 'down' ? 'text-danger' : 'text-text-secondary hover:text-text'}`} title="点踩">
                      <span className={`material-symbols-outlined text-xs ${rating === 'down' ? 'filled' : ''}`}>thumb_down</span>
                    </button>
                    <button onClick={onRegenerate} className="text-[10px] text-text-secondary hover:text-text flex items-center gap-0.5" title="重新生成">
                      <span className="material-symbols-outlined text-xs">refresh</span>
                    </button>
                    {onBranch && (
                      <button onClick={onBranch} className="text-[10px] text-text-secondary hover:text-text flex items-center gap-0.5" title="创建分支">
                        <span className="material-symbols-outlined text-xs">call_split</span>
                      </button>
                    )}
                  </>
                )}
                {onDelete && (
                  <button onClick={onDelete} className="text-[10px] text-text-secondary hover:text-danger flex items-center gap-0.5 ml-auto" title="删除">
                    <span className="material-symbols-outlined text-xs">delete</span>
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Empty({ chat, hasFilter }: { chat: any; hasFilter: boolean }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-text-secondary py-6 px-2">
      <span className="material-symbols-outlined text-3xl mb-2 opacity-40">
        {hasFilter ? 'search_off' : 'chat_bubble'}
      </span>
      <p className="text-[10px] text-center">
        {hasFilter ? '无匹配会话' : '暂无历史对话'}
      </p>
      {!hasFilter && (
        <button
          onClick={chat.newSession}
          className="mt-2 text-[10px] text-primary hover:underline"
        >
          开始新对话
        </button>
      )}
    </div>
  );
}

function Empty2({ hasSessions, onNew }: { hasSessions: boolean; onNew: () => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-text-secondary">
      {hasSessions ? (
        <>
          <span className="material-symbols-outlined text-4xl mb-2 opacity-40">forum</span>
          <p className="text-xs">选择左侧会话查看详情</p>
        </>
      ) : (
        <>
          <span className="material-symbols-outlined text-4xl mb-2 opacity-40">chat_add_on</span>
          <p className="text-xs font-medium text-text-secondary">开始你的第一次对话</p>
          <p className="text-[10px] text-text-secondary/60 mt-1 mb-3">让 SoloForge 帮你写代码、读文件、调度任务</p>
          <Button variant="primary" size="sm" icon="add" onClick={onNew}>新建对话</Button>
        </>
      )}
    </div>
  );
}

function EmptyChat({ onNew }: { onNew: () => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-text-secondary">
      <span className="material-symbols-outlined text-4xl mb-2 opacity-40">edit_note</span>
      <p className="text-xs">该对话还没有消息</p>
      <p className="text-[10px] text-text-secondary/60 mt-1">到下方"对话区"开始发送消息</p>
    </div>
  );
}
