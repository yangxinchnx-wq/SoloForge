// ─────────────────────────────────────────────────────────────────
// 看板 — KanbanBoard
// - 拖拽式任务管理
// - 泳道/列/卡片
// - WIP 限制
// - 燃尽图
// - 分配人/标签/截止日期
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type Priority = 'urgent' | 'high' | 'medium' | 'low';
type ColumnId = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';

interface Card {
  id: string;
  column: ColumnId;
  title: string;
  description: string;
  priority: Priority;
  assignee: string;
  tags: string[];
  storyPoints: number;
  created: number;
  dueDate?: number;
  epic?: string;
  blockedBy?: string[];
  comments: number;
  attachments: number;
}

const COLUMNS: { id: ColumnId; label: string; wipLimit?: number; color: string }[] = [
  { id: 'backlog',     label: 'Backlog',     color: '#9ca3af' },
  { id: 'todo',        label: 'To Do',       wipLimit: 5,  color: '#6b7280' },
  { id: 'in_progress', label: 'In Progress', wipLimit: 3,  color: '#3b82f6' },
  { id: 'review',      label: 'In Review',   wipLimit: 4,  color: '#a855f7' },
  { id: 'done',        label: 'Done',        color: '#16a34a' },
];

const CARDS: Card[] = [
  { id: 'c1',  column: 'backlog',     title: '实现多语言切换',     description: 'i18n 支持中英文日韩', priority: 'medium',  assignee: 'Alice',  tags: ['frontend', 'i18n'],                storyPoints: 5,  created: Date.now() - 86400000 * 5,  dueDate: Date.now() + 86400000 * 7,  comments: 3, attachments: 0 },
  { id: 'c2',  column: 'backlog',     title: '数据库分片方案',     description: '订单表 > 1 亿行, 评估分片策略', priority: 'high', assignee: 'David',  tags: ['backend', 'db', 'sharding'],     storyPoints: 13, created: Date.now() - 86400000 * 3,  dueDate: Date.now() + 86400000 * 21, comments: 8, attachments: 2 },
  { id: 'c3',  column: 'backlog',     title: '性能基准测试',       description: '建立 P50/P95/P99 监控', priority: 'low',     assignee: 'Bob',    tags: ['performance'],                       storyPoints: 3,  created: Date.now() - 86400000 * 2,  comments: 1, attachments: 0 },
  { id: 'c4',  column: 'todo',        title: 'OAuth2 集成',        description: '接入 GitHub/Google 登录', priority: 'high', assignee: 'Bob',    tags: ['auth', 'oauth'],                     storyPoints: 8,  created: Date.now() - 86400000 * 4,  dueDate: Date.now() + 86400000 * 3,  comments: 12, attachments: 4, epic: '用户认证' },
  { id: 'c5',  column: 'todo',        title: '用户画像 v2',        description: '基于 LLM 重建画像', priority: 'medium',  assignee: 'Carol',  tags: ['ml', 'user-profile'],                storyPoints: 8,  created: Date.now() - 86400000 * 6,  dueDate: Date.now() + 86400000 * 14, comments: 5, attachments: 1, epic: '个性化' },
  { id: 'c6',  column: 'in_progress', title: 'JWT 刷新机制',       description: 'access + refresh token', priority: 'urgent', assignee: 'Alice',  tags: ['auth', 'security'],                  storyPoints: 5,  created: Date.now() - 86400000 * 2,  dueDate: Date.now() + 86400000 * 1,  comments: 7, attachments: 2, epic: '用户认证' },
  { id: 'c7',  column: 'in_progress', title: '推荐系统 v2',        description: 'LLM-based 推荐', priority: 'high',    assignee: 'Bob',    tags: ['ml', 'recommendation'],              storyPoints: 13, created: Date.now() - 86400000 * 7,  dueDate: Date.now() + 86400000 * 5,  comments: 18, attachments: 6, epic: '个性化' },
  { id: 'c8',  column: 'review',      title: 'API 文档',           description: 'OpenAPI 3.0 规范', priority: 'medium', assignee: 'Eve',    tags: ['docs', 'api'],                        storyPoints: 3,  created: Date.now() - 86400000 * 3,  comments: 4, attachments: 1 },
  { id: 'c9',  column: 'review',      title: 'CI/CD 优化',         description: '并行化测试阶段', priority: 'low',    assignee: 'Frank',  tags: ['devops', 'ci'],                      storyPoints: 5,  created: Date.now() - 86400000 * 5,  comments: 2, attachments: 0 },
  { id: 'c10', column: 'done',        title: '登录页 UI',          description: '新设计稿实现', priority: 'medium',  assignee: 'David',  tags: ['frontend', 'ui'],                     storyPoints: 3,  created: Date.now() - 86400000 * 14, comments: 5, attachments: 3, epic: '用户认证' },
  { id: 'c11', column: 'done',        title: '日志聚合',           description: 'ELK stack 部署', priority: 'low',     assignee: 'Frank',  tags: ['devops', 'logging'],                  storyPoints: 5,  created: Date.now() - 86400000 * 21, comments: 3, attachments: 0 },
  { id: 'c12', column: 'done',        title: '单元测试覆盖率',     description: '提升到 80%', priority: 'medium',  assignee: 'Bob',    tags: ['testing', 'quality'],                 storyPoints: 5,  created: Date.now() - 86400000 * 10, comments: 6, attachments: 1 },
];

