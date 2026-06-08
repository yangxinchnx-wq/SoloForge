// ─────────────────────────────────────────────────────────────────
// 部署流水线 — DeploymentPipeline
// - CI/CD 流水线可视化
// - 多环境部署 (dev/staging/prod)
// - 蓝绿/金丝雀/滚动发布
// - 审批门禁
// - 回滚机制
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled' | 'awaiting_approval';
type DeployStrategy = 'recreate' | 'rolling' | 'blue_green' | 'canary' | 'a_b_test';

interface Stage {
  id: string;
  name: string;
  status: StageStatus;
  duration?: number;
  started?: number;
  command: string;
  agent?: string;
  approver?: string;
  artifacts?: string[];
  logs?: string[];
}

interface Environment {
  id: string;
  name: string;
  cluster: string;
  replicas: { ready: number; desired: number };
  version: string;
  strategy: DeployStrategy;
  traffic: number;
  status: 'healthy' | 'degraded' | 'down';
}

const STAGES: Stage[] = [
  { id: 's1', name: 'Lint & Format',     status: 'success', duration: 23,   command: 'pnpm lint', agent: 'eslint-1',  started: Date.now() - 600000, logs: ['✓ 247 files checked', '✓ 0 errors, 0 warnings'] },
  { id: 's2', name: 'Unit Tests',        status: 'success', duration: 156,  command: 'pnpm test',  agent: 'jest-1',    started: Date.now() - 540000, artifacts: ['coverage.xml'], logs: ['✓ 1247 tests passed', 'Coverage: 87.3%'] },
  { id: 's3', name: 'Build',             status: 'success', duration: 89,   command: 'pnpm build', agent: 'builder-1', started: Date.now() - 360000, artifacts: ['app-1.4.3.tar.gz', 'docker-image:sha256:abc123'], logs: ['✓ Build complete', 'Image size: 142 MB'] },
  { id: 's4', name: 'Security Scan',     status: 'success', duration: 45,   command: 'trivy + snyk', agent: 'scanner-1', started: Date.now() - 240000, artifacts: ['security-report.json'], logs: ['✓ 0 critical, 2 high vulnerabilities'] },
  { id: 's5', name: 'Push to Registry', status: 'success', duration: 18,   command: 'docker push',  agent: 'registry-1',started: Date.now() - 180000, artifacts: ['registry.internal/soloforge:1.4.3'] },
  { id: 's6', name: 'Deploy to Staging',status: 'success', duration: 67,   command: 'kubectl apply -f staging/', started: Date.now() - 120000, logs: ['✓ 3/3 pods ready', '✓ health check passed'] },
  { id: 's7', name: 'Integration Tests',status: 'success', duration: 234,  command: 'pnpm test:e2e', agent: 'cypress-1', started: Date.now() - 60000,  logs: ['✓ 89 e2e tests passed'] },
  { id: 's8', name: 'Approval Gate',    status: 'awaiting_approval',      command: 'manual approval', approver: 'Tech Lead', logs: ['⏳ Waiting for @tech-lead approval'] },
  { id: 's9', name: 'Deploy to Prod',   status: 'pending',                 command: 'kubectl apply -f prod/', logs: [] },
  { id: 's10',name: 'Smoke Test',       status: 'pending',                 command: 'pnpm test:smoke', logs: [] },
  { id: 's11',name: 'Notify',           status: 'pending',                 command: 'slack-notify', logs: [] },
];

const ENVIRONMENTS: Environment[] = [
  { id: 'e1', name: 'Development', cluster: 'k8s-dev',  replicas: { ready: 2, desired: 2 },  version: '1.4.3-rc.2', strategy: 'recreate',     traffic: 0,   status: 'healthy' },
  { id: 'e2', name: 'Staging',     cluster: 'k8s-stg',  replicas: { ready: 3, desired: 3 },  version: '1.4.3-rc.1', strategy: 'rolling',      traffic: 0,   status: 'healthy' },
  { id: 'e3', name: 'Production',  cluster: 'k8s-prod', replicas: { ready: 24, desired: 24 }, version: '1.4.2',     strategy: 'blue_green',   traffic: 100, status: 'healthy' },
  { id: 'e4', name: 'Canary',      cluster: 'k8s-prod', replicas: { ready: 2, desired: 2 },  version: '1.4.3',     strategy: 'canary',       traffic: 5,   status: 'healthy' },
];

