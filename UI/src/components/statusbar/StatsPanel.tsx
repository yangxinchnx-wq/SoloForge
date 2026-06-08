// ─────────────────────────────────────────────────────────────────
// 详细统计面板
// 底部"展开"按钮触发,展示 4 维度指标 (CPU/内存/网络/磁盘) + 节点列表
// ─────────────────────────────────────────────────────────────────

import { useState } from 'react';
import type { SystemStatus, KernelStatus } from '../../types';

interface Props {
  onClose: () => void;
  cpuHist: number[];
  memHist: number[];
  netHist: number[];
  diskHist: number[];
  system: SystemStatus | null;
  kernel: KernelStatus | null;
}

interface NodeRow {
  id: string;
  name: string;
  role: string;
  cpu: number;
  mem: number;
  status: 'online' | 'idle' | 'error';
}

const NODES: NodeRow[] = [
  { id: 'n1', name: 'AIRuntime-1',  role: 'runtime',  cpu: 38, mem: 4.2, status: 'online' },
  { id: 'n2', name: 'Governor-1',   role: 'governor', cpu: 22, mem: 2.1, status: 'online' },
  { id: 'n3', name: 'Court-1',      role: 'court',    cpu: 12, mem: 0.9, status: 'online' },
  { id: 'n4', name: 'Scheduler-1',  role: 'scheduler',cpu: 45, mem: 1.4, status: 'online' },
  { id: 'n5', name: 'Archiver-1',   role: 'archiver', cpu: 8,  mem: 0.5, status: 'online' },
  { id: 'n6', name: 'MemoryEngine', role: 'memory',   cpu: 18, mem: 3.6, status: 'online' },
  { id: 'n7', name: 'Judge-J7',     role: 'juror',    cpu: 5,  mem: 0.2, status: 'idle'   },
  { id: 'n8', name: 'Judge-J8',     role: 'juror',    cpu: 3,  mem: 0.2, status: 'idle'   },
];

