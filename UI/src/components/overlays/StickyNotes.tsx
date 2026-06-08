// ─────────────────────────────────────────────────────────────────
// 便签 Sticky Notes
// - 桌面贴纸:可拖动 + 改变颜色 + Markdown 预览
// - 跨项目分享(每条便签带 project 标签)
// - localStorage 持久化 + 导入/导出
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  projectName?: string;
}

interface StickyNote {
  id: string;
  text: string;
  color: 'yellow' | 'pink' | 'blue' | 'green' | 'purple' | 'orange';
  x: number;
  y: number;
  w: number;
  h: number;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  project: string;
  tags: string[];
  author: string;
  /** 链接到的文件/上下文,用于跨项目跳转 */
  link?: string;
}

const STORAGE_KEY = 'soloforge.stickynotes.v1';
const CURRENT_USER_KEY = 'soloforge.user.name';

const COLORS: StickyNote['color'][] = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange'];
const COLOR_STYLE: Record<StickyNote['color'], { bg: string; border: string; head: string; pin: string }> = {
  yellow: { bg: 'bg-yellow-200/90',   border: 'border-yellow-400/60',   head: 'bg-yellow-300/80',   pin: 'text-yellow-700' },
  pink:   { bg: 'bg-pink-200/90',     border: 'border-pink-400/60',     head: 'bg-pink-300/80',     pin: 'text-pink-700' },
  blue:   { bg: 'bg-sky-200/90',      border: 'border-sky-400/60',      head: 'bg-sky-300/80',      pin: 'text-sky-700' },
  green:  { bg: 'bg-emerald-200/90',  border: 'border-emerald-400/60',  head: 'bg-emerald-300/80',  pin: 'text-emerald-700' },
  purple: { bg: 'bg-violet-200/90',   border: 'border-violet-400/60',   head: 'bg-violet-300/80',   pin: 'text-violet-700' },
  orange: { bg: 'bg-orange-200/90',   border: 'border-orange-400/60',   head: 'bg-orange-300/80',   pin: 'text-orange-700' },
};

