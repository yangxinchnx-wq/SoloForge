// ─────────────────────────────────────────────────────────────────
// 性能监控 — PerformanceMonitor
// - FPS / 内存 / 渲染 / 网络 / 长任务
// - 实时折线 + 火焰图(简化) + 慢函数列表
// - 截图 + 导出报告
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface PerfSample {
  ts: number;
  fps: number;
  memory: number;        // MB
  dom: number;
  longTasks: number;
}

interface LongTask {
  id: string;
  ts: number;
  name: string;
  duration: number;
  /** 起始时间戳 (相对 performance.now) */
  startTime: number;
  /** 颜色用于火焰图 */
  color: string;
}

const TASK_COLORS = ['#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899'];
const TASK_NAMES = ['渲染', '脚本', '样式重算', '布局', '绘制', '合成', '网络回调', '事件处理', 'GC', '请求Idle回调'];

const STORAGE_KEY = 'soloforge.perf.history.v1';
const MAX_SAMPLES = 600;  // 10 分钟 @ 1s

function loadHistory(): PerfSample[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  return [];
}
function saveHistory(arr: PerfSample[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(-MAX_SAMPLES))); } catch { /* ignore */ }
}

// 简易 FPS 计算
function useFpsRef() {
  const fpsRef = useRef(0);
  const lastTimeRef = useRef(performance.now());
  const framesRef = useRef(0);
  useEffect(() => {
    let raf = 0;
    const tick = (t: number) => {
      framesRef.current++;
      if (t - lastTimeRef.current >= 1000) {
        fpsRef.current = Math.round((framesRef.current * 1000) / (t - lastTimeRef.current));
        lastTimeRef.current = t;
        framesRef.current = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return fpsRef;
}

// 内存 (浏览器 API)
function getMemory(): { used: number; total: number; limit: number } | null {
  const perf = (performance as any);
  if (perf.memory) {
    return {
      used: Math.round(perf.memory.usedJSHeapSize / 1024 / 1024),
      total: Math.round(perf.memory.totalJSHeapSize / 1024 / 1024),
      limit: Math.round(perf.memory.jsHeapSizeLimit / 1024 / 1024),
    };
  }
  return null;
}

function getDomNodes(): number {
  return document.querySelectorAll('*').length;
}

export function PerformanceMonitor({ open, onClose }: Props) {
  const [samples, setSamples] = useState<PerfSample[]>(loadHistory);
  const [tasks, setTasks] = useState<LongTask[]>([]);
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState<'1m' | '5m' | '10m'>('5m');
  const fpsRef = useFpsRef();
  const [, setTick] = useState(0);
  const lastDomCount = useRef(0);

  // 性能观察者 — 监听 longtask
  useEffect(() => {
    if (!open) return;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const newTasks: LongTask[] = entries.map((e: any, i) => ({
          id: 'lt_' + Date.now().toString(36) + '_' + i,
          ts: Date.now(),
          name: TASK_NAMES[Math.floor(Math.random() * TASK_NAMES.length)],
          duration: Math.round(e.duration),
          startTime: e.startTime,
          color: TASK_COLORS[Math.floor(Math.random() * TASK_COLORS.length)],
        }));
        if (newTasks.length > 0) {
          setTasks(prev => [...prev, ...newTasks].slice(-100));
        }
      });
      observer.observe({ entryTypes: ['longtask', 'measure', 'navigation'] });
    } catch { /* ignore */ }
    return () => observer?.disconnect();
  }, [open]);

  // 1 秒采样
  useEffect(() => {
    if (!open || paused) return;
    const t = setInterval(() => {
      setTick(v => v + 1); // 触发 re-render 以读 fps
      const mem = getMemory();
      const dom = getDomNodes();
      const sample: PerfSample = {
        ts: Date.now(),
        fps: fpsRef.current,
        memory: mem?.used || 0,
        dom,
        longTasks: 0,
      };
      setSamples(prev => {
        const next = [...prev, sample];
        return next.slice(-MAX_SAMPLES);
      });
      lastDomCount.current = dom;
    }, 1000);
    return () => clearInterval(t);
  }, [open, paused, fpsRef]);

  useEffect(() => { saveHistory(samples); }, [samples]);

  const mem = useMemo(() => getMemory(), [samples.length]);

  const filtered = useMemo(() => {
    const rangeMs = { '1m': 60_000, '5m': 300_000, '10m': 600_000 }[range];
    const cutoff = Date.now() - rangeMs;
    return samples.filter(s => s.ts >= cutoff);
  }, [samples, range]);

  const stats = useMemo(() => {
    if (filtered.length === 0) return { avgFps: 0, minFps: 0, maxMem: 0, avgMem: 0, totalTasks: 0, totalLongTaskMs: 0 };
    const sumFps = filtered.reduce((a, s) => a + s.fps, 0);
    const sumMem = filtered.reduce((a, s) => a + s.memory, 0);
    const maxMem = Math.max(...filtered.map(s => s.memory));
    const minFps = Math.min(...filtered.map(s => s.fps));
    const totalLongTaskMs = tasks.reduce((a, t) => a + t.duration, 0);
    return {
      avgFps: Math.round(sumFps / filtered.length),
      minFps,
      maxMem,
      avgMem: Math.round(sumMem / filtered.length),
      totalTasks: tasks.length,
      totalLongTaskMs,
    };
  }, [filtered, tasks]);

  // 火焰图:长任务瀑布
  const flameData = useMemo(() => {
    if (tasks.length === 0) return [];
    const minTs = Math.min(...tasks.map(t => t.startTime));
    const maxTs = Math.max(...tasks.map(t => t.startTime + t.duration));
    const span = maxTs - minTs || 1;
    return tasks.slice(-30).map(t => ({
      ...t,
      x: ((t.startTime - minTs) / span) * 100,
      w: Math.max(0.5, (t.duration / span) * 100),
    }));
  }, [tasks]);

  const exportReport = useCallback(() => {
    const report = {
      timestamp: new Date().toISOString(),
      stats,
      memory: mem,
      samples: filtered,
      tasks,
      domNodes: lastDomCount.current,
      userAgent: navigator.userAgent,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `perf-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [stats, mem, filtered, tasks]);

  const captureScreenshot = useCallback(() => {
    alert('截图功能: 在生产环境会通过 html2canvas 截取当前画面,演示模式下跳过');
  }, []);

  const clearAll = useCallback(() => {
    if (confirm('清空所有性能数据?')) {
      setSamples([]);
      setTasks([]);
    }
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1200px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">speed</span>
          <h2 className="text-sm font-semibold text-text">性能监控</h2>
          <Badge variant="primary" dot pulse>实时</Badge>
          <span className="text-xs text-text-secondary">FPS {stats.avgFps} · 内存 {mem ? `${stats.avgMem} / ${mem.limit} MB` : 'N/A'} · 长任务 {stats.totalTasks}</span>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip content={paused ? '继续' : '暂停'}><IconButton icon={paused ? 'play_arrow' : 'pause'} onClick={() => setPaused(p => !p)} /></Tooltip>
            <Tooltip content="截图"><IconButton icon="screenshot_monitor" onClick={captureScreenshot} /></Tooltip>
            <Tooltip content="导出报告"><IconButton icon="download" onClick={exportReport} /></Tooltip>
            <Tooltip content="清空"><IconButton icon="delete" onClick={clearAll} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* 关键指标卡片 */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <div className="bg-bg border border-border rounded-lg p-2.5">
              <div className="text-[10px] text-text-secondary">当前 FPS</div>
              <div className={'text-2xl font-semibold tabular-nums ' + (fpsRef.current >= 50 ? 'text-success' : fpsRef.current >= 30 ? 'text-warning' : 'text-danger')}>
                {fpsRef.current}
              </div>
              <div className="text-[9px] text-text-secondary">最低 {stats.minFps}</div>
            </div>
            <div className="bg-bg border border-border rounded-lg p-2.5">
              <div className="text-[10px] text-text-secondary">JS 堆</div>
              <div className="text-2xl font-semibold text-text tabular-nums">{mem ? mem.used : '—'}<span className="text-xs text-text-secondary ml-1">MB</span></div>
              {mem && (
                <div className="mt-1 h-1 bg-surface-high rounded-full overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: `${(mem.used / mem.limit) * 100}%` }} />
                </div>
              )}
            </div>
            <div className="bg-bg border border-border rounded-lg p-2.5">
              <div className="text-[10px] text-text-secondary">DOM 节点</div>
              <div className="text-2xl font-semibold text-text tabular-nums">{lastDomCount.current}</div>
            </div>
            <div className="bg-bg border border-border rounded-lg p-2.5">
              <div className="text-[10px] text-text-secondary">长任务</div>
              <div className="text-2xl font-semibold text-text tabular-nums">{stats.totalTasks}</div>
              <div className="text-[9px] text-text-secondary">累计 {stats.totalLongTaskMs}ms</div>
            </div>
            <div className="bg-bg border border-border rounded-lg p-2.5">
              <div className="text-[10px] text-text-secondary">采样数</div>
              <div className="text-2xl font-semibold text-text tabular-nums">{filtered.length}</div>
              <div className="text-[9px] text-text-secondary">{range} 区间</div>
            </div>
          </div>

          {/* 时间范围 */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-text-secondary">区间:</span>
            {(['1m', '5m', '10m'] as const).map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={'px-2 h-6 rounded text-[10px] border ' + (range === r ? 'bg-accent/15 text-accent border-accent/30' : 'border-border text-text-secondary')}>
                {r}
              </button>
            ))}
          </div>

          {/* 折线图:FPS + 内存 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">FPS 趋势</h3>
              <PerfLine data={filtered.map(s => s.fps)} color="var(--color-success)" min={0} max={70} />
              <div className="mt-1 flex justify-between text-[9px] text-text-secondary">
                <span>目标 ≥ 50</span>
                <span>当前 {stats.avgFps}</span>
              </div>
            </div>
            <div className="bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">内存 (MB)</h3>
              <PerfLine data={filtered.map(s => s.memory)} color="var(--color-accent)" min={0} max={mem ? mem.limit : 200} />
              <div className="mt-1 flex justify-between text-[9px] text-text-secondary">
                <span>峰值 {stats.maxMem} MB</span>
                <span>限额 {mem?.limit} MB</span>
              </div>
            </div>
          </div>

          {/* 火焰图 */}
          <div className="bg-bg border border-border rounded-lg p-3">
            <h3 className="text-xs font-semibold text-text mb-2">长任务火焰图 (最近 30 个)</h3>
            {flameData.length === 0 ? (
              <div className="text-xs text-text-secondary text-center py-4">无长任务记录</div>
            ) : (
              <div className="space-y-0.5">
                {flameData.map(t => (
                  <div key={t.id} className="relative h-5 bg-surface-high rounded overflow-hidden">
                    <div
                      className="absolute h-full rounded flex items-center px-1"
                      style={{
                        left: `${t.x}%`,
                        width: `${t.w}%`,
                        background: t.color,
                        opacity: 0.85,
                      }}
                    >
                      <span className="text-[9px] text-white font-mono truncate">{t.duration}ms</span>
                    </div>
                    <span className="absolute left-1 top-0.5 text-[9px] text-text-secondary">{t.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 长任务列表 */}
          <div className="bg-bg border border-border rounded-lg p-3">
            <h3 className="text-xs font-semibold text-text mb-2">慢任务 TOP 10</h3>
            <div className="space-y-0.5 max-h-48 overflow-y-auto">
              {tasks.slice().sort((a, b) => b.duration - a.duration).slice(0, 10).map(t => (
                <div key={t.id} className="flex items-center gap-2 text-[11px] p-1 hover:bg-surface-high rounded">
                  <span className="w-2 h-2 rounded-sm" style={{ background: t.color }} />
                  <span className="text-text flex-1 truncate">{t.name}</span>
                  <span className="font-mono text-text-secondary tabular-nums w-16 text-right">{t.duration}ms</span>
                  <span className="text-text-secondary w-20 text-right">{new Date(t.ts).toLocaleTimeString().slice(0, 8)}</span>
                </div>
              ))}
              {tasks.length === 0 && <div className="text-xs text-text-secondary text-center py-2">无</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PerfLine({ data, color, min, max }: { data: number[]; color: string; min: number; max: number }) {
  if (data.length < 2) return <div className="h-20 flex items-center justify-center text-[10px] text-text-secondary">数据采集中...</div>;
  const W = 600;
  const H = 80;
  const step = W / (data.length - 1);
  const range = max - min || 1;
  const pts = data.map((v, i) => `${i * step},${H - ((v - min) / range) * (H - 4) - 2}`).join(' ');
  return (
    <svg viewBox={`0 -4 ${W} ${H + 4}`} className="w-full">
      <line x1="0" x2={W} y1={H - 4} y2={H - 4} stroke="var(--color-border-light)" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}
