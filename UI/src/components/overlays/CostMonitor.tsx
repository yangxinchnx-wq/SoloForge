// ─────────────────────────────────────────────────────────────────
// 云成本监控 — CostMonitor
// - 多云 (AWS/GCP/Azure/自建) 资源费用
// - 按服务/区域/标签分组
// - 月度趋势 + 预算告警
// - 节省建议 (rightsizing/spot/reserved)
// - 账单导出
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type Provider = 'AWS' | 'GCP' | 'Azure' | 'Self-hosted';
type ServiceType = 'compute' | 'storage' | 'network' | 'database' | 'ml' | 'other';

interface CostItem {
  id: string;
  provider: Provider;
  service: string;
  type: ServiceType;
  region: string;
  resource: string;
  dailyCost: number;  // USD
  monthToDate: number;
  tags: Record<string, string>;
  usage: number; // %
  recommendation?: 'rightsizing' | 'reserved' | 'spot' | 'idle' | 'none';
}

const SEED_COSTS: CostItem[] = [
  // AWS
  { id: 'c1', provider: 'AWS', service: 'EC2',         type: 'compute',  region: 'us-east-1', resource: 'i-0abc123 (m5.2xlarge)', dailyCost: 192, monthToDate: 4032, tags: { env: 'prod', team: 'platform' }, usage: 78, recommendation: 'reserved' },
  { id: 'c2', provider: 'AWS', service: 'EC2',         type: 'compute',  region: 'us-east-1', resource: 'i-0def456 (t3.medium)',  dailyCost: 24,  monthToDate: 504,  tags: { env: 'dev', team: 'frontend' }, usage: 12, recommendation: 'rightsizing' },
  { id: 'c3', provider: 'AWS', service: 'RDS',         type: 'database', region: 'us-east-1', resource: 'db-prod (db.r5.large)',  dailyCost: 96,  monthToDate: 2016, tags: { env: 'prod', team: 'platform' }, usage: 65, recommendation: 'reserved' },
  { id: 'c4', provider: 'AWS', service: 'S3',          type: 'storage',  region: 'us-east-1', resource: 'bucket-data-lake',       dailyCost: 18,  monthToDate: 378,  tags: { env: 'prod', team: 'data' }, usage: 45, recommendation: 'none' },
  { id: 'c5', provider: 'AWS', service: 'CloudFront',  type: 'network',  region: 'global',    resource: 'cdn-prod',                dailyCost: 32,  monthToDate: 672,  tags: { env: 'prod' }, usage: 88, recommendation: 'none' },
  { id: 'c6', provider: 'AWS', service: 'SageMaker',   type: 'ml',       region: 'us-west-2', resource: 'ml.g4dn.xlarge (4)',     dailyCost: 384, monthToDate: 8064, tags: { env: 'prod', team: 'ai' }, usage: 92, recommendation: 'spot' },
  { id: 'c7', provider: 'AWS', service: 'EC2',         type: 'compute',  region: 'us-east-1', resource: 'i-0ghi789 (m5.large)',    dailyCost: 0,   monthToDate: 168,  tags: { env: 'dev', team: 'test' }, usage: 0, recommendation: 'idle' },
  // GCP
  { id: 'c8', provider: 'GCP', service: 'GKE',         type: 'compute',  region: 'us-central1', resource: 'gke-cluster-prod',      dailyCost: 320, monthToDate: 6720, tags: { env: 'prod', team: 'platform' }, usage: 70, recommendation: 'reserved' },
  { id: 'c9', provider: 'GCP', service: 'BigQuery',    type: 'database', region: 'us-central1', resource: 'analytics-prod',         dailyCost: 56,  monthToDate: 1176, tags: { env: 'prod', team: 'data' }, usage: 35, recommendation: 'none' },
  { id: 'c10', provider: 'GCP', service: 'Cloud SQL',  type: 'database', region: 'us-central1', resource: 'pg-main',                dailyCost: 88,  monthToDate: 1848, tags: { env: 'prod' }, usage: 60, recommendation: 'reserved' },
  // Azure
  { id: 'c11', provider: 'Azure', service: 'AKS',      type: 'compute',  region: 'eastus',     resource: 'aks-prod',               dailyCost: 240, monthToDate: 5040, tags: { env: 'prod', team: 'platform' }, usage: 65, recommendation: 'none' },
  { id: 'c12', provider: 'Azure', service: 'Functions', type: 'compute',  region: 'eastus',     resource: 'func-api',               dailyCost: 12,  monthToDate: 252,  tags: { env: 'prod' }, usage: 22, recommendation: 'none' },
  // Self
  { id: 'c13', provider: 'Self-hosted', service: 'Bare Metal', type: 'compute', region: 'dc1', resource: 'dell-r740 (4)',  dailyCost: 80,  monthToDate: 1680, tags: { env: 'prod' }, usage: 85, recommendation: 'none' },
];

