// ─────────────────────────────────────────────────────────────────
// 日志流面板 — LogStream
// - 类似 k8s/kubectl logs 实时流
// - 多服务标签 / 时间范围 / 关键字
// - 自动滚动 + 暂停
// - JSON / 文本 解析
// - 颜色规则
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  events: any[];
}

interface LogEntry {
  id: string;
  ts: number;
  service: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  raw: string;
  fields?: Record<string, any>;
}

const STORAGE_KEY = 'soloforge.log-stream.v1';
const STORAGE_RULES = 'soloforge.log-stream.rules.v1';
const MAX_ENTRIES = 5000;

const SERVICE_COLORS: Record<string, string> = {
  kernel: '#8b5cf6', agent: '#10b981', court: '#f59e0b',
  governor: '#ec4899', scheduler: '#06b6d4', system: '#3b82f6',
  db: '#84cc16', api: '#f43f5e', user: '#a78bfa',
};

const LEVEL_STYLE: Record<string, { color: string; bg: string; weight: number }> = {
  debug: { color: 'text-text-secondary', bg: '', weight: 400 },
  info:  { color: 'text-accent',         bg: '', weight: 400 },
  warn:  { color: 'text-warning',        bg: 'bg-warning/5', weight: 500 },
  error: { color: 'text-danger',         bg: 'bg-danger/5', weight: 600 },
  fatal: { color: 'text-white',          bg: 'bg-danger/30', weight: 700 },
};

const COLOR_RULES_DEFAULT = [
  { pattern: 'OOM|fatal|panic', color: '#ef4444', bold: true },
  { pattern: 'error|ERROR|Error', color: '#ef4444', bold: false },
  { pattern: 'warn|WARN|Warning', color: '#f59e0b', bold: false },
  { pattern: 'success|OK|done', color: '#10b981', bold: false },
  { pattern: 'GET|POST|PUT|DELETE', color: '#3b82f6', bold: false },
];

