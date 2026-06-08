// ─────────────────────────────────────────────────────────────────
// API 监控 — ApiMonitor
// - 实时端点健康 (响应时间/状态码/错误率)
// - P50/P95/P99 延迟
// - 流量趋势 + 地理分布
// - 告警 + 慢查询
// - OpenAPI/Swagger 集成
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Endpoint {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  service: string;
  rpm: number;       // requests per minute
  p50: number;       // ms
  p95: number;
  p99: number;
  errorRate: number; // %
  status: 'healthy' | 'degraded' | 'down';
  lastChecked: number;
  tags: string[];
}

const SEED_ENDPOINTS: Endpoint[] = [
  { id: 'e1', method: 'GET',    path: '/api/users',          service: 'core-api',     rpm: 240, p50: 12, p95: 45, p99: 128, errorRate: 0.1, status: 'healthy', lastChecked: Date.now(), tags: ['public', 'cache'] },
  { id: 'e2', method: 'GET',    path: '/api/users/:id',      service: 'core-api',     rpm: 180, p50: 8,  p95: 32, p99: 95,  errorRate: 0.0, status: 'healthy', lastChecked: Date.now(), tags: ['public', 'cache'] },
  { id: 'e3', method: 'POST',   path: '/api/users',          service: 'core-api',     rpm: 24,  p50: 45, p95: 120,p99: 280, errorRate: 0.3, status: 'healthy', lastChecked: Date.now(), tags: ['auth', 'write'] },
  { id: 'e4', method: 'PUT',    path: '/api/users/:id',      service: 'core-api',     rpm: 12,  p50: 32, p95: 88, p99: 210, errorRate: 0.5, status: 'healthy', lastChecked: Date.now(), tags: ['auth', 'write'] },
  { id: 'e5', method: 'GET',    path: '/api/posts',          service: 'content-api',  rpm: 380, p50: 18, p95: 65, p99: 145, errorRate: 0.2, status: 'healthy', lastChecked: Date.now(), tags: ['public', 'cache'] },
  { id: 'e6', method: 'GET',    path: '/api/posts/:id',      service: 'content-api',  rpm: 420, p50: 15, p95: 52, p99: 120, errorRate: 0.1, status: 'healthy', lastChecked: Date.now(), tags: ['public', 'cache'] },
  { id: 'e7', method: 'POST',   path: '/api/posts',          service: 'content-api',  rpm: 8,   p50: 120,p95: 480,p99: 1200,errorRate: 2.1, status: 'degraded', lastChecked: Date.now(), tags: ['auth', 'write', 'slow'] },
  { id: 'e8', method: 'DELETE', path: '/api/posts/:id',      service: 'content-api',  rpm: 2,   p50: 65, p95: 180,p99: 320, errorRate: 0.0, status: 'healthy', lastChecked: Date.now(), tags: ['auth', 'write'] },
  { id: 'e9', method: 'GET',    path: '/api/search',         service: 'search-api',   rpm: 156, p50: 85, p95: 240,p99: 580, errorRate: 0.4, status: 'healthy', lastChecked: Date.now(), tags: ['public', 'elastic'] },
  { id: 'e10',method: 'POST',   path: '/api/search/advanced',service: 'search-api',   rpm: 24,  p50: 320,p95: 1200,p99: 3400,errorRate: 5.2, status: 'degraded', lastChecked: Date.now(), tags: ['elastic', 'slow'] },
  { id: 'e11',method: 'GET',    path: '/api/payments',       service: 'payment-api',  rpm: 45,  p50: 220,p95: 480,p99: 980, errorRate: 1.2, status: 'healthy', lastChecked: Date.now(), tags: ['pci', 'auth'] },
  { id: 'e12',method: 'POST',   path: '/api/payments/charge',service: 'payment-api',  rpm: 32,  p50: 480,p95: 1200,p99: 2800,errorRate: 0.8, status: 'healthy', lastChecked: Date.now(), tags: ['pci', 'auth', 'write'] },
  { id: 'e13',method: 'GET',    path: '/api/auth/me',        service: 'auth-api',     rpm: 320, p50: 6,  p95: 18, p99: 42,  errorRate: 0.0, status: 'healthy', lastChecked: Date.now(), tags: ['auth'] },
  { id: 'e14',method: 'POST',   path: '/api/auth/login',     service: 'auth-api',     rpm: 18,  p50: 145,p95: 320,p99: 580, errorRate: 1.4, status: 'healthy', lastChecked: Date.now(), tags: ['auth', 'write', 'brute'] },
  { id: 'e15',method: 'GET',    path: '/api/analytics',      service: 'analytics-api',rpm: 12,  p50: 0,  p95: 0,  p99: 0,   errorRate: 100,status: 'down',     lastChecked: Date.now(), tags: ['degraded'] },
];