export function StatsPanel({ onClose, cpuHist, memHist, netHist, diskHist, system, kernel }: Props) {
  const memPct = system?.memory ?? 0;
  const cpuPct = system?.cpu ?? 0;
  const netUp = system?.network?.up ?? 0;
  const netDown = system?.network?.down ?? 0;
  const diskPct = diskHist[diskHist.length - 1] || 0;
  const netPct = Math.min(100, (netUp + netDown) / 1024);

  const online = NODES.filter(n => n.status === 'online').length;
  const idle = NODES.filter(n => n.status === 'idle').length;

  return (
    <div className="fixed bottom-9 left-3 right-3 h-[320px] bg-bg border border-border rounded-lg shadow-2xl z-50 flex flex-col animate-slide-in-up">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 h-9 bg-surface-high border-b border-border">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <span className="material-symbols-outlined text-primary text-sm">monitoring</span>
          详细统计
          <span className="text-text-secondary">· 实时</span>
          <span className="flex items-center gap-1 text-[10px] text-success">
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
            LIVE
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-text-secondary">
          <span>Tick {(kernel?.currentTick ?? 0).toLocaleString()}</span>
          <span>·</span>
          <span>v{kernel?.version ?? 0}</span>
          <button
            onClick={onClose}
            className="material-symbols-outlined text-sm text-text-secondary hover:text-text ml-2"
          >close</button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧：四大指标图表 */}
        <div className="flex-1 grid grid-cols-4 gap-3 p-3 border-r border-border">
          <BigMetric
            icon="memory"
            title="CPU"
            pct={cpuPct}
            data={cpuHist}
            colorClass="text-primary"
            unit="%"
            detail={`${(cpuPct * 0.32).toFixed(1)} GB/s · 8 核`}
          />
          <BigMetric
            icon="storage"
            title="内存"
            pct={memPct}
            data={memHist}
            colorClass="text-success"
            unit="%"
            detail={`${system?.memoryUsed ?? 0} / ${system?.memoryTotal ?? 0} GB`}
          />
          <BigMetric
            icon="swap_vert"
            title="网络"
            pct={netPct}
            data={netHist}
            colorClass="text-info"
            unit="MB/s"
            detail={`↑ ${(netUp / 1024).toFixed(1)} · ↓ ${(netDown / 1024).toFixed(1)}`}
          />
          <BigMetric
            icon="hard_drive"
            title="磁盘"
            pct={diskPct}
            data={diskHist}
            colorClass="text-warning"
            unit="%"
            detail="234 GB / 1 TB"
          />
        </div>

        {/* 右侧：节点列表 */}
        <div className="w-[360px] flex flex-col">
          <div className="flex items-center justify-between px-3 h-8 border-b border-border-light bg-bg-dim">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              节点 ({NODES.length})
            </span>
            <div className="flex items-center gap-1.5 text-[9px] text-text-secondary">
              <span className="flex items-center gap-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                在线 {online}
              </span>
              <span className="flex items-center gap-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-warning" />
                空闲 {idle}
              </span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5 scrollbar-thin">
            {NODES.map(n => (
              <div
                key={n.id}
                className="group flex items-center gap-2 p-1.5 rounded hover:bg-surface-high transition-colors"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    n.status === 'online' ? 'bg-success animate-pulse' :
                    n.status === 'idle' ? 'bg-warning' : 'bg-danger'
                  }`}
                />
                <span className="text-[10px] font-mono text-text flex-1 truncate">{n.name}</span>
                <span className="text-[9px] text-text-secondary shrink-0">{n.role}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[9px] text-text-secondary tabular-nums w-7 text-right">
                    {n.cpu}%
                  </span>
                  <div className="w-10 h-1 bg-bg rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        n.cpu > 70 ? 'bg-danger' : n.cpu > 40 ? 'bg-warning' : 'bg-primary'
                      }`}
                      style={{ width: `${n.cpu}%` }}
                    />
                  </div>
                  <span className="text-[9px] text-text-secondary tabular-nums w-10 text-right">
                    {n.mem}G
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function BigMetric({
  icon, title, pct, data, colorClass, unit, detail,
}: {
  icon: string;
  title: string;
  pct: number;
  data: number[];
  colorClass: string;
  unit: string;
  detail: string;
}) {
  const max = Math.max(...data, 1);
  const min = Math.min(...data);
  const w = 200, h = 60;
  const step = w / Math.max(data.length - 1, 1);
  const points = data.map((v, i) => `${i * step},${h - (v / max) * (h - 4) - 2}`).join(' ');
  const area = `0,${h} ${points} ${w},${h}`;
  const colorMap: Record<string, string> = {
    'text-primary': '#7c3aed',
    'text-success': '#10b981',
    'text-info': '#3b82f6',
    'text-warning': '#f59e0b',
  };
  const hex = colorMap[colorClass] || '#7c3aed';
  const gid = `g-${title}`;

  return (
    <div className="flex flex-col p-2.5 rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <span className={`material-symbols-outlined text-sm ${colorClass}`}>{icon}</span>
          <span className="text-[11px] font-semibold text-text">{title}</span>
        </div>
        <span className={`text-base font-bold tabular-nums ${colorClass}`}>
          {pct.toFixed(0)}
          <span className="text-[9px] text-text-secondary ml-0.5">{unit}</span>
        </span>
      </div>
      <svg
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={hex} stopOpacity="0.3" />
            <stop offset="100%" stopColor={hex} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${gid})`} />
        <polyline
          points={points}
          fill="none"
          stroke={hex}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <line
          x1="0" y1={h - 0.5} x2={w} y2={h - 0.5}
          stroke="currentColor"
          className="text-border"
          strokeWidth="0.5"
        />
      </svg>
      <div className="flex items-center justify-between mt-1 text-[9px] text-text-secondary">
        <span className="font-mono">min {min.toFixed(0)}</span>
        <span>{detail}</span>
        <span className="font-mono">max {max.toFixed(0)}</span>
      </div>
    </div>
  );
}