function priorityVariant(p: Priority): 'danger' | 'warning' | 'info' | 'default' {
  return p === 'urgent' ? 'danger' : p === 'high' ? 'warning' : p === 'medium' ? 'info' : 'default';
}
function priorityLabel(p: Priority): string { return { urgent: '紧急', high: '高', medium: '中', low: '低' }[p]; }

export function KanbanBoard({ open, onClose }: Props) {
  const [tab, setTab] = useState<'board' | 'sprint' | 'epics' | 'burndown'>('board');
  const [cards, setCards] = useState<Card[]>(CARDS);
  const [activeId, setActiveId] = useState<string | null>(null);

  const stats = useMemo(() => {
    const total = cards.length;
    const done = cards.filter(c => c.column === 'done').length;
    const wip = cards.filter(c => c.column === 'in_progress' || c.column === 'review').length;
    const totalPoints = cards.reduce((s, c) => s + c.storyPoints, 0);
    const donePoints = cards.filter(c => c.column === 'done').reduce((s, c) => s + c.storyPoints, 0);
    return { total, done, wip, totalPoints, donePoints };
  }, [cards]);

  if (!open) return null;

  function onDragStart(e: React.DragEvent, id: string) {
    setActiveId(id);
    e.dataTransfer.setData('text/plain', id);
  }
  function onDragOver(e: React.DragEvent) { e.preventDefault(); }
  function onDrop(e: React.DragEvent, col: ColumnId) {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    if (id) setCards(cards.map(c => c.id === id ? { ...c, column: col } : c));
    setActiveId(null);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">view_kanban</span>
          <h2 className="text-sm font-semibold text-text">看板</h2>
          <Badge variant="info">Sprint #42</Badge>
          <Badge variant="info">{stats.total} 卡片</Badge>
          <Badge variant="success">{stats.donePoints}/{stats.totalPoints} 点</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="add" variant="primary">新建卡片</Button>
            <Button size="sm" icon="filter">筛选</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'board',    l: '看板' },
            { k: 'sprint',   l: 'Sprint 详情' },
            { k: 'epics',    l: 'Epic' },
            { k: 'burndown', l: '燃尽图' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3 space-y-3">
          {tab === 'board' && (
            <div className="grid grid-cols-5 gap-2 h-full">
              {COLUMNS.map(col => {
                const colCards = cards.filter(c => c.column === col.id);
                const wipExceeded = col.wipLimit && colCards.length > col.wipLimit;
                return (
                  <div key={col.id} onDragOver={onDragOver} onDrop={(e) => onDrop(e, col.id)}
                    className="bg-bg border border-border-light rounded-lg flex flex-col min-h-0">
                    <div className="px-2 py-1.5 border-b border-border-light flex items-center gap-1 shrink-0">
                      <span className="w-2 h-2 rounded-full" style={{ background: col.color }}></span>
                      <span className="text-[11px] font-semibold text-text">{col.label}</span>
                      <span className={'text-[10px] font-mono ' + (wipExceeded ? 'text-danger' : 'text-text-secondary')}>
                        {colCards.length}{col.wipLimit ? `/${col.wipLimit}` : ''}
                      </span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
                      {colCards.map(card => (
                        <div key={card.id} draggable onDragStart={(e) => onDragStart(e, card.id)}
                          onClick={() => setActiveId(card.id === activeId ? null : card.id)}
                          className={'bg-surface-high rounded p-2 cursor-grab border ' + (activeId === card.id ? 'border-accent' : 'border-border-light')}>
                          <div className="flex items-center gap-1 mb-1">
                            <Badge variant={priorityVariant(card.priority)}>{priorityLabel(card.priority)}</Badge>
                            <span className="text-[10px] text-text-secondary ml-auto font-mono">{card.storyPoints} SP</span>
                          </div>
                          <p className="text-[11px] font-medium text-text leading-tight">{card.title}</p>
                          {card.tags.length > 0 && (
                            <div className="flex flex-wrap gap-0.5 mt-1">
                              {card.tags.slice(0, 2).map(t => <code key={t} className="text-[9px] px-1 bg-bg rounded text-text-secondary">{t}</code>)}
                            </div>
                          )}
                          <div className="flex items-center gap-1 mt-1.5 text-[10px] text-text-secondary">
                            <span className="w-4 h-4 rounded-full bg-accent text-white text-[9px] flex items-center justify-center">{card.assignee[0]}</span>
                            {card.dueDate && <span className="ml-auto">📅</span>}
                            {card.comments > 0 && <span>💬 {card.comments}</span>}
                            {card.attachments > 0 && <span>📎 {card.attachments}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'sprint' && (
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <p className="text-[10px] text-text-secondary">Sprint 进度</p>
                <p className="text-2xl font-bold text-text font-mono mt-1">{Math.round(stats.donePoints / stats.totalPoints * 100)}%</p>
                <p className="text-[10px] text-text-secondary">{stats.donePoints}/{stats.totalPoints} 点</p>
                <div className="h-1.5 bg-surface-high rounded-full overflow-hidden mt-2">
                  <div className="h-full bg-success" style={{ width: `${stats.donePoints / stats.totalPoints * 100}%` }}></div>
                </div>
              </div>
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <p className="text-[10px] text-text-secondary">Sprint 周期</p>
                <p className="text-base font-bold text-text mt-1">2026-06-02 → 2026-06-15</p>
                <p className="text-[10px] text-text-secondary">剩余 5 天</p>
              </div>
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <p className="text-[10px] text-text-secondary">团队速率</p>
                <p className="text-2xl font-bold text-text font-mono mt-1">32</p>
                <p className="text-[10px] text-text-secondary">avg SP/sprint</p>
              </div>
              <div className="col-span-3 bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">团队负载</h3>
                <div className="space-y-1.5">
                  {['Alice', 'Bob', 'Carol', 'David', 'Eve', 'Frank'].map(name => {
                    const myCards = cards.filter(c => c.assignee === name && c.column !== 'done');
                    const myPoints = myCards.reduce((s, c) => s + c.storyPoints, 0);
                    return (
                      <div key={name} className="flex items-center gap-2">
                        <span className="w-4 h-4 rounded-full bg-accent text-white text-[9px] flex items-center justify-center">{name[0]}</span>
                        <span className="text-[11px] text-text w-16">{name}</span>
                        <div className="flex-1 h-3 bg-surface-high rounded-full overflow-hidden">
                          <div className="h-full bg-accent" style={{ width: `${Math.min(myPoints / 13 * 100, 100)}%` }}></div>
                        </div>
                        <span className="text-[10px] text-text-secondary font-mono w-20 text-right">{myCards.length} 任务 · {myPoints} SP</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {tab === 'epics' && (
            <div className="grid grid-cols-2 gap-3">
              {['用户认证', '个性化', '基础设施', '前端重构'].map(epicName => {
                const epicCards = cards.filter(c => c.epic === epicName);
                const doneCards = epicCards.filter(c => c.column === 'done');
                const totalPts = epicCards.reduce((s, c) => s + c.storyPoints, 0);
                const donePts = doneCards.reduce((s, c) => s + c.storyPoints, 0);
                return (
                  <div key={epicName} className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-sm font-semibold text-text mb-2">{epicName}</h3>
                    <div className="flex items-center gap-3 text-[11px] mb-2">
                      <span>{epicCards.length} 任务</span>
                      <span>{donePts}/{totalPts} SP</span>
                    </div>
                    <div className="h-2 bg-surface-high rounded-full overflow-hidden">
                      <div className="h-full bg-accent" style={{ width: `${totalPts ? donePts / totalPts * 100 : 0}%` }}></div>
                    </div>
                    <div className="mt-2 space-y-1">
                      {epicCards.map(c => (
                        <div key={c.id} className="text-[10px] text-text-secondary flex items-center gap-1">
                          <span className={c.column === 'done' ? 'line-through' : ''}>• {c.title}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'burndown' && (
            <div className="bg-bg border border-border-light rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">Sprint 燃尽图</h3>
              <svg viewBox="0 0 600 200" className="w-full bg-surface-high rounded">
                {/* Grid */}
                {Array.from({ length: 6 }, (_, i) => (
                  <line key={`h${i}`} x1="40" y1={i * 35 + 10} x2="580" y2={i * 35 + 10} stroke="rgba(255,255,255,0.05)" />
                ))}
                {/* Axes */}
                <line x1="40" y1="10" x2="40" y2="180" stroke="#6b7280" />
                <line x1="40" y1="180" x2="580" y2="180" stroke="#6b7280" />
                {/* Ideal line */}
                <line x1="40" y1="20" x2="580" y2="180" stroke="#9ca3af" strokeWidth="1" strokeDasharray="4 4" />
                {/* Actual line */}
                <path d="M 40 20 L 110 25 L 180 35 L 250 60 L 320 75 L 390 95 L 460 110 L 530 125" fill="none" stroke="#a855f7" strokeWidth="2" />
                <path d="M 40 20 L 110 25 L 180 35 L 250 60 L 320 75 L 390 95 L 460 110 L 530 125 L 530 180 L 40 180 Z" fill="rgba(168,85,247,0.1)" />
                {/* Labels */}
                <text x="310" y="195" fontSize="10" fill="#9ca3af" textAnchor="middle">Sprint 进度 (天)</text>
                <text x="15" y="100" fontSize="10" fill="#9ca3af" textAnchor="middle" transform="rotate(-90 15 100)">剩余点数</text>
              </svg>
              <div className="grid grid-cols-3 gap-3 mt-3">
                <div className="bg-surface-high rounded p-2 text-center">
                  <p className="text-[10px] text-text-secondary">理想剩余</p>
                  <p className="text-lg font-bold text-text font-mono">22 SP</p>
                </div>
                <div className="bg-surface-high rounded p-2 text-center">
                  <p className="text-[10px] text-text-secondary">实际剩余</p>
                  <p className="text-lg font-bold text-warning font-mono">28 SP</p>
                </div>
                <div className="bg-surface-high rounded p-2 text-center">
                  <p className="text-[10px] text-text-secondary">落后</p>
                  <p className="text-lg font-bold text-danger font-mono">+6 SP</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
