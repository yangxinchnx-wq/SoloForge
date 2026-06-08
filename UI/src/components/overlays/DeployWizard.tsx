// ─────────────────────────────────────────────────────────────────
// 部署向导 (4 步：环境 → 构建 → 通道 → 确认)
// 顶栏"部署"按钮 + Home 快速操作
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { pushNotification } from './Notifications';
import { Button, Badge, ProgressBar } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  projectName?: string;
}

const STEPS = [
  { id: 'env',     label: '环境',     icon: 'computer' },
  { id: 'build',   label: '构建',     icon: 'build_circle' },
  { id: 'channel', label: '通道',     icon: 'rocket_launch' },
  { id: 'confirm', label: '确认',     icon: 'check_circle' },
] as const;

const ENVS = [
  { id: 'dev',     label: '开发环境', icon: 'computer',    desc: '本地开发 · 自动重启 · 调试日志', color: 'text-accent' },
  { id: 'staging', label: '预发环境', icon: 'science',     desc: '镜像生产 · 蓝绿部署 · 流量镜像', color: 'text-warning' },
  { id: 'prod',    label: '生产环境', icon: 'verified',    desc: '零停机 · 自动回滚 · 监控告警',     color: 'text-success' },
] as const;

const CHANNELS = [
  { id: 'k8s',  label: 'Kubernetes',  icon: 'deployed_code', desc: '集群部署 (推荐)' },
  { id: 'docker', label: 'Docker',    icon: 'deployed_code_history', desc: '单机容器' },
  { id: 'vm',   label: '虚拟机',       icon: 'dns',           desc: '裸机 / VM' },
  { id: 'edge', label: '边缘节点',     icon: 'router',        desc: 'CDN 边缘' },
] as const;

