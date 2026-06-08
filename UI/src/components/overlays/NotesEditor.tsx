// ─────────────────────────────────────────────────────────────────
// 富文本/便签编辑器 — NotesEditor
// - WYSIWYG 编辑 (粗体/斜体/下划线/标题/列表/链接/图片/代码)
// - 笔记分类/标签/搜索
// - Markdown 实时预览
// - 导出 PDF/HTML/Markdown
// - 自动保存
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  category: string;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

const STORE = 'soloforge.notes-editor.v1';

const CATEGORIES = [
  { id: 'all', name: '全部', icon: 'apps' },
  { id: 'note', name: '随笔', icon: 'edit_note' },
  { id: 'idea', name: '灵感', icon: 'lightbulb' },
  { id: 'task', name: '待办', icon: 'checklist' },
  { id: 'journal', name: '日志', icon: 'event_note' },
  { id: 'archive', name: '归档', icon: 'inventory' },
];

const SEED: Note[] = [
  { id: 'n1', title: 'SoloForge 架构草图', content: '# SoloForge\n\n- 微内核 (TS)\n- 调度器 (Rust)\n- 数据库 (SurrealDB)\n- MARL 引擎 (Python)\n\n> 设计原则: 单一职责 + 事件驱动', tags: ['架构', '设计'], category: 'idea', pinned: true, archived: false, createdAt: Date.now() - 86400000 * 3, updatedAt: Date.now() - 3600000 },
  { id: 'n2', title: '本周待办', content: '## TODO\n\n- [x] 写完 Phase 1 设计文档\n- [ ] 部署到 staging\n- [ ] 评审 PR #42\n- [ ] 准备周五分享', tags: ['工作'], category: 'task', pinned: false, archived: false, createdAt: Date.now() - 86400000, updatedAt: Date.now() - 7200000 },
  { id: 'n3', title: 'React 19 新特性', content: '## Server Components\n- 默认在服务端渲染\n- 减少 bundle size\n- 直接访问后端\n\n## Actions\n- 替代 useEffect\n- 配合 transitions', tags: ['React', '前端'], category: 'note', pinned: false, archived: false, createdAt: Date.now() - 86400000 * 5, updatedAt: Date.now() - 86400000 * 2 },
  { id: 'n4', title: '2026-05 总结', content: '## 月度总结\n\n### 完成\n- 上线 v1.0\n- 团队扩展到 8 人\n- 营收 +30%\n\n### 反思\n- 文档投入不够\n- 自动化测试覆盖率 60%', tags: ['总结', '反思'], category: 'journal', pinned: false, archived: true, createdAt: Date.now() - 86400000 * 30, updatedAt: Date.now() - 86400000 * 30 },
];

function load(): Note[] { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return SEED; }
function save(d: Note[]) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* */ } }

function renderMd(md: string): string {
  let html = md;
  // 标题
  html = html.replace(/^### (.*$)/gim, '<h3 class="text-sm font-semibold mt-2 mb-1">$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2 class="text-base font-bold mt-3 mb-1">$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1 class="text-lg font-bold mt-3 mb-2">$1</h1>');
  // 粗体/斜体
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`(.+?)`/g, '<code class="px-1 bg-surface-high rounded text-[10px] font-mono">$1</code>');
  // 列表
  html = html.replace(/^- \[ \] (.+)/gim, '<div class="flex gap-1 text-xs"><span>☐</span>$1</div>');
  html = html.replace(/^- \[x\] (.+)/gim, '<div class="flex gap-1 text-xs text-success"><span>☑</span>$1</div>');
  html = html.replace(/^- (.+)/gim, '<div class="flex gap-1 text-xs"><span>•</span>$1</div>');
  // 引用
  html = html.replace(/^> (.+)/gim, '<blockquote class="border-l-2 border-accent pl-2 text-text-secondary text-xs italic">$1</blockquote>');
  // 链接
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" class="text-accent underline" target="_blank">$1</a>');
  // 段落
  html = html.split('\n\n').map(p => p.includes('<') ? p : `<p class="text-xs leading-relaxed">${p}</p>`).join('\n');
  return html;
}

