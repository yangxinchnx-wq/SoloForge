// ─────────────────────────────────────────────────────────────────
// 文档协作 — DocCollab
// - 多人实时 Markdown 协作文档
// - 内置编辑 + 渲染预览
// - 协作者在线状态 / 远程光标
// - 评论 + 修订版本
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  userName?: string;
}

interface Doc {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  author: string;
  revisions: Revision[];
  comments: Comment[];
}

interface Revision {
  id: string;
  ts: number;
  author: string;
  message: string;
  diff: number;  // 字符数变化
}

interface Comment {
  id: string;
  author: string;
  text: string;
  ts: number;
  resolved: boolean;
  line?: number;
}

const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'];

const STORAGE_KEY = 'soloforge.doc-collab.v1';

function loadDocs(): Doc[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  // 注入示例
  const now = Date.now();
  return [
    {
      id: 'd1',
      name: '项目 README',
      author: 'me',
      createdAt: now - 7 * 86_400_000,
      updatedAt: now - 3600_000,
      content: `# SoloForge 项目说明

## 概述
SoloForge 是一个 AI 多智能体自治系统核心框架,基于微内核架构。

## 核心特性
- **微内核** — TypeScript + Node.js 业务编排
- **高性能调度** — Rust 调度器
- **嵌入式数据库** — SurrealDB (RocksDB)
- **MARL 引擎** — Python 强化学习

## 快速开始
\`\`\`bash
npm install
npm run dev
\`\`\`

## 贡献
欢迎 PR!`,
      revisions: [
        { id: 'r1', ts: now - 7 * 86_400_000, author: 'me', message: '初始版本', diff: 200 },
        { id: 'r2', ts: now - 3 * 86_400_000, author: 'Alice', message: '添加快速开始', diff: 80 },
      ],
      comments: [
        { id: 'c1', author: 'Bob', text: '需要补充部署章节', ts: now - 86_400_000, resolved: false, line: 8 },
        { id: 'c2', author: 'Alice', text: '微内核图可以加一张', ts: now - 3600_000, resolved: false, line: 4 },
      ],
    },
  ];
}

function saveDocs(docs: Doc[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(docs)); } catch { /* ignore */ }
}