const STRATEGY_LABEL: Record<DeployStrategy, string> = {
  recreate:   'Recreate 重建',
  rolling:    'Rolling 滚动',
  blue_green: 'Blue/Green 蓝绿',
  canary:     'Canary 金丝雀',
  a_b_test:   'A/B Test',
};

function statusVariant(s: StageStatus): 'success' | 'info' | 'warning' | 'danger' | 'default' {
  return s === 'success' ? 'success' : s === 'running' ? 'info' : s === 'failed' ? 'danger' : s === 'awaiting_approval' ? 'warning' : 'default';
}
function statusLabel(s: StageStatus): string {
  return { pending: '等待', running: '运行中', success: '成功', failed: '失败', skipped: '跳过', cancelled: '取消', awaiting_approval: '待审批' }[s];
}

export function DeploymentPipeline({ open, onClose }: Props) {
  const [tab, setTab] = useState<'pipeline' | 'environments' | 'history' | 'rollback'>('pipeline');
  const [activeStageId, setActiveStageId] = useState<string>(STAGES[6].id);
  const activeStage = STAGES.find(s => s.id === activeStageId) || STAGES[0];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">rocket_launch</span>
          <h2 className="text-sm font-semibold text-text">部署流水线</h2>
          <Badge variant="info">v1.4.3</Badge>
          <Badge variant="warning">审批中</Badge>
          <Badge variant="info">Commit abc123</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="play_arrow" variant="primary">触发部署</Button>
            <Button size="sm" icon="undo">回滚</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'pipeline',     l: '流水线' },
            { k: 'environments', l: `环境 (${ENVIRONMENTS.length})` },
            { k: 'history',      l: '部署历史' },
            { k: 'rollback',     l: '回滚' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3 space-y-3">
          {tab === 'pipeline' && (
            <>
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-3">流水线阶段</h3>
                <div className="relative">
                  <div className="flex items-center gap-2 overflow-x-auto pb-2">
                    {STAGES.map((s, i) => (
                      <div key={s.id} className="flex items-center gap-2 shrink-0">
                        <div onClick={() => setActiveStageId(s.id)}
                          className={'cursor-pointer rounded-lg p-2 border min-w-32 transition ' + (
                            s.status === 'success' ? 'border-success/40 bg-success/5' :
                            s.status === 'failed' ? 'border-danger/40 bg-danger/5' :
                            s.status === 'running' ? 'border-info/40 bg-info/5 animate-pulse' :
                            s.status === 'awaiting_approval' ? 'border-warning/40 bg-warning/5' :
                            'border-border-light bg-surface-high'
                          ) + ' ' + (activeStageId === s.id ? 'ring-2 ring-accent' : '')}>
                          <div className="flex items-center gap-1 mb-1">
                            <span className="text-[10px] text-text-secondary font-mono">#{i + 1}</span>
                            <Badge variant={statusVariant(s.status)}>{statusLabel(s.status)}</Badge>
                          </div>
                          <p className="text-[11px] font-medium text-text">{s.name}</p>
                          {s.duration && <p className="text-[10px] text-text-secondary mt-0.5">{s.duration}s</p>}
                          {s.approver && <p className="text-[10px] text-warning mt-0.5">@ {s.approver}</p>}
                        </div>
                        {i < STAGES.length - 1 && (
                          <span className={'material-symbols-outlined text-base ' + (
                            s.status === 'success' ? 'text-success' :
                            s.status === 'failed' ? 'text-danger' :
                            'text-text-secondary'
                          )}>arrow_forward</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">阶段详情: {activeStage.name}</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] text-text-secondary mb-1">命令</p>
                    <code className="text-[11px] font-mono text-text bg-surface-high px-2 py-1 rounded block">{activeStage.command}</code>
                  </div>
                  <div>
                    <p className="text-[10px] text-text-secondary mb-1">执行 Agent</p>
                    <p className="text-[11px] text-text">{activeStage.agent || activeStage.approver || '-'}</p>
                  </div>
                </div>
                {activeStage.logs && activeStage.logs.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[10px] text-text-secondary mb-1">日志</p>
                    <pre className="bg-black text-green-300 rounded p-2 text-[10px] font-mono max-h-32 overflow-y-auto">{activeStage.logs.join('\n')}</pre>
                  </div>
                )}
                {activeStage.artifacts && activeStage.artifacts.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[10px] text-text-secondary mb-1">产物</p>
                    <div className="space-y-1">
                      {activeStage.artifacts.map(a => (
                        <div key={a} className="flex items-center gap-2 bg-surface-high rounded p-1.5">
                          <span className="material-symbols-outlined text-sm text-accent">inventory_2</span>
                          <code className="text-[10px] font-mono text-text flex-1">{a}</code>
                          <Button size="sm" icon="download">下载</Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {activeStage.status === 'awaiting_approval' && (
                  <div className="mt-3 bg-warning/10 border border-warning/30 rounded p-2 flex items-center gap-2">
                    <span className="material-symbols-outlined text-warning">pending</span>
                    <span className="text-[11px] text-text flex-1">等待 <strong>{activeStage.approver}</strong> 审批后继续部署到生产</span>
                    <Button size="sm" variant="primary" icon="check">批准</Button>
                    <Button size="sm" variant="danger" icon="close">拒绝</Button>
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'environments' && (
            <div className="grid grid-cols-2 gap-3">
              {ENVIRONMENTS.map(env => (
                <div key={env.id} className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-sm font-semibold text-text">{env.name}</h3>
                    <Badge variant={env.status === 'healthy' ? 'success' : env.status === 'degraded' ? 'warning' : 'danger'}>{env.status}</Badge>
                    <span className="ml-auto text-[10px] text-text-secondary font-mono">{env.cluster}</span>
                  </div>
                  <div className="space-y-1.5 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="text-text-secondary w-20">版本</span>
                      <code className="font-mono text-text">{env.version}</code>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-text-secondary w-20">副本</span>
                      <span className="text-text font-mono">{env.replicas.ready}/{env.replicas.desired}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-text-secondary w-20">策略</span>
                      <Badge variant="info">{STRATEGY_LABEL[env.strategy]}</Badge>
                    </div>
                    {env.traffic > 0 && (
                      <div>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-text-secondary w-20">流量</span>
                          <span className="text-text font-mono">{env.traffic}%</span>
                        </div>
                        <div className="h-1.5 bg-surface-high rounded-full overflow-hidden">
                          <div className="h-full bg-accent" style={{ width: `${env.traffic}%` }}></div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'history' && (
            <div className="bg-bg border border-border-light rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">部署历史</h3>
              <div className="space-y-1.5">
                {[
                  { v: '1.4.3', env: 'Production', time: Date.now() - 60000,    status: 'in_progress', approver: 'Tech Lead' },
                  { v: '1.4.3', env: 'Staging',    time: Date.now() - 180000,   status: 'success',     approver: 'Tech Lead' },
                  { v: '1.4.2', env: 'Production', time: Date.now() - 86400000,  status: 'success' },
                  { v: '1.4.1', env: 'Production', time: Date.now() - 172800000, status: 'rolled_back' },
                  { v: '1.4.0', env: 'Production', time: Date.now() - 259200000, status: 'success' },
                  { v: '1.3.5', env: 'Production', time: Date.now() - 345600000, status: 'success' },
                ].map((d, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 bg-surface-high rounded">
                    <Badge variant={d.status === 'success' ? 'success' : d.status === 'in_progress' ? 'info' : d.status === 'rolled_back' ? 'warning' : 'danger'}>{d.status}</Badge>
                    <code className="text-[11px] font-mono text-text">v{d.v}</code>
                    <Badge variant="info">{d.env}</Badge>
                    {d.approver && <span className="text-[10px] text-text-secondary">@ {d.approver}</span>}
                    <span className="text-[10px] text-text-secondary ml-auto">{new Date(d.time).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'rollback' && (
            <div className="bg-bg border border-border-light rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">回滚到历史版本</h3>
              <div className="bg-warning/10 border border-warning/30 rounded p-3 mb-3">
                <p className="text-[11px] text-text"><span className="material-symbols-outlined text-base align-middle text-warning">warning</span> 回滚将立即替换当前生产环境,可能造成服务中断。请确认操作。</p>
              </div>
              <div className="space-y-1.5">
                {['1.4.2', '1.4.0', '1.3.5', '1.3.4', '1.3.3'].map((v, i) => (
                  <div key={v} className="flex items-center gap-2 p-2 bg-surface-high rounded">
                    <input type="radio" name="rollback" defaultChecked={i === 0} className="shrink-0" />
                    <code className="text-[11px] font-mono text-text flex-1">v{v}</code>
                    <Badge variant="info">{i === 0 ? '当前' : `${i * 3} 天前`}</Badge>
                    <Button size="sm" icon="undo" variant="danger">回滚</Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
