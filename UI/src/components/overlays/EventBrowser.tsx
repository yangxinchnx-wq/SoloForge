// ─────────────────────────────────────────────────────────────────
// 事件浏览器 — EventBrowser
// - 完整事件流过滤 / 搜索 / 关联查看
// - 类别/级别/时间/来源 过滤
// - 事件详情 + JSON 视图
// - 实时跟随新事件
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  events: any[];
}

type Level = 'all' | 'info' | 'success' | 'warning' | 'error' | 'debug';
type Source = 'all' | 'kernel' | 'agent' | 'system' | 'court' | 'governor' | 'scheduler' | 'user';

const LEVEL_STYLE: Record<string, { icon: string; color: string; variant: any }> = {
  info:    { icon: 'info',         color: 'text-accent',  variant: 'info' },
  success: { icon: 'check_circle', color: 'text-success', variant: 'success' },
  warning: { icon: 'warning',      color: 'text-warning', variant: 'warning' },
  error:   { icon: 'error',        color: 'text-danger',  variant: 'danger' },
  debug:   { icon: 'bug_report',   color: 'text-text-secondary', variant: 'default' },
};

const SOURCE_STYLE: Record<string, { icon: string; color: string }> = {
  kernel:    { icon: 'memory',     color: 'text-violet-400' },
  agent:     { icon: 'smart_toy',  color: 'text-emerald-400' },
  system:    { icon: 'settings',   color: 'text-blue-400' },
  court:     { icon: 'gavel',      color: 'text-amber-400' },
  governor:  { icon: 'model_training', color: 'text-pink-400' },
  scheduler: { icon: 'schedule',   color: 'text-cyan-400' },
  user:      { icon: 'person',     color: 'text-text-secondary' },
};

const PRESET_QUERIES = [
  { label: '今日错误',    match: (e: any) => e.level === 'error' && e.ts > Date.now() - 86_400_000 },
  { label: 'Court 投票',  match: (e: any) => e.type?.includes('court') || e.title?.includes('陪审') },
  { label: 'Agent 启动',  match: (e: any) => e.type === 'agent_start' || e.title?.includes('agent') },
  { label: '性能告警',    match: (e: any) => e.type === 'perf' || e.tags?.includes('perf') },
  { label: '长任务',      match: (e: any) => e.duration > 1000 },
  { label: '最近 1 小时', match: (e: any) => e.ts > Date.now() - 3600_000 },
];

