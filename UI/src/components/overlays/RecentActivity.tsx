// ─────────────────────────────────────────────────────────────────
// 最近活动面板 (右上角弹出)
// - 决策 / 训练 / 上传 / 部署等事件流
// - 真实事件: 优先用后端 events,无连接时回落到 SEED
// - 内置 type 分类与图标映射
// - 支持过滤、清空、导出、详情展开
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useMemo } from 'react';
import { Button, Badge, Tooltip } from '../ui/Button';
import type { KernelEvent } from '../../types';
import { pushToast } from './Notifications';

type ActivityType = 'decision' | 'training' | 'deploy' | 'upload' | 'court' | 'memory' | 'tick' | 'system';

interface Activity {
  id: string;
  ts: number;
  type: ActivityType;
  title: string;
  detail: string;
  actor: string;
}

const TYPES: Record<ActivityType, { icon: string; color: string; bg: string; label: string }> = {
  decision: { icon: 'gavel',          color: 'text-accent',   bg: 'bg-accent/10',   label: '决策' },
  training: { icon: 'model_training', color: 'text-primary',  bg: 'bg-primary/10',  label: '训练' },
  deploy:   { icon: 'rocket_launch',  color: 'text-success',  bg: 'bg-success/10',  label: '部署' },
  upload:   { icon: 'cloud_upload',   color: 'text-info',     bg: 'bg-info/10',     label: '上传' },
  court:    { icon: 'balance',        color: 'text-warning',  bg: 'bg-warning/10',  label: '法庭' },
  memory:   { icon: 'memory',         color: 'text-text',     bg: 'bg-surface-high',label: '记忆' },
  tick:     { icon: 'bolt',           color: 'text-text-secondary', bg: 'bg-surface-high',label: 'Tick' },
  system:   { icon: 'dns',            color: 'text-text-secondary', bg: 'bg-surface-high',label: '系统' },
};

const SEED: Omit<Activity, 'id' | 'ts'>[] = [
  { type: 'decision', title: '决策 dec_8432',   detail: 'Candidate #3 胜出 · score 0.87',  actor: 'AIRuntime-1' },
  { type: 'training', title: 'MAPPO 训练批次',  detail: 'ep=148, reward=0.62, loss=0.034', actor: 'Governor-1' },
  { type: 'memory',   title: '记忆召回',        detail: '3 条命中 · 关联 decision',         actor: 'MemoryEngine' },
  { type: 'court',    title: '案件 court_192',  detail: '5/5 陪审通过 · verdict=allow',     actor: 'Court-1' },
  { type: 'decision', title: '决策 dec_8433',   detail: 'Candidate #1 胜出 · score 0.92',  actor: 'AIRuntime-1' },
  { type: 'deploy',   title: '部署完成',         detail: 'v0.4.2 → production',             actor: 'CI/CD' },
  { type: 'upload',   title: '上传文件 model.bin',detail: '48 MB · 大小校验通过',           actor: 'User' },
  { type: 'training', title: 'MAPPO 训练批次',   detail: 'ep=149, reward=0.71, loss=0.029', actor: 'Governor-1' },
  { type: 'memory',   title: '记忆写入',         detail: 'episode 312 → archive',           actor: 'MemoryEngine' },
  { type: 'decision', title: '决策 dec_8434',   detail: 'Candidate #2 胜出 · score 0.78',  actor: 'AIRuntime-1' },
];

// 把后端 event 字符串映射到 ActivityType
function classifyEvent(eventName: string): ActivityType {
  const e = eventName.toLowerCase();
  if (e.includes('decision') || e.includes('candidate')) return 'decision';
  if (e.includes('train') || e.includes('episode') || e.includes('marl')) return 'training';
  if (e.includes('deploy') || e.includes('release')) return 'deploy';
  if (e.includes('upload') || e.includes('file')) return 'upload';
  if (e.includes('court') || e.includes('verdict') || e.includes('juror')) return 'court';
  if (e.includes('memory') || e.includes('recall')) return 'memory';
  if (e.includes('tick')) return 'tick';
  return 'system';
}