// ─── 简易 Markdown → HTML ───
function renderMarkdown(s: string): string {
  let h = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // 代码块
  h = h.replace(/```([\s\S]*?)```/g, '<pre class="bg-black/10 rounded p-1.5 my-1 overflow-auto text-[11px]">$1</pre>');
  // 行内代码
  h = h.replace(/`([^`\n]+)`/g, '<code class="bg-black/10 rounded px-1 text-[11px]">$1</code>');
  // 标题
  h = h.replace(/^### (.+)$/gm, '<h3 class="text-xs font-semibold mt-1">$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2 class="text-sm font-semibold mt-1">$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1 class="text-sm font-bold mt-1">$1</h1>');
  // 粗体/斜体
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // 链接
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="underline text-blue-700">$1</a>');
  // 列表
  h = h.replace(/^- (.+)$/gm, '<li class="ml-3 list-disc">$1</li>');
  h = h.replace(/(<li[^>]*>.*?<\/li>\n?)+/g, m => `<ul class="my-0.5">${m}</ul>`);
  // 任务列表
  h = h.replace(/^\[ \] (.+)$/gm, '<div class="flex items-center gap-1"><input type="checkbox" disabled class="scale-75"> $1</div>');
  h = h.replace(/^\[x\] (.+)$/gim, '<div class="flex items-center gap-1"><input type="checkbox" checked disabled class="scale-75"> <s>$1</s></div>');
  // 换行
  h = h.replace(/\n/g, '<br>');
  return h;
}

function loadNotes(): StickyNote[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  return [];
}
function saveNotes(notes: StickyNote[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(notes)); } catch { /* ignore */ }
}
function getUserName(): string {
  return localStorage.getItem(CURRENT_USER_KEY) || 'me';
}

export function StickyNotes({ open, onClose, projectName = 'SoloForge' }: Props) {
  const [notes, setNotes] = useState<StickyNote[]>(loadNotes);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [filter, setFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState<string>('__all');
  const [showPreview, setShowPreview] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{ id: string; ox: number; oy: number; sx: number; sy: number } | null>(null);

  useEffect(() => { saveNotes(notes); }, [notes]);

  const author = getUserName();

  // 派生:所有项目列表
  const allProjects = useMemo(() => {
    const set = new Set<string>();
    notes.forEach(n => set.add(n.project));
    return Array.from(set);
  }, [notes]);

  // 过滤
  const filtered = useMemo(() => {
    return notes.filter(n => {
      if (projectFilter !== '__all' && n.project !== projectFilter) return false;
      if (!filter) return true;
      const q = filter.toLowerCase();
      return n.text.toLowerCase().includes(q) || n.tags.some(t => t.toLowerCase().includes(q));
    });
  }, [notes, filter, projectFilter]);

  const addNote = useCallback((color: StickyNote['color'] = 'yellow') => {
    const now = Date.now();
    // 错落排布
    const offset = (notes.length % 6) * 32;
    const newNote: StickyNote = {
      id: 'sn_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      text: '',
      color,
      x: 60 + offset,
      y: 40 + offset,
      w: 240,
      h: 200,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      project: projectName,
      tags: [],
      author,
    };
    setNotes(prev => [newNote, ...prev]);
    setEditingId(newNote.id);
  }, [notes.length, projectName, author]);

  const updateNote = useCallback((id: string, patch: Partial<StickyNote>) => {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n));
  }, []);

  const removeNote = useCallback((id: string) => {
    setNotes(prev => prev.filter(n => n.id !== id));
  }, []);

  // 拖动逻辑
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragging.sx;
      const dy = e.clientY - dragging.sy;
      updateNote(dragging.id, { x: Math.max(0, dragging.ox + dx), y: Math.max(0, dragging.oy + dy) });
    };
    const onUp = () => setDragging(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, updateNote]);

  const startDrag = (e: React.MouseEvent, n: StickyNote) => {
    if (n.pinned) return;
    e.stopPropagation();
    e.preventDefault();
    setDragging({ id: n.id, ox: n.x, oy: n.y, sx: e.clientX, sy: e.clientY });
  };

  const bringToFront = useCallback((id: string) => {
    setNotes(prev => {
      const idx = prev.findIndex(n => n.id === id);
      if (idx < 0 || idx === 0) return prev;
      const arr = [...prev];
      const [n] = arr.splice(idx, 1);
      arr.unshift(n);
      return arr;
    });
  }, []);

  const cycleColor = useCallback((id: string) => {
    setNotes(prev => prev.map(n => {
      if (n.id !== id) return n;
      const idx = COLORS.indexOf(n.color);
      return { ...n, color: COLORS[(idx + 1) % COLORS.length], updatedAt: Date.now() };
    }));
  }, []);

  // 标签解析
  const parseTags = (s: string): { text: string; tags: string[] } => {
    const tags = Array.from(s.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)).map(m => m[1]);
    return { text: s, tags };
  };

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sticky-notes-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [notes]);

  const exportMarkdown = useCallback(() => {
    const lines = notes.map(n =>
      `<!-- note:${n.id} color:${n.color} project:${n.project} author:${n.author} created:${new Date(n.createdAt).toISOString()} -->\n` +
      n.text
    );
    const blob = new Blob([lines.join('\n\n---\n\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sticky-notes-${new Date().toISOString().slice(0, 10)}.md`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [notes]);

  const importJson = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const arr = JSON.parse(reader.result as string);
        if (Array.isArray(arr)) {
          setNotes(arr);
        }
      } catch (e) { /* ignore */ }
    };
    reader.readAsText(file);
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1200px] max-w-[95vw] h-[82vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">sticky_note_2</span>
          <h2 className="text-sm font-semibold text-text">便签墙</h2>
          <span className="text-xs text-text-secondary">{notes.length} 张 · 当前项目 <Badge variant="primary">{projectName}</Badge></span>
          <div className="ml-auto flex items-center gap-1.5">
            {/* 视图切换 */}
            <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
              {(['board', 'list'] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={
                    'px-2 h-6 rounded text-[10px] transition ' +
                    (view === v ? 'bg-surface-high text-text shadow-sm' : 'text-text-secondary hover:text-text')
                  }
                >
                  {v === 'board' ? '墙' : '列表'}
                </button>
              ))}
            </div>
            <Tooltip content="导出 JSON"><IconButton icon="code" onClick={exportJson} /></Tooltip>
            <Tooltip content="导出 Markdown"><IconButton icon="description" onClick={exportMarkdown} /></Tooltip>
            <Tooltip content="导入"><IconButton icon="upload" onClick={() => fileInputRef.current?.click()} /></Tooltip>
            <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={(e) => {
              const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = '';
            }} />
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        {/* 工具条 */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg shrink-0">
          {/* 新增色板 */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-text-secondary mr-1">新增:</span>
            {COLORS.map(c => (
              <button
                key={c}
                onClick={() => addNote(c)}
                className={`w-6 h-6 rounded-full border-2 border-white shadow-sm ${COLOR_STYLE[c].bg} hover:scale-110 transition`}
                title={`新增${c}色便签`}
              />
            ))}
          </div>
          <div className="w-px h-5 bg-border" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索文字 / #标签"
            className="bg-surface border border-border-light rounded px-2 h-7 text-xs text-text w-44 focus:border-accent outline-none"
          />
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="bg-surface border border-border-light rounded px-2 h-7 text-xs text-text focus:border-accent outline-none"
          >
            <option value="__all">全部项目</option>
            {allProjects.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <div className="ml-auto text-[10px] text-text-secondary">
            钉住 {notes.filter(n => n.pinned).length} · 作者 {new Set(notes.map(n => n.author)).size} 位
          </div>
        </div>

        {/* 主体 */}
        {view === 'board' ? (
          <div
            ref={boardRef}
            className="flex-1 relative overflow-auto bg-gradient-to-br from-bg via-surface to-bg"
            style={{
              backgroundImage:
                'radial-gradient(circle at 1px 1px, var(--color-border-light) 1px, transparent 0)',
              backgroundSize: '20px 20px',
            }}
          >
            {filtered.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-text-secondary">
                <span className="material-symbols-outlined text-5xl opacity-30">sticky_note_2</span>
                <p className="mt-3 text-sm">还没有便签,点击上方色板新增</p>
              </div>
            )}
            {filtered.map((n, idx) => {
              const style = COLOR_STYLE[n.color];
              const isPreview = !!showPreview[n.id];
              const isEditing = editingId === n.id;
              return (
                <div
                  key={n.id}
                  onMouseDown={() => bringToFront(n.id)}
                  style={{
                    left: n.x,
                    top: n.y,
                    width: n.w,
                    minHeight: n.h,
                    zIndex: idx + 1,
                  }}
                  className={`absolute ${style.bg} ${style.border} border rounded-lg shadow-md hover:shadow-xl transition-shadow overflow-hidden flex flex-col`}
                >
                  {/* 头部 (拖动把) */}
                  <div
                    onMouseDown={(e) => startDrag(e, n)}
                    className={`${style.head} px-2 py-1 flex items-center gap-1 cursor-${n.pinned ? 'default' : 'move'} select-none`}
                  >
                    <button
                      onClick={(e) => { e.stopPropagation(); updateNote(n.id, { pinned: !n.pinned }); }}
                      className={`material-symbols-outlined text-sm ${n.pinned ? 'filled' : ''} ${style.pin}`}
                      title={n.pinned ? '取消钉住' : '钉住'}
                    >
                      push_pin
                    </button>
                    <span className={`text-[10px] font-semibold ${style.pin} truncate flex-1`}>
                      {n.tags[0] ? `#${n.tags[0]}` : n.project}
                    </span>
                    <span className={`text-[9px] ${style.pin} opacity-60`}>{n.author}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowPreview(p => ({ ...p, [n.id]: !p[n.id] })); }}
                      className={`material-symbols-outlined text-sm ${style.pin}`}
                      title={isPreview ? '编辑' : '预览'}
                    >
                      {isPreview ? 'edit' : 'visibility'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); cycleColor(n.id); }}
                      className={`material-symbols-outlined text-sm ${style.pin}`}
                      title="切换颜色"
                    >
                      palette
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeNote(n.id); }}
                      className={`material-symbols-outlined text-sm ${style.pin} hover:opacity-100 opacity-60`}
                      title="删除"
                    >
                      close
                    </button>
                  </div>
                  {/* 主体 */}
                  <div className="flex-1 p-2 overflow-auto">
                    {isPreview ? (
                      <div
                        className="text-xs text-text leading-relaxed break-words"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(n.text || '_(空)_') }}
                      />
                    ) : isEditing ? (
                      <textarea
                        autoFocus
                        value={n.text}
                        onChange={(e) => {
                          const parsed = parseTags(e.target.value);
                          updateNote(n.id, { text: e.target.value, tags: parsed.tags });
                        }}
                        onBlur={() => setEditingId(null)}
                        placeholder="写点什么... 支持 Markdown,#标签 #task"
                        className="w-full bg-transparent text-xs text-text outline-none resize-none border-none"
                        style={{ minHeight: n.h - 60 }}
                      />
                    ) : (
                      <div
                        onClick={() => setEditingId(n.id)}
                        className="text-xs text-text leading-relaxed break-words whitespace-pre-wrap min-h-[80px] cursor-text"
                      >
                        {n.text || <span className="text-text-secondary/50">点击编辑...</span>}
                      </div>
                    )}
                  </div>
                  {/* 底部标签 + 时间 */}
                  {(n.tags.length > 0 || n.link) && (
                    <div className="px-2 pb-1 flex items-center gap-1 flex-wrap">
                      {n.tags.map(t => (
                        <span key={t} className={`text-[9px] px-1 rounded ${style.pin} bg-black/10`}>#{t}</span>
                      ))}
                      {n.link && (
                        <span className={`text-[9px] px-1 rounded ${style.pin} bg-black/10 truncate`}>📎 {n.link}</span>
                      )}
                    </div>
                  )}
                  <div className={`px-2 pb-1 text-[9px] ${style.pin} opacity-50`}>
                    {new Date(n.createdAt).toLocaleDateString()}
                    {n.updatedAt > n.createdAt + 1000 && <span> · 已编辑</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          // 列表视图
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {filtered.length === 0 ? (
              <div className="text-center text-text-secondary text-sm py-12">没有便签</div>
            ) : (
              filtered.map(n => {
                const style = COLOR_STYLE[n.color];
                return (
                  <div key={n.id} className={`${style.bg} ${style.border} border rounded-lg p-3 flex items-start gap-3`}>
                    <div className="flex-1 min-w-0">
                      <div className={`text-[10px] ${style.pin} mb-1 flex items-center gap-2`}>
                        <Badge variant="primary">{n.project}</Badge>
                        <span>{n.author}</span>
                        <span>·</span>
                        <span>{new Date(n.createdAt).toLocaleString()}</span>
                        {n.pinned && <span className="material-symbols-outlined text-xs filled">push_pin</span>}
                      </div>
                      <div className="text-xs text-text whitespace-pre-wrap break-words">{n.text || '_(空)_'}</div>
                      {n.tags.length > 0 && (
                        <div className="mt-1 flex gap-1 flex-wrap">
                          {n.tags.map(t => <span key={t} className={`text-[10px] px-1 rounded ${style.pin} bg-black/10`}>#{t}</span>)}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <Tooltip content="切换颜色"><button onClick={() => cycleColor(n.id)} className={`material-symbols-outlined text-base ${style.pin}`}>palette</button></Tooltip>
                      <Tooltip content="钉住/取消"><button onClick={() => updateNote(n.id, { pinned: !n.pinned })} className={`material-symbols-outlined text-base ${style.pin} ${n.pinned ? 'filled' : ''}`}>push_pin</button></Tooltip>
                      <Tooltip content="删除"><button onClick={() => removeNote(n.id)} className={`material-symbols-outlined text-base ${style.pin}`}>delete</button></Tooltip>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* 底栏统计 */}
        <div className="border-t border-border bg-surface-high px-4 py-1.5 flex items-center gap-3 text-[10px] text-text-secondary shrink-0">
          <span>跨项目共享 {new Set(notes.map(n => n.project)).size} 个</span>
          <span>·</span>
          <span>总字数 {notes.reduce((a, n) => a + n.text.length, 0)}</span>
          <span>·</span>
          <span>本周新增 {notes.filter(n => Date.now() - n.createdAt < 7 * 24 * 3600 * 1000).length}</span>
          <span className="ml-auto">拖动头部移动 · Markdown 语法 · #标签 自动识别</span>
        </div>
      </div>
    </div>
  );
}
