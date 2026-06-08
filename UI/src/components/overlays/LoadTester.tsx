// ─────────────────────────────────────────────────────────────────
// 负载测试器 — LoadTester
// - 多种压测模式 (Ramp/Stress/Spike/Soak)
// - 实时指标 (RPS/延迟/错误率)
// - 虚拟用户管理
// - 断言与 SLA 检查
// - 分布式压测节点
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type TestMode = 'ramp' | 'stress' | 'spike' | 'soak' | 'breakpoint';
type TestStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed';

interface LoadTest {
  id: string;
  name: string;
  mode: TestMode;
  status: TestStatus;
  target: string;
  virtualUsers: number;
  duration: number;     // seconds
  rampUp: number;
  currentRps: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
  started?: number;
  progress: number;     // 0-100
}

interface TestNode {
  id: string;
  region: string;
  status: 'online' | 'offline' | 'busy';
  cpu: number;
  memory: number;
  vus: number;          // active virtual users
}

const TESTS: LoadTest[] = [
  { id: 't1', name: '登录接口压测',  mode: 'ramp',     status: 'running',  target: 'https://api.example.com/v1/auth/login', virtualUsers: 500,  duration: 300, rampUp: 60, currentRps: 1245, p50: 45, p95: 128, p99: 245, errorRate: 0.02, started: Date.now() - 180000, progress: 60 },
  { id: 't2', name: '搜索接口',     mode: 'spike',    status: 'running',  target: 'https://api.example.com/v1/search',     virtualUsers: 1000, duration: 180, rampUp: 10, currentRps: 3450, p50: 78, p95: 245, p99: 489, errorRate: 0.05, started: Date.now() - 60000, progress: 33 },
  { id: 't3', name: '支付链路稳定性', mode: 'soak',     status: 'completed', target: 'https://api.example.com/v1/payments',   virtualUsers: 200,  duration: 3600, rampUp: 120, currentRps: 0, p50: 56, p95: 167, p99: 312, errorRate: 0.01, progress: 100 },
  { id: 't4', name: '极限压测',     mode: 'breakpoint',status: 'failed',   target: 'https://api.example.com/v1/users',      virtualUsers: 5000, duration: 600, rampUp: 300, currentRps: 0, p50: 0, p95: 0, p99: 0, errorRate: 0.0, progress: 0 },
];

const NODES: TestNode[] = [
  { id: 'n1', region: 'us-east-1',   status: 'busy',   cpu: 78, memory: 62, vus: 450 },
  { id: 'n2', region: 'us-west-2',   status: 'busy',   cpu: 65, memory: 54, vus: 320 },
  { id: 'n3', region: 'eu-west-1',   status: 'online', cpu: 23, memory: 18, vus: 0 },
  { id: 'n4', region: 'ap-northeast-1', status: 'busy', cpu: 82, memory: 71, vus: 530 },
  { id: 'n5', region: 'ap-southeast-1', status: 'online', cpu: 12, memory: 8,  vus: 0 },
  { id: 'n6', region: 'sa-east-1',   status: 'offline',cpu: 0,  memory: 0,  vus: 0 },
];

function modeLabel(m: TestMode): string { return { ramp: 'Ramp 渐增', stress: 'Stress 压力', spike: 'Spike 尖峰', soak: 'Soak 浸泡', breakpoint: 'Breakpoint 极限' }[m]; }
function statusVariant(s: TestStatus): 'success' | 'info' | 'warning' | 'danger' | 'default' {
  return s === 'running' ? 'info' : s === 'completed' ? 'success' : s === 'failed' ? 'danger' : s === 'paused' ? 'warning' : 'default';
}