export function DeployWizard({ open, onClose, projectName = 'Mollag' }: Props) {
  const [step, setStep] = useState(0);
  const [env, setEnv] = useState<typeof ENVS[number]['id']>('staging');
  const [channel, setChannel] = useState<typeof CHANNELS[number]['id']>('k8s');
  const [buildCmd, setBuildCmd] = useState('npm run build && npx tsx scripts/db-migrate.ts');
  const [replicas, setReplicas] = useState(3);
  const [autoRollback, setAutoRollback] = useState(true);
  const [healthCheck, setHealthCheck] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setStep(0);
      setProgress(0);
      setLogs([]);
      setDeploying(false);
    }
  }, [open]);

  // 部署进度模拟
  useEffect(() => {
    if (!deploying) return;
    if (progress >= 100) {
      setDeploying(false);
      setStep(3);
      pushNotification({
        level: 'success',
        title: '部署完成',
        message: `${projectName} 已成功部署到 ${env} 环境`,
      });
      return;
    }
    const timer = setTimeout(() => {
      setProgress(p => Math.min(100, p + Math.random() * 12 + 6));
      const msgs = [
        '▶ 执行构建命令...',
        '✓ TypeScript 编译通过',
        '✓ Vite 打包完成 (379 KB → 112 KB gzip)',
        '✓ 数据库迁移: 5 个 schema 已应用',
        '▶ 上传镜像到 registry...',
        `✓ 推送 ${projectName}:v1.0.${Math.floor(Math.random() * 9) + 1}`,
        `▶ 滚动更新到 ${env} 集群...`,
        `✓ 副本数扩展到 ${replicas}`,
        '✓ 健康检查通过 (HTTP 200)',
        '✓ 流量切换完成',
      ];
      setLogs(prev => [...prev, msgs[Math.min(Math.floor(progress / 12), msgs.length - 1)]]);
    }, 400);
    return () => clearTimeout(timer);
  }, [deploying, progress, env, replicas, projectName]);

  if (!open) return null;

  const next = () => {
    if (step < STEPS.length - 1) setStep(step + 1);
    else if (step === STEPS.length - 1) {
      // 最后一页：开始部署
      setStep(3);
      setDeploying(true);
      setProgress(0);
    }
  };
  const back = () => { if (step > 0) setStep(step - 1); };

  const envMeta = ENVS.find(e => e.id === env)!;
  const channelMeta = CHANNELS.find(c => c.id === channel)!;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in p-4"
      onClick={onClose}
    >
      <div
        className="w-[680px] max-w-[95vw] max-h-[90vh] bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary filled">rocket_launch</span>
            <span className="text-sm font-display font-bold text-text">部署向导</span>
            <Badge variant="primary" className="text-[9px]">{projectName}</Badge>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text p-1">
            <span className="material-symbols-outlined text-base">close</span>
          </button>
        </div>

        {/* 步骤指示器 */}
        <div className="flex items-center px-6 py-3 border-b border-border-light bg-bg-dim shrink-0">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center flex-1">
              <div className={`flex items-center gap-1.5 ${i === step ? 'text-primary' : i < step ? 'text-success' : 'text-text-secondary'}`}>
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold ${
                  i === step ? 'bg-primary text-on-primary' : i < step ? 'bg-success/20 text-success' : 'bg-surface-high text-text-secondary'
                }`}>
                  {i < step ? <span className="material-symbols-outlined text-xs">check</span> : i + 1}
                </div>
                <span className="text-[11px] font-medium">{s.label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-px mx-2 ${i < step ? 'bg-success' : 'bg-border-light'}`} />
              )}
            </div>
          ))}
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto scrollbar-thin p-4">
          {step === 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-text">选择部署环境</h3>
              <p className="text-[11px] text-text-secondary">环境决定了部署的 SLA 和回滚策略</p>
              <div className="space-y-2">
                {ENVS.map(e => (
                  <button
                    key={e.id}
                    onClick={() => setEnv(e.id)}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left ${
                      env === e.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border-light hover:border-primary/40 bg-surface-low'
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center bg-surface border border-border-light ${e.color}`}>
                      <span className="material-symbols-outlined text-xl">{e.icon}</span>
                    </div>
                    <div className="flex-1">
                      <div className="text-xs font-semibold text-text">{e.label}</div>
                      <div className="text-[10px] text-text-secondary mt-0.5">{e.desc}</div>
                    </div>
                    {env === e.id && <span className="material-symbols-outlined text-primary filled">check_circle</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-text">构建配置</h3>
              <div>
                <label className="text-[10px] text-text-secondary block mb-1">构建命令</label>
                <textarea
                  value={buildCmd}
                  onChange={e => setBuildCmd(e.target.value)}
                  rows={3}
                  className="w-full px-2 py-1.5 bg-bg-dim border border-border-light rounded text-[11px] font-mono text-text focus:outline-none focus:border-primary"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-text-secondary block mb-1">副本数</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min={1} max={10} value={replicas}
                      onChange={e => setReplicas(Number(e.target.value))}
                      className="flex-1 accent-primary"
                    />
                    <span className="text-xs font-mono text-text w-6 text-right">{replicas}</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-text-secondary block">安全选项</label>
                  <label className="flex items-center gap-1.5 text-xs text-text cursor-pointer">
                    <input type="checkbox" checked={autoRollback} onChange={e => setAutoRollback(e.target.checked)} className="accent-primary" />
                    <span className="material-symbols-outlined text-sm text-warning">undo</span>
                    自动回滚
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-text cursor-pointer">
                    <input type="checkbox" checked={healthCheck} onChange={e => setHealthCheck(e.target.checked)} className="accent-primary" />
                    <span className="material-symbols-outlined text-sm text-success">monitor_heart</span>
                    健康检查
                  </label>
                </div>
              </div>
              <div className="bg-bg-dim border border-border-light rounded p-2 text-[10px] font-mono text-text-secondary">
                <div>预计构建时间: ~45s</div>
                <div>预计产物大小: ~112 KB gzip</div>
                <div>运行时镜像: node:20-alpine</div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-text">选择部署通道</h3>
              <div className="grid grid-cols-2 gap-2">
                {CHANNELS.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setChannel(c.id)}
                    className={`flex items-center gap-2 p-2.5 rounded-lg border-2 transition-all text-left ${
                      channel === c.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border-light hover:border-primary/40 bg-surface-low'
                    }`}
                  >
                    <span className={`material-symbols-outlined text-lg ${channel === c.id ? 'text-primary' : 'text-text-secondary'}`}>{c.icon}</span>
                    <div className="flex-1">
                      <div className="text-xs font-semibold text-text">{c.label}</div>
                      <div className="text-[9px] text-text-secondary">{c.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              {!deploying && progress === 0 && (
                <>
                  <h3 className="text-sm font-semibold text-text">确认部署</h3>
                  <div className="bg-bg-dim border border-border-light rounded-lg p-3 space-y-1.5 text-xs">
                    <div className="flex justify-between"><span className="text-text-secondary">项目</span><span className="text-text font-mono">{projectName}</span></div>
                    <div className="flex justify-between"><span className="text-text-secondary">环境</span><Badge variant="primary">{envMeta.label}</Badge></div>
                    <div className="flex justify-between"><span className="text-text-secondary">通道</span><span className="text-text">{channelMeta.label}</span></div>
                    <div className="flex justify-between"><span className="text-text-secondary">副本数</span><span className="text-text font-mono">{replicas}</span></div>
                    <div className="flex justify-between"><span className="text-text-secondary">回滚</span><span className="text-text">{autoRollback ? '启用' : '关闭'}</span></div>
                    <div className="flex justify-between"><span className="text-text-secondary">健康检查</span><span className="text-text">{healthCheck ? '启用' : '关闭'}</span></div>
                  </div>
                  {/* 部署估算 */}
                  {(() => {
                    // 估算: 时间 / 成本 / 风险等级
                    const envCostFactor = env === 'prod' ? 3 : env === 'staging' ? 1.5 : 1;
                    const channelSpeed = channel === 'k8s' ? 1.0 : channel === 'docker' ? 0.8 : channel === 'vm' ? 1.4 : 0.6;
                    const estSeconds = Math.round(replicas * 4 * envCostFactor * channelSpeed + 20);
                    const estCost = (replicas * 0.5 * envCostFactor).toFixed(2);
                    const riskLevel = env === 'prod' ? (replicas >= 5 ? 'medium' : 'low') : env === 'staging' ? 'low' : 'none';
                    const riskMeta = {
                      none:  { label: '无风险',   color: 'text-text-secondary', bg: 'bg-surface-high',  icon: 'shield' },
                      low:   { label: '低风险',   color: 'text-success',       bg: 'bg-success/10',    icon: 'shield' },
                      medium:{ label: '中风险',   color: 'text-warning',       bg: 'bg-warning/10',    icon: 'warning' },
                      high:  { label: '高风险',   color: 'text-danger',        bg: 'bg-danger/10',     icon: 'crisis_alert' },
                    }[riskLevel];
                    return (
                      <div className="grid grid-cols-4 gap-1.5">
                        <div className="p-2 bg-surface border border-border-light rounded text-center">
                          <div className="text-[9px] text-text-secondary uppercase">预计时长</div>
                          <div className="text-sm font-bold text-text font-mono mt-0.5">{estSeconds}s</div>
                        </div>
                        <div className="p-2 bg-surface border border-border-light rounded text-center">
                          <div className="text-[9px] text-text-secondary uppercase">成本</div>
                          <div className="text-sm font-bold text-text font-mono mt-0.5">${estCost}</div>
                        </div>
                        <div className={`p-2 border border-border-light rounded text-center ${riskMeta.bg}`}>
                          <div className="text-[9px] text-text-secondary uppercase">风险</div>
                          <div className={`text-sm font-bold font-mono mt-0.5 flex items-center justify-center gap-0.5 ${riskMeta.color}`}>
                            <span className="material-symbols-outlined text-xs">{riskMeta.icon}</span>
                            {riskMeta.label}
                          </div>
                        </div>
                        <div className="p-2 bg-surface border border-border-light rounded text-center">
                          <div className="text-[9px] text-text-secondary uppercase">回滚</div>
                          <div className={`text-sm font-bold font-mono mt-0.5 ${autoRollback ? 'text-success' : 'text-text-secondary'}`}>
                            {autoRollback ? '✓ 自动' : '✗ 手动'}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                  <p className="text-[11px] text-text-secondary text-center">点击"开始部署"将启动完整流程</p>
                </>
              )}
              {(deploying || progress > 0) && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary animate-rotate-360">progress_activity</span>
                    <span className="text-sm font-semibold text-text">部署中...</span>
                    <span className="ml-auto text-xs font-mono text-text">{Math.floor(progress)}%</span>
                  </div>
                  <ProgressBar value={progress} color="primary" />
                  <div className="bg-bg-dim border border-border-light rounded p-2 max-h-[40vh] overflow-y-auto scrollbar-thin font-mono text-[10px] space-y-0.5">
                    {logs.length === 0 ? (
                      <div className="text-text-secondary">准备中...</div>
                    ) : logs.map((l, i) => (
                      <div key={i} className={l.startsWith('✓') ? 'text-success' : l.startsWith('▶') ? 'text-text' : 'text-text-secondary'}>
                        {l}
                      </div>
                    ))}
                    {deploying && <div className="text-primary animate-typing">▊</div>}
                  </div>
                  {progress >= 100 && (
                    <div className="flex items-center gap-2 p-2 bg-success/10 border border-success/30 rounded">
                      <span className="material-symbols-outlined text-success filled">check_circle</span>
                      <span className="text-xs text-success font-semibold">部署成功</span>
                      <a href="#" className="ml-auto text-[10px] text-primary hover:underline">查看服务 →</a>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 h-12 border-t border-border bg-bg-dim shrink-0">
          <div className="text-[10px] text-text-secondary">
            步骤 {step + 1} / {STEPS.length} · {STEPS[step].label}
          </div>
          <div className="flex items-center gap-2">
            {step > 0 && progress === 0 && (
              <Button variant="ghost" size="sm" onClick={back}>上一步</Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
            {progress < 100 && (
              <Button
                variant="primary" size="sm"
                icon={step === STEPS.length - 1 ? 'rocket_launch' : 'arrow_forward'}
                onClick={next}
              >
                {step === STEPS.length - 1 ? '开始部署' : '下一步'}
              </Button>
            )}
            {progress >= 100 && (
              <Button variant="primary" size="sm" icon="check" onClick={onClose}>完成</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