// 把 KernelEvent 转 Activity
function fromKernelEvent(e: KernelEvent, idx: number): Activity {
  const type = classifyEvent(e.event);
  const t = TYPES[type];
  return {
    id: `evt_${e.timestamp}_${idx}`,
    ts: e.timestamp || Date.now(),
    type,
    title: e.event,
    detail: typeof e.payload === 'string'
      ? e.payload
      : e.payload
        ? JSON.stringify(e.payload).slice(0, 120)
        : '(无 payload)',
    actor: (e.payload && (e.payload.actor || e.payload.source)) || 'kernel',
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  events?: KernelEvent[];
  connected?: boolean;
}

const FILTER_TYPES: ActivityType[] = ['decision', 'training', 'court', 'memory', 'deploy', 'upload', 'system'];

export function RecentActivity({ open, onClose, events, connected }: Props) {
  const [seedItems, setSeedItems] = useState<Activity[]>([]);
  const [filter, setFilter] = useState<ActivityType | 'all'>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Activity | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // 是否使用真实事件
  const useReal = !!events && events.length > 0;
  // 最近 1 秒是否有新事件 (用于触发 UI 闪烁)
  const [pulse, setPulse] = useState(0);
  const lastTsRef = useRef<number>(0);

  // 初始化 seed(无真实事件时)
  useEffect(() => {
    if (!open) return;
    if (useReal) return;
    const seed: Activity[] = SEED.map((s, i) => ({
      ...s, id: 'a_' + i, ts: Date.now() - i * 14000,
    }));
    setSeedItems(seed);
    const t = setInterval(() => {
      const tpl = SEED[Math.floor(Math.random() * SEED.length)];
      setSeedItems(prev => [
        { ...tpl, id: 'a_' + Date.now().toString(36), ts: Date.now() },
        ...prev,
      ].slice(0, 30));
    }, 8000);
    return () => clearInterval(t);
  }, [open, useReal]);

  // 真实事件流
  const realItems: Activity[] = useMemo(() => {
    if (!events) return [];
    return events.map((e, i) => fromKernelEvent(e, i));
  }, [events]);

  // 新事件检测
  useEffect(() => {
    if (!useReal || realItems.length === 0) return;
    const newest = realItems[0]?.ts || 0;
    if (newest > lastTsRef.current) {
      lastTsRef.current = newest;
      setPulse(p => p + 1);
    }
  }, [realItems, useReal]);

  const items = useReal ? realItems : seedItems;

  // 过滤 & 搜索
  const filtered = useMemo(() => {
    return items.filter(a => {
      if (filter !== 'all' && a.type !== filter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return a.title.toLowerCase().includes(q) ||
               a.detail.toLowerCase().includes(q) ||
               a.actor.toLowerCase().includes(q);
      }
      return true;
    });
  }, [items, filter, search]);

  // 统计
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    items.forEach(a => { map[a.type] = (map[a.type] || 0) + 1; });
    return map;
  }, [items]);

  if (!open) return null;

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `soloforge-activity-${new Date().toISOString().slice(0, 19)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="fixed inset-0 z-[150]" onClick={onClose} />
      <div
        ref={ref}
        className="fixed top-12 right-3 w-[420px] max-h-[80vh] bg-bg border border-border rounded-xl shadow-2xl z-[160] flex flex-col overflow-hidden animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-3 h-10 border-b border-border bg-surface">
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-outlined text-primary text-sm shrink-0">history_toggle_off</span>
            <span className="text-xs font-semibold text-text shrink-0">最近活动</span>
            <Badge variant="primary">{items.length}</Badge>
            {useReal ? (
              <span key={pulse} className="flex items-center gap-1 text-[10px] text-success animate-pulse shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                LIVE
              </span>
            ) : (
              <Badge variant="warning" dot>模拟</Badge>
            )}
            {/* 事件密度 sparkline */}
            <DensitySpark items={items} />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Tooltip content="清空">
              <button
                onClick={() => setSeedItems([])}
                className="p-1 rounded hover:bg-surface-high text-text-secondary"
              >
                <span className="material-symbols-outlined text-sm">delete_sweep</span>
              </button>
            </Tooltip>
            <Tooltip content="导出 JSON">
              <button
                onClick={exportJson}
                className="p-1 rounded hover:bg-surface-high text-text-secondary"
              >
                <span className="material-symbols-outlined text-sm">download</span>
              </button>
            </Tooltip>
            <Tooltip content="关闭">
              <button
                onClick={onClose}
                className="p-1 rounded hover:bg-surface-high text-text-secondary"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </Tooltip>
          </div>
        </div>

        {/* 搜索框 */}
        <div className="px-3 py-2 border-b border-border-light bg-bg-dim">
          <div className="flex items-center gap-1.5 px-2 h-7 bg-surface border border-border-light rounded-md">
            <span className="material-symbols-outlined text-xs text-text-secondary">search</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索活动..."
              className="flex-1 bg-transparent text-[11px] text-text placeholder-text-secondary outline-none"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="material-symbols-outlined text-xs text-text-secondary hover:text-text"
              >close</button>
            )}
          </div>
        </div>

        {/* 类别过滤 */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-light bg-bg-dim overflow-x-auto scrollbar-thin">
          <FilterChip
            active={filter === 'all'}
            onClick={() => setFilter('all')}
            label="全部"
            count={items.length}
          />
          {FILTER_TYPES.map(t => (
            <FilterChip
              key={t}
              active={filter === t}
              onClick={() => setFilter(t)}
              label={TYPES[t].label}
              count={counts[t] || 0}
              color={TYPES[t].color}
            />
          ))}
        </div>

        {/* 状态栏 */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border-light text-[10px] text-text-secondary">
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-success animate-pulse' : 'bg-warning'}`} />
          <span>{connected ? '已连接后端' : '本地模拟'}</span>
          <span>·</span>
          <span>显示 {filtered.length} / {items.length}</span>
          <div className="flex-1" />
          <span className="font-mono">{useReal ? 'eventStream' : 'seedLoop'}</span>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5 scrollbar-thin">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
              <span className="material-symbols-outlined text-3xl mb-2 opacity-40">pending</span>
              <p className="text-xs">{items.length === 0 ? '暂无活动' : '没有匹配的活动'}</p>
            </div>
          ) : filtered.map((a, i) => {
            const s = TYPES[a.type];
            return (
              <div
                key={a.id}
                style={{ animationDelay: `${Math.min(i * 30, 200)}ms` }}
                onClick={() => setSelected(selected?.id === a.id ? null : a)}
                className={`group flex items-start gap-2 p-2 rounded-lg border bg-surface hover:border-primary/40 transition-colors cursor-pointer animate-slide-in-up ${
                  selected?.id === a.id ? 'border-primary bg-primary/5' : 'border-border-light'
                }`}
              >
                <div className={`shrink-0 w-7 h-7 rounded-lg ${s.bg} flex items-center justify-center ${s.color}`}>
                  <span className="material-symbols-outlined text-sm">{s.icon}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${s.bg} ${s.color}`}>
                      {s.label}
                    </span>
                    <span className="text-[11px] font-medium text-text truncate">{a.title}</span>
                  </div>
                  <div className="text-[10px] text-text-secondary mt-0.5 line-clamp-2">{a.detail}</div>
                  <div className="flex items-center gap-1.5 mt-1 text-[9px] text-text-secondary/70 font-mono">
                    <span>{a.actor}</span>
                    <span>·</span>
                    <span>{formatRel(a.ts)}</span>
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); setSelected(selected?.id === a.id ? null : a); }}
                  className="opacity-0 group-hover:opacity-100 material-symbols-outlined text-xs text-text-secondary hover:text-text"
                >
                  {selected?.id === a.id ? 'expand_less' : 'expand_more'}
                </button>
              </div>
            );
          })}
        </div>

        {/* 详情面板(选中项) */}
        {selected && (
          <div className="border-t border-border bg-bg-dim p-3 text-[10px]">
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-semibold text-text">活动详情</span>
              <div className="flex items-center gap-1">
                <ActionChip icon="content_copy" label="复制 ID" onClick={() => copy(selected.id, 'ID 已复制')} />
                <ActionChip icon="schedule" label="复制时间" onClick={() => copy(new Date(selected.ts).toISOString(), '时间已复制')} />
                <ActionChip icon="code" label="复制详情" onClick={() => copy(selected.detail, '详情已复制')} />
                <button
                  onClick={() => setSelected(null)}
                  className="ml-1 material-symbols-outlined text-xs text-text-secondary hover:text-text"
                >close</button>
              </div>
            </div>
            <div className="grid grid-cols-[60px_1fr] gap-x-2 gap-y-1 text-text-secondary">
              <div>类型</div><div className="text-text font-mono flex items-center gap-1.5">
                <span className={`material-symbols-outlined text-xs ${TYPES[selected.type].color}`}>{TYPES[selected.type].icon}</span>
                {TYPES[selected.type].label}
              </div>
              <div>标题</div><div className="text-text font-mono truncate" title={selected.title}>{selected.title}</div>
              <div>来源</div><div className="text-text font-mono truncate" title={selected.actor}>{selected.actor}</div>
              <div>时间</div><div className="text-text font-mono">{new Date(selected.ts).toLocaleString('zh-CN', { hour12: false })}</div>
              <div>相对</div><div className="text-text font-mono">{formatRel(selected.ts)}</div>
              <div>ID</div>
              <div className="text-text font-mono truncate flex items-center gap-1.5">
                <span className="truncate" title={selected.id}>{selected.id}</span>
                <button
                  onClick={() => copy(selected.id, 'ID 已复制')}
                  className="material-symbols-outlined text-[10px] text-text-secondary hover:text-primary shrink-0"
                  title="复制"
                >content_copy</button>
              </div>
            </div>
            <div className="mt-2 p-2 bg-surface rounded text-text-secondary font-mono break-all max-h-24 overflow-y-auto scrollbar-thin">
              {selected.detail}
            </div>
            {/* 操作按钮: 跳到源 / 关联到对话 */}
            <div className="mt-2 flex items-center gap-1.5">
              <button
                onClick={() => sendToChat(selected)}
                className="flex items-center gap-1 px-2 h-6 rounded-md bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 text-[10px] font-medium transition-colors"
              >
                <span className="material-symbols-outlined text-xs">chat</span>
                追问 AI
              </button>
              <button
                onClick={() => replayEvent(selected)}
                className="flex items-center gap-1 px-2 h-6 rounded-md bg-surface text-text-secondary border border-border-light hover:text-text hover:border-primary/40 text-[10px] font-medium transition-colors"
              >
                <span className="material-symbols-outlined text-xs">replay</span>
                复制为查询
              </button>
              <div className="flex-1" />
              <span className="text-[9px] text-text-secondary/60 font-mono">
                hash={hashShort(selected.id)}
              </span>
            </div>
          </div>
        )}

        {/* 底栏 */}
        <div className="flex items-center justify-between px-3 h-9 bg-bg-dim border-t border-border text-[10px] text-text-secondary">
          <span>显示 {filtered.length} 条</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" icon="download" onClick={exportJson}>导出</Button>
          </div>
        </div>
      </div>
    </>
  );
}

function FilterChip({ active, onClick, label, count, color }: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 flex items-center gap-1 px-2 h-5 rounded-full text-[10px] transition-colors ${
        active
          ? 'bg-primary-container text-on-primary-container'
          : 'bg-surface text-text-secondary hover:text-text border border-border-light'
      }`}
    >
      <span className={active ? 'text-on-primary-container' : (color || 'text-text-secondary')}>
        {label}
      </span>
      <span className={`font-mono ${active ? 'text-on-primary-container/70' : 'text-text-secondary/70'}`}>
        {count}
      </span>
    </button>
  );
}