export function LoadTester({ open, onClose }: Props) {
  const [tab, setTab] = useState<'tests' | 'realtime' | 'nodes' | 'results'>('tests');
  const [activeTestId, setActiveTestId] = useState<string>(TESTS[0].id);
  const activeTest = TESTS.find(t => t.id === activeTestId) || TESTS[0];

  const totalVus = NODES.reduce((s, n) => s + n.vus, 0);
  const onlineNodes = NODES.filter(n => n.status !== 'offline').length;
  const activeTests = TESTS.filter(t => t.status === 'running').length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">speed</span>
          <h2 className="text-sm font-semibold text-text">负载测试器</h2>
          <Badge variant="info">{TESTS.length} 测试</Badge>
          <Badge variant="info">{activeTests} 运行中</Badge>
          <Badge variant="success">{totalVus.toLocaleString()} VUs</Badge>
          <Badge variant="info">{onlineNodes}/{NODES.length} 节点</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="play_arrow" variant="primary">新建测试</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'tests',    l: `测试 (${TESTS.length})` },
            { k: 'realtime', l: '实时指标' },
            { k: 'nodes',    l: `节点 (${NODES.length})` },
            { k: 'results',  l: '结果与报告' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-72 border-r border-border bg-bg overflow-y-auto">
            {tab === 'tests' && TESTS.map(t => (
              <div key={t.id} onClick={() => setActiveTestId(t.id)}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeTestId === t.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-1 mb-1">
                  <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
                  <Badge variant="info">{modeLabel(t.mode)}</Badge>
                </div>
                <div className="text-[11px] font-medium text-text">{t.name}</div>
                <div className="text-[10px] text-text-secondary mt-0.5">
                  {t.virtualUsers.toLocaleString()} VUs · {t.duration}s
                </div>
                {t.status === 'running' && (
                  <div className="h-1 bg-bg rounded-full overflow-hidden mt-1">
                    <div className="h-full bg-accent" style={{ width: `${t.progress}%` }}></div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'tests' && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-sm font-semibold text-text mb-1">{activeTest.name}</h3>
                  <p className="text-[10px] text-text-secondary font-mono mb-2">{activeTest.target}</p>
                  <div className="grid grid-cols-4 gap-2 text-[11px]">
                    <div><p className="text-[10px] text-text-secondary">模式</p><Badge variant="info">{modeLabel(activeTest.mode)}</Badge></div>
                    <div><p className="text-[10px] text-text-secondary">虚拟用户</p><p className="text-text font-mono">{activeTest.virtualUsers.toLocaleString()}</p></div>
                    <div><p className="text-[10px] text-text-secondary">持续</p><p className="text-text font-mono">{activeTest.duration}s</p></div>
                    <div><p className="text-[10px] text-text-secondary">Ramp-up</p><p className="text-text font-mono">{activeTest.rampUp}s</p></div>
                  </div>
                  {activeTest.status === 'running' && (
                    <div className="mt-2">
                      <div className="flex items-center justify-between text-[10px] mb-0.5">
                        <span className="text-text-secondary">进度</span>
                        <span className="text-text font-mono">{activeTest.progress}%</span>
                      </div>
                      <div className="h-1.5 bg-surface-high rounded-full overflow-hidden">
                        <div className="h-full bg-accent" style={{ width: `${activeTest.progress}%` }}></div>
                      </div>
                    </div>
                  )}
                </div>

                {activeTest.status === 'running' && (
                  <div className="grid grid-cols-4 gap-3">
                    <div className="bg-bg border border-border-light rounded-lg p-3">
                      <p className="text-[10px] text-text-secondary">RPS</p>
                      <p className="text-2xl font-bold text-text font-mono mt-1">{activeTest.currentRps.toLocaleString()}</p>
                    </div>
                    <div className="bg-bg border border-border-light rounded-lg p-3">
                      <p className="text-[10px] text-text-secondary">P50</p>
                      <p className="text-2xl font-bold text-text font-mono mt-1">{activeTest.p50}ms</p>
                    </div>
                    <div className="bg-bg border border-border-light rounded-lg p-3">
                      <p className="text-[10px] text-text-secondary">P95</p>
                      <p className="text-2xl font-bold text-warning font-mono mt-1">{activeTest.p95}ms</p>
                    </div>
                    <div className="bg-bg border border-border-light rounded-lg p-3">
                      <p className="text-[10px] text-text-secondary">P99</p>
                      <p className="text-2xl font-bold text-danger font-mono mt-1">{activeTest.p99}ms</p>
                    </div>
                  </div>
                )}
              </>
            )}

            {tab === 'realtime' && (
              <div className="space-y-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">实时 RPS 趋势</h3>
                  <svg viewBox="0 0 600 100" className="w-full h-24">
                    {(() => {
                      const points = Array.from({ length: 60 }, (_, i) => 1000 + Math.sin(i / 3) * 200 + Math.random() * 100);
                      const max = Math.max(...points);
                      const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i / 59) * 590 + 5} ${95 - (p / max) * 85}`).join(' ');
                      return <><path d={path} fill="none" stroke="#a855f7" strokeWidth="1.5" /><path d={path + ' L 595 95 L 5 95 Z'} fill="rgba(168,85,247,0.1)" /></>;
                    })()}
                  </svg>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">延迟分布 (P50/P95/P99)</h3>
                    <svg viewBox="0 0 300 80" className="w-full h-20">
                      {(() => {
                        const points = Array.from({ length: 50 }, (_, i) => Math.exp(-Math.pow((i - 30) / 8, 2)) * 70);
                        const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i / 49) * 290 + 5} ${75 - p}`).join(' ');
                        return <><path d={path} fill="none" stroke="#3b82f6" strokeWidth="1.5" /><path d={path + ' L 295 75 L 5 75 Z'} fill="rgba(59,130,246,0.1)" /></>;
                      })()}
                    </svg>
                  </div>
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">错误率</h3>
                    <svg viewBox="0 0 300 80" className="w-full h-20">
                      {(() => {
                        const points = Array.from({ length: 50 }, () => 0.5 + Math.random() * 2);
                        const max = 5;
                        const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i / 49) * 290 + 5} ${75 - (p / max) * 70}`).join(' ');
                        return <><path d={path} fill="none" stroke="#dc2626" strokeWidth="1.5" /></>;
                      })()}
                    </svg>
                  </div>
                </div>
              </div>
            )}

            {tab === 'nodes' && (
              <div className="grid grid-cols-3 gap-3">
                {NODES.map(n => (
                  <div key={n.id} className="bg-bg border border-border-light rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={'w-2 h-2 rounded-full ' + (n.status === 'online' ? 'bg-success' : n.status === 'busy' ? 'bg-info' : 'bg-text-secondary')}></span>
                      <span className="text-[11px] font-medium text-text">{n.region}</span>
                      <Badge variant={n.status === 'busy' ? 'info' : n.status === 'online' ? 'success' : 'default'}>{n.status}</Badge>
                    </div>
                    <div className="space-y-1.5 text-[10px]">
                      <div>
                        <div className="flex justify-between mb-0.5"><span className="text-text-secondary">CPU</span><span className="text-text font-mono">{n.cpu}%</span></div>
                        <div className="h-1 bg-surface-high rounded-full overflow-hidden"><div className="h-full bg-accent" style={{ width: `${n.cpu}%` }}></div></div>
                      </div>
                      <div>
                        <div className="flex justify-between mb-0.5"><span className="text-text-secondary">Memory</span><span className="text-text font-mono">{n.memory}%</span></div>
                        <div className="h-1 bg-surface-high rounded-full overflow-hidden"><div className="h-full bg-info" style={{ width: `${n.memory}%` }}></div></div>
                      </div>
                      <div className="text-text">VUs: <span className="font-mono font-semibold">{n.vus}</span></div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'results' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">完成的测试报告</h3>
                <div className="space-y-1.5">
                  {TESTS.filter(t => t.status === 'completed' || t.status === 'failed').map(t => (
                    <div key={t.id} className="bg-surface-high rounded p-2">
                      <div className="flex items-center gap-2">
                        <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
                        <span className="text-[11px] font-medium text-text">{t.name}</span>
                        <span className="text-[10px] text-text-secondary ml-auto">{t.virtualUsers.toLocaleString()} VUs · {t.duration}s</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
