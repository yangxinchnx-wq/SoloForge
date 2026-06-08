// ─────────────────────────────────────────────────────────────────
// 命令历史与收藏 — CommandHistory
// - 记录所有调用的命令 (palette / 快捷键 / slash)
// - 收藏 / 标签 / 搜索 / 统计
// - 一键重放
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  onReplay?: (cmd: CommandEntry) => void;
}

export interface CommandEntry {
  id: string;
  ts: number;
  /** 命令 ID 或动作名称 */
  cmd: string;
  /** 显示标签 */
  label: string;
  /** 来源: palette / hotkey / slash / voice / context */
  source: 'palette' | 'hotkey' | 'slash' | 'voice' | 'context' | 'auto';
  /** 附加参数 (e.g. 搜索词、目标文件) */
  args?: string;
  /** 持续时间 ms */
  duration?: number;
  /** 收藏 */
  favorite?: boolean;
  /** 用户标记的标签 */
  tags?: string[];
  /** 成功/失败 */
  success?: boolean;
}

const STORAGE_KEY = 'soloforge.command-history.v1';
const MAX_ENTRIES = 2000;

function load(): CommandEntry[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  // 注入一些历史
  const now = Date.now();
  return [
    { id: 'h1', ts: now - 3600_000,  cmd: 'palette',    label: '切换主题 — 极简白',       source: 'palette', args: 'theme light', duration: 120,  favorite: true,  tags: ['主题'], success: true },
    { id: 'h2', ts: now - 3300_000,  cmd: 'gitTime',    label: '打开 Git 时光机',          source: 'hotkey',  duration: 80,                   success: true, tags: ['Git'] },
    { id: 'h3', ts: now - 2800_000,  cmd: 'search',     label: '搜索 useState',            source: 'palette', args: 'useState',     duration: 200, favorite: true,  tags: ['搜索'], success: true },
    { id: 'h4', ts: now - 1500_000,  cmd: 'deploy',     label: '打开部署向导',             source: 'hotkey',  duration: 60,                   success: true, tags: ['部署'] },
    { id: 'h5', ts: now - 900_000,   cmd: 'themeGen',   label: 'AI 主题生成器',            source: 'hotkey',  duration: 150,                  success: true, tags: ['主题', 'AI'] },
    { id: 'h6', ts: now - 600_000,   cmd: 'newSession', label: '新建对话',                 source: 'hotkey',  duration: 30,                   success: true, tags: ['会话'] },
    { id: 'h7', ts: now - 300_000,   cmd: 'palette',    label: '跳到 SettingsModal',       source: 'palette', duration: 90,                   success: false, tags: [] },
    { id: 'h8', ts: now - 60_000,    cmd: 'snippets',   label: '打开代码片段',             source: 'hotkey',  duration: 50,                   success: true, tags: ['代码'] },
  ];
}
function save(arr: CommandEntry[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(-MAX_ENTRIES))); } catch { /* ignore */ }
}

const SOURCE_STYLE: Record<CommandEntry['source'], { icon: string; label: string; color: string }> = {
  palette:  { icon: 'search',     label: '面板', color: 'bg-blue-500/15 text-blue-500 border-blue-500/30' },
  hotkey:   { icon: 'keyboard',   label: '快捷键', color: 'bg-violet-500/15 text-violet-500 border-violet-500/30' },
  slash:    { icon: 'tag',        label: 'Slash', color: 'bg-cyan-500/15 text-cyan-500 border-cyan-500/30' },
  voice:    { icon: 'mic',        label: '语音', color: 'bg-pink-500/15 text-pink-500 border-pink-500/30' },
  context:  { icon: 'mouse',      label: '右键', color: 'bg-amber-500/15 text-amber-500 border-amber-500/30' },
  auto:     { icon: 'auto_mode',  label: '自动', color: 'bg-text-secondary/15 text-text-secondary border-text-secondary/30' },
};

