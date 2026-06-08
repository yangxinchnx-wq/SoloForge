// ─────────────────────────────────────────────────────────────────
// 书签 / 收藏夹管理 — BookmarkManager
// - 分组 / 标签 / 搜索
// - 导入/导出 (HTML/JSON)
// - 快速访问最近
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Bookmark {
  id: string;
  url: string;
  title: string;
  description?: string;
  favicon?: string;
  group: string;
  tags: string[];
  addedAt: number;
  visitCount: number;
  lastVisit?: number;
  pinned: boolean;
}

interface Group {
  id: string;
  name: string;
  icon: string;
  color: string;
  collapsed: boolean;
}

const STORE = 'soloforge.bookmarks.v1';

const SEED_GROUPS: Group[] = [
  { id: 'dev',     name: '开发',     icon: 'code',       color: '#3b82f6', collapsed: false },
  { id: 'docs',    name: '文档',     icon: 'menu_book',  color: '#10b981', collapsed: false },
  { id: 'tools',   name: '工具',     icon: 'build',      color: '#f59e0b', collapsed: false },
  { id: 'ai',      name: 'AI/ML',    icon: 'smart_toy',  color: '#8b5cf6', collapsed: false },
  { id: 'design',  name: '设计',     icon: 'palette',    color: '#ec4899', collapsed: false },
];

const SEED_BOOKMARKS: Bookmark[] = [
  { id: 'b1', url: 'https://github.com', title: 'GitHub', group: 'dev', tags: ['代码', '协作'], addedAt: Date.now() - 86400000 * 30, visitCount: 124, lastVisit: Date.now() - 3600000, pinned: true, favicon: '🔗' },
  { id: 'b2', url: 'https://stackoverflow.com', title: 'Stack Overflow', group: 'dev', tags: ['问答'], addedAt: Date.now() - 86400000 * 20, visitCount: 56, pinned: false, favicon: '🟠' },
  { id: 'b3', url: 'https://developer.mozilla.org', title: 'MDN Web Docs', group: 'docs', tags: ['文档', 'Web'], addedAt: Date.now() - 86400000 * 15, visitCount: 89, lastVisit: Date.now() - 7200000, pinned: true, favicon: '📘' },
  { id: 'b4', url: 'https://react.dev', title: 'React', group: 'docs', tags: ['框架', '前端'], addedAt: Date.now() - 86400000 * 10, visitCount: 45, pinned: false, favicon: '⚛️' },
  { id: 'b5', url: 'https://surrealdb.com', title: 'SurrealDB', group: 'dev', tags: ['数据库'], addedAt: Date.now() - 86400000 * 5, visitCount: 12, pinned: false, favicon: '🌀' },
  { id: 'b6', url: 'https://chat.openai.com', title: 'ChatGPT', group: 'ai', tags: ['AI', '对话'], addedAt: Date.now() - 86400000 * 7, visitCount: 234, lastVisit: Date.now() - 1800000, pinned: true, favicon: '🤖' },
  { id: 'b7', url: 'https://huggingface.co', title: 'Hugging Face', group: 'ai', tags: ['AI', '模型'], addedAt: Date.now() - 86400000 * 3, visitCount: 23, pinned: false, favicon: '🤗' },
  { id: 'b8', url: 'https://figma.com', title: 'Figma', group: 'design', tags: ['设计', 'UI'], addedAt: Date.now() - 86400000 * 14, visitCount: 67, lastVisit: Date.now() - 86400000, pinned: false, favicon: '🎨' },
];

function load(): { bookmarks: Bookmark[]; groups: Group[] } {
  try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ }
  return { bookmarks: SEED_BOOKMARKS, groups: SEED_GROUPS };
}
function save(d: { bookmarks: Bookmark[]; groups: Group[] }) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* */ } }

