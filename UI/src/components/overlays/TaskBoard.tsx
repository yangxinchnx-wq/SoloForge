// ─────────────────────────────────────────────────────────────────
// 看板任务管理 — TaskBoard (Trello 风格)
// - 多列 + 拖拽卡片
// - 任务优先级/标签/截止日期/负责人
// - 列表视图/日历视图
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Task {
  id: string;
  title: string;
  description: string;
  column: 'todo' | 'doing' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  tags: string[];
  assignee?: string;
  due?: string;
  createdAt: number;
}

const STORE = 'soloforge.task-board.v1';

const COLUMNS: Array<{ id: Task['column']; name: string; color: string; icon: string }> = [
  { id: 'todo',   name: '待办',   color: '#6b7280', icon: 'inbox' },
  { id: 'doing',  name: '进行中', color: '#3b82f6', icon: 'play_arrow' },
  { id: 'review', name: '评审中', color: '#f59e0b', icon: 'rate_review' },
  { id: 'done',   name: '已完成', color: '#10b981', icon: 'check_circle' },
];

const PRIORITY_COLORS = {
  low: 'bg-text-secondary/20 text-text-secondary',
  medium: 'bg-info/20 text-info',
  high: 'bg-warning/20 text-warning',
  urgent: 'bg-danger/20 text-danger',
} as const;

const PRIORITY_LABEL = { low: '低', medium: '中', high: '高', urgent: '紧急' };

const DEFAULT: Task[] = [
  { id: 't1', title: '设计新仪表盘', description: '可视化关键指标', column: 'todo', priority: 'high', tags: ['设计', 'UI'], assignee: 'Alice', due: '2026-06-15', createdAt: Date.now() - 86400000 * 3 },
  { id: 't2', title: '实现 API 限流', description: '基于 token bucket', column: 'todo', priority: 'medium', tags: ['后端'], assignee: 'Bob', createdAt: Date.now() - 86400000 * 2 },
  { id: 't3', title: '修复登录 Bug', description: 'Safari 下 cookie 丢失', column: 'doing', priority: 'urgent', tags: ['Bug', '前端'], assignee: 'Carol', due: '2026-06-08', createdAt: Date.now() - 86400000 },
  { id: 't4', title: '写文档', description: 'API 文档 v2', column: 'doing', priority: 'low', tags: ['文档'], createdAt: Date.now() - 3600000 },
  { id: 't5', title: '代码评审 PR #42', description: '重构 hooks', column: 'review', priority: 'medium', tags: ['Code Review'], assignee: 'Dan', createdAt: Date.now() - 7200000 },
  { id: 't6', title: '部署 v1.2', description: '生产环境', column: 'done', priority: 'high', tags: ['DevOps'], assignee: 'Eve', createdAt: Date.now() - 86400000 * 5 },
  { id: 't7', title: '更新依赖', description: '升级到 v18', column: 'done', priority: 'low', tags: ['维护'], createdAt: Date.now() - 86400000 * 7 },
];

function load(): Task[] { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return DEFAULT; }
function save(d: Task[]) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* */ } }