function loadEntries(): LogEntry[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  // 注入示例
  const now = Date.now();
  return Array.from({ length: 50 }, (_, i) => {
    const services = Object.keys(SERVICE_COLORS);
    const levels: LogEntry['level'][] = ['debug', 'info', 'info', 'info', 'warn', 'error'];
    const svc = services[i % services.length];
    const lvl = levels[i % levels.length];
    const messages = [
      'GET /api/agents 200 23ms',
      'POST /api/decision 201 145ms',
      'cache miss for key=agent_state_42',
      'connection refused: 127.0.0.1:6379',
      'decision submitted: id=dec_' + Math.random().toString(36).slice(2, 8),
      'court vote received: juror=alice, weight=0.85',
      'agent spawned: coder-7, prompt="..."',
      'OOM: heap out of memory',
      'panic: runtime error: invalid memory address',
      'token expired, refreshing...',
    ];
    return {
      id: 'l_' + (now - i * 1000) + '_' + i,
      ts: now - i * 1000,
      service: svc,
      level: lvl,
      message: messages[i % messages.length],
      raw: `[${svc}] ${messages[i % messages.length]}`,
    };
  });
}
function saveEntries(arr: LogEntry[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(-MAX_ENTRIES))); } catch { /* ignore */ }
}
function loadRules() {
  try {
    const r = localStorage.getItem(STORAGE_RULES);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  return COLOR_RULES_DEFAULT;
}
function saveRules(arr: typeof COLOR_RULES_DEFAULT) {
  try { localStorage.setItem(STORAGE_RULES, JSON.stringify(arr)); } catch { /* ignore */ }
}

export function LogStream({ open, onClose, events }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>(loadEntries);
  const [filter, setFilter] = useState('');
  const [services, setServices] = useState<string[]>(Object.keys(SERVICE_COLORS));
  const [levels, setLevels] = useState<string[]>(['info', 'warn', 'error', 'fatal']);
  const [timeRange, setTimeRange] = useState<'1m' | '5m' | 'all'>('all');
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showRaw, setShowRaw] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [fontSize, setFontSize] = useState(12);
  const [selected, setSelected] = useState<string | null>(null);
  const [rules, setRules] = useState(loadRules);
  const [view, setView] = useState<'stream' | 'timeline' | 'services'>('stream');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { saveEntries(entries); }, [entries]);
  useEffect(() => { saveRules(rules); }, [rules]);

  // 模拟新日志注入
  useEffect(() => {
    if (!open || paused) return;
    const t = setInterval(() => {
      const svc = Object.keys(SERVICE_COLORS)[Math.floor(Math.random() * Object.keys(SERVICE_COLORS).length)];
      const lvl: LogEntry['level'] = (['debug', 'info', 'info', 'info', 'warn', 'error', 'fatal'] as const)[Math.floor(Math.random() * 7)];
      const messages = [
        `processed request id=req_${Math.random().toString(36).slice(2, 8)}`,
        `cache hit ratio ${(Math.random() * 100).toFixed(0)}%`,
        `query took ${Math.floor(Math.random() * 200)}ms`,
        `agent heart beat: alive=true`,
        `rate limit remaining: ${Math.floor(Math.random() * 1000)}`,
        `connection reset by peer`,
        `disk usage: ${(Math.random() * 100).toFixed(0)}%`,
        `token refresh OK`,
      ];
      const msg = messages[Math.floor(Math.random() * messages.length)];
      setEntries(prev => [...prev, {
        id: 'l_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        ts: Date.now(),
        service: svc,
        level: lvl,
        message: msg,
        raw: `[${svc}] ${msg}`,
      }].slice(-MAX_ENTRIES));
    }, 1200);
    return () => clearInterval(t);
  }, [open, paused]);

  // 自动滚动
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length, autoScroll]);

  // 从后端 events 拉取 (如果有)
  useEffect(() => {
    if (!open || paused) return;
    if (events.length === 0) return;
    const last = entries[entries.length - 1];
    const newOnes = events
      .filter(e => !entries.some(en => en.ts === e.ts))
      .slice(-5)
      .map(e => ({
        id: 'e_' + e.ts,
        ts: e.ts,
        service: e.source || 'system',
        level: (e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'info') as LogEntry['level'],
        message: e.title || e.message || e.event || JSON.stringify(e).slice(0, 80),
        raw: JSON.stringify(e),
      }));
    if (newOnes.length > 0) {
      setEntries(prev => [...prev, ...newOnes].slice(-MAX_ENTRIES));
    }
  }, [events.length, paused, open]);

  const filtered = useMemo(() => {
    const range = { '1m': 60_000, '5m': 300_000, all: Infinity }[timeRange];
    const cutoff = Date.now() - range;
    return entries.filter(e => {
      if (e.ts < cutoff) return false;
      if (!services.includes(e.service)) return false;
      if (!levels.includes(e.level)) return false;
      if (filter && !e.message.toLowerCase().includes(filter.toLowerCase())) return false;
      return true;
    });
  }, [entries, filter, services, levels, timeRange]);

  const stats = useMemo(() => {
    const byLevel: Record<string, number> = {};
    const byService: Record<string, number> = {};
    filtered.forEach(e => {
      byLevel[e.level] = (byLevel[e.level] || 0) + 1;
      byService[e.service] = (byService[e.service] || 0) + 1;
    });
    return { byLevel, byService };
  }, [filtered]);

  const exportLogs = useCallback(() => {
    const text = filtered.map(e => `${new Date(e.ts).toISOString()} [${e.service}] [${e.level.toUpperCase()}] ${e.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [filtered]);

  const applyColorRule = useCallback((text: string): { color: string; bold: boolean } => {
    for (const rule of rules) {
      if (new RegExp(rule.pattern, 'i').test(text)) {
        return { color: rule.color, bold: rule.bold };
      }
    }
    return { color: '', bold: false };
  }, [rules]);

  const toggleService = (svc: string) => {
    setServices(prev => prev.includes(svc) ? prev.filter(s => s !== svc) : [...prev, svc]);
  };
  const toggleLevel = (lvl: string) => {
    setLevels(prev => prev.includes(lvl) ? prev.filter(l => l !== lvl) : [...prev, lvl]);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">terminal</span>
          <h2 className="text-sm font-semibold text-text">日志流</h2>
          <Badge variant="primary" dot pulse={!paused}>{filtered.length} 条{paused && ' (已暂停)'}</Badge>
          <span className="text-xs text-text-secondary">模拟 kubectl logs 体验</span>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip content={paused ? '继续' : '暂停'}><IconButton icon={paused ? 'play_arrow' : 'pause'} onClick={() => setPaused(p => !p)} active={paused} /></Tooltip>
            <Tooltip content={autoScroll ? '停止跟随' : '自动滚动'}><IconButton icon={autoScroll ? 'vertical_align_bottom' : 'pause'} onClick={() => setAutoScroll(p => !p)} active={autoScroll} /></Tooltip>
            <Tooltip content="清空"><IconButton icon="delete" onClick={() => setEntries([])} /></Tooltip>
            <Tooltip content="导出"><IconButton icon="download" onClick={exportLogs} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        {/* 工具条 */}
        <div className="px-4 py-2 border-b border-border bg-bg shrink-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="过滤关键字..."
              className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs text-text font-mono focus:border-accent outline-none"
            />
            <div className="flex items-center gap-0.5 p-0.5 bg-surface rounded-md border border-border-light">
              {(['1m', '5m', 'all'] as const).map(r => (
                <button key={r} onClick={() => setTimeRange(r)}
                  className={'px-2 h-6 rounded text-[10px] ' + (timeRange === r ? 'bg-surface-high text-text' : 'text-text-secondary hover:text-text')}>
                  {r}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-0.5 p-0.5 bg-surface rounded-md border border-border-light">
              {(['stream', 'timeline', 'services'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  className={'px-2 h-6 rounded text-[10px] ' + (view === v ? 'bg-surface-high text-text' : 'text-text-secondary hover:text-text')}>
                  {v === 'stream' ? '流' : v === 'timeline' ? '时间' : '服务'}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1 text-[10px] text-text-secondary cursor-pointer">
              <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} className="accent-accent" />
              换行
            </label>
            <label className="flex items-center gap-1 text-[10px] text-text-secondary cursor-pointer">
              <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} className="accent-accent" />
              原始
            </label>
            <select value={fontSize} onChange={(e) => setFontSize(+e.target.value)}
              className="bg-surface border border-border-light rounded h-6 text-[10px] text-text px-1">
              <option value={10}>10px</option>
              <option value={11}>11px</option>
              <option value={12}>12px</option>
              <option value={14}>14px</option>
            </select>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-text-secondary">服务:</span>
            {Object.entries(SERVICE_COLORS).map(([svc, color]) => (
              <button key={svc} onClick={() => toggleService(svc)}
                className={'px-1.5 h-5 rounded text-[10px] flex items-center gap-1 border ' + (services.includes(svc) ? 'border-accent/30' : 'border-border opacity-40')}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
                {svc}
                <span className="text-text-secondary">{stats.byService[svc] || 0}</span>
              </button>
            ))}
            <span className="text-[10px] text-text-secondary ml-2">级别:</span>
            {(['debug', 'info', 'warn', 'error', 'fatal'] as const).map(lvl => (
              <button key={lvl} onClick={() => toggleLevel(lvl)}
                className={'px-1.5 h-5 rounded text-[10px] border ' + (levels.includes(lvl) ? LEVEL_STYLE[lvl].color + ' border-current' : 'opacity-40 border-border')}>
                {lvl} <span className="opacity-70">{stats.byLevel[lvl] || 0}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 主体 */}
        {view === 'stream' ? (
          <div className="flex-1 flex overflow-hidden">
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto bg-black/40 p-2 font-mono"
              style={{ fontSize, whiteSpace: wrap ? 'pre-wrap' : 'pre' }}
            >
              {filtered.length === 0 ? (
                <div className="text-text-secondary text-center py-12">无匹配日志</div>
              ) : (
                filtered.map(e => {
                  const lvlStyle = LEVEL_STYLE[e.level];
                  const ruleStyle = applyColorRule(e.message);
                  return (
                    <div
                      key={e.id}
                      onClick={() => setSelected(e.id)}
                      className={'px-1 hover:bg-surface-high/30 rounded cursor-pointer ' + lvlStyle.color + ' ' + lvlStyle.bg}
                      style={{ fontWeight: lvlStyle.weight }}
                    >
                      <span className="text-text-secondary">[{new Date(e.ts).toLocaleTimeString().slice(0, 12)}]</span>
                      {' '}
                      <span style={{ color: SERVICE_COLORS[e.service] }}>[{e.service}]</span>
                      {' '}
                      <span className="uppercase">[{e.level}]</span>
                      {' '}
                      {showRaw ? (
                        <span className="text-text">{e.raw}</span>
                      ) : (
                        <span style={ruleStyle.color ? { color: ruleStyle.color, fontWeight: ruleStyle.bold ? 600 : 400 } : undefined}>
                          {e.message}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            {selected && (() => {
              const e = filtered.find(x => x.id === selected);
              if (!e) return null;
              return (
                <div className="w-80 border-l border-border bg-bg p-3 overflow-y-auto">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-semibold text-text">日志详情</h3>
                    <IconButton icon="close" onClick={() => setSelected(null)} />
                  </div>
                  <div className="space-y-2 text-[11px]">
                    <div><span className="text-text-secondary">时间:</span> <span className="font-mono">{new Date(e.ts).toISOString()}</span></div>
                    <div><span className="text-text-secondary">服务:</span> <span style={{ color: SERVICE_COLORS[e.service] }}>{e.service}</span></div>
                    <div><span className="text-text-secondary">级别:</span> <span className={LEVEL_STYLE[e.level].color}>{e.level}</span></div>
                    <div>
                      <div className="text-text-secondary mb-1">消息:</div>
                      <div className="bg-bg border border-border rounded p-2 font-mono break-all">{e.message}</div>
                    </div>
                    <div>
                      <div className="text-text-secondary mb-1">原始:</div>
                      <pre className="bg-bg border border-border rounded p-2 text-[10px] font-mono break-all whitespace-pre-wrap">{e.raw}</pre>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        ) : view === 'timeline' ? (
          <div className="flex-1 overflow-y-auto p-3">
            <div className="bg-bg border border-border rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">时间分布</h3>
              {(() => {
                const min = Math.min(...filtered.map(e => e.ts));
                const max = Math.max(...filtered.map(e => e.ts));
                const span = max - min || 1;
                // 按时间桶
                const buckets = 30;
                const arr = Array(buckets).fill(0);
                const lvl: ('debug' | 'info' | 'warn' | 'error' | 'fatal')[][] = Array.from({ length: buckets }, () => []);
                filtered.forEach(e => {
                  const idx = Math.min(buckets - 1, Math.floor(((e.ts - min) / span) * buckets));
                  arr[idx]++;
                  lvl[idx].push(e.level);
                });
                return (
                  <div className="flex items-end gap-0.5 h-32">
                    {arr.map((v, i) => {
                      const max = Math.max(...arr, 1);
                      const has = lvl[i].includes('error') || lvl[i].includes('fatal');
                      return (
                        <div key={i} className="flex-1 flex flex-col items-center group">
                          <div className="text-[9px] text-text-secondary opacity-0 group-hover:opacity-100">{v}</div>
                          <div className={'w-full rounded-t ' + (has ? 'bg-danger' : v > 0 ? 'bg-primary' : 'bg-surface-high')} style={{ height: `${(v / max) * 100}%`, minHeight: v ? 2 : 0 }} />
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {Object.entries(stats.byLevel).map(([lvl, n]) => (
                <div key={lvl} className="bg-bg border border-border rounded p-2">
                  <div className="text-[10px] text-text-secondary">{lvl}</div>
                  <div className={'text-xl font-semibold ' + LEVEL_STYLE[lvl]?.color}>{n}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-3">
            <h3 className="text-xs font-semibold text-text mb-2">服务流量</h3>
            <div className="space-y-1">
              {Object.entries(SERVICE_COLORS).map(([svc, color]) => {
                const n = stats.byService[svc] || 0;
                const max = Math.max(...Object.values(stats.byService), 1);
                return (
                  <div key={svc} className="flex items-center gap-2 text-[11px]">
                    <span className="w-3 h-3 rounded-sm" style={{ background: color }} />
                    <span className="text-text w-20 truncate">{svc}</span>
                    <div className="flex-1 h-4 bg-surface-high rounded overflow-hidden">
                      <div className="h-full" style={{ width: `${(n / max) * 100}%`, background: color }} />
                    </div>
                    <span className="text-text-secondary tabular-nums w-12 text-right">{n}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