export function EventBrowser({ open, onClose, events }: Props) {
  const [view, setView] = useState<'list' | 'grouped' | 'timeline'>('list');
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<Level>('all');
  const [sourceFilter, setSourceFilter] = useState<Source>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [timeRange, setTimeRange] = useState<'1h' | '24h' | '7d' | 'all'>('all');
  const [presetIdx, setPresetIdx] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const range = { '1h': 3600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, all: Infinity }[timeRange];
    const cutoff = Date.now() - range;
    return events.filter(e => {
      if (e.ts < cutoff) return false;
      if (levelFilter !== 'all' && (e.level || 'info') !== levelFilter) return false;
      if (sourceFilter !== 'all' && (e.source || 'system') !== sourceFilter) return false;
      if (presetIdx != null && !PRESET_QUERIES[presetIdx].match(e)) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return JSON.stringify(e).toLowerCase().includes(q);
    });
  }, [events, search, levelFilter, sourceFilter, timeRange, presetIdx]);

  const selected = useMemo(() => filtered.find(e => e.id === selectedId) || filtered[filtered.length - 1] || null, [filtered, selectedId]);

  // 自动跟随
  useEffect(() => {
    if (autoFollow && filtered.length > 0) {
      setSelectedId(filtered[filtered.length - 1].id);
      setTimeout(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
      }, 50);
    }
  }, [filtered.length, autoFollow]);

  const stats = useMemo(() => {
    const byLevel: Record<string, number> = {};
    filtered.forEach(e => {
      const l = e.level || 'info';
      byLevel[l] = (byLevel[l] || 0) + 1;
    });
    return { total: filtered.length, byLevel };
  }, [filtered]);

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `events-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [filtered]);

  const exportNdjson = useCallback(() => {
    const blob = new Blob([filtered.map(e => JSON.stringify(e)).join('\n')], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `events-${new Date().toISOString().slice(0, 10)}.ndjson`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [filtered]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">event_note</span>
          <h2 className="text-sm font-semibold text-text">事件浏览器</h2>
          <Badge variant="primary" dot pulse>实时</Badge>
          <span className="text-xs text-text-secondary">{stats.total} / {events.length} 事件</span>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip content={autoFollow ? '暂停跟随' : '自动跟随'}>
              <IconButton icon={autoFollow ? 'visibility_off' : 'visibility'} onClick={() => setAutoFollow(p => !p)} active={autoFollow} />
            </Tooltip>
            <Tooltip content="导出 JSON"><IconButton icon="code" onClick={exportJson} /></Tooltip>
            <Tooltip content="导出 NDJSON"><IconButton icon="stream" onClick={exportNdjson} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        {/* 工具条 */}
        <div className="px-4 py-2 border-b border-border bg-bg shrink-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="全文搜索事件内容..."
              className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs text-text focus:border-accent outline-none"
            />
            <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value as Level)}
              className="bg-surface border border-border-light rounded px-2 h-7 text-xs text-text">
              <option value="all">全部级别</option>
              <option value="info">信息</option>
              <option value="success">成功</option>
              <option value="warning">警告</option>
              <option value="error">错误</option>
              <option value="debug">调试</option>
            </select>
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as Source)}
              className="bg-surface border border-border-light rounded px-2 h-7 text-xs text-text">
              <option value="all">全部来源</option>
              <option value="kernel">内核</option>
              <option value="agent">代理</option>
              <option value="system">系统</option>
              <option value="court">法庭</option>
              <option value="governor">Governor</option>
              <option value="scheduler">调度器</option>
              <option value="user">用户</option>
            </select>
            <div className="flex items-center gap-0.5 p-0.5 bg-surface rounded-md border border-border-light">
              {(['1h', '24h', '7d', 'all'] as const).map(r => (
                <button key={r} onClick={() => setTimeRange(r)}
                  className={'px-2 h-6 rounded text-[10px] transition ' + (timeRange === r ? 'bg-surface-high text-text shadow-sm' : 'text-text-secondary hover:text-text')}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-secondary">预设:</span>
            {PRESET_QUERIES.map((p, i) => (
              <button
                key={i}
                onClick={() => setPresetIdx(presetIdx === i ? null : i)}
                className={'px-2 h-5 rounded text-[10px] border ' + (presetIdx === i ? 'bg-accent/15 text-accent border-accent/30' : 'border-border text-text-secondary hover:text-text')}
              >
                {p.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2 text-[10px] text-text-secondary">
              <span className="text-accent">{stats.byLevel.info || 0} info</span>
              <span className="text-success">{stats.byLevel.success || 0} success</span>
              <span className="text-warning">{stats.byLevel.warning || 0} warn</span>
              <span className="text-danger">{stats.byLevel.error || 0} error</span>
            </div>
          </div>
        </div>

        {/* 主体 */}
        <div className="flex-1 grid grid-cols-3 gap-0 overflow-hidden">
          <div className="col-span-2 border-r border-border flex flex-col overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light bg-bg flex items-center gap-2">
              <span>事件流 ({filtered.length})</span>
              <div className="ml-auto flex items-center gap-0.5">
                {(['list', 'grouped', 'timeline'] as const).map(v => (
                  <button key={v} onClick={() => setView(v)}
                    className={'px-1.5 h-5 rounded text-[10px] ' + (view === v ? 'bg-surface-high text-text' : 'text-text-secondary')}>
                    {v === 'list' ? '列表' : v === 'grouped' ? '分组' : '时间线'}
                  </button>
                ))}
              </div>
            </div>
            <div ref={listRef} className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="text-center text-text-secondary text-sm py-12">无匹配事件</div>
              ) : view === 'list' ? (
                <div className="divide-y divide-border-light">
                  {filtered.slice().reverse().map((e, i) => {
                    const lvl = LEVEL_STYLE[e.level || 'info'];
                    const src = SOURCE_STYLE[e.source || 'system'];
                    return (
                      <div
                        key={e.id || i}
                        onClick={() => setSelectedId(e.id || String(i))}
                        className={'flex items-start gap-2 p-2 cursor-pointer transition ' + (selectedId === (e.id || String(i)) ? 'bg-accent/10' : 'hover:bg-surface-high')}
                      >
                        <span className="text-[10px] text-text-secondary font-mono w-16 shrink-0 mt-0.5">
                          {new Date(e.ts).toLocaleTimeString().slice(0, 8)}
                        </span>
                        <Badge variant={lvl.variant} dot>
                          <span className="material-symbols-outlined text-[10px] mr-0.5">{lvl.icon}</span>
                          {e.level || 'info'}
                        </Badge>
                        <span className={'material-symbols-outlined text-sm shrink-0 mt-0.5 ' + src.color}>{src.icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-text truncate">{e.title || e.message || e.event || JSON.stringify(e).slice(0, 80)}</div>
                          {e.type && <div className="text-[10px] text-text-secondary font-mono">{e.type}</div>}
                        </div>
                        {e.duration != null && <span className="text-[9px] text-text-secondary tabular-nums shrink-0">{e.duration}ms</span>}
                      </div>
                    );
                  })}
                </div>
              ) : view === 'grouped' ? (
                <div className="p-2 space-y-2">
                  {(Object.entries(
                    filtered.slice().reverse().reduce((acc, e) => {
                      const k = e.type || e.level || 'other';
                      (acc[k] = acc[k] || []).push(e);
                      return acc;
                    }, {} as Record<string, any[]>)
                  ) as [string, any[]][]).map(([type, list]) => (
                    <div key={type} className="bg-bg border border-border rounded-lg overflow-hidden">
                      <div className="px-2 py-1 bg-surface-high flex items-center gap-2">
                        <span className="text-[10px] font-mono text-text">{type}</span>
                        <span className="text-[10px] text-text-secondary">× {list.length}</span>
                      </div>
                      <div className="divide-y divide-border-light">
                        {list.slice(0, 5).map((e, i) => (
                          <div key={i} onClick={() => setSelectedId(e.id || String(i))}
                            className="p-1.5 hover:bg-surface-high cursor-pointer text-[11px] flex items-center gap-2">
                            <span className="text-text-secondary font-mono w-14 shrink-0">{new Date(e.ts).toLocaleTimeString().slice(0, 8)}</span>
                            <span className="text-text truncate flex-1">{e.title || e.message || e.event}</span>
                          </div>
                        ))}
                        {list.length > 5 && <div className="p-1 text-[10px] text-text-secondary text-center">+{list.length - 5} 更多</div>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                // 时间线
                <div className="p-3">
                  {(() => {
                    const minTs = Math.min(...filtered.map(e => e.ts));
                    const maxTs = Math.max(...filtered.map(e => e.ts));
                    const span = maxTs - minTs || 1;
                    return (
                      <div className="relative h-32 bg-bg border border-border rounded">
                        {/* 网格 */}
                        {[0.25, 0.5, 0.75].map(p => (
                          <div key={p} className="absolute left-0 right-0 border-t border-border-light" style={{ top: `${p * 100}%` }} />
                        ))}
                        {filtered.slice(-200).map((e, i) => {
                          const x = ((e.ts - minTs) / span) * 100;
                          const lvl = LEVEL_STYLE[e.level || 'info'];
                          return (
                            <Tooltip key={i} content={`${new Date(e.ts).toLocaleTimeString()} · ${e.level || 'info'} · ${e.title || ''}`}>
                              <div
                                className={'absolute w-1 h-1 rounded-full cursor-pointer ' + (e.level === 'error' ? 'bg-danger' : e.level === 'warning' ? 'bg-warning' : e.level === 'success' ? 'bg-success' : 'bg-accent')}
                                style={{ left: `${x}%`, top: `${30 + (i % 4) * 20}%` }}
                                onClick={() => setSelectedId(e.id || String(i))}
                              />
                            </Tooltip>
                          );
                        })}
                        <div className="absolute bottom-1 left-2 text-[9px] text-text-secondary">{new Date(minTs).toLocaleString()}</div>
                        <div className="absolute bottom-1 right-2 text-[9px] text-text-secondary">{new Date(maxTs).toLocaleString()}</div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>

          {/* 详情 */}
          <div className="flex flex-col overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light bg-bg">事件详情</div>
            {!selected ? (
              <div className="flex-1 flex flex-col items-center justify-center text-text-secondary text-xs p-4">
                <span className="material-symbols-outlined text-4xl opacity-30">event_note</span>
                <p className="mt-2">选择一个事件查看详情</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                <div>
                  <div className="text-[10px] text-text-secondary">标题</div>
                  <div className="text-sm text-text font-medium">{selected.title || selected.message || '(无)'}</div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <div className="text-[10px] text-text-secondary">时间</div>
                    <div className="text-text font-mono">{new Date(selected.ts).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-text-secondary">级别</div>
                    <Badge variant={LEVEL_STYLE[selected.level || 'info'].variant}>{selected.level || 'info'}</Badge>
                  </div>
                  <div>
                    <div className="text-[10px] text-text-secondary">来源</div>
                    <div className="text-text">{selected.source || 'system'}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-text-secondary">类型</div>
                    <div className="text-text font-mono">{selected.type || '—'}</div>
                  </div>
                  {selected.duration != null && (
                    <div>
                      <div className="text-[10px] text-text-secondary">耗时</div>
                      <div className="text-text font-mono">{selected.duration}ms</div>
                    </div>
                  )}
                  {selected.correlationId && (
                    <div>
                      <div className="text-[10px] text-text-secondary">关联 ID</div>
                      <code className="text-accent text-[10px]">{selected.correlationId}</code>
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-[10px] text-text-secondary mb-1">完整 JSON</div>
                  <pre className="bg-bg border border-border rounded p-2 text-[10px] font-mono text-text overflow-auto max-h-64">{JSON.stringify(selected, null, 2)}</pre>
                </div>
                {selected.payload && (
                  <div>
                    <div className="text-[10px] text-text-secondary mb-1">Payload</div>
                    <pre className="bg-bg border border-border rounded p-2 text-[10px] font-mono text-text overflow-auto max-h-32">{JSON.stringify(selected.payload, null, 2)}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