const PROVIDER_COLORS: Record<Provider, string> = {
  'AWS': 'bg-warning',
  'GCP': 'bg-info',
  'Azure': 'bg-accent',
  'Self-hosted': 'bg-success',
};

const TYPE_COLORS: Record<ServiceType, string> = {
  compute: 'text-accent',
  storage: 'text-warning',
  network: 'text-info',
  database: 'text-success',
  ml: 'text-danger',
  other: 'text-text-secondary',
};

const STORE = 'soloforge.cost-monitor.v1';

function loadBudget(): { monthly: number; alert: number } {
  try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ }
  return { monthly: 30000, alert: 80 };
}
function saveBudget(b: { monthly: number; alert: number }) {
  try { localStorage.setItem(STORE, JSON.stringify(b)); } catch { /* */ }
}

function fmtUsd(n: number): string {
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
  return '$' + n.toFixed(0);
}

export function CostMonitor({ open, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'resources' | 'trends' | 'recommend' | 'budget'>('overview');
  const [filter, setFilter] = useState<Provider | 'all'>('all');
  const [budget, setBudget] = useState(loadBudget);
  const [sortBy, setSortBy] = useState<'cost' | 'usage' | 'name'>('cost');

  useEffect(() => { saveBudget(budget); }, [budget]);

  const filtered = useMemo(() => {
    return filter === 'all' ? SEED_COSTS : SEED_COSTS.filter(c => c.provider === filter);
  }, [filter]);

  const stats = useMemo(() => {
    const total = filtered.reduce((a, c) => a + c.monthToDate, 0);
    const byProvider: Record<string, number> = {};
    const byService: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byTeam: Record<string, number> = {};
    for (const c of filtered) {
      byProvider[c.provider] = (byProvider[c.provider] || 0) + c.monthToDate;
      byService[c.service] = (byService[c.service] || 0) + c.monthToDate;
      byType[c.type] = (byType[c.type] || 0) + c.monthToDate;
      const team = c.tags.team || 'untagged';
      byTeam[team] = (byTeam[team] || 0) + c.monthToDate;
    }
    return { total, byProvider, byService, byType, byTeam };
  }, [filtered]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortBy === 'cost') return b.monthToDate - a.monthToDate;
      if (sortBy === 'usage') return a.usage - b.usage;
      return a.resource.localeCompare(b.resource);
    });
  }, [filtered, sortBy]);

  // 节省潜力
  const savings = useMemo(() => {
    const recs: Array<{ item: CostItem; save: number; action: string }> = [];
    for (const c of filtered) {
      if (c.recommendation === 'reserved') {
        recs.push({ item: c, save: c.monthToDate * 0.4, action: 'Reserved Instance (1yr) 节省约 40%' });
      } else if (c.recommendation === 'spot') {
        recs.push({ item: c, save: c.monthToDate * 0.7, action: 'Spot Instance 节省约 70%' });
      } else if (c.recommendation === 'rightsizing') {
        recs.push({ item: c, save: c.monthToDate * 0.5, action: '降配到 t3.small 节省约 50%' });
      } else if (c.recommendation === 'idle') {
        recs.push({ item: c, save: c.monthToDate, action: '停止闲置资源,节省 100%' });
      }
    }
    return recs;
  }, [filtered]);
  const totalSavings = savings.reduce((a, s) => a + s.save, 0);

  // 30 天趋势 (合成)
  const trend = useMemo(() => {
    const days = 30;
    const arr: number[] = [];
    const daily = stats.total / days;
    for (let i = 0; i < days; i++) {
      const noise = (Math.sin(i * 0.7) + Math.cos(i * 0.3) + (Math.random() - 0.5)) * 0.15;
      arr.push(Math.max(0, daily * (1 + noise)));
    }
    return arr;
  }, [stats.total]);

  const monthPct = (stats.total / budget.monthly) * 100;
  const overBudget = monthPct > 100;
  const nearAlert = monthPct >= budget.alert;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">payments</span>
          <h2 className="text-sm font-semibold text-text">云成本监控</h2>
          <Badge variant="primary">{fmtUsd(stats.total)} MTD</Badge>
          <Badge variant={overBudget ? 'danger' : nearAlert ? 'warning' : 'success'}>{monthPct.toFixed(0)}% / 预算</Badge>
          <Badge variant="info">节省潜力 {fmtUsd(totalSavings)}</Badge>
          <select value={filter} onChange={(e) => setFilter(e.target.value as any)} className="ml-2 bg-bg border border-border-light rounded px-2 h-7 text-xs">
            <option value="all">所有云</option>
            <option value="AWS">AWS</option>
            <option value="GCP">GCP</option>
            <option value="Azure">Azure</option>
            <option value="Self-hosted">自建</option>
          </select>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="file_download">导出账单</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'overview', l: '概览' },
            { k: 'resources', l: `资源 (${filtered.length})` },
            { k: 'trends', l: '趋势' },
            { k: 'recommend', l: `优化 (${savings.length})` },
            { k: 'budget', l: '预算' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3">
          {tab === 'overview' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {(['AWS', 'GCP', 'Azure', 'Self-hosted'] as Provider[]).map(p => (
                  <div key={p} className="bg-bg border border-border-light rounded-lg p-2">
                    <div className="flex items-center gap-1 mb-1">
                      <span className={'w-2 h-2 rounded-full ' + PROVIDER_COLORS[p]} />
                      <span className="text-xs font-semibold text-text">{p}</span>
                    </div>
                    <p className="text-lg font-bold text-text">{fmtUsd(stats.byProvider[p] || 0)}</p>
                    <p className="text-[10px] text-text-secondary">{((stats.byProvider[p] || 0) / stats.total * 100).toFixed(0)}% 总占比</p>
                  </div>
                ))}
                <div className="bg-accent/10 border border-accent/30 rounded-lg p-2">
                  <p className="text-[10px] text-accent">合计</p>
                  <p className="text-lg font-bold text-accent">{fmtUsd(stats.total)}</p>
                  <p className="text-[10px] text-text-secondary">{filtered.length} 资源</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">按服务类型</h3>
                  {Object.entries(stats.byType).map(([t, v]) => (
                    <div key={t} className="flex items-center gap-2 mb-1">
                      <span className={'w-2 h-2 rounded-full ' + TYPE_COLORS[t as ServiceType].replace('text-', 'bg-')} />
                      <span className="text-[10px] text-text w-16">{t}</span>
                      <div className="flex-1 h-2 bg-surface-high rounded overflow-hidden">
                        <div className={'h-full ' + TYPE_COLORS[t as ServiceType].replace('text-', 'bg-')} style={{ width: (v / stats.total * 100) + '%' }} />
                      </div>
                      <span className="text-[10px] font-mono text-text w-16 text-right">{fmtUsd(v)}</span>
                    </div>
                  ))}
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">按团队</h3>
                  {Object.entries(stats.byTeam).map(([t, v]) => (
                    <div key={t} className="flex items-center gap-2 mb-1">
                      <span className="material-symbols-outlined text-[10px] text-text-secondary">group</span>
                      <span className="text-[10px] text-text w-20">{t}</span>
                      <div className="flex-1 h-2 bg-surface-high rounded overflow-hidden">
                        <div className="h-full bg-accent" style={{ width: (v / stats.total * 100) + '%' }} />
                      </div>
                      <span className="text-[10px] font-mono text-text w-16 text-right">{fmtUsd(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'resources' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-1 border-b border-border-light flex items-center gap-1">
                <span className="text-[10px] text-text-secondary">排序:</span>
                <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
                  {(['cost', 'usage', 'name'] as const).map(s => (
                    <button key={s} onClick={() => setSortBy(s)} className={'px-2 h-5 rounded text-[10px] ' + (sortBy === s ? 'bg-surface-high text-text' : 'text-text-secondary')}>
                      {s === 'cost' ? '费用' : s === 'usage' ? '使用率' : '名称'}
                    </button>
                  ))}
                </div>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5">云</th>
                    <th className="text-left px-2 py-1.5">服务/资源</th>
                    <th className="text-left px-2 py-1.5 w-20">区域</th>
                    <th className="text-left px-2 py-1.5 w-20">类型</th>
                    <th className="text-right px-2 py-1.5 w-20">日费用</th>
                    <th className="text-right px-2 py-1.5 w-20">MTD</th>
                    <th className="text-left px-2 py-1.5 w-20">使用率</th>
                    <th className="text-left px-2 py-1.5 w-20">建议</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(c => (
                    <tr key={c.id} className="border-t border-border-light">
                      <td className="px-2 py-1">
                        <span className={'inline-block w-2 h-2 rounded-full mr-1 ' + PROVIDER_COLORS[c.provider]} />
                        <span className="text-[10px] font-mono text-text-secondary">{c.provider}</span>
                      </td>
                      <td className="px-2 py-1">
                        <div className="text-[10px] font-semibold text-text">{c.service}</div>
                        <div className="text-[10px] text-text-secondary font-mono truncate">{c.resource}</div>
                      </td>
                      <td className="px-2 py-1 text-[10px] text-text-secondary">{c.region}</td>
                      <td className="px-2 py-1">
                        <Badge variant="default">{c.type}</Badge>
                      </td>
                      <td className="px-2 py-1 text-right text-[10px] font-mono text-text">{fmtUsd(c.dailyCost)}</td>
                      <td className="px-2 py-1 text-right text-[10px] font-mono text-text">{fmtUsd(c.monthToDate)}</td>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-1">
                          <div className="w-12 h-1.5 bg-surface-high rounded overflow-hidden">
                            <div className={'h-full ' + (c.usage > 80 ? 'bg-success' : c.usage > 30 ? 'bg-warning' : 'bg-danger')} style={{ width: c.usage + '%' }} />
                          </div>
                          <span className="text-[10px] text-text-secondary">{c.usage}%</span>
                        </div>
                      </td>
                      <td className="px-2 py-1">
                        {c.recommendation && c.recommendation !== 'none' ? (
                          <Badge variant={c.recommendation === 'idle' ? 'danger' : 'warning'}>{c.recommendation}</Badge>
                        ) : <span className="text-[10px] text-text-secondary">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'trends' && (
            <div className="space-y-3">
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">近 30 天每日费用</h3>
                <div className="flex items-end gap-px h-40">
                  {trend.map((d, i) => (
                    <div key={i} className="flex-1 bg-accent/70 hover:bg-accent rounded-t relative group" style={{ height: (d / Math.max(...trend) * 100) + '%' }} title={`Day ${i + 1}: ${fmtUsd(d)}`} />
                  ))}
                </div>
                <div className="flex justify-between text-[10px] text-text-secondary mt-1">
                  <span>30 天前</span>
                  <span>15 天前</span>
                  <span>今天</span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">平均日费用</p>
                  <p className="text-xl font-bold text-text">{fmtUsd(stats.total / 30)}</p>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">预测月末</p>
                  <p className="text-xl font-bold text-text">{fmtUsd(stats.total / 30 * 30)}</p>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">同比上月</p>
                  <p className="text-xl font-bold text-success">+8%</p>
                </div>
              </div>
            </div>
          )}

          {tab === 'recommend' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-success/10 border-b border-success/30 flex items-center gap-2">
                <span className="material-symbols-outlined text-success">savings</span>
                <span className="text-xs text-text">总节省潜力: <strong className="text-success">{fmtUsd(totalSavings)}/月</strong></span>
              </div>
              {savings.length === 0 ? <p className="p-4 text-center text-xs text-text-secondary">无优化建议 🎉</p> : (
                <table className="w-full text-xs">
                  <thead className="bg-surface-high text-text-secondary text-[10px]">
                    <tr>
                      <th className="text-left px-2 py-1.5">资源</th>
                      <th className="text-left px-2 py-1.5">建议</th>
                      <th className="text-right px-2 py-1.5">月节省</th>
                      <th className="text-left px-2 py-1.5 w-16">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {savings.map((s, i) => (
                      <tr key={i} className="border-t border-border-light">
                        <td className="px-2 py-1.5">
                          <div className="text-[10px] font-mono text-text">{s.item.resource}</div>
                          <div className="text-[10px] text-text-secondary">{s.item.service} · {s.item.provider}</div>
                        </td>
                        <td className="px-2 py-1.5 text-[10px] text-text">{s.action}</td>
                        <td className="px-2 py-1.5 text-right text-[10px] font-mono text-success">{fmtUsd(s.save)}</td>
                        <td className="px-2 py-1.5">
                          <Button size="xs" icon="auto_fix">应用</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'budget' && (
            <div className="space-y-3">
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">月度预算</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-text-secondary">预算上限 (USD)</label>
                    <input type="number" value={budget.monthly} onChange={(e) => setBudget({ ...budget, monthly: parseInt(e.target.value) || 0 })}
                      className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs mt-1" />
                  </div>
                  <div>
                    <label className="text-[10px] text-text-secondary">告警阈值 (%)</label>
                    <input type="number" value={budget.alert} onChange={(e) => setBudget({ ...budget, alert: parseInt(e.target.value) || 0 })}
                      className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs mt-1" />
                  </div>
                </div>
                <div className="mt-3">
                  <div className="flex justify-between text-[10px] text-text-secondary mb-1">
                    <span>已使用: {fmtUsd(stats.total)}</span>
                    <span>{monthPct.toFixed(0)}%</span>
                  </div>
                  <div className="h-3 bg-surface-high rounded overflow-hidden">
                    <div className={'h-full ' + (overBudget ? 'bg-danger' : nearAlert ? 'bg-warning' : 'bg-success')} style={{ width: Math.min(100, monthPct) + '%' }} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>{SEED_COSTS.length} 资源</span>
          <span>·</span>
          <span>4 云服务</span>
          <span>·</span>
          <span>实时计费</span>
        </div>
      </div>
    </div>
  );
}