export function CommandHistory({ open, onClose, onReplay }: Props) {
  const [history, setHistory] = useState<CommandEntry[]>(load);
  const [view, setView] = useState<'list' | 'stats' | 'graph'>('list');
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<CommandEntry['source'] | 'all' | 'fav'>('all');
  const [timeRange, setTimeRange] = useState<'1h' | '24h' | '7d' | 'all'>('all');

  useEffect(() => { save(history); }, [history]);

  const filtered = useMemo(() => {
    const range = { '1h': 3600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, all: Infinity }[timeRange];
    return history.filter(h => {
      if (h.ts < Date.now() - range) return false;
      if (sourceFilter === 'fav' && !h.favorite) return false;
      if (sourceFilter !== 'all' && sourceFilter !== 'fav' && h.source !== sourceFilter) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return h.label.toLowerCase().includes(q)
        || h.cmd.toLowerCase().includes(q)
        || (h.args || '').toLowerCase().includes(q)
        || (h.tags || []).some(t => t.toLowerCase().includes(q));
    });
  }, [history, search, sourceFilter, timeRange]);

  const stats = useMemo(() => {
    const byCmd = new Map<string, number>();
    const byHour = Array(24).fill(0);
    const byDay = Array(7).fill(0);
    const dayMs = 86_400_000;
    const startOfDay = (ts: number) => Math.floor(ts / dayMs) * dayMs;
    let totalDuration = 0;
    let successCount = 0;
    let favCount = 0;
    history.forEach(h => {
      byCmd.set(h.cmd, (byCmd.get(h.cmd) || 0) + 1);
      byHour[new Date(h.ts).getHours()]++;
      const dayIdx = 6 - Math.floor((Date.now() - startOfDay(h.ts)) / dayMs);
      if (dayIdx >= 0 && dayIdx < 7) byDay[dayIdx]++;
      if (h.duration) totalDuration += h.duration;
      if (h.success !== false) successCount++;
      if (h.favorite) favCount++;
    });
    return {
      total: history.length,
      byCmd: Array.from(byCmd.entries()).sort((a, b) => b[1] - a[1]),
      byHour,
      byDay,
      avgDuration: history.length ? Math.round(totalDuration / history.length) : 0,
      successRate: history.length ? ((successCount / history.length) * 100).toFixed(0) : '0',
      favCount,
    };
  }, [history]);

  const toggleFav = useCallback((id: string) => {
    setHistory(prev => prev.map(h => h.id === id ? { ...h, favorite: !h.favorite } : h));
  }, []);

  const removeOne = useCallback((id: string) => {
    setHistory(prev => prev.filter(h => h.id !== id));
  }, []);

  const replay = useCallback((h: CommandEntry) => {
    onReplay?.(h);
  }, [onReplay]);

  const clearAll = useCallback(() => {
    if (confirm('清空所有命令历史?')) setHistory([]);
  }, []);

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `command-history-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [history]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1100px] max-w-[95vw] h-[82vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">history</span>
          <h2 className="text-sm font-semibold text-text">命令历史与收藏</h2>
          <Badge variant="primary">{history.length} 条</Badge>
          <span className="text-xs text-text-secondary">收藏 {stats.favCount} · 成功率 {stats.successRate}%</span>
          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
              {(['list', 'stats', 'graph'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  className={'px-2 h-6 rounded text-[10px] transition ' + (view === v ? 'bg-surface-high text-text shadow-sm' : 'text-text-secondary hover:text-text')}>
                  {v === 'list' ? '列表' : v === 'stats' ? '统计' : '图谱'}
                </button>
              ))}
            </div>
            <Tooltip content="导出 JSON"><IconButton icon="download" onClick={exportJson} /></Tooltip>
            <Tooltip content="清空"><IconButton icon="delete" onClick={clearAll} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        {/* 工具条 */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg shrink-0">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索命令/参数/标签..."
            className="bg-surface border border-border-light rounded px-2 h-7 text-xs text-text w-56 focus:border-accent outline-none"
          />
          <div className="flex items-center gap-0.5 p-0.5 bg-surface rounded-md border border-border-light">
            {(['all', '1h', '24h', '7d'] as const).map(r => (
              <button key={r} onClick={() => setTimeRange(r)}
                className={'px-2 h-6 rounded text-[10px] transition ' + (timeRange === r ? 'bg-surface-high text-text shadow-sm' : 'text-text-secondary hover:text-text')}>
                {r === 'all' ? '全部' : r}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 p-0.5 bg-surface rounded-md border border-border-light">
            {(['all', 'fav', 'palette', 'hotkey', 'slash', 'voice', 'context'] as const).map(s => (
              <button key={s} onClick={() => setSourceFilter(s)}
                className={'px-2 h-6 rounded text-[10px] transition ' + (sourceFilter === s ? 'bg-surface-high text-text shadow-sm' : 'text-text-secondary hover:text-text')}>
                {s === 'all' ? '全部源' : s === 'fav' ? '★ 收藏' : SOURCE_STYLE[s].label}
              </button>
            ))}
          </div>
        </div>

        {/* 主体 */}
        {view === 'list' ? (
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {filtered.length === 0 ? (
              <div className="text-center text-xs text-text-secondary py-12">无匹配历史</div>
            ) : (
              filtered.slice().reverse().map(h => {
                const s = SOURCE_STYLE[h.source];
                return (
                  <div key={h.id} className="flex items-center gap-2 p-2 hover:bg-surface-high rounded transition group">
                    <span className="text-[10px] text-text-secondary font-mono w-14 shrink-0">
                      {new Date(h.ts).toLocaleTimeString().slice(0, 8)}
                    </span>
                    <span className="text-[10px] text-text-secondary font-mono w-12 shrink-0">
                      {new Date(h.ts).toLocaleDateString().slice(5)}
                    </span>
                    <span className={'px-1.5 h-5 inline-flex items-center text-[9px] rounded border ' + s.color}>
                      <span className="material-symbols-outlined text-xs mr-0.5">{s.icon}</span>
                      {s.label}
                    </span>
                    <span className="text-xs text-text flex-1 truncate">{h.label}</span>
                    {h.args && <code className="text-[10px] font-mono text-text-secondary bg-bg px-1.5 rounded truncate max-w-[160px]">{h.args}</code>}
                    {h.duration != null && <span className="text-[9px] text-text-secondary tabular-nums">{h.duration}ms</span>}
                    {h.success === false && <span className="material-symbols-outlined text-xs text-danger">error</span>}
                    {h.favorite && <span className="material-symbols-outlined text-xs filled text-yellow-500">star</span>}
                    <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition">
                      <Tooltip content="收藏"><IconButton size="xs" icon={h.favorite ? 'star' : 'star_border'} onClick={() => toggleFav(h.id)} /></Tooltip>
                      <Tooltip content="重放"><IconButton size="xs" icon="replay" onClick={() => replay(h)} /></Tooltip>
                      <Tooltip content="删除"><IconButton size="xs" icon="close" onClick={() => removeOne(h.id)} /></Tooltip>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : view === 'stats' ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* 统计卡片 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div className="bg-bg border border-border rounded-lg p-2.5">
                <div className="text-[10px] text-text-secondary">总命令数</div>
                <div className="text-2xl font-semibold text-text tabular-nums">{stats.total}</div>
              </div>
              <div className="bg-bg border border-border rounded-lg p-2.5">
                <div className="text-[10px] text-text-secondary">平均耗时</div>
                <div className="text-2xl font-semibold text-text tabular-nums">{stats.avgDuration}<span className="text-xs text-text-secondary ml-1">ms</span></div>
              </div>
              <div className="bg-bg border border-border rounded-lg p-2.5">
                <div className="text-[10px] text-text-secondary">成功率</div>
                <div className="text-2xl font-semibold text-success tabular-nums">{stats.successRate}<span className="text-xs ml-1">%</span></div>
              </div>
              <div className="bg-bg border border-border rounded-lg p-2.5">
                <div className="text-[10px] text-text-secondary">收藏数</div>
                <div className="text-2xl font-semibold text-yellow-500 tabular-nums">{stats.favCount}</div>
              </div>
            </div>

            {/* 命令排行 */}
            <div className="bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">命令排行 TOP 15</h3>
              <div className="space-y-0.5">
                {stats.byCmd.slice(0, 15).map(([cmd, n], i) => {
                  const max = stats.byCmd[0]?.[1] || 1;
                  return (
                    <div key={cmd} className="flex items-center gap-2 text-[11px]">
                      <span className="text-text-secondary w-4 text-right tabular-nums">{i + 1}.</span>
                      <span className="font-mono text-text w-32 truncate">{cmd}</span>
                      <div className="flex-1 h-4 bg-surface-high rounded-sm overflow-hidden">
                        <div className="h-full bg-accent" style={{ width: `${(n / max) * 100}%` }} />
                      </div>
                      <span className="text-text-secondary tabular-nums w-10 text-right">{n}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 时段分布 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-bg border border-border rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">24 小时分布</h3>
                <div className="flex items-end gap-0.5 h-24">
                  {stats.byHour.map((v, i) => {
                    const max = Math.max(...stats.byHour, 1);
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group">
                        <div className="text-[9px] text-text-secondary opacity-0 group-hover:opacity-100">{v}</div>
                        <div className="w-full rounded-t bg-primary" style={{ height: `${(v / max) * 100}%`, minHeight: v ? 2 : 0 }} />
                        <div className="text-[9px] text-text-secondary">{i}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="bg-bg border border-border rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">最近 7 天</h3>
                <div className="flex items-end gap-1 h-24">
                  {stats.byDay.map((v, i) => {
                    const max = Math.max(...stats.byDay, 1);
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group">
                        <div className="text-[9px] text-text-secondary opacity-0 group-hover:opacity-100">{v}</div>
                        <div className="w-full rounded-t bg-accent" style={{ height: `${(v / max) * 100}%`, minHeight: v ? 2 : 0 }} />
                        <div className="text-[9px] text-text-secondary">{i + 1}d</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ) : (
          // 图谱视图:命令流转图
          <div className="flex-1 overflow-y-auto p-4">
            <div className="bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-3">命令流转图 (最近 30 条)</h3>
              <div className="flex flex-wrap gap-1 items-center">
                {history.slice(-30).map((h, i) => {
                  const s = SOURCE_STYLE[h.source];
                  return (
                    <div key={h.id} className="flex items-center gap-1">
                      <div className={'px-1.5 py-0.5 rounded text-[9px] border ' + s.color} title={h.label}>
                        {h.cmd}
                      </div>
                      {i < history.slice(-30).length - 1 && <span className="text-text-secondary text-[10px]">→</span>}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mt-3 bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">源分布饼图</h3>
              <div className="grid grid-cols-2 gap-2">
                {(['palette', 'hotkey', 'slash', 'voice', 'context', 'auto'] as const).map(src => {
                  const n = history.filter(h => h.source === src).length;
                  const pct = history.length ? (n / history.length) * 100 : 0;
                  return (
                    <div key={src} className="flex items-center gap-2 text-[11px]">
                      <span className={'px-1.5 h-5 inline-flex items-center text-[9px] rounded border ' + SOURCE_STYLE[src].color}>
                        {SOURCE_STYLE[src].label}
                      </span>
                      <div className="flex-1 h-3 bg-surface-high rounded-sm overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-text-secondary tabular-nums w-12 text-right">{n} ({pct.toFixed(0)}%)</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
