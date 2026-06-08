// ─────────────────────────────────────────────────────────────────
// 持续集成/构建监控 — BuildMonitor
// - 构建流水线状态 (CI/CD)
// - 实时日志流
// - 阶段时间线 (install/lint/test/build/deploy)
// - 失败/重试/取消
// - 历史构建趋势
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type Stage = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

interface BuildStage {
  id: string;
  name: string;
  status: Stage;
  startTime?: number;
  endTime?: number;
  duration?: number;
  logs: string[];
}

interface Build {
  id: string;
  number: number;
  branch: string;
  commit: string;
  author: string;
  message: string;
  trigger: 'push' | 'pr' | 'manual' | 'schedule';
  status: 'running' | 'success' | 'failed' | 'cancelled';
  startTime: number;
  endTime?: number;
  duration?: number;
  stages: BuildStage[];
}

const STAGE_TEMPLATES: Array<{ id: string; name: string; icon: string; duration: number }> = [
  { id: 'checkout', name: '检出代码', icon: 'download', duration: 3000 },
  { id: 'install',  name: '安装依赖', icon: 'package_2', duration: 30000 },
  { id: 'lint',     name: 'Lint 检查', icon: 'rule', duration: 8000 },
  { id: 'test',     name: '单元测试', icon: 'science', duration: 45000 },
  { id: 'build',    name: '构建产物', icon: 'construction', duration: 60000 },
  { id: 'deploy',   name: '部署',     icon: 'rocket_launch', duration: 20000 },
];

