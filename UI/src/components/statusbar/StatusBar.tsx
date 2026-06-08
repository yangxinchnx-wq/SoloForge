// ─────────────────────────────────────────────────────────────────
// 底部状态栏
// 设置 / 项目名 / AI 状态 / 内存 / CPU / 任务进度 / 调度 / Tick / 日志
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react';
import type { SystemStatus, KernelStatus, SchedulerStats } from '../../types';
import { Tooltip, StatusDot, IconButton, ProgressBar, Badge } from '../ui/Button';
import { StatsPanel } from './StatsPanel';

interface Props {
  projectName: string;
  kernel: KernelStatus | null;
  system: SystemStatus | null;
  scheduler: SchedulerStats | null;
  onOpenSettings: () => void;
}

export function StatusBar({ projectName, kernel, system, scheduler, onOpenSettings }: Props) {
  const [progress, setProgress] = useState(0);
  const [aiState, setAiState] = useState('就绪');
  const [showLog, setShowLog] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [cpuHist, setCpuHist] = useState<number[]>(Array(20).fill(0));
  const [memHist, setMemHist] = useState<number[]>(Array(20).fill(0));
  const [netHist, setNetHist] = useState<number[]>(Array(20).fill(0));
  const [diskHist, setDiskHist] = useState<number[]>(Array(20).fill(0));

  // 任务进度
  useEffect(() => {
    const t = setInterval(() => {
      setProgress(p => (p + 1.4) % 101);
    }, 200);
    return () => clearInterval(t);
  }, []);

  // 资源历史
  useEffect(() => {
    if (!system) return;
    setCpuHist(h => [...h.slice(1), system.cpu ?? 0]);
    setMemHist(h => [...h.slice(1), system.memory ?? 0]);
    setNetHist(h => [...h.slice(1), Math.min(100, (system.network.up + system.network.down) / 2048)]);
    setDiskHist(h => [...h.slice(1), 30 + Math.sin(Date.now() / 3000) * 20 + Math.random() * 5]);
  }, [system?.cpu, system?.memory, system?.network.up, system?.network.down]);

  // AI 状态
  useEffect(() => {
    if (!kernel) { setAiState('等待中'); return; }
    const map: Record<string, string> = {
      READY: '就绪', RUNNING: '运行中', PAUSED: '已暂停', PANIC: '异常',
      STOPPED: '已停止', BOOTING: '启动中', IDLE: '空闲',
    };
    setAiState(map[kernel.state] || kernel.state);
  }, [kernel]);

  const memPct = system?.memory ?? 0;
  const cpuPct = system?.cpu ?? 0;
  const memColor = memPct > 85 ? 'danger' : memPct > 65 ? 'warning' : 'success';
  const cpuColor = cpuPct > 80 ? 'danger' : cpuPct > 50 ? 'warning' : 'success';

  return (
    <>
      <footer className="flex items-center justify-between px-3 h-7 bg-surface border-t border-border text-[11px] font-mono text-text-secondary shrink-0 gap-3">
        {/* 左：基础信息 */}
        <div className="flex items-center gap-3 shrink-0">
          <Tooltip content="设置">
            <button onClick={onOpenSettings} className="flex items-center gap-1 hover:text-text transition-colors">
              <span className="material-symbols-outlined text-xs">settings</span>
              <span>设置</span>
            </button>
          </Tooltip>
          <div className="w-px h-3 bg-border" />
          <Tooltip content="项目">
            <span className="flex items-center gap-1 hover:text-text cursor-default">
              <span className="material-symbols-outlined text-xs">folder</span>
              <span className="truncate max-w-[120px]">{projectName || '未命名'}</span>
            </span>
          </Tooltip>
          <div className="w-px h-3 bg-border" />
          <Tooltip content="文件数">
            <span className="flex items-center gap-1 hover:text-text">
              <span className="material-symbols-outlined text-xs">description</span>
              <span className="text-text tabular-nums">128</span>
              <span>文件</span>
            </span>
          </Tooltip>
          <div className="w-px h-3 bg-border" />
          <Tooltip content={`AI 状态：${aiState}`}>
            <span className="flex items-center gap-1">
              <StatusDot
                status={aiState === '运行中' || aiState === '就绪' ? 'running' : aiState === '异常' ? 'error' : 'pending'}
                pulse={aiState === '运行中'}
              />
              <span>AI:</span>
              <span className="text-text">{aiState}</span>
            </span>
          </Tooltip>
          <div className="w-px h-3 bg-border" />
          <Tooltip content="展开详细统计">
            <button onClick={() => setShowStats(s => !s)} className="flex items-center hover:text-text text-text-secondary">
              <span className="material-symbols-outlined text-xs">{showStats ? 'expand_more' : 'expand_less'}</span>
            </button>
          </Tooltip>
        </div>

        {/* 中：资源 */}
        <div className="flex items-center gap-3 shrink-0">
          <Tooltip content={`CPU 使用率 ${cpuPct.toFixed(1)}%`}>
            <span className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-xs">memory</span>
              <span>CPU</span>
              <span className={`font-semibold tabular-nums ${cpuColor === 'danger' ? 'text-danger' : cpuColor === 'warning' ? 'text-warning' : 'text-success'}`}>
                {cpuPct.toFixed(0)}%
              </span>
              <Spark data={cpuHist} color={cpuColor === 'danger' ? 'text-danger' : cpuColor === 'warning' ? 'text-warning' : 'text-success'} />
            </span>
          </Tooltip>
          <div className="w-px h-3 bg-border" />
          <Tooltip content={`内存 ${system?.memoryUsed}GB / ${system?.memoryTotal}GB`}>
            <span className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-xs">storage</span>
              <span>内存</span>
              <span className={`font-semibold tabular-nums ${memColor === 'danger' ? 'text-danger' : memColor === 'warning' ? 'text-warning' : 'text-success'}`}>
                {memPct.toFixed(0)}%
              </span>
              <Spark data={memHist} color={memColor === 'danger' ? 'text-danger' : memColor === 'warning' ? 'text-warning' : 'text-success'} />
              <div className="w-12 h-1 bg-surface-high rounded-full overflow-hidden">
                <div
                  className={`h-full ${memColor === 'danger' ? 'bg-danger' : memColor === 'warning' ? 'bg-warning' : 'bg-success'} transition-all`}
                  style={{ width: `${memPct}%` }}
                />
              </div>
            </span>
          </Tooltip>
          <div className="w-px h-3 bg-border" />
          <Tooltip content={`网络 ↑${system?.network.up.toFixed(0) ?? 0} KB/s · ↓${system?.network.down.toFixed(0) ?? 0} KB/s`}>
            <span className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-xs">swap_vert</span>
              <span>网络</span>
              <span className="text-text font-semibold tabular-nums w-10 text-right text-[10px]">
                ↑{((system?.network.up ?? 0) / 1024).toFixed(1)}M
              </span>
              <Spark data={netHist} color="text-accent" />
            </span>
          </Tooltip>
          <div className="w-px h-3 bg-border" />
          <Tooltip content="磁盘 I/O">
            <span className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-xs">hard_drive</span>
              <span>磁盘</span>
              <Spark data={diskHist} color="text-warning" />
            </span>
          </Tooltip>
        </div>

        {/* 右：调度 / Tick / 日志 */}
        <div className="flex items-center gap-3 shrink-0">
          <Tooltip content="任务进度（模拟）">
            <span className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-xs">task_alt</span>
              <span>任务</span>
              <div className="w-16 h-1.5 bg-surface-high rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
              </div>
              <span className="text-text tabular-nums w-8 text-right">{progress.toFixed(0)}%</span>
            </span>
          </Tooltip>
          <div className="w-px h-3 bg-border" />
          <Tooltip content="调度器队列">
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-xs">schedule</span>
              <span>调度</span>
              <Badge variant="default" className="text-[9px]">{scheduler?.queueSize ?? 0}</Badge>
            </span>
          </Tooltip>
          <div className="w-px h-3 bg-border" />
          <Tooltip content="时钟周期">
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-xs">timer</span>
              <span>Tick</span>
              <span className="text-text tabular-nums">{(kernel?.currentTick ?? 0).toLocaleString()}</span>
            </span>
          </Tooltip>
          <div className="w-px h-3 bg-border" />
          <Tooltip content="事件计数">
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-xs">bolt</span>
              <span className="text-text">v{kernel?.version ?? 0}</span>
            </span>
          </Tooltip>
          <div className="w-px h-3 bg-border" />
          <Tooltip content="Pomodoro 计时器">
            <span className="flex items-center gap-1 hover:text-text">
              <span className="material-symbols-outlined text-xs">timer</span>
              <span className="text-text tabular-nums">25:00</span>
            </span>
          </Tooltip>
          <div className="w-px h-3 bg-border" />
          <Tooltip content="日志">
            <button onClick={() => setShowLog(s => !s)} className="flex items-center gap-1 hover:text-text">
              <span className="material-symbols-outlined text-xs">description</span>
              <span>日志</span>
            </button>
          </Tooltip>
        </div>
      </footer>

      {/* 浮动日志面板 */}
      {showLog && <LogPanel onClose={() => setShowLog(false)} />}

      {/* 浮动详细统计面板 */}
      {showStats && (
        <StatsPanel
          onClose={() => setShowStats(false)}
          cpuHist={cpuHist}
          memHist={memHist}
          netHist={netHist}
          diskHist={diskHist}
          system={system}
          kernel={kernel}
        />
      )}
    </>
  );
}