function exportHtml(arr: Bookmark[]): string {
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks Menu</H1>
<DL><p>
${arr.map(b => `  <DT><A HREF="${b.url}">${b.title}</A>`).join('\n')}
</DL><p>`;
}

export function BookmarkManager({ open, onClose }: Props) {
  const [data, setData] = useState(load);
  const [search, setSearch] = useState('');
  const [activeGroup, setActiveGroup] = useState<string | 'all' | 'pinned' | 'recent'>('all');
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => { save(data); }, [data]);

  const filtered = useMemo(() => {
    let r = data.bookmarks;
    if (activeGroup === 'pinned') r = r.filter(b => b.pinned);
    else if (activeGroup === 'recent') r = [...r].sort((a, b) => (b.lastVisit || b.addedAt) - (a.lastVisit || a.addedAt)).slice(0, 20);
    else if (activeGroup !== 'all') r = r.filter(b => b.group === activeGroup);
    if (search) {
      const q = search.toLowerCase();
      r = r.filter(b => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q) || b.tags.some(t => t.toLowerCase().includes(q)));
    }
    return r;
  }, [data, search, activeGroup]);

  const editing = useMemo(() => data.bookmarks.find(b => b.id === editingId) || null, [data, editingId]);

  const addBookmark = useCallback(() => {
    const id = 'b_' + Date.now().toString(36);
    setData(prev => ({ ...prev, bookmarks: [{ id, url: 'https://', title: '新书签', group: 'dev', tags: [], addedAt: Date.now(), visitCount: 0, pinned: false, favicon: '🔗' }, ...prev.bookmarks] }));
    setEditingId(id);
  }, []);

  const updateBookmark = useCallback((id: string, patch: Partial<Bookmark>) => {
    setData(prev => ({ ...prev, bookmarks: prev.bookmarks.map(b => b.id === id ? { ...b, ...patch } : b) }));
  }, []);

  const delBookmark = useCallback((id: string) => {
    setData(prev => ({ ...prev, bookmarks: prev.bookmarks.filter(b => b.id !== id) }));
    if (editingId === id) setEditingId(null);
  }, [editingId]);

  const togglePin = useCallback((id: string) => {
    setData(prev => ({ ...prev, bookmarks: prev.bookmarks.map(b => b.id === id ? { ...b, pinned: !b.pinned } : b) }));
  }, []);

  const importJson = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        if (Array.isArray(parsed)) {
          setData(prev => ({ ...prev, bookmarks: [...prev.bookmarks, ...parsed.map((b: any) => ({ ...b, id: b.id || 'b_' + Date.now().toString(36) + Math.random() }))] }));
        }
      } catch { /* */ }
    };
    reader.readAsText(file);
  }, []);

  const visit = useCallback((b: Bookmark) => {
    setData(prev => ({ ...prev, bookmarks: prev.bookmarks.map(x => x.id === b.id ? { ...x, visitCount: x.visitCount + 1, lastVisit: Date.now() } : x) }));
    window.open(b.url, '_blank');
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1200px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">bookmarks</span>
          <h2 className="text-sm font-semibold text-text">书签 / 收藏夹</h2>
          <Badge variant="primary">{data.bookmarks.length} 书签</Badge>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索书签..."
            className="bg-surface border border-border-light rounded px-2 h-7 text-xs w-48 ml-auto" />
          <Button size="sm" icon="add" onClick={addBookmark}>新增</Button>
          <Tooltip content="导入书签"><IconButton icon="upload" onClick={() => {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = '.json,.html';
            inp.onchange = () => { const f = inp.files?.[0]; if (f) importJson(f); };
            inp.click();
          }} /></Tooltip>
          <Tooltip content="导出 HTML"><IconButton icon="download" onClick={() => {
            const blob = new Blob([exportHtml(data.bookmarks)], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = 'bookmarks.html'; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
          }} /></Tooltip>
          <IconButton icon="close" onClick={onClose} />
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-48 border-r border-border bg-bg p-2 space-y-0.5">
            {[
              { id: 'all', name: '全部', icon: 'apps', color: '#6b7280' },
              { id: 'pinned', name: '⭐ 已置顶', icon: 'push_pin', color: '#f59e0b' },
              { id: 'recent', name: '🕐 最近', icon: 'schedule', color: '#3b82f6' },
            ].map(g => (
              <button key={g.id} onClick={() => setActiveGroup(g.id as any)} className={'w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-1.5 ' + (activeGroup === g.id ? 'bg-accent/15 text-accent' : 'hover:bg-surface-high text-text')}>
                <span className="material-symbols-outlined text-sm" style={{ color: g.color }}>{g.icon}</span>
                <span className="flex-1">{g.name}</span>
                <span className="text-[10px] text-text-secondary">{g.id === 'all' ? data.bookmarks.length : g.id === 'pinned' ? data.bookmarks.filter(b => b.pinned).length : 20}</span>
              </button>
            ))}
            <div className="border-t border-border-light my-2" />
            <p className="text-[10px] text-text-secondary px-2 mb-1">分组</p>
            {data.groups.map(g => (
              <button key={g.id} onClick={() => setActiveGroup(g.id)} className={'w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-1.5 ' + (activeGroup === g.id ? 'bg-accent/15 text-accent' : 'hover:bg-surface-high text-text')}>
                <span className="material-symbols-outlined text-sm" style={{ color: g.color }}>{g.icon}</span>
                <span className="flex-1">{g.name}</span>
                <span className="text-[10px] text-text-secondary">{data.bookmarks.filter(b => b.group === g.id).length}</span>
              </button>
            ))}
          </div>

          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-y-auto p-2">
              {filtered.length === 0 ? <p className="p-8 text-center text-xs text-text-secondary">无书签</p> : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {filtered.map(b => (
                    <div key={b.id} onClick={() => setEditingId(b.id)}
                      className={'bg-bg border rounded-lg p-2.5 cursor-pointer hover:shadow-md transition ' + (editingId === b.id ? 'border-accent ring-2 ring-accent/20' : 'border-border')}>
                      <div className="flex items-start gap-2">
                        <span className="text-2xl shrink-0">{b.favicon || '🔗'}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1">
                            <h3 className="text-sm font-semibold text-text truncate flex-1">{b.title}</h3>
                            {b.pinned && <span className="material-symbols-outlined text-xs filled text-yellow-500">push_pin</span>}
                          </div>
                          <div className="text-[10px] text-text-secondary font-mono truncate">{b.url}</div>
                          <div className="flex items-center gap-2 mt-1 text-[10px] text-text-secondary">
                            <span>访问 {b.visitCount}</span>
                            {b.lastVisit && <span>· {new Date(b.lastVisit).toLocaleDateString()}</span>}
                            {b.tags.map(t => <span key={t} className="px-1 rounded bg-accent/15 text-accent">#{t}</span>)}
                          </div>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <IconButton icon="open_in_new" size="xs" tooltip="访问" onClick={(e) => { e.stopPropagation(); visit(b); }} />
                          <IconButton icon={b.pinned ? 'push_pin' : 'push_pin'} size="xs" tooltip="置顶" onClick={(e) => { e.stopPropagation(); togglePin(b.id); }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {editing && (
              <div className="w-72 border-l border-border bg-bg p-3 space-y-2 overflow-y-auto">
                <h3 className="text-xs font-semibold text-text">书签详情</h3>
                <input value={editing.title} onChange={(e) => updateBookmark(editing.id, { title: e.target.value })}
                  className="w-full bg-surface border border-border-light rounded px-2 h-8 text-sm font-medium" />
                <input value={editing.url} onChange={(e) => updateBookmark(editing.id, { url: e.target.value })}
                  className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs font-mono" />
                <input value={editing.favicon || ''} onChange={(e) => updateBookmark(editing.id, { favicon: e.target.value })}
                  placeholder="emoji 图标" className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs" />
                <div>
                  <label className="text-[10px] text-text-secondary">分组</label>
                  <select value={editing.group} onChange={(e) => updateBookmark(editing.id, { group: e.target.value })}
                    className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs">
                    {data.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-text-secondary">标签 (逗号)</label>
                  <input value={editing.tags.join(', ')} onChange={(e) => updateBookmark(editing.id, { tags: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                    className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs" />
                </div>
                <textarea value={editing.description || ''} onChange={(e) => updateBookmark(editing.id, { description: e.target.value })} placeholder="描述"
                  className="w-full bg-surface border border-border-light rounded p-2 text-xs h-16" />
                <div className="text-[10px] text-text-secondary">访问 {editing.visitCount} 次</div>
                <Button size="sm" variant="danger" icon="delete" block onClick={() => delBookmark(editing.id)}>删除</Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