const SEED_BUILDS: Build[] = [
  {
    id: 'b1', number: 1287, branch: 'main', commit: 'a1b2c3d', author: 'Alice', message: 'feat: 新增思维导图',
    trigger: 'push', status: 'success', startTime: Date.now() - 3600000, endTime: Date.now() - 3600000 + 165000, duration: 165000,
    stages: [
      { id: 'checkout', name: '检出代码', status: 'success', startTime: 0, endTime: 3000, duration: 3000, logs: ['Cloning repo...', 'Done.'] },
      { id: 'install', name: '安装依赖', status: 'success', startTime: 3000, endTime: 33000, duration: 30000, logs: ['npm install...', 'added 1247 packages'] },
      { id: 'lint', name: 'Lint 检查', status: 'success', startTime: 33000, endTime: 41000, duration: 8000, logs: ['ESLint: 0 errors, 2 warnings'] },
      { id: 'test', name: '单元测试', status: 'success', startTime: 41000, endTime: 86000, duration: 45000, logs: ['Running 124 tests...', 'All tests passed'] },
      { id: 'build', name: '构建产物', status: 'success', startTime: 86000, endTime: 146000, duration: 60000, logs: ['vite build...', 'dist size: 1.2MB'] },
      { id: 'deploy', name: '部署', status: 'success', startTime: 146000, endTime: 165000, duration: 19000, logs: ['Deploying to production...', 'Live at https://soloforge.dev'] },
    ],
  },
  {
    id: 'b2', number: 1286, branch: 'feat/db-designer', commit: 'e4f5g6h', author: 'Bob', message: 'feat: 数据库设计器',
    trigger: 'pr', status: 'failed', startTime: Date.now() - 7200000, endTime: Date.now() - 7200000 + 86000, duration: 86000,
    stages: [
      { id: 'checkout', name: '检出代码', status: 'success', startTime: 0, endTime: 3000, duration: 3000, logs: ['Cloning...'] },
      { id: 'install', name: '安装依赖', status: 'success', startTime: 3000, endTime: 33000, duration: 30000, logs: ['npm install...'] },
      { id: 'lint', name: 'Lint 检查', status: 'success', startTime: 33000, endTime: 41000, duration: 8000, logs: ['ESLint: 0 errors'] },
      { id: 'test', name: '单元测试', status: 'failed', startTime: 41000, endTime: 86000, duration: 45000, logs: ['FAIL src/api/client.test.ts', 'Expected "200" but got "500"'] },
      { id: 'build', name: '构建产物', status: 'skipped', logs: [] },
      { id: 'deploy', name: '部署', status: 'skipped', logs: [] },
    ],
  },
  {
    id: 'b3', number: 1285, branch: 'main', commit: 'i7j8k9l', author: 'System', message: 'chore: 自动依赖更新',
    trigger: 'schedule', status: 'success', startTime: Date.now() - 86400000, endTime: Date.now() - 86400000 + 145000, duration: 145000,
    stages: STAGE_TEMPLATES.map(s => ({ id: s.id, name: s.name, status: 'success' as Stage, startTime: 0, endTime: s.duration, duration: s.duration, logs: ['OK'] })),
  },
];

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function BuildMonitor({ open, onClose }: Props) {
  const [builds, setBuilds] = useState<Build[]>(SEED_BUILDS);
  const [activeId, setActiveId] = useState<string>(SEED_BUILDS[0].id);
  const [autoScroll, setAutoScroll] = useState(true);
  const [running, setRunning] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const active = useMemo(() => builds.find(b => b.id === activeId), [builds, activeId]);

  // 模拟实时运行
  useEffect(() => {
    if (!running) return;
    const b: Build = {
      id: 'b_' + Date.now().toString(36), number: builds[0].number + 1,
      branch: 'feat/monitor-test', commit: 'x' + Math.random().toString(36).slice(2, 6),
      author: 'me', message: 'feat: 实时构建测试', trigger: 'manual', status: 'running',
      startTime: Date.now(),
      stages: STAGE_TEMPLATES.map(s => ({ id: s.id, name: s.name, status: 'pending' as Stage, logs: [] })),
    };
    setBuilds(prev => [b, ...prev]);
    setActiveId(b.id);

    let stageIdx = 0;
    const totalDuration = STAGE_TEMPLATES.reduce((a, s) => a + s.duration, 0);
    const tick = window.setInterval(() => {
      setBuilds(prev => {
        return prev.map(x => {
          if (x.id !== b.id) return x;
          const elapsed = Date.now() - x.startTime;
          let curElapsed = 0;
          const newStages = x.stages.map((s, i) => {
            if (i < stageIdx) return s;
            if (i === stageIdx) {
              const stageStart = curElapsed;
              const stageElapsed = elapsed - stageStart;
              const tplDur = STAGE_TEMPLATES.find(t => t.id === s.id)?.duration || 0;
              if (stageElapsed >= tplDur) {
                stageIdx++;
                return { ...s, status: 'success' as Stage, startTime: stageStart, endTime: stageStart + tplDur, duration: tplDur, logs: [...s.logs, `[${fmtMs(stageElapsed)}] ✓ ${s.name} 完成`] };
              }
              return { ...s, status: 'running' as Stage, startTime: stageStart, logs: [...s.logs, `[${fmtMs(stageElapsed)}] 正在执行 ${s.name}...`] };
            }
            curElapsed += STAGE_TEMPLATES.find(t => t.id === s.id)?.duration || 0;
            return s;
          });
          const allDone = newStages.every(s => s.status === 'success' || s.status === 'skipped');
          if (allDone) {
            setRunning(false);
            window.clearInterval(tick);
            return { ...x, status: 'success', endTime: elapsed, duration: elapsed, stages: newStages };
          }
          return { ...x, stages: newStages };
        });
      });
    }, 800);
    return () => { window.clearInterval(tick); };
  }, [running, builds]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [active?.stages, autoScroll]);

  const retry = useCallback((id: string) => {
    setBuilds(prev => prev.map(b => b.id === id ? { ...b, status: 'running', startTime: Date.now(), endTime: undefined, duration: undefined, stages: b.stages.map(s => ({ ...s, status: 'pending' as Stage, logs: [] })) } : b));
  }, []);

  const cancel = useCallback((id: string) => {
    setBuilds(prev => prev.map(b => b.id === id ? { ...b, status: 'cancelled', endTime: Date.now() } : b));
  }, []);

  const stats = useMemo(() => {
    const recent = builds.slice(0, 20);
    return {
      total: recent.length,
      success: recent.filter(b => b.status === 'success').length,
      failed: recent.filter(b => b.status === 'failed').length,
      successRate: recent.length > 0 ? Math.round(recent.filter(b => b.status === 'success').length / recent.length * 100) : 0,
      avgDuration: recent.filter(b => b.duration).reduce((a, b) => a + (b.duration || 0), 0) / Math.max(1, recent.filter(b => b.duration).length),
    };
  }, [builds]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">build_circle</span>
          <h2 className="text-sm font-semibold text-text">构建监控 (CI/CD)</h2>
          <Badge variant="success">✓ {stats.success}</Badge>
          <Badge variant="danger">✕ {stats.failed}</Badge>
          <Badge variant="info">{stats.successRate}% 成功率</Badge>
          <Badge variant="default">~{fmtMs(stats.avgDuration)}</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="play_arrow" onClick={() => setRunning(true)} loading={running}>新建构建</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-80 border-r border-border bg-bg overflow-y-auto">
            {builds.map(b => (
              <div key={b.id} onClick={() => setActiveId(b.id)}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeId === b.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-1 mb-1">
                  <span className="text-[10px] text-text-secondary">#{b.number}</span>
                  <Badge variant={b.trigger === 'push' ? 'info' : b.trigger === 'pr' ? 'warning' : b.trigger === 'manual' ? 'primary' : 'default'}>{b.trigger}</Badge>
                  <Badge variant={b.status === 'success' ? 'success' : b.status === 'failed' ? 'danger' : b.status === 'running' ? 'info' : 'default'}>{b.status}</Badge>
                </div>
                <div className="text-xs font-medium text-text truncate">{b.message}</div>
                <div className="text-[10px] text-text-secondary mt-0.5 flex items-center gap-1">
                  <span className="material-symbols-outlined text-[10px]">account_tree</span>
                  <code className="font-mono">{b.branch}</code>
                  <span>·</span>
                  <code className="font-mono">{b.commit}</code>
                  <span>·</span>
                  <span>{b.author}</span>
                </div>
                <div className="text-[10px] text-text-secondary mt-0.5">
                  {new Date(b.startTime).toLocaleTimeString()} · {b.duration ? fmtMs(b.duration) : '运行中'}
                </div>
              </div>
            ))}
          </div>

          {active && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="px-4 py-3 border-b border-border bg-surface-high">
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-text">#{active.number}</span>
                  <Badge variant={active.status === 'success' ? 'success' : active.status === 'failed' ? 'danger' : 'info'}>{active.status}</Badge>
                  <code className="text-xs text-text-secondary font-mono">{active.branch}</code>
                  <code className="text-xs text-text-secondary font-mono">@{active.commit}</code>
                  <div className="ml-auto flex items-center gap-1">
                    {active.status === 'failed' && <Button size="xs" icon="refresh" onClick={() => retry(active.id)}>重试</Button>}
                    {active.status === 'running' && <Button size="xs" icon="stop" onClick={() => cancel(active.id)}>取消</Button>}
                  </div>
                </div>
                <p className="text-sm text-text mt-1">{active.message}</p>
              </div>

              <div className="px-4 py-2 border-b border-border bg-bg">
                <h3 className="text-xs font-semibold text-text mb-1">阶段时间线</h3>
                <div className="flex items-center gap-0.5">
                  {active.stages.map((s, i) => {
                    const color = s.status === 'success' ? 'bg-success' : s.status === 'failed' ? 'bg-danger' : s.status === 'running' ? 'bg-info animate-pulse' : s.status === 'skipped' ? 'bg-text-secondary/30' : 'bg-surface-high border border-border';
                    return (
                      <div key={s.id} className="flex-1">
                        <div className="text-[9px] text-text-secondary mb-0.5 truncate">{s.name}</div>
                        <div className={'h-6 rounded ' + color + ' flex items-center justify-center text-[9px] text-white font-mono'}>
                          {s.duration ? fmtMs(s.duration) : s.status === 'running' ? '...' : ''}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-2">
                  <span className="text-xs font-semibold text-text">实时日志</span>
                  <label className="text-[10px] text-text-secondary flex items-center gap-1 ml-auto">
                    <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />自动滚动
                  </label>
                </div>
                <div ref={logRef} className="flex-1 overflow-auto bg-bg p-2 font-mono text-[10px] text-text">
                  {active.stages.flatMap(s => s.logs.map((l, i) => (
                    <div key={s.id + i} className="whitespace-pre-wrap">
                      <span className="text-text-secondary">[{s.name}]</span> <span className="text-text">{l}</span>
                    </div>
                  )))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