function renderMarkdown(s: string): string {
  let h = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  h = h.replace(/```([\s\S]*?)```/g, '<pre class="bg-black/30 rounded p-2 my-1 overflow-auto text-[11px]">$1</pre>');
  h = h.replace(/`([^`\n]+)`/g, '<code class="bg-black/30 rounded px-1 text-[11px]">$1</code>');
  h = h.replace(/^### (.+)$/gm, '<h3 class="text-xs font-semibold mt-1">$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2 class="text-sm font-semibold mt-1">$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1 class="text-sm font-bold mt-1">$1</h1>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="underline text-blue-700">$1</a>');
  h = h.replace(/^- (.+)$/gm, '<li class="ml-3 list-disc">$1</li>');
  h = h.replace(/^(\d+)\. (.+)$/gm, '<li class="ml-3 list-decimal">$2</li>');
  h = h.replace(/\n/g, '<br>');
  return h;
}

export function DocCollab({ open, onClose, userName = 'me' }: Props) {
  const [docs, setDocs] = useState<Doc[]>(loadDocs);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<'edit' | 'split' | 'preview' | 'revisions' | 'comments'>('split');
  const [commentInput, setCommentInput] = useState('');
  const [commitMsg, setCommitMsg] = useState('');
  const [presence] = useState([
    { name: 'Alice', color: COLORS[1], online: true,  cursor: { line: 3, col: 12 } },
    { name: 'Bob',   color: COLORS[2], online: true,  cursor: { line: 7, col: 8 } },
    { name: 'Diana', color: COLORS[3], online: false, cursor: { line: 1, col: 0 } },
  ]);

  useEffect(() => { saveDocs(docs); }, [docs]);

  const active = useMemo(() => docs.find(d => d.id === activeId) || null, [docs, activeId]);

  const updateContent = useCallback((newContent: string) => {
    if (!activeId) return;
    setDocs(prev => prev.map(d => d.id === activeId ? { ...d, content: newContent, updatedAt: Date.now() } : d));
  }, [activeId]);

  const createDoc = useCallback(() => {
    const newDoc: Doc = {
      id: 'd_' + Date.now().toString(36),
      name: '新文档',
      author: userName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      content: '# 新文档\n\n开始写作...',
      revisions: [{ id: 'r_' + Date.now().toString(36), ts: Date.now(), author: userName, message: '创建', diff: 0 }],
      comments: [],
    };
    setDocs(prev => [newDoc, ...prev]);
    setActiveId(newDoc.id);
  }, [userName]);

  const commitRevision = useCallback(() => {
    if (!activeId || !commitMsg.trim()) return;
    setDocs(prev => prev.map(d => {
      if (d.id !== activeId) return d;
      return {
        ...d,
        revisions: [...d.revisions, {
          id: 'r_' + Date.now().toString(36),
          ts: Date.now(),
          author: userName,
          message: commitMsg,
          diff: d.content.length,
        }],
      };
    }));
    setCommitMsg('');
  }, [activeId, commitMsg, userName]);

  const addComment = useCallback(() => {
    if (!activeId || !commentInput.trim()) return;
    setDocs(prev => prev.map(d => d.id === activeId ? {
      ...d,
      comments: [...d.comments, {
        id: 'c_' + Date.now().toString(36),
        author: userName,
        text: commentInput,
        ts: Date.now(),
        resolved: false,
      }],
    } : d));
    setCommentInput('');
  }, [activeId, commentInput, userName]);

  const resolveComment = useCallback((docId: string, commentId: string) => {
    setDocs(prev => prev.map(d => d.id === docId ? {
      ...d,
      comments: d.comments.map(c => c.id === commentId ? { ...c, resolved: !c.resolved } : c),
    } : d));
  }, []);

  const deleteDoc = useCallback((id: string) => {
    setDocs(prev => prev.filter(d => d.id !== id));
    if (activeId === id) setActiveId(null);
  }, [activeId]);

  const exportMd = useCallback((doc: Doc) => {
    const blob = new Blob([doc.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${doc.name}.md`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">edit_document</span>
          <h2 className="text-sm font-semibold text-text">文档协作</h2>
          {active && <Badge variant="primary">{active.name}</Badge>}
          <span className="text-xs text-text-secondary">
            {presence.filter(p => p.online).length} 人在线 · {docs.length} 文档
          </span>
          {/* 在线头像 */}
          <div className="ml-auto flex items-center gap-2">
            <div className="flex -space-x-1.5">
              {presence.filter(p => p.online).map(p => (
                <div
                  key={p.name}
                  className="w-6 h-6 rounded-full border-2 border-surface-high flex items-center justify-center text-white text-[10px] font-semibold"
                  style={{ background: p.color }}
                  title={p.name}
                >
                  {p.name.slice(0, 1)}
                </div>
              ))}
            </div>
            <IconButton icon="add" onClick={createDoc} />
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 左:文档列表 */}
          <div className="w-56 border-r border-border bg-bg flex flex-col">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light">文档</div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {docs.map(d => (
                <div
                  key={d.id}
                  onClick={() => setActiveId(d.id)}
                  className={'p-2 rounded cursor-pointer border ' + (activeId === d.id ? 'bg-accent/10 border-accent/30' : 'border-transparent hover:bg-surface-high')}
                >
                  <div className="text-xs text-text truncate">{d.name}</div>
                  <div className="text-[10px] text-text-secondary mt-0.5 flex items-center gap-1">
                    <span>{d.author}</span>
                    <span>·</span>
                    <span>{new Date(d.updatedAt).toLocaleDateString()}</span>
                  </div>
                  <div className="text-[10px] text-text-secondary">{d.revisions.length} 版本 · {d.comments.filter(c => !c.resolved).length} 评论</div>
                </div>
              ))}
            </div>
          </div>

          {/* 中:文档内容 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {!active ? (
              <div className="flex-1 flex flex-col items-center justify-center text-text-secondary">
                <span className="material-symbols-outlined text-5xl opacity-30">edit_document</span>
                <p className="mt-3 text-sm">选择或创建文档开始协作</p>
                <Button variant="primary" size="sm" icon="add" onClick={createDoc} className="mt-3">新建文档</Button>
              </div>
            ) : (
              <>
                <div className="px-4 py-2 border-b border-border bg-surface-high flex items-center gap-2 shrink-0">
                  <input
                    value={active.name}
                    onChange={(e) => setDocs(prev => prev.map(d => d.id === active.id ? { ...d, name: e.target.value } : d))}
                    className="bg-transparent text-sm font-semibold text-text focus:outline-none"
                  />
                  <div className="ml-auto flex items-center gap-1">
                    {(['edit', 'split', 'preview', 'revisions', 'comments'] as const).map(v => (
                      <button key={v} onClick={() => setView(v)}
                        className={'px-2 h-6 rounded text-[10px] ' + (view === v ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:text-text')}>
                        {v === 'edit' ? '✏️ 编辑' : v === 'split' ? '⇆ 分屏' : v === 'preview' ? '👁 预览' : v === 'revisions' ? '📜 版本' : '💬 评论'}
                      </button>
                    ))}
                    <Tooltip content="导出 Markdown"><IconButton icon="download" onClick={() => exportMd(active)} /></Tooltip>
                    <Tooltip content="删除"><IconButton icon="delete" onClick={() => deleteDoc(active.id)} /></Tooltip>
                  </div>
                </div>
                {/* 远程光标覆盖 */}
                {view !== 'revisions' && view !== 'comments' && (
                  <div className="relative flex-1 flex overflow-hidden">
                    {(view === 'edit' || view === 'split') && (
                      <textarea
                        value={active.content}
                        onChange={(e) => updateContent(e.target.value)}
                        className={'flex-1 bg-bg p-4 text-sm font-mono text-text resize-none focus:outline-none ' + (view === 'split' ? 'border-r border-border' : '')}
                        spellCheck={false}
                      />
                    )}
                    {(view === 'preview' || view === 'split') && (
                      <div className="flex-1 bg-bg p-4 overflow-auto" dangerouslySetInnerHTML={{ __html: renderMarkdown(active.content) }} />
                    )}
                    {/* 远程光标 */}
                    {presence.filter(p => p.online).map(p => (
                      <div
                        key={p.name}
                        className="absolute pointer-events-none animate-pulse"
                        style={{ top: 16 + p.cursor.line * 22, left: p.name === 'Bob' ? '50%' : '20%' }}
                      >
                        <div className="w-0.5 h-5" style={{ background: p.color }} />
                        <div className="text-[9px] px-1 rounded" style={{ background: p.color, color: 'white' }}>{p.name}</div>
                      </div>
                    ))}
                  </div>
                )}

                {view === 'revisions' && (
                  <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    <div className="bg-bg border border-border rounded-lg p-3">
                      <h3 className="text-xs font-semibold text-text mb-2">提交新版本</h3>
                      <div className="flex gap-2">
                        <input
                          value={commitMsg}
                          onChange={(e) => setCommitMsg(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && commitRevision()}
                          placeholder="版本说明..."
                          className="flex-1 bg-bg border border-border-light rounded px-2 h-7 text-xs text-text"
                        />
                        <Button size="sm" icon="save" onClick={commitRevision}>提交</Button>
                      </div>
                    </div>
                    {active.revisions.slice().reverse().map(r => (
                      <div key={r.id} className="bg-bg border border-border rounded-lg p-3">
                        <div className="flex items-center gap-2">
                          <div className="w-5 h-5 rounded-full bg-accent text-white text-[10px] font-semibold flex items-center justify-center">{r.author.slice(0, 1)}</div>
                          <span className="text-xs font-semibold text-text">{r.message}</span>
                          <span className="text-[10px] text-text-secondary ml-auto">{new Date(r.ts).toLocaleString()}</span>
                        </div>
                        <div className="text-[10px] text-text-secondary mt-1">
                          {r.author} · 内容长度 {r.diff} 字符
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {view === 'comments' && (
                  <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    <div className="bg-bg border border-border rounded-lg p-3">
                      <h3 className="text-xs font-semibold text-text mb-2">添加评论</h3>
                      <div className="flex gap-2">
                        <input
                          value={commentInput}
                          onChange={(e) => setCommentInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && addComment()}
                          placeholder="写下你的评论..."
                          className="flex-1 bg-bg border border-border-light rounded px-2 h-7 text-xs text-text"
                        />
                        <Button size="sm" icon="send" onClick={addComment}>发送</Button>
                      </div>
                    </div>
                    {active.comments.map(c => (
                      <div key={c.id} className={'bg-bg border rounded-lg p-3 ' + (c.resolved ? 'opacity-50 border-success/30' : 'border-border')}>
                        <div className="flex items-center gap-2 mb-1">
                          <div className="w-5 h-5 rounded-full bg-primary text-white text-[10px] font-semibold flex items-center justify-center">{c.author.slice(0, 1)}</div>
                          <span className="text-xs font-semibold text-text">{c.author}</span>
                          <span className="text-[10px] text-text-secondary ml-auto">{new Date(c.ts).toLocaleString()}</span>
                        </div>
                        <div className="text-xs text-text">{c.text}</div>
                        <div className="mt-1 flex items-center gap-2 text-[10px]">
                          <button onClick={() => resolveComment(active.id, c.id)} className="text-text-secondary hover:text-success">
                            {c.resolved ? '↺ 重新打开' : '✓ 解决'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