export function TaskBoard({ open, onClose }: Props) {
  const [tasks, setTasks] = useState<Task[]>(load);
  const [view, setView] = useState<'board' | 'list' | 'calendar'>('board');
  const [filter, setFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => { save(tasks); }, [tasks]);

  const filtered = useMemo(() => tasks.filter(t => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return t.title.toLowerCase().includes(q) || t.tags.some(tg => tg.toLowerCase().includes(q));
  }), [tasks, filter]);

  const addTask = useCallback((column: Task['column']) => {
    const id = 't_' + Date.now().toString(36);
    setTasks(prev => [...prev, {
      id, title: '新任务', description: '', column, priority: 'medium', tags: [], createdAt: Date.now(),
    }]);
    setEditingId(id);
  }, []);

  const updateTask = useCallback((id: string, patch: Partial<Task>) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  }, []);

  const delTask = useCallback((id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id));
    if (editingId === id) setEditingId(null);
  }, [editingId]);

  const moveTask = useCallback((id: string, column: Task['column']) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, column } : t));
    setDraggingId(null);
  }, []);

  const onDrop = useCallback((column: Task['column'], e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('task-id') || draggingId;
    if (id) moveTask(id, column);
  }, [draggingId, moveTask]);

  const editing = useMemo(() => tasks.find(t => t.id === editingId) || null, [tasks, editingId]);

  if (!open) return null;

  const stats = COLUMNS.map(c => ({ ...c, count: filtered.filter(t => t.column === c.id).length }));

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">view_kanban</span>
          <h2 className="text-sm font-semibold text-text">任务看板</h2>
          <Badge variant="primary">{tasks.length} 任务</Badge>
          <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
            {(['board', 'list', 'calendar'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} className={'px-2 h-6 rounded text-[10px] ' + (view === v ? 'bg-surface-high text-text' : 'text-text-secondary hover:text-text')}>
                {v === 'board' ? '看板' : v === 'list' ? '列表' : '日历'}
              </button>
            ))}
          </div>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="搜索..."
            className="bg-surface border border-border-light rounded px-2 h-7 text-xs text-text ml-auto w-48" />
          <IconButton icon="close" onClick={onClose} />
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-auto p-3">
            {view === 'board' && (
              <div className="grid grid-cols-4 gap-3 h-full">
                {COLUMNS.map(c => (
                  <div key={c.id} className="bg-bg rounded-lg border border-border flex flex-col"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => onDrop(c.id, e)}>
                    <div className="px-3 py-2 border-b border-border flex items-center gap-1.5 shrink-0" style={{ borderTopColor: c.color, borderTopWidth: 2 }}>
                      <span className="material-symbols-outlined text-sm" style={{ color: c.color }}>{c.icon}</span>
                      <h3 className="text-xs font-semibold text-text">{c.name}</h3>
                      <Badge variant="default">{stats.find(s => s.id === c.id)?.count || 0}</Badge>
                      <IconButton icon="add" size="xs" className="ml-auto" onClick={() => addTask(c.id)} />
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-2">
                      {filtered.filter(t => t.column === c.id).map(t => (
                        <div key={t.id}
                          draggable
                          onDragStart={(e) => { e.dataTransfer.setData('task-id', t.id); setDraggingId(t.id); }}
                          onDragEnd={() => setDraggingId(null)}
                          onClick={() => setEditingId(t.id)}
                          className={'bg-surface rounded-md border border-border-light p-2 cursor-pointer hover:shadow-md transition ' + (draggingId === t.id ? 'opacity-40' : '')}>
                          {t.tags.length > 0 && (
                            <div className="flex gap-1 mb-1 flex-wrap">
                              {t.tags.map(tg => <span key={tg} className="text-[9px] px-1.5 py-0.5 rounded bg-accent/15 text-accent">{tg}</span>)}
                            </div>
                          )}
                          <h4 className="text-xs font-medium text-text mb-1 line-clamp-2">{t.title}</h4>
                          <div className="flex items-center gap-1 text-[10px] text-text-secondary">
                            <span className={'px-1.5 py-0.5 rounded ' + PRIORITY_COLORS[t.priority]}>{PRIORITY_LABEL[t.priority]}</span>
                            {t.due && <span className="material-symbols-outlined text-[10px]">schedule</span>}
                            {t.due && <span>{t.due}</span>}
                            {t.assignee && <span className="ml-auto px-1.5 rounded bg-primary text-on-primary">{t.assignee[0]}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {view === 'list' && (
              <div className="bg-bg rounded-lg border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-surface-high text-text-secondary text-[10px]">
                    <tr>
                      <th className="text-left px-3 py-2">标题</th>
                      <th className="text-left px-3 py-2 w-20">状态</th>
                      <th className="text-left px-3 py-2 w-16">优先级</th>
                      <th className="text-left px-3 py-2 w-24">负责人</th>
                      <th className="text-left px-3 py-2 w-24">截止</th>
                      <th className="text-left px-3 py-2 w-20">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(t => (
                      <tr key={t.id} className="border-t border-border hover:bg-surface-high">
                        <td className="px-3 py-2 text-text font-medium">{t.title}</td>
                        <td className="px-3 py-2"><Badge variant="default">{COLUMNS.find(c => c.id === t.column)?.name}</Badge></td>
                        <td className="px-3 py-2"><span className={'px-1.5 py-0.5 rounded ' + PRIORITY_COLORS[t.priority]}>{PRIORITY_LABEL[t.priority]}</span></td>
                        <td className="px-3 py-2 text-text-secondary">{t.assignee || '—'}</td>
                        <td className="px-3 py-2 text-text-secondary">{t.due || '—'}</td>
                        <td className="px-3 py-2">
                          <IconButton icon="edit" size="xs" onClick={() => setEditingId(t.id)} />
                          <IconButton icon="delete" size="xs" onClick={() => delTask(t.id)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {view === 'calendar' && (
              <div className="bg-bg rounded-lg border border-border p-3">
                <h3 className="text-xs font-semibold text-text mb-2">未来 30 天</h3>
                <div className="grid grid-cols-7 gap-1 text-[10px]">
                  {Array.from({ length: 30 }, (_, i) => {
                    const d = new Date(Date.now() + i * 86400000);
                    const dayTasks = filtered.filter(t => t.due === d.toISOString().split('T')[0]);
                    return (
                      <div key={i} className="bg-surface rounded p-1.5 min-h-20 border border-border-light">
                        <div className="text-text-secondary font-mono text-[9px]">{d.getMonth() + 1}/{d.getDate()}</div>
                        {dayTasks.map(t => <div key={t.id} className="text-[9px] bg-accent/15 text-accent rounded px-1 mt-0.5 truncate">{t.title}</div>)}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {editing && (
            <div className="w-80 border-l border-border bg-bg p-3 overflow-y-auto">
              <h3 className="text-xs font-semibold text-text mb-2">任务详情</h3>
              <input value={editing.title} onChange={(e) => updateTask(editing.id, { title: e.target.value })}
                className="w-full bg-surface border border-border-light rounded px-2 h-8 text-sm text-text font-medium mb-2" />
              <textarea value={editing.description} onChange={(e) => updateTask(editing.id, { description: e.target.value })} placeholder="描述"
                className="w-full bg-surface border border-border-light rounded p-2 text-xs text-text h-20 mb-2" />
              <div className="space-y-2 text-xs">
                <div>
                  <label className="text-[10px] text-text-secondary">状态</label>
                  <Select
                    value={editing.column}
                    options={COLUMNS.map(c => ({ value: c.id, label: c.name }))}
                    onChange={(v) => updateTask(editing.id, { column: v as Task['column'] })}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-text-secondary">优先级</label>
                  <Select
                    value={editing.priority}
                    options={(['low', 'medium', 'high', 'urgent'] as const).map(p => ({ value: p, label: PRIORITY_LABEL[p] }))}
                    onChange={(v) => updateTask(editing.id, { priority: v as Task['priority'] })}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-text-secondary">负责人</label>
                  <input value={editing.assignee || ''} onChange={(e) => updateTask(editing.id, { assignee: e.target.value })} placeholder="姓名"
                    className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-text-secondary">截止日期</label>
                  <input type="date" value={editing.due || ''} onChange={(e) => updateTask(editing.id, { due: e.target.value })}
                    className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-text-secondary">标签 (逗号分隔)</label>
                  <input value={editing.tags.join(', ')} onChange={(e) => updateTask(editing.id, { tags: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                    className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs" />
                </div>
              </div>
              <Button size="sm" variant="danger" icon="delete" block onClick={() => delTask(editing.id)} className="mt-3">删除</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