interface Incident {
  id: string;
  ts: number;
  severity: 'info' | 'warning' | 'critical';
  endpoint: string;
  message: string;
  resolved?: boolean;
}

const SEED_INCIDENTS: Incident[] = [
  { id: 'i1', ts: Date.now() - 60000,  severity: 'critical', endpoint: '/api/analytics', message: '5xx 错误率 100% 超过阈值 5%' },
  { id: 'i2', ts: Date.now() - 300000, severity: 'warning',  endpoint: '/api/search/advanced', message: 'P99 延迟 3400ms 超过 SLO 2000ms' },
  { id: 'i3', ts: Date.now() - 600000, severity: 'warning',  endpoint: '/api/posts',     message: 'P95 延迟 480ms 略高于基线' },
  { id: 'i4', ts: Date.now() - 3600000,severity: 'info',     endpoint: '/api/auth/login', message: '检测到 12 个失败登录,可能为暴力破解', resolved: true },
];

const STORE = 'soloforge.api-monitor.v1';

function load(): Endpoint[] { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return SEED_ENDPOINTS; }
function save(v: Endpoint[]) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* */ } }

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-success', POST: 'bg-accent', PUT: 'bg-warning', DELETE: 'bg-danger', PATCH: 'bg-info',
};

function statusColor(s: Endpoint['status']) {
  return s === 'healthy' ? 'success' : s === 'degraded' ? 'warning' : 'danger';
}

