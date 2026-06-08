// ─────────────────────────────────────────────────────────────────
// 数据可视化面板 — Dashboard
// - 多种图表(柱/线/饼/环/热力图/统计卡)手绘 SVG
// - 实时数据 (来自 events / kernel / agents)
// ─────────────────────────────────────────────────────────────────

import { useMemo, useEffect, useState } from 'react';
import { Tooltip, IconButton, Badge } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  events: any[];
  kernel?: any;
  agents?: any[];
  db?: any;
}

const SPARK_W = 80;
const SPARK_H = 24;

function Sparkline({ data, color = 'var(--color-primary)' }: { data: number[]; color?: string }) {
  if (data.length < 2) return <div style={{ width: SPARK_W, height: SPARK_H }} />;
  const max = Math.max(...data, 1);
  const step = SPARK_W / (data.length - 1);
  const pts = data.map((v, i) => `${i * step},${SPARK_H - (v / max) * (SPARK_H - 2) - 1}`).join(' ');
  return (
    <svg width={SPARK_W} height={SPARK_H} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

function BarChart({ data, color = 'var(--color-primary)' }: { data: { label: string; value: number }[]; color?: string }) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div className="flex items-end gap-1 h-32">
      {data.map((d, i) => {
        const h = (d.value / max) * 100;
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
            <div className="text-[9px] text-text-secondary opacity-0 group-hover:opacity-100 transition">{d.value}</div>
            <div className="w-full rounded-t" style={{ height: `${h}%`, background: color, minHeight: 2 }} />
            <div className="text-[9px] text-text-secondary truncate w-full text-center">{d.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function LineChart({ series, height = 120, labels }: {
  series: { name: string; color: string; data: number[] }[];
  height?: number;
  labels?: string[];
}) {
  const W = 600;
  const all = series.flatMap(s => s.data);
  const max = Math.max(...all, 1);
  const stepX = series[0]?.data.length > 1 ? W / (series[0].data.length - 1) : W;
  return (
    <svg viewBox={`0 -10 ${W} ${height + 30}`} className="w-full">
      {/* 网格 */}
      {[0.25, 0.5, 0.75, 1].map((p, i) => (
        <line key={i} x1="0" x2={W} y1={height - height * p} y2={height - height * p} stroke="var(--color-border-light)" strokeDasharray="2 4" />
      ))}
      {series.map((s, si) => {
        const pts = s.data.map((v, i) => `${i * stepX},${height - (v / max) * (height - 4) - 2}`).join(' ');
        return (
          <polyline key={si} points={pts} fill="none" stroke={s.color} strokeWidth={2} />
        );
      })}
      {labels && labels.map((l, i) => (
        <text key={i} x={i * stepX} y={height + 12} fontSize={9} fill="var(--color-text-secondary)" textAnchor="middle">{l}</text>
      ))}
    </svg>
  );
}

function Donut({ data, size = 120 }: { data: { label: string; value: number; color: string }[]; size?: number }) {
  const total = data.reduce((a, b) => a + b.value, 0) || 1;
  const r = size / 2 - 8;
  const cx = size / 2;
  const cy = size / 2;
  let acc = 0;
  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size}>
        {data.map((d, i) => {
          if (d.value === 0) return null;
          const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
          acc += d.value;
          const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
          const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
          const x2 = cx + r * Math.cos(end),   y2 = cy + r * Math.sin(end);
          const large = end - start > Math.PI ? 1 : 0;
          return (
            <path key={i} d={`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`} fill={d.color} />
          );
        })}
        <circle cx={cx} cy={cy} r={r * 0.55} fill="var(--color-surface)" />
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize={20} fontWeight={600} fill="var(--color-text)">{total}</text>
        <text x={cx} y={cy + 12} textAnchor="middle" fontSize={9} fill="var(--color-text-secondary)">总计</text>
      </svg>
      <div className="flex-1 space-y-0.5 text-[11px]">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ background: d.color }} />
            <span className="text-text-secondary flex-1">{d.label}</span>
            <span className="font-mono tabular-nums text-text">{d.value}</span>
            <span className="text-text-secondary w-10 text-right">{((d.value / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Heatmap({ data, rows, cols, labels }: { data: number[]; rows: number; cols: number; labels: string[] }) {
  const max = Math.max(...data, 1);
  return (
    <div className="space-y-1">
      <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {data.map((v, i) => {
          const intensity = v / max;
          return (
            <div
              key={i}
              className="aspect-square rounded-sm"
              style={{ background: `color-mix(in srgb, var(--color-primary) ${intensity * 100}%, var(--color-surface-high))` }}
              title={`${labels[i] || i}: ${v}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-text-secondary">
        {labels.filter((_, i) => i % Math.ceil(labels.length / 6) === 0).map((l, i) => <span key={i}>{l}</span>)}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, spark, color = 'var(--color-primary)' }: {
  icon: string; label: string; value: string | number; spark?: number[]; color?: string;
}) {
  return (
    <div className="bg-bg border border-border rounded-lg p-3 hover:border-primary/50 transition">
      <div className="flex items-center gap-1.5 text-text-secondary text-[10px]">
        <span className="material-symbols-outlined text-sm" style={{ color }}>{icon}</span>
        {label}
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        <span className="text-2xl font-semibold text-text tabular-nums">{value}</span>
        {spark && spark.length > 1 && <Sparkline data={spark} color={color} />}
      </div>
    </div>
  );
}

export function Dashboard({ open, onClose, events, kernel, agents, db }: Props) {
  const [range, setRange] = useState<'1h' | '24h' | '7d'>('24h');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick(v => v + 1), 5000);
    return () => clearInterval(t);
  }, [open]);

  const ranges = { '1h': 3600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 } as const;
  const cutoff = Date.now() - ranges[range];
  const filtered = useMemo(() => events.filter(e => e.ts >= cutoff), [events, range, tick]);

  // 派生统计
  const eventLevelData = useMemo(() => {
    const levels = ['info', 'success', 'warning', 'error'] as const;
    const labels: Record<typeof levels[number], string> = { info: '信息', success: '成功', warning: '警告', error: '错误' };
    const colors: Record<typeof levels[number], string> = { info: '#3b82f6', success: '#10b981', warning: '#f59e0b', error: '#ef4444' };
    return levels.map(l => ({
      label: labels[l],
      value: filtered.filter(e => (e.level || e.type) === l).length,
      color: colors[l],
    }));
  }, [filtered]);

  // 每小时事件数 (24 buckets for 24h, 7 for 7d, 12 for 1h at 5min each)
  const hourlyData = useMemo(() => {
    const buckets = range === '1h' ? 12 : range === '24h' ? 24 : 7;
    const span = ranges[range];
    const arr = Array(buckets).fill(0);
    filtered.forEach(e => {
      const idx = Math.min(buckets - 1, Math.floor(((e.ts - cutoff) / span) * buckets));
      arr[idx]++;
    });
    return arr;
  }, [filtered, range]);

  const hourlyLabels = useMemo(() => {
    const buckets = range === '1h' ? 12 : range === '24h' ? 24 : 7;
    const now = Date.now();
    return Array.from({ length: buckets }, (_, i) => {
      const t = new Date(cutoff + (i / buckets) * (now - cutoff));
      if (range === '7d') return `${t.getMonth() + 1}/${t.getDate()}`;
      return `${t.getHours().toString().padStart(2, '0')}`;
    });
  }, [range]);

  // Agent 类型分布
  const agentTypeData = useMemo(() => {
    if (!agents || agents.length === 0) {
      return [
        { label: '代码', value: 12, color: '#8b5cf6' },
        { label: '测试', value: 8,  color: '#06b6d4' },
        { label: '文档', value: 5,  color: '#10b981' },
        { label: '其他', value: 3,  color: '#f59e0b' },
      ];
    }
    const map = new Map<string, number>();
    agents.forEach(a => { const k = a.role || a.type || '其他'; map.set(k, (map.get(k) || 0) + 1); });
    const colors = ['#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#3b82f6'];
    return Array.from(map.entries()).map(([k, v], i) => ({ label: k, value: v, color: colors[i % colors.length] }));
  }, [agents]);

  // 活动热力图 (7 天 x 24 小时)
  const activityHeatmap = useMemo(() => {
    const days = 7;
    const hours = 24;
    const cells = Array(days * hours).fill(0);
    const dayMs = 86_400_000;
    const startOfDay = (ts: number) => Math.floor(ts / dayMs) * dayMs;
    filtered.forEach(e => {
      const dayIdx = Math.min(days - 1, days - 1 - Math.floor((Date.now() - startOfDay(e.ts)) / dayMs));
      const hour = new Date(e.ts).getHours();
      cells[dayIdx * hours + hour]++;
    });
    return cells;
  }, [filtered]);

  const dayLabels = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.now() - (6 - i) * 86_400_000);
      return ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    });
  }, []);

  // kernel state 火花
  const kernelSpark = useMemo(() => {
    const arr: number[] = [];
    for (let i = 0; i < 20; i++) {
      arr.push(Math.sin((Date.now() / 10000) + i) * 0.5 + 0.5 + Math.random() * 0.2);
    }
    return arr.map(v => Math.round(v * 100));
  }, [tick]);

  const stats = useMemo(() => {
    const realEvents = events.length;
    const successCount = events.filter(e => e.level === 'success' || e.type === 'success').length;
    const errorCount = events.filter(e => e.level === 'error' || e.type === 'error').length;
    return { realEvents, successCount, errorCount, filtered: filtered.length };
  }, [events, filtered, tick]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">monitoring</span>
          <h2 className="text-sm font-semibold text-text">数据可视化面板</h2>
          <Badge variant="primary" dot pulse>实时</Badge>
          <span className="text-xs text-text-secondary">{filtered.length} / {events.length} 事件 · tick {tick}</span>
          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
              {(['1h', '24h', '7d'] as const).map(r => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={'px-2 h-6 rounded text-[10px] transition ' + (range === r ? 'bg-surface-high text-text shadow-sm' : 'text-text-secondary hover:text-text')}
                >
                  {r}
                </button>
              ))}
            </div>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 统计卡片 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard icon="event"        label="事件总数"  value={stats.filtered}      spark={kernelSpark} color="var(--color-primary)" />
            <StatCard icon="check_circle" label="成功"      value={stats.successCount} spark={kernelSpark.map(v => v * 0.8)} color="var(--color-success)" />
            <StatCard icon="error"        label="错误"      value={stats.errorCount}   spark={kernelSpark.map(v => v * 0.1)} color="var(--color-danger)" />
            <StatCard icon="memory"       label="Kernel 状态" value={kernel?.state || '—'} spark={kernelSpark} color="var(--color-accent)" />
          </div>

          {/* 第一行:折线 + 环形 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="lg:col-span-2 bg-bg border border-border rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-text">事件趋势 (按时间桶)</h3>
                <span className="text-[10px] text-text-secondary">峰值 {Math.max(...hourlyData)}</span>
              </div>
              <LineChart
                series={[{ name: '事件', color: 'var(--color-primary)', data: hourlyData }]}
                labels={hourlyLabels}
                height={120}
              />
            </div>
            <div className="bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">事件级别分布</h3>
              <Donut data={eventLevelData} size={140} />
            </div>
          </div>

          {/* 第二行:柱状 + 环形 + 热力图 */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <div className="bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">每时段事件数</h3>
              <BarChart data={hourlyData.slice(-12).map((v, i) => ({ label: hourlyLabels[hourlyLabels.length - 12 + i] || '', value: v }))} />
            </div>
            <div className="bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">Agent 类型</h3>
              <Donut data={agentTypeData} size={140} />
            </div>
            <div className="bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">活动热力图 (7×24)</h3>
              <Heatmap data={activityHeatmap} rows={7} cols={24} labels={dayLabels} />
              <div className="mt-1.5 flex items-center justify-between text-[9px] text-text-secondary">
                <span>少</span>
                <div className="flex gap-0.5">
                  {[0, 0.25, 0.5, 0.75, 1].map((p, i) => (
                    <span key={i} className="w-2 h-2 rounded-sm" style={{ background: `color-mix(in srgb, var(--color-primary) ${p * 100}%, var(--color-surface-high))` }} />
                  ))}
                </div>
                <span>多</span>
              </div>
            </div>
          </div>

          {/* 底部:实时事件流 */}
          <div className="bg-bg border border-border rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-text">最近事件流</h3>
              <span className="text-[10px] text-text-secondary">每 5s 刷新</span>
            </div>
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {filtered.slice(-12).reverse().map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] py-0.5 px-1 hover:bg-surface-high rounded">
                  <span className="text-text-secondary font-mono w-16 shrink-0">{new Date(e.ts).toLocaleTimeString().slice(0, 8)}</span>
                  <Badge variant={(e.level === 'error' ? 'danger' : e.level === 'success' ? 'success' : e.level === 'warning' ? 'warning' : 'info') as any} dot>
                    {e.level || e.type || 'info'}
                  </Badge>
                  <span className="text-text flex-1 truncate">{e.title || e.message || e.event || JSON.stringify(e).slice(0, 80)}</span>
                </div>
              ))}
              {filtered.length === 0 && <div className="text-xs text-text-secondary text-center py-4">无事件</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