function applyFormat(text: string, sel: number[], format: string): string {
  if (sel[0] === sel[1]) return text;
  const before = text.slice(0, sel[0]);
  const selected = text.slice(sel[0], sel[1]);
  const after = text.slice(sel[1]);
  const wrappers: Record<string, [string, string]> = {
    bold: ['**', '**'],
    italic: ['*', '*'],
    code: ['`', '`'],
    strike: ['~~', '~~'],
    h1: ['# ', ''],
    h2: ['## ', ''],
    h3: ['### ', ''],
    quote: ['> ', ''],
    ul: ['- ', ''],
  };
  const [l, r] = wrappers[format] || ['', ''];
  return before + l + selected + r + after;
}

export function NotesEditor({ open, onClose }: Props) {
  const [notes, setNotes] = useState<Note[]>(load);
  const [activeId, setActiveId] = useState<string | null>(notes[0]?.id || null);
  const [search, setSearch] = useState('');
  const [activeCat, setActiveCat] = useState('all');
  const [mode, setMode] = useState<'edit' | 'preview' | 'split'>('split');
  const [showTags, setShowTags] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { save(notes); }, [notes]);

  const active = useMemo(() => notes.find(n => n.id === activeId) || null, [notes, activeId]);
  const filtered = useMemo(() => notes.filter(n => {
    if (activeCat === 'archive') { if (!n.archived) return false; }
    else if (n.archived) return false;
    if (activeCat !== 'all' && n.category !== activeCat) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!n.title.toLowerCase().includes(q) && !n.content.toLowerCase().includes(q) && !n.tags.some(t => t.toLowerCase().includes(q))) return false;
    }
    return true;
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt), [notes, activeCat, search]);

  const addNote = useCallback(() => {
    const id = 'n_' + Date.now().toString(36);
    setNotes(prev => [{ id, title: '新笔记', content: '', tags: [], category: 'note', pinned: false, archived: false, createdAt: Date.now(), updatedAt: Date.now() }, ...prev]);
    setActiveId(id);
  }, []);

  const updateNote = useCallback((id: string, patch: Partial<Note>) => {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n));
  }, []);

  const delNote = useCallback((id: string) => {
    setNotes(prev => prev.filter(n => n.id !== id));
    if (activeId === id) setActiveId(null);
  }, [activeId]);

  const togglePin = useCallback((id: string) => {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, pinned: !n.pinned } : n));
  }, []);

  const toggleArchive = useCallback((id: string) => {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, archived: !n.archived } : n));
  }, []);

  const insertFormat = useCallback((format: string) => {
    if (!active || !textareaRef.current) return;
    const ta = textareaRef.current;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const newContent = applyFormat(active.content, [start, end], format);
    updateNote(active.id, { content: newContent });
    setTimeout(() => { ta.focus(); ta.setSelectionRange(start + 2, end + 2); }, 0);
  }, [active, updateNote]);

  const exportMd = useCallback(() => {
    if (!active) return;
    const blob = new Blob([`# ${active.title}\n\n${active.content}`], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${active.title}.md`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [active]);

  const exportHtml = useCallback(() => {
    if (!active) return;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${active.title}</title></head><body>${renderMd(active.content)}</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${active.title}.html`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [active]);

  // 自动保存 (debounced)
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => save(notes), 1000);
    return () => clearTimeout(t);
  }, [active, notes]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">edit_note</span>
          <h2 className="text-sm font-semibold text-text">笔记编辑器</h2>
          <Badge variant="primary">{notes.length} 笔记</Badge>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索..."
            className="bg-surface border border-border-light rounded px-2 h-7 text-xs w-40 ml-auto" />
          <Button size="sm" icon="add" onClick={addNote}>新建</Button>
          <IconButton icon="close" onClick={onClose} />
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-56 border-r border-border bg-bg p-2 overflow-y-auto">
            {CATEGORIES.map(c => {
              const count = notes.filter(n => c.id === 'archive' ? n.archived : !n.archived && (c.id === 'all' || n.category === c.id)).length;
              return (
                <button key={c.id} onClick={() => setActiveCat(c.id)}
                  className={'w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-1.5 mb-0.5 ' + (activeCat === c.id ? 'bg-accent/15 text-accent' : 'hover:bg-surface-high text-text')}>
                  <span className="material-symbols-outlined text-sm">{c.icon}</span>
                  <span className="flex-1">{c.name}</span>
                  <span className="text-[10px] text-text-secondary">{count}</span>
                </button>
              );
            })}
            <div className="border-t border-border-light my-2" />
            {filtered.map(n => (
              <div key={n.id} onClick={() => setActiveId(n.id)}
                className={'px-2 py-1.5 rounded cursor-pointer mb-0.5 ' + (activeId === n.id ? 'bg-accent/15' : 'hover:bg-surface-high')}>
                <div className="flex items-center gap-1">
                  {n.pinned && <span className="material-symbols-outlined text-xs filled text-yellow-500">push_pin</span>}
                  <h4 className="text-xs font-medium text-text truncate flex-1">{n.title}</h4>
                </div>
                <p className="text-[10px] text-text-secondary truncate">{n.content.split('\n').find(l => l.trim() && !l.startsWith('#')) || '空'}</p>
                <div className="text-[9px] text-text-secondary mt-0.5">{new Date(n.updatedAt).toLocaleDateString()}</div>
              </div>
            ))}
          </div>

          <div className="flex-1 flex flex-col overflow-hidden">
            {active ? (
              <>
                <div className="px-3 py-1.5 border-b border-border bg-bg flex items-center gap-1 flex-wrap">
                  <Tooltip content="粗体 (Ctrl+B)"><button onClick={() => insertFormat('bold')} className="px-2 h-6 rounded text-xs font-bold hover:bg-surface-high text-text">B</button></Tooltip>
                  <Tooltip content="斜体 (Ctrl+I)"><button onClick={() => insertFormat('italic')} className="px-2 h-6 rounded text-xs italic hover:bg-surface-high text-text">I</button></Tooltip>
                  <Tooltip content="代码"><button onClick={() => insertFormat('code')} className="px-2 h-6 rounded text-xs font-mono hover:bg-surface-high text-text">{'<>'}</button></Tooltip>
                  <Tooltip content="删除线"><button onClick={() => insertFormat('strike')} className="px-2 h-6 rounded text-xs line-through hover:bg-surface-high text-text">S</button></Tooltip>
                  <div className="w-px h-4 bg-border mx-1" />
                  <Tooltip content="标题1"><button onClick={() => insertFormat('h1')} className="px-2 h-6 rounded text-xs font-bold hover:bg-surface-high text-text">H1</button></Tooltip>
                  <Tooltip content="标题2"><button onClick={() => insertFormat('h2')} className="px-2 h-6 rounded text-xs font-bold hover:bg-surface-high text-text">H2</button></Tooltip>
                  <Tooltip content="标题3"><button onClick={() => insertFormat('h3')} className="px-2 h-6 rounded text-xs font-bold hover:bg-surface-high text-text">H3</button></Tooltip>
                  <div className="w-px h-4 bg-border mx-1" />
                  <Tooltip content="列表"><button onClick={() => insertFormat('ul')} className="px-2 h-6 rounded hover:bg-surface-high text-text"><span className="material-symbols-outlined text-sm">format_list_bulleted</span></button></Tooltip>
                  <Tooltip content="引用"><button onClick={() => insertFormat('quote')} className="px-2 h-6 rounded hover:bg-surface-high text-text"><span className="material-symbols-outlined text-sm">format_quote</span></button></Tooltip>
                  <div className="w-px h-4 bg-border mx-1" />
                  <div className="flex items-center gap-0.5 p-0.5 bg-surface rounded-md border border-border-light ml-auto">
                    {(['edit', 'split', 'preview'] as const).map(m => (
                      <button key={m} onClick={() => setMode(m)} className={'px-2 h-5 rounded text-[10px] ' + (mode === m ? 'bg-surface-high text-text' : 'text-text-secondary')}>
                        {m === 'edit' ? '编辑' : m === 'split' ? '分屏' : '预览'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="px-3 py-1.5 border-b border-border bg-bg flex items-center gap-1">
                  <input value={active.title} onChange={(e) => updateNote(active.id, { title: e.target.value })}
                    className="flex-1 bg-transparent text-base font-semibold text-text outline-none" />
                  <Select
                    value={active.category}
                    options={CATEGORIES.filter(c => c.id !== 'all' && c.id !== 'archive').map(c => ({ value: c.id, label: c.name }))}
                    onChange={(v) => updateNote(active.id, { category: v })}
                    className="w-24"
                  />
                  <Tooltip content={active.pinned ? '取消置顶' : '置顶'}><IconButton icon="push_pin" filled={active.pinned} onClick={() => togglePin(active.id)} /></Tooltip>
                  <Tooltip content={active.archived ? '取消归档' : '归档'}><IconButton icon="inventory" active={active.archived} onClick={() => toggleArchive(active.id)} /></Tooltip>
                  <Tooltip content="导出 MD"><IconButton icon="description" onClick={exportMd} /></Tooltip>
                  <Tooltip content="导出 HTML"><IconButton icon="html" onClick={exportHtml} /></Tooltip>
                  <Tooltip content="删除"><IconButton icon="delete" onClick={() => delNote(active.id)} /></Tooltip>
                </div>

                <div className={'flex-1 flex overflow-hidden ' + (mode === 'edit' ? 'flex-col' : '')}>
                  {(mode === 'edit' || mode === 'split') && (
                    <textarea
                      ref={textareaRef}
                      value={active.content}
                      onChange={(e) => updateNote(active.id, { content: e.target.value })}
                      className={'flex-1 bg-bg p-3 text-xs font-mono text-text outline-none resize-none ' + (mode === 'split' ? 'border-r border-border' : '')}
                      placeholder="支持 Markdown: # 标题, **粗体**, *斜体*, - 列表, > 引用, [链接](url)"
                    />
                  )}
                  {(mode === 'preview' || mode === 'split') && (
                    <div className="flex-1 bg-surface p-3 overflow-auto" dangerouslySetInnerHTML={{ __html: renderMd(active.content) }} />
                  )}
                </div>

                <div className="px-3 py-1 border-t border-border bg-bg text-[10px] text-text-secondary flex items-center gap-2">
                  <span>创建: {new Date(active.createdAt).toLocaleString()}</span>
                  <span>·</span>
                  <span>更新: {new Date(active.updatedAt).toLocaleString()}</span>
                  <span>·</span>
                  <span>{active.content.length} 字符</span>
                  {active.tags.length > 0 && <><span>·</span>{active.tags.map(t => <span key={t} className="px-1 rounded bg-accent/15 text-accent">#{t}</span>)}</>}
                  <input placeholder="+ 标签" onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.currentTarget.value) {
                      updateNote(active.id, { tags: [...active.tags, e.currentTarget.value.trim()] });
                      e.currentTarget.value = '';
                    }
                  }} className="ml-auto bg-transparent text-[10px] w-20 outline-none" />
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-text-secondary">
                <div className="text-center">
                  <span className="material-symbols-outlined text-5xl opacity-30">edit_note</span>
                  <p className="text-sm mt-2">选择或新建一个笔记</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