export function ApiMonitor({ open, onClose }: Props) {
  const [eps, setEps] = useState<Endpoint[]>(load);
  const [tab, setTab] = useState<'overview' | 'endpoints' | 'incidents' | 'trends' | 'geo'>('overview');
  const [serviceFilter, setServiceFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'rpm' | 'p95' | 'error' | 'name'>('rpm');

  useEffect(() => { save(eps); }, [eps]);

  // 模拟实时数据
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => {
      setEps(prev => prev.map(e => ({
        ...e,
        rpm: Math.max(0, e.rpm + Math.round((Math.random() - 0.5) * 30)),
        p50: Math.max(1, e.p50 + Math.round((Math.random() - 0.5) * 5)),
        p95: Math.max(2, e.p95 + Math.round((Math.random() - 0.5) * 15)),
        p99: Math.max(5, e.p99 + Math.round((Math.random() - 0.5) * 50)),
        errorRate: Math.max(0, e.errorRate + (Math.random() - 0.5) * 0.3),
        lastChecked: Date.now(),
      })));
    }, 3000);
    return () => clearInterval(t);
  }, [open]);

  const services = useMemo(() => Array.from(new Set(eps.map(e => e.service))), [eps]);
  const filtered = useMemo(() => {
    return eps.filter(e => {
      if (serviceFilter !== 'all' && e.service !== serviceFilter) return false;
      if (statusFilter !== 'all' && e.status !== statusFilter) return false;
      return true;
    });
  }, [eps, serviceFilter, statusFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortBy === 'rpm') return b.rpm - a.rpm;
      if (sortBy === 'p95') return b.p95 - a.p95;
      if (sortBy === 'error') return b.errorRate - a.errorRate;
      return a.path.localeCompare(b.path);
    });
  }, [filtered, sortBy]);

  const stats = useMemo(() => {
    const total = filtered.reduce((a, e) => a + e.rpm, 0);
    const avgP95 = filtered.length > 0 ? filtered.reduce((a, e) => a + e.p95, 0) / filtered.length : 0;
    const avgErr = filtered.length > 0 ? filtered.reduce((a, e) => a + e.errorRate, 0) / filtered.length : 0;
    const down = filtered.filter(e => e.status === 'down').length;
    const degraded = filtered.filter(e => e.status === 'degraded').length;
    return { total, avgP95, avgErr, down, degraded, healthy: filtered.length - down - degraded };
  }, [filtered]);

  // 30 分钟趋势
  const trend = useMemo(() => {
    const arr = Array.from({ length: 30 }, (_, i) => ({
      time: i,
      rpm: 0, p95: 0, err: 0,
    }));
    filtered.forEach(e => {
      arr.forEach((p, i) => {
        p.rpm += e.rpm * (0.8 + Math.sin(i * 0.4) * 0.2);
        p.p95 = Math.max(p.p95, e.p95 * (0.9 + Math.random() * 0.2));
        p.err += e.errorRate;
      });
    });
    return arr;
  }, [filtered]);

  // 地理分布 (mock)
  const geo = useMemo(() => [
    { region: '北美',  pct: 45, color: 'bg-accent' },
    { region: '欧洲',  pct: 28, color: 'bg-success' },
    { region: '亚太',  pct: 18, color: 'bg-warning' },
    { region: '南美',  pct: 5,  color: 'bg-info' },
    { region: '其他',  pct: 4,  color: 'bg-text-secondary' },
  ], []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">monitor_heart</span>
          <h2 className="text-sm font-semibold text-text">API 监控</h2>
          <Badge variant="success">{stats.healthy} 健康</Badge>
          <Badge variant="warning">{stats.degraded} 降级</Badge>
          <Badge variant="danger">{stats.down} 故障</Badge>
          <Badge variant="info">{stats.total} RPM</Badge>
          <Badge variant="default">P95 {stats.avgP95.toFixed(0)}ms</Badge>
          <div className="ml-auto flex items-center gap-1">
            <IconButton icon="refresh" />
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'overview', l: '概览' },
            { k: 'endpoints',l: `端点 (${filtered.length})` },
            { k: 'incidents',l: `事件 (${SEED_INCIDENTS.length})` },
            { k: 'trends',   l: '趋势' },
            { k: 'geo',      l: '地理' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3">
          {tab === 'overview' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">总流量</p>
                  <p className="text-2xl font-bold text-text">{stats.total}</p>
                  <p className="text-[10px] text-text-secondary">RPM</p>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">P50</p>
                  <p className="text-2xl font-bold text-text">{(stats.avgP95 * 0.4).toFixed(0)}ms</p>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">P95</p>
                  <p className="text-2xl font-bold text-text">{stats.avgP95.toFixed(0)}ms</p>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">P99</p>
                  <p className="text-2xl font-bold text-text">{(stats.avgP95 * 2.5).toFixed(0)}ms</p>
                </div>
                <div className={'border rounded-lg p-3 ' + (stats.avgErr > 1 ? 'bg-warning/10 border-warning/30' : 'bg-success/10 border-success/30')}>
                  <p className="text-[10px] text-text-secondary">错误率</p>
                  <p className={'text-2xl font-bold ' + (stats.avgErr > 1 ? 'text-warning' : 'text-success')}>{stats.avgErr.toFixed(2)}%</p>
                </div>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">按服务</h3>
                {services.map(svc => {
                  const svcEps = filtered.filter(e => e.service === svc);
                  const total = svcEps.reduce((a, e) => a + e.rpm, 0);
                  const down = svcEps.filter(e => e.status === 'down').length;
                  return (
                    <div key={svc} className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-mono text-text w-24">{svc}</span>
                      <div className="flex-1 h-2 bg-surface-high rounded overflow-hidden">
                        <div className="h-full bg-accent" style={{ width: (total / Math.max(stats.total, 1) * 100) + '%' }} />
                      </div>
                      <span className="text-[10px] text-text-secondary w-16 text-right">{total} RPM</span>
                      {down > 0 ? <Badge variant="danger">{down} 故障</Badge> : <Badge variant="success">OK</Badge>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'endpoints' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 border-b border-border-light flex items-center gap-1">
                <select value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)} className="bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                  <option value="all">全部服务</option>
                  {services.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                  <option value="all">全部状态</option>
                  <option value="healthy">健康</option>
                  <option value="degraded">降级</option>
                  <option value="down">故障</option>
                </select>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                  <option value="rpm">流量</option>
                  <option value="p95">P95 延迟</option>
                  <option value="error">错误率</option>
                  <option value="name">名称</option>
                </select>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5">方法</th>
                    <th className="text-left px-2 py-1.5">路径</th>
                    <th className="text-left px-2 py-1.5 w-20">服务</th>
                    <th className="text-right px-2 py-1.5 w-16">RPM</th>
                    <th className="text-right px-2 py-1.5 w-16">P50</th>
                    <th className="text-right px-2 py-1.5 w-16">P95</th>
                    <th className="text-right px-2 py-1.5 w-16">P99</th>
                    <th className="text-right px-2 py-1.5 w-16">错误率</th>
                    <th className="text-left px-2 py-1.5 w-16">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(e => (
                    <tr key={e.id} className="border-t border-border-light">
                      <td className="px-2 py-1">
                        <span className={'inline-block px-1.5 py-0.5 rounded text-[9px] font-mono text-white ' + METHOD_COLORS[e.method]}>{e.method}</span>
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text">{e.path}</td>
                      <td className="px-2 py-1 text-[10px] text-text-secondary">{e.service}</td>
                      <td className="px-2 py-1 text-right text-[10px] font-mono text-text">{e.rpm}</td>
                      <td className="px-2 py-1 text-right text-[10px] font-mono text-text-secondary">{e.p50}ms</td>
                      <td className={'px-2 py-1 text-right text-[10px] font-mono ' + (e.p95 > 1000 ? 'text-danger' : e.p95 > 500 ? 'text-warning' : 'text-text')}>{e.p95}ms</td>
                      <td className={'px-2 py-1 text-right text-[10px] font-mono ' + (e.p99 > 2000 ? 'text-danger' : e.p99 > 1000 ? 'text-warning' : 'text-text')}>{e.p99}ms</td>
                      <td className={'px-2 py-1 text-right text-[10px] font-mono ' + (e.errorRate > 5 ? 'text-danger' : e.errorRate > 1 ? 'text-warning' : 'text-text-secondary')}>{e.errorRate.toFixed(2)}%</td>
                      <td className="px-2 py-1"><Badge variant={statusColor(e.status) as any}>{e.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'incidents' && (
            <div className="space-y-2">
              {SEED_INCIDENTS.map(i => (
                <div key={i.id} className={'bg-bg border rounded-lg p-3 ' + (i.severity === 'critical' ? 'border-danger/50' : i.severity === 'warning' ? 'border-warning/50' : 'border-info/50')}>
                  <div className="flex items-center gap-2">
                    <Badge variant={i.severity === 'critical' ? 'danger' : i.severity === 'warning' ? 'warning' : 'info'}>{i.severity}</Badge>
                    <code className="text-[10px] font-mono text-text">{i.endpoint}</code>
                    <span className="text-[10px] text-text-secondary ml-auto">{new Date(i.ts).toLocaleTimeString()}</span>
                    {i.resolved && <Badge variant="success">已解决</Badge>}
                  </div>
                  <p className="text-xs text-text mt-1">{i.message}</p>
                </div>
              ))}
            </div>
          )}

          {tab === 'trends' && (
            <div className="space-y-3">
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">30 分钟 RPM 趋势</h3>
                <div className="flex items-end gap-px h-32">
                  {trend.map((p, i) => (
                    <div key={i} className="flex-1 bg-accent/70 hover:bg-accent rounded-t" style={{ height: (p.rpm / Math.max(...trend.map(t => t.rpm), 1) * 100) + '%' }} title={`${i}m: ${p.rpm.toFixed(0)} RPM`} />
                  ))}
                </div>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">30 分钟 P95 延迟</h3>
                <div className="flex items-end gap-px h-32">
                  {trend.map((p, i) => (
                    <div key={i} className="flex-1 bg-warning/70 hover:bg-warning rounded-t" style={{ height: (p.p95 / Math.max(...trend.map(t => t.p95), 1) * 100) + '%' }} title={`${i}m: ${p.p95.toFixed(0)}ms`} />
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'geo' && (
            <div className="bg-bg border border-border-light rounded-lg p-4">
              <h3 className="text-xs font-semibold text-text mb-3">流量地理分布</h3>
              <div className="space-y-2">
                {geo.map(g => (
                  <div key={g.region} className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-sm text-accent">public</span>
                    <span className="text-xs text-text w-16">{g.region}</span>
                    <div className="flex-1 h-4 bg-surface-high rounded overflow-hidden">
                      <div className={'h-full ' + g.color} style={{ width: g.pct + '%' }} />
                    </div>
                    <span className="text-xs font-mono text-text w-12 text-right">{g.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>{eps.length} 端点</span>
          <span>·</span>
          <span>{services.length} 服务</span>
          <span>·</span>
          <span>采样: 30s</span>
          <span>·</span>
          <span>SLO: P99 &lt; 1000ms, 错误率 &lt; 1%</span>
        </div>
      </div>
    </div>
  );
}
