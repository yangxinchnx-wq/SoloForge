// ─────────────────────────────────────────────────────────────────
// 编码时间线 — CodingTimeline
// - 跨会话/项目的编码活动回顾
// - 时间线/日历/统计三视图
// - 按日聚合:行数/会话数/时长/活动类型
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface DayStat {
  date: string;       // YYYY-MM-DD
  sessions: number;
  totalMinutes: number;
  linesAdded: number;
  linesRemoved: number;
  filesTouched: number;
  languages: Record<string, number>;
  activities: Record<string, number>;  // chat/code/test/review/refactor
  firstActivity: number;  // ts
  lastActivity: number;   // ts
}

const STORAGE_KEY = 'soloforge.coding-timeline.v1';

function loadStats(): DayStat[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  // 生成 60 天模拟数据
  const arr: DayStat[] = [];
  const now = new Date();
  for (let i = 59; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const day = d.toISOString().slice(0, 10);
    const seed = (i * 13 + 7) % 7;
    const active = seed > 1 || Math.random() > 0.3;
    const minutes = active ? Math.floor(20 + Math.random() * 240 + (seed < 3 ? 120 : 0)) : 0;
    const linesAdded = active ? Math.floor(minutes * (1 + Math.random() * 3)) : 0;
    const linesRemoved = active ? Math.floor(linesAdded * (0.2 + Math.random() * 0.3)) : 0;
    const files = active ? Math.floor(1 + Math.random() * 8) : 0;
    const sessions = active ? Math.floor(1 + Math.random() * 4) : 0;
    const langs: Record<string, number> = {};
    if (active) {
      const langsArr = ['TypeScript', 'Python', 'Rust', 'CSS', 'Markdown', 'JSON', 'SQL'];
      const cnt = 1 + Math.floor(Math.random() * 3);
      for (let j = 0; j < cnt; j++) {
        const l = langsArr[Math.floor(Math.random() * langsArr.length)];
        langs[l] = (langs[l] || 0) + Math.floor(1 + Math.random() * 4);
      }
    }
    const activities: Record<string, number> = {};
    if (active) {
      const types = ['chat', 'code', 'test', 'review', 'refactor'];
      types.forEach(t => {
        const v = Math.floor(Math.random() * 12);
        if (v > 0) activities[t] = v;
      });
    }
    arr.push({
      date: day,
      sessions: active ? sessions : 0,
      totalMinutes: minutes,
      linesAdded,
      linesRemoved,
      filesTouched: files,
      languages: langs,
      activities,
      firstActivity: active ? d.getTime() + 9 * 3600_000 : 0,
      lastActivity: active ? d.getTime() + 18 * 3600_000 : 0,
    });
  }
  return arr;
}
function saveStats(arr: DayStat[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); } catch { /* ignore */ }
}

const ACTIVITY_STYLE: Record<string, { icon: string; label: string; color: string }> = {
  chat:     { icon: 'chat',         label: '对话', color: 'bg-blue-500' },
  code:     { icon: 'code',         label: '编码', color: 'bg-emerald-500' },
  test:     { icon: 'science',      label: '测试', color: 'bg-cyan-500' },
  review:   { icon: 'rate_review',  label: '审查', color: 'bg-amber-500' },
  refactor: { icon: 'build',        label: '重构', color: 'bg-violet-500' },
};

const LANG_COLOR: Record<string, string> = {
  TypeScript: '#3178c6', Python: '#3572A5', Rust: '#dea584', CSS: '#563d7c',
  Markdown: '#083fa1', JSON: '#292929', SQL: '#e38c00', JavaScript: '#f1e05a',
};