function formatRel(ts: number) {
  const raw = Date.now() - ts;
  const d = Math.max(0, raw);
  if (d < 1000) return '刚刚';
  if (d < 60000) return `${Math.floor(d / 1000)}秒前`;
  if (d < 3600000) return `${Math.floor(d / 60000)}分钟前`;
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

// ─── 详情面板辅助 ───
function ActionChip({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-1.5 h-5 rounded text-[9px] text-text-secondary hover:text-text hover:bg-surface transition-colors"
      title={label}
    >
      <span className="material-symbols-outlined text-[10px]">{icon}</span>
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

function copy(text: string, toastMsg: string) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
  pushToast({ level: 'success', title: toastMsg, duration: 1800 });
}

function fallbackCopy(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  document.body.removeChild(ta);
}

function hashShort(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

function sendToChat(a: Activity) {
  const text = `请解释以下事件:\n\n- 类型: ${TYPES[a.type].label}\n- 标题: ${a.title}\n- 来源: ${a.actor}\n- 详情: ${a.detail}\n- 时间: ${new Date(a.ts).toLocaleString('zh-CN')}\n- ID: ${a.id}`;
  copy(text, '已复制追问模板');
  pushToast({
    level: 'info',
    title: '已复制到剪贴板',
    message: '粘贴到对话框可追问 AI',
    duration: 2500,
  });
}

function replayEvent(a: Activity) {
  const text = `${a.title}: ${a.detail}`;
  copy(text, '查询已复制');
}

// ─── 事件密度 sparkline (24 个桶 = 60s) ───
function DensitySpark({ items }: { items: Activity[] }) {
  // 24 桶，每桶 60s
  const BUCKETS = 24;
  const WINDOW_MS = 60_000;
  const now = Date.now();
  const counts = new Array(BUCKETS).fill(0);
  let max = 0;
  for (const a of items) {
    const age = now - a.ts;
    if (age < 0 || age > WINDOW_MS) continue;
    const bucket = Math.min(BUCKETS - 1, Math.floor((age / WINDOW_MS) * BUCKETS));
    counts[bucket]++;
    if (counts[bucket] > max) max = counts[bucket];
  }
  // 反转:左新右旧
  const ordered = counts.slice().reverse();
  const total = counts.reduce((a, b) => a + b, 0);
  const peak = counts.indexOf(max);
  return (
    <div className="flex items-center gap-1.5 ml-1 min-w-0">
      <div className="flex items-end gap-px h-4 w-[72px] shrink-0" title={`事件密度 · 24 桶 / 60s · 峰值 ${max}`}>
        {ordered.map((c, i) => {
          const h = max === 0 ? 2 : Math.max(2, Math.round((c / max) * 16));
          // 颜色按密度梯度
          const ratio = c / max;
          const color = ratio > 0.75 ? 'bg-primary' : ratio > 0.4 ? 'bg-primary/60' : ratio > 0.1 ? 'bg-primary/35' : 'bg-primary/15';
          return (
            <span
              key={i}
              className={`flex-1 rounded-sm ${color} transition-all`}
              style={{ height: `${h}px` }}
            />
          );
        })}
      </div>
      <span className="text-[9px] text-text-secondary/70 font-mono tabular-nums shrink-0">
        {total}/min{peak >= 0 ? ` ·peak t-${peak + 1}s` : ''}
      </span>
    </div>
  );
}
