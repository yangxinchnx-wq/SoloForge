// ─────────────────────────────────────────────────────────────────
// Token 用量追踪器 — TokenTracker
// - 实时 Token 消耗监控
// - 按模型/用户/项目维度统计
// - 预算管理与告警
// - 成本分析
// - 速率限制
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type Model = 'claude-opus-4.7' | 'claude-sonnet-4.5' | 'gpt-4o' | 'gpt-4-turbo' | 'gemini-2.0-pro' | 'llama-3.1-70b';

interface UsageRecord {
  id: string;
  ts: number;
  model: Model;
  user: string;
  project: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  status: 'ok' | 'rate_limited' | 'error' | 'timeout';
}

interface Budget {
  monthly: number;     // USD
  daily: number;
  alertAt: number;     // 0-100 (% of monthly)
  hardCap: number;
}

const MODEL_PRICING: Record<Model, { input: number; output: number; rpm: number; tpm: number }> = {
  'claude-opus-4.7':   { input: 0.000015, output: 0.000075, rpm: 1000, tpm: 800000 },
  'claude-sonnet-4.5': { input: 0.000003, output: 0.000015, rpm: 2000, tpm: 1000000 },
  'gpt-4o':            { input: 0.000002, output: 0.000010, rpm: 5000, tpm: 2000000 },
  'gpt-4-turbo':       { input: 0.000010, output: 0.000030, rpm: 500,  tpm: 300000 },
  'gemini-2.0-pro':    { input: 0.000001, output: 0.000004, rpm: 2000, tpm: 1000000 },
  'llama-3.1-70b':     { input: 0.000001, output: 0.000002, rpm: 600,  tpm: 500000 },
};

const MODEL_LABEL: Record<Model, string> = {
  'claude-opus-4.7':   'Claude Opus 4.7',
  'claude-sonnet-4.5': 'Claude Sonnet 4.5',
  'gpt-4o':            'GPT-4o',
  'gpt-4-turbo':       'GPT-4 Turbo',
  'gemini-2.0-pro':    'Gemini 2.0 Pro',
  'llama-3.1-70b':     'Llama 3.1 70B',
};

const USAGE_RECORDS: UsageRecord[] = [
  { id: 'u1',  ts: Date.now() - 60000,    model: 'claude-opus-4.7',   user: 'Alice Chen',  project: 'soloforge-core',  tokensIn: 1240, tokensOut: 480, costUsd: 0.0546, latencyMs: 2340, status: 'ok' },
  { id: 'u2',  ts: Date.now() - 180000,   model: 'gpt-4o',            user: 'Bob Wang',    project: 'marketing-bot',   tokensIn: 850,  tokensOut: 220, costUsd: 0.0039, latencyMs: 980,  status: 'ok' },
  { id: 'u3',  ts: Date.now() - 300000,   model: 'claude-sonnet-4.5', user: 'Carol Liu',   project: 'soloforge-core',  tokensIn: 2100, tokensOut: 720, costUsd: 0.0171, latencyMs: 1450, status: 'ok' },
  { id: 'u4',  ts: Date.now() - 600000,   model: 'gpt-4-turbo',       user: 'David Zhang', project: 'data-analysis',   tokensIn: 3200, tokensOut: 1200, costUsd: 0.0680, latencyMs: 3200, status: 'ok' },
  { id: 'u5',  ts: Date.now() - 900000,   model: 'gemini-2.0-pro',    user: 'Eve',         project: 'marketing-bot',   tokensIn: 1200, tokensOut: 480, costUsd: 0.0031, latencyMs: 1100, status: 'ok' },
  { id: 'u6',  ts: Date.now() - 1200000,  model: 'claude-opus-4.7',   user: 'Alice Chen',  project: 'research',        tokensIn: 4500, tokensOut: 1800, costUsd: 0.2025, latencyMs: 4100, status: 'ok' },
  { id: 'u7',  ts: Date.now() - 1800000,  model: 'gpt-4o',            user: 'Frank',       project: 'soloforge-core',  tokensIn: 600,   tokensOut: 200, costUsd: 0.0032, latencyMs: 850,  status: 'rate_limited' },
  { id: 'u8',  ts: Date.now() - 2400000,  model: 'claude-sonnet-4.5', user: 'Bob Wang',    project: 'soloforge-core',  tokensIn: 1800, tokensOut: 540, costUsd: 0.0135, latencyMs: 1200, status: 'ok' },
  { id: 'u9',  ts: Date.now() - 3600000,  model: 'llama-3.1-70b',     user: 'Grace',       project: 'internal-tools',  tokensIn: 900,   tokensOut: 320, costUsd: 0.0015, latencyMs: 600,  status: 'ok' },
  { id: 'u10', ts: Date.now() - 4800000,  model: 'claude-opus-4.7',   user: 'Carol Liu',   project: 'data-analysis',   tokensIn: 2200, tokensOut: 880, costUsd: 0.0990, latencyMs: 2800, status: 'timeout' },
];