export function CodingTimeline({ open, onClose }: Props) {
  const [stats, setStats] = useState<DayStat[]>(loadStats);
  const [view, setView] = useState<'timeline' | 'calendar' | 'stats'>('timeline');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => { saveStats(stats); }, [stats]);

  const totals = useMemo(() => {
    const sum = stats.reduce(
      (a, s) => ({
        minutes: a.minutes + s.totalMinutes,
        added: a.added + s.linesAdded,
        removed: a.removed + s.linesRemoved,
        sessions: a.sessions + s.sessions,
        files: a.files + s.filesTouched,
        activeDays: a.activeDays + (s.totalMinutes > 0 ? 1 : 0),
      }),
      { minutes: 0, added: 0, removed: 0, sessions: 0, files: 0, activeDays: 0 }
    );
    const allLangs: Record<string, number> = {};
    stats.forEach(s => Object.entries(s.languages).forEach(([k, v]) => allLangs[k] = (allLangs[k] || 0) + v));
    return { ...sum, languages: allLangs };
  }, [stats]);

  // 语言分布
  const langRanking = useMemo(() => {
    return Object.entries(totals.languages).sort((a, b) => b[1] - a[1]);
  }, [totals]);

  const exportCsv = useCallback(() => {
    const lines = ['date,sessions,minutes,lines_added,lines_removed,files,top_lang'];
    stats.forEach(s => {
      const topLang = Object.entries(s.languages).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      lines.push([s.date, s.sessions, s.totalMinutes, s.linesAdded, s.linesRemoved, s.filesTouched, topLang].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `coding-timeline-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [stats]);

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(stats, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `coding-timeline-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [stats]);

  if (!open) return null;

  // 日历视图布局:7 列 (周日-周六) × N 周
  const calendar = useMemo(() => {
    if (stats.length === 0) return { weeks: [] as DayStat[][], monthLabels: [] as { week: number; label: string }[] };
    const last = new Date(stats[stats.length - 1].date);
    const first = new Date(stats[0].date);
    const firstDow = first.getDay();
    const cells: (DayStat | null)[] = [];
    for (let i = 0; i < firstDow; i++) cells.push(null);
    stats.forEach(s => cells.push(s));
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks: DayStat[][] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7) as DayStat[]);
    // 月份标签:每 4 周左右标一个
    const monthLabels: { week: number; label: string }[] = [];
    weeks.forEach((w, i) => {
      if (w[0]) {
        const d = new Date(w[0].date);
        const prev = i > 0 && weeks[i - 1][0] ? new Date(weeks[i - 1][0]!.date) : null;
        if (!prev || d.getMonth() !== prev.getMonth()) {
          monthLabels.push({ week: i, label: `${d.getMonth() + 1}月` });
        }
      }
    });
    return { weeks, monthLabels };
  }, [stats]);

  const maxMin = useMemo(() => Math.max(...stats.map(s => s.totalMinutes), 1), [stats]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1200px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">timeline</span>
          <h2 className="text-sm font-semibold text-text">编码时间线</h2>
          <Badge variant="primary">近 60 天</Badge>
          <span className="text-xs text-text-secondary">
            活跃 {totals.activeDays} 天 · {Math.round(totals.minutes / 60)}h · +{totals.added} -{totals.removed} 行
          </span>
          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
              {(['timeline', 'calendar', 'stats'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  className={'px-2 h-6 rounded text-[10px] transition ' + (view === v ? 'bg-surface-high text-text shadow-sm' : 'text-text-secondary hover:text-text')}>
                  {v === 'timeline' ? '时间线' : v === 'calendar' ? '日历' : '统计'}
                </button>
              ))}
            </div>
            <Tooltip content="导出 CSV"><IconButton icon="table_view" onClick={exportCsv} /></Tooltip>
            <Tooltip content="导出 JSON"><IconButton icon="download" onClick={exportJson} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 overflow-hidden flex">
          {view === 'timeline' ? (
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                <div className="bg-bg border border-border rounded-lg p-2.5">
                  <div className="text-[10px] text-text-secondary">总时长</div>
                  <div className="text-2xl font-semibold text-text tabular-nums">{Math.round(totals.minutes / 60)}<span className="text-xs ml-1">h</span></div>
                </div>
                <div className="bg-bg border border-border rounded-lg p-2.5">
                  <div className="text-[10px] text-text-secondary">净增行</div>
                  <div className="text-2xl font-semibold text-success tabular-nums">+{totals.added - totals.removed}</div>
                </div>
                <div className="bg-bg border border-border rounded-lg p-2.5">
                  <div className="text-[10px] text-text-secondary">会话数</div>
                  <div className="text-2xl font-semibold text-text tabular-nums">{totals.sessions}</div>
                </div>
                <div className="bg-bg border border-border rounded-lg p-2.5">
                  <div className="text-[10px] text-text-secondary">文件数</div>
                  <div className="text-2xl font-semibold text-text tabular-nums">{totals.files}</div>
                </div>
              </div>
              {/* 时间线:横向柱状图 */}
              <div className="bg-bg border border-border rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">每日活跃分钟</h3>
                <div className="space-y-1">
                  {stats.slice().reverse().map(s => {
                    const pct = (s.totalMinutes / maxMin) * 100;
                    return (
                      <div key={s.date} className="flex items-center gap-2 group">
                        <span className="text-[10px] text-text-secondary font-mono w-16 shrink-0">{s.date.slice(5)}</span>
                        <div className="flex-1 h-4 bg-surface-high rounded-sm overflow-hidden relative">
                          <div
                            className="absolute h-full bg-primary rounded-sm"
                            style={{ width: `${pct}%` }}
                          />
                          {s.activities && Object.keys(s.activities).length > 0 && (
                            <div className="absolute inset-0 flex">
                              {Object.entries(s.activities).map(([k, v]) => {
                                const total = Object.values(s.activities).reduce((a, b) => a + b, 0);
                                return (
                                  <div
                                    key={k}
                                    className={ACTIVITY_STYLE[k]?.color || 'bg-text-secondary'}
                                    style={{ width: `${(v / total) * 100}%` }}
                                    title={`${ACTIVITY_STYLE[k]?.label || k}: ${v}`}
                                  />
                                );
                              })}
                            </div>
                          )}
                        </div>
                        <span className="text-[10px] text-text-secondary tabular-nums w-12 text-right">{s.totalMinutes}m</span>
                        <span className="text-[10px] text-success tabular-nums w-14 text-right">+{s.linesAdded}</span>
                        <span className="text-[10px] text-danger tabular-nums w-12 text-right">-{s.linesRemoved}</span>
                        <span className="text-[10px] text-text-secondary tabular-nums w-10 text-right">{s.sessions}会</span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center gap-3 text-[10px] text-text-secondary">
                  {Object.entries(ACTIVITY_STYLE).map(([k, v]) => (
                    <span key={k} className="flex items-center gap-1">
                      <span className={'w-2 h-2 rounded-sm ' + v.color} />{v.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : view === 'calendar' ? (
            <div className="flex-1 overflow-y-auto p-4">
              <div className="bg-bg border border-border rounded-lg p-4">
                <div className="flex items-center gap-1 mb-3 text-[10px] text-text-secondary">
                  <span>少</span>
                  {[0, 0.25, 0.5, 0.75, 1].map((p, i) => (
                    <span key={i} className="w-3 h-3 rounded-sm" style={{ background: `color-mix(in srgb, var(--color-primary) ${p * 100}%, var(--color-surface-high))` }} />
                  ))}
                  <span>多</span>
                </div>
                <div className="overflow-x-auto">
                  <div className="inline-block min-w-full">
                    <div className="flex gap-1 mb-1 pl-6">
                      {calendar.monthLabels.map((m, i) => (
                        <span key={i} className="text-[10px] text-text-secondary" style={{ marginLeft: i === 0 ? m.week * 14 : (m.week - calendar.monthLabels[i-1].week) * 14 - 14 }}>{m.label}</span>
                      ))}
                    </div>
                    <div className="flex gap-1">
                      <div className="flex flex-col gap-1 text-[9px] text-text-secondary pr-1 pt-px">
                        {['日', '一', '二', '三', '四', '五', '六'].map(d => <span key={d}>{d}</span>)}
                      </div>
                      <div className="flex gap-1">
                        {calendar.weeks.map((w, wi) => (
                          <div key={wi} className="flex flex-col gap-1">
                            {w.map((d, di) => {
                              if (!d) return <div key={di} className="w-3 h-3" />;
                              const intensity = d.totalMinutes / maxMin;
                              return (
                                <Tooltip key={di} content={`${d.date}: ${d.totalMinutes}m, +${d.linesAdded} -${d.linesRemoved}, ${d.sessions} 会话`}>
                                  <button
                                    onClick={() => setSelectedDate(d.date)}
                                    className="w-3 h-3 rounded-sm hover:ring-2 hover:ring-primary"
                                    style={{ background: `color-mix(in srgb, var(--color-primary) ${intensity * 100}%, var(--color-surface-high))` }}
                                  />
                                </Tooltip>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              {/* 选中日详情 */}
              {selectedDate && (() => {
                const d = stats.find(s => s.date === selectedDate);
                if (!d) return null;
                return (
                  <div className="mt-3 bg-bg border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-text">{d.date} 详情</h3>
                      <IconButton icon="close" onClick={() => setSelectedDate(null)} />
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-[11px]">
                      <div><span className="text-text-secondary">时长:</span> <span className="font-mono">{d.totalMinutes} 分钟</span></div>
                      <div><span className="text-text-secondary">会话:</span> <span className="font-mono">{d.sessions}</span></div>
                      <div><span className="text-text-secondary">文件:</span> <span className="font-mono">{d.filesTouched}</span></div>
                      <div><span className="text-text-secondary">行:</span> <span className="font-mono text-success">+{d.linesAdded}</span> <span className="font-mono text-danger">-{d.linesRemoved}</span></div>
                    </div>
                    {Object.keys(d.languages).length > 0 && (
                      <div className="mt-2">
                        <div className="text-[10px] text-text-secondary mb-1">语言</div>
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(d.languages).map(([k, v]) => (
                            <span key={k} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: LANG_COLOR[k] || '#666', color: 'white' }}>
                              {k} × {v}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {Object.keys(d.activities).length > 0 && (
                      <div className="mt-2">
                        <div className="text-[10px] text-text-secondary mb-1">活动</div>
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(d.activities).map(([k, v]) => (
                            <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-high text-text">
                              {ACTIVITY_STYLE[k]?.icon && <span className="material-symbols-outlined text-xs align-middle mr-0.5">{ACTIVITY_STYLE[k].icon}</span>}
                              {ACTIVITY_STYLE[k]?.label || k}: {v}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          ) : (
            // 统计视图
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <div className="bg-bg border border-border rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">语言分布 (60 天累计)</h3>
                <div className="space-y-1">
                  {langRanking.map(([lang, n]) => {
                    const max = langRanking[0]?.[1] || 1;
                    return (
                      <div key={lang} className="flex items-center gap-2 text-[11px]">
                        <span className="w-3 h-3 rounded-sm" style={{ background: LANG_COLOR[lang] || '#666' }} />
                        <span className="text-text w-24 truncate">{lang}</span>
                        <div className="flex-1 h-3 bg-surface-high rounded-sm overflow-hidden">
                          <div className="h-full rounded-sm" style={{ width: `${(n / max) * 100}%`, background: LANG_COLOR[lang] || '#666' }} />
                        </div>
                        <span className="text-text-secondary tabular-nums w-12 text-right">{n}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="bg-bg border border-border rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">活动类型分布</h3>
                <div className="space-y-1">
                  {Object.entries(ACTIVITY_STYLE).map(([k, v]) => {
                    const total = stats.reduce((a, s) => a + (s.activities[k] || 0), 0);
                    const all = (Object.keys(ACTIVITY_STYLE) as (keyof typeof ACTIVITY_STYLE)[]).reduce(
                      (a, kk) => a + stats.reduce((aa, s) => aa + (s.activities[kk] || 0), 0), 0);
                    const pct = all ? (total / all) * 100 : 0;
                    return (
                      <div key={k} className="flex items-center gap-2 text-[11px]">
                        <span className="material-symbols-outlined text-sm" style={{ color: ACTIVITY_STYLE[k]?.color?.replace('bg-', 'text-') || 'currentColor' }}>{v.icon}</span>
                        <span className="text-text w-16">{v.label}</span>
                        <div className="flex-1 h-3 bg-surface-high rounded-sm overflow-hidden">
                          <div className={'h-full rounded-sm ' + v.color} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-text-secondary tabular-nums w-12 text-right">{total} ({pct.toFixed(0)}%)</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="bg-bg border border-border rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">工作日 vs 周末</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[10px] text-text-secondary">工作日 (周一-周五)</div>
                    <div className="text-xl font-semibold text-text tabular-nums">
                      {Math.round(stats.filter(s => {
                        const dow = new Date(s.date).getDay();
                        return dow >= 1 && dow <= 5;
                      }).reduce((a, s) => a + s.totalMinutes, 0) / 60)}h
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-text-secondary">周末 (周六-周日)</div>
                    <div className="text-xl font-semibold text-text tabular-nums">
                      {Math.round(stats.filter(s => {
                        const dow = new Date(s.date).getDay();
                        return dow === 0 || dow === 6;
                      }).reduce((a, s) => a + s.totalMinutes, 0) / 60)}h
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