// ─── 迷你折线图 ───
function Spark({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 100);
  const w = 36, h = 12;
  const step = w / (data.length - 1);
  const points = data.map((v, i) => `${i * step},${h - (v / max) * h}`).join(' ');
  return (
    <svg width={w} height={h} className="opacity-80">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
        strokeLinecap="round"
        className={color}
      />
    </svg>
  );
}

// ─── 浮动日志面板 ───
function LogPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [logs, setLogs] = useState<Array<{ ts: number; level: string; msg: string }>>([]);

  useEffect(() => {
    const types = ['INFO', 'INFO', 'INFO', 'DEBUG', 'WARN', 'INFO', 'INFO', 'ERROR', 'INFO'];
    const msgs = [
      'api: GET /api/status 200',
      'kernel: tick advanced',
      'surreal: query executed',
      'garnet: cache hit',
      'governor: policy applied',
      'scheduler: task dispatched',
      'eventbus: emit decision.created',
      'archiver: retry 1/3',
      'court: case opened',
    ];
    const tick = setInterval(() => {
      const idx = Math.floor(Math.random() * types.length);
      setLogs(l => [...l.slice(-50), { ts: Date.now(), level: types[idx], msg: msgs[idx] }]);
    }, 600);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs]);

  return (
    <div className="fixed bottom-9 right-3 w-[480px] h-[300px] bg-bg border border-border rounded-lg shadow-2xl z-50 flex flex-col animate-slide-in-up">
      <div className="flex items-center justify-between px-3 h-9 bg-surface-high border-b border-border">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <span className="material-symbols-outlined text-primary text-sm">terminal</span>
          实时日志
          <span className="text-text-secondary">{logs.length} 条</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setLogs([])} className="material-symbols-outlined text-sm text-text-secondary hover:text-text">delete_sweep</button>
          <button onClick={onClose} className="material-symbols-outlined text-sm text-text-secondary hover:text-text">close</button>
        </div>
      </div>
      <div ref={ref} className="flex-1 overflow-y-auto p-2 font-mono text-[10px] leading-relaxed space-y-0.5 scrollbar-thin">
        {logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-secondary">
            <span className="material-symbols-outlined text-3xl opacity-40 mr-2">pending</span>
            等待日志...
          </div>
        ) : logs.map((l, i) => (
          <div key={i} className="flex items-start gap-2 hover:bg-surface-high px-1 -mx-1 rounded">
            <span className="text-text-secondary shrink-0 w-16">
              {new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
            <span className={`shrink-0 w-10 ${
              l.level === 'ERROR' ? 'text-danger' :
              l.level === 'WARN' ? 'text-warning' :
              l.level === 'DEBUG' ? 'text-text-secondary' : 'text-info'
            }`}>{l.level}</span>
            <span className="text-text flex-1">{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