const BUDGET: Budget = { monthly: 5000, daily: 200, alertAt: 80, hardCap: 110 };

const PROJECTS = ['soloforge-core', 'marketing-bot', 'data-analysis', 'research', 'internal-tools'];
const USERS = ['Alice Chen', 'Bob Wang', 'Carol Liu', 'David Zhang', 'Eve', 'Frank', 'Grace'];

function formatUSD(n: number): string { return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function formatNum(n: number): string { return n.toLocaleString(); }

export function TokenTracker({ open, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'models' | 'users' | 'budget' | 'realtime'>('overview');
  const [timeRange, setTimeRange] = useState<'1h' | '24h' | '7d' | '30d'>('24h');

  const totalCost = useMemo(() => USAGE_RECORDS.reduce((s, r) => s + r.costUsd, 0), []);
  const totalTokensIn = useMemo(() => USAGE_RECORDS.reduce((s, r) => s + r.tokensIn, 0), []);
  const totalTokensOut = useMemo(() => USAGE_RECORDS.reduce((s, r) => s + r.tokensOut, 0), []);
  const okCount = USAGE_RECORDS.filter(r => r.status === 'ok').length;
  const errorCount = USAGE_RECORDS.filter(r => r.status !== 'ok').length;

  const modelStats = useMemo(() => {
    const m: Record<string, { cost: number; tokensIn: number; tokensOut: number; count: number }> = {};
    for (const r of USAGE_RECORDS) {
      if (!m[r.model]) m[r.model] = { cost: 0, tokensIn: 0, tokensOut: 0, count: 0 };
      m[r.model].cost += r.costUsd;
      m[r.model].tokensIn += r.tokensIn;
      m[r.model].tokensOut += r.tokensOut;
      m[r.model].count += 1;
    }
    return m;
  }, []);

  const userStats = useMemo(() => {
    const u: Record<string, { cost: number; calls: number }> = {};
    for (const r of USAGE_RECORDS) {
      if (!u[r.user]) u[r.user] = { cost: 0, calls: 0 };
      u[r.user].cost += r.costUsd;
      u[r.user].calls += 1;
    }
    return u;
  }, []);

  const monthlyUsedPct = (totalCost / BUDGET.monthly) * 100;
  const dailyUsedPct = (totalCost / BUDGET.daily) * 100;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">token</span>
          <h2 className="text-sm font-semibold text-text">Token 用量追踪器</h2>
          <Badge variant="info">{formatNum(USAGE_RECORDS.length)} 请求</Badge>
          <Badge variant="success">{okCount} 成功</Badge>
          {errorCount > 0 && <Badge variant="warning">{errorCount} 错误</Badge>}
          <Badge variant={monthlyUsedPct > BUDGET.alertAt ? 'warning' : 'info'}>{monthlyUsedPct.toFixed(1)}% 预算</Badge>
          <div className="ml-auto flex items-center gap-1">
            <select value={timeRange} onChange={(e) => setTimeRange(e.target.value as any)} className="bg-bg border border-border-light rounded px-2 h-7 text-[10px]">
              <option value="1h">最近 1 小时</option>
              <option value="24h">最近 24 小时</option>
              <option value="7d">最近 7 天</option>
              <option value="30d">最近 30 天</option>
            </select>
            <Button size="sm" icon="download">导出</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'overview', l: '总览' },
            { k: 'models',   l: '按模型' },
            { k: 'users',    l: '按用户' },
            { k: 'budget',   l: '预算' },
            { k: 'realtime', l: '实时流' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3 space-y-3">
          <div className="grid grid-cols-5 gap-3">
            <div className="bg-bg border border-border-light rounded-lg p-3">
              <p className="text-[10px] text-text-secondary">总成本</p>
              <p className="text-lg font-bold text-text font-mono mt-1">{formatUSD(totalCost)}</p>
            </div>
            <div className="bg-bg border border-border-light rounded-lg p-3">
              <p className="text-[10px] text-text-secondary">输入 Token</p>
              <p className="text-lg font-bold text-text font-mono mt-1">{formatNum(totalTokensIn)}</p>
            </div>
            <div className="bg-bg border border-border-light rounded-lg p-3">
              <p className="text-[10px] text-text-secondary">输出 Token</p>
              <p className="text-lg font-bold text-text font-mono mt-1">{formatNum(totalTokensOut)}</p>
            </div>
            <div className="bg-bg border border-border-light rounded-lg p-3">
              <p className="text-[10px] text-text-secondary">成功率</p>
              <p className="text-lg font-bold text-success font-mono mt-1">{((okCount / USAGE_RECORDS.length) * 100).toFixed(1)}%</p>
            </div>
            <div className="bg-bg border border-border-light rounded-lg p-3">
              <p className="text-[10px] text-text-secondary">平均延迟</p>
              <p className="text-lg font-bold text-text font-mono mt-1">{(USAGE_RECORDS.reduce((s, r) => s + r.latencyMs, 0) / USAGE_RECORDS.length).toFixed(0)}ms</p>
            </div>
          </div>

          {tab === 'overview' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">月度预算使用</h3>
                  <div className="flex items-baseline gap-1 mb-1">
                    <span className="text-2xl font-bold text-text font-mono">{formatUSD(totalCost)}</span>
                    <span className="text-[10px] text-text-secondary">/ {formatUSD(BUDGET.monthly)}</span>
                  </div>
                  <div className="h-2 bg-surface-high rounded-full overflow-hidden">
                    <div className={'h-full ' + (monthlyUsedPct > BUDGET.alertAt ? 'bg-warning' : 'bg-success')} style={{ width: `${Math.min(monthlyUsedPct, 100)}%` }}></div>
                  </div>
                  <div className="flex items-center justify-between mt-1 text-[10px] text-text-secondary">
                    <span>告警线: {BUDGET.alertAt}%</span>
                    <span>硬上限: {BUDGET.hardCap}%</span>
                  </div>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">日预算使用</h3>
                  <div className="flex items-baseline gap-1 mb-1">
                    <span className="text-2xl font-bold text-text font-mono">{formatUSD(totalCost)}</span>
                    <span className="text-[10px] text-text-secondary">/ {formatUSD(BUDGET.daily)}</span>
                  </div>
                  <div className="h-2 bg-surface-high rounded-full overflow-hidden">
                    <div className={'h-full ' + (dailyUsedPct > 100 ? 'bg-danger' : dailyUsedPct > BUDGET.alertAt ? 'bg-warning' : 'bg-accent')} style={{ width: `${Math.min(dailyUsedPct, 100)}%` }}></div>
                  </div>
                </div>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">成本趋势 (近 24h)</h3>
                <svg viewBox="0 0 600 80" className="w-full h-20">
                  {(() => {
                    const points = Array.from({ length: 24 }, (_, i) => 30 + Math.sin(i / 2) * 15 + Math.random() * 8);
                    const max = Math.max(...points);
                    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i / 23) * 580 + 10} ${70 - (p / max) * 60}`).join(' ');
                    return <><path d={path} fill="none" stroke="#a855f7" strokeWidth="1.5" /><path d={path + ' L 590 70 L 10 70 Z'} fill="rgba(168,85,247,0.1)" /></>;
                  })()}
                </svg>
              </div>
            </>
          )}

          {tab === 'models' && (
            <div className="bg-bg border border-border-light rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">按模型拆分</h3>
              <div className="space-y-2">
                {Object.entries(modelStats).sort((a, b) => b[1].cost - a[1].cost).map(([model, s]) => {
                  const pricing = MODEL_PRICING[model as Model];
                  const pct = (s.cost / totalCost) * 100;
                  return (
                    <div key={model} className="bg-surface-high rounded p-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-text min-w-32">{MODEL_LABEL[model as Model]}</span>
                        <div className="flex-1 h-4 bg-bg rounded relative overflow-hidden">
                          <div className="h-full bg-accent" style={{ width: `${pct}%` }}></div>
                        </div>
                        <span className="text-[10px] text-text font-mono w-16 text-right">{formatUSD(s.cost)}</span>
                        <span className="text-[10px] text-text-secondary w-12 text-right">{pct.toFixed(1)}%</span>
                      </div>
                      <div className="mt-1.5 grid grid-cols-5 gap-2 text-[10px]">
                        <div><span className="text-text-secondary">调用:</span> <span className="text-text font-mono">{s.count}</span></div>
                        <div><span className="text-text-secondary">In:</span> <span className="text-text font-mono">{formatNum(s.tokensIn)}</span></div>
                        <div><span className="text-text-secondary">Out:</span> <span className="text-text font-mono">{formatNum(s.tokensOut)}</span></div>
                        <div><span className="text-text-secondary">In $/1k:</span> <span className="text-text font-mono">${(pricing.input * 1000).toFixed(4)}</span></div>
                        <div><span className="text-text-secondary">RPM 限制:</span> <span className="text-text font-mono">{pricing.rpm}</span></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'users' && (
            <div className="bg-bg border border-border-light rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">按用户拆分</h3>
              <table className="w-full text-[11px]">
                <thead className="text-text-secondary border-b border-border-light">
                  <tr>
                    <th className="text-left py-1.5">用户</th>
                    <th className="text-right py-1.5">调用次数</th>
                    <th className="text-right py-1.5">总成本</th>
                    <th className="text-right py-1.5">平均成本/调用</th>
                    <th className="text-right py-1.5">占比</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(userStats).sort((a, b) => b[1].cost - a[1].cost).map(([user, s]) => {
                    const pct = (s.cost / totalCost) * 100;
                    return (
                      <tr key={user} className="border-b border-border-light">
                        <td className="py-1.5 text-text">{user}</td>
                        <td className="py-1.5 text-right text-text font-mono">{s.calls}</td>
                        <td className="py-1.5 text-right text-text font-mono">{formatUSD(s.cost)}</td>
                        <td className="py-1.5 text-right text-text-secondary font-mono">{formatUSD(s.cost / s.calls)}</td>
                        <td className="py-1.5 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <div className="w-16 h-1.5 bg-surface-high rounded-full overflow-hidden">
                              <div className="h-full bg-accent" style={{ width: `${pct}%` }}></div>
                            </div>
                            <span className="text-text-secondary font-mono w-10 text-right">{pct.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'budget' && (
            <div className="space-y-3">
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">月度预算 ({formatUSD(BUDGET.monthly)})</h3>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-text-secondary w-20">告警阈值</span>
                    <div className="flex-1 h-2 bg-surface-high rounded-full overflow-hidden">
                      <div className="h-full bg-warning" style={{ width: `${BUDGET.alertAt}%` }}></div>
                    </div>
                    <span className="text-[10px] text-text font-mono w-12 text-right">{BUDGET.alertAt}%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-text-secondary w-20">硬上限</span>
                    <div className="flex-1 h-2 bg-surface-high rounded-full overflow-hidden">
                      <div className="h-full bg-danger" style={{ width: `${BUDGET.hardCap}%` }}></div>
                    </div>
                    <span className="text-[10px] text-text font-mono w-12 text-right">{BUDGET.hardCap}%</span>
                  </div>
                </div>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">按项目</h3>
                <div className="space-y-1.5">
                  {PROJECTS.map(p => {
                    const projectCost = USAGE_RECORDS.filter(r => r.project === p).reduce((s, r) => s + r.costUsd, 0);
                    return (
                      <div key={p} className="flex items-center gap-2 p-1.5 bg-surface-high rounded">
                        <code className="text-[11px] font-mono text-text flex-1">{p}</code>
                        <Badge variant="info">{(USAGE_RECORDS.filter(r => r.project === p).length)} 调用</Badge>
                        <span className="text-[10px] text-text font-mono w-20 text-right">{formatUSD(projectCost)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {tab === 'realtime' && (
            <div className="bg-bg border border-border-light rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">实时请求流</h3>
              <div className="space-y-1 max-h-96 overflow-y-auto">
                {USAGE_RECORDS.slice().reverse().map(r => (
                  <div key={r.id} className="flex items-center gap-2 py-1.5 border-b border-border-light">
                    <span className="text-text-secondary text-[10px] w-12 shrink-0">{new Date(r.ts).toLocaleTimeString().slice(0, 8)}</span>
                    <Badge variant={r.status === 'ok' ? 'success' : r.status === 'rate_limited' ? 'warning' : r.status === 'timeout' ? 'warning' : 'danger'}>{r.status}</Badge>
                    <Badge variant="info">{MODEL_LABEL[r.model]}</Badge>
                    <span className="text-[10px] text-text flex-1 truncate">{r.user} · {r.project}</span>
                    <span className="text-[10px] text-text-secondary font-mono w-20 text-right">{r.tokensIn}/{r.tokensOut}</span>
                    <span className="text-[10px] text-text font-mono w-16 text-right">{formatUSD(r.costUsd)}</span>
                    <span className="text-[10px] text-text-secondary font-mono w-16 text-right">{r.latencyMs}ms</span>
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
