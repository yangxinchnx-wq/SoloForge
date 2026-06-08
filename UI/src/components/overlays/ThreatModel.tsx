// ─────────────────────────────────────────────────────────────────
// 威胁建模工具 — ThreatModel
// - STRIDE 分类 (Spoofing/Tampering/Repudiation/Info Disclosure/DoS/Elevation)
// - 数据流图 (DFD) - 进程/数据存储/外部实体/数据流
// - 信任边界可视化
// - 威胁识别 + 缓解措施
// - 风险评分 (Likelihood × Impact)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type Stride = 'S' | 'T' | 'R' | 'I' | 'D' | 'E';
type DfdType = 'process' | 'datastore' | 'external' | 'flow';
type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

interface DfdNode {
  id: string;
  type: DfdType;
  label: string;
  x: number;       // % (0-100)
  y: number;       // % (0-100)
  trust: 'internet' | 'dmz' | 'internal' | 'privileged';
}

interface DfdEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  encrypted: boolean;
}

interface Threat {
  id: string;
  stride: Stride;
  title: string;
  target: string;       // node id
  description: string;
  likelihood: 1 | 2 | 3 | 4 | 5;
  impact: 1 | 2 | 3 | 4 | 5;
  mitigations: string[];
  status: 'open' | 'in_progress' | 'mitigated' | 'accepted' | 'transferred';
  owner?: string;
}

const STRIDE_LABEL: Record<Stride, string> = {
  S: 'Spoofing 欺骗',
  T: 'Tampering 篡改',
  R: 'Repudiation 否认',
  I: 'Info Disclosure 信息泄露',
  D: 'Denial of Service 拒绝服务',
  E: 'Elevation 特权提升'
};

const STRIDE_COLOR: Record<Stride, string> = {
  S: 'danger',  T: 'warning', R: 'info',
  I: 'danger',  D: 'warning', E: 'warning'
};

const DFD_NODES: DfdNode[] = [
  { id: 'n1', type: 'external',  label: 'User Browser',     x: 8,  y: 22, trust: 'internet' },
  { id: 'n2', type: 'external',  label: 'Mobile App',       x: 8,  y: 62, trust: 'internet' },
  { id: 'n3', type: 'process',   label: 'CDN/WAF',          x: 28, y: 22, trust: 'dmz' },
  { id: 'n4', type: 'process',   label: 'API Gateway',      x: 28, y: 62, trust: 'dmz' },
  { id: 'n5', type: 'process',   label: 'Auth Service',     x: 50, y: 30, trust: 'internal' },
  { id: 'n6', type: 'process',   label: 'App Service',      x: 50, y: 70, trust: 'internal' },
  { id: 'n7', type: 'datastore', label: 'PostgreSQL',       x: 75, y: 30, trust: 'privileged' },
  { id: 'n8', type: 'datastore', label: 'Redis Cache',      x: 75, y: 70, trust: 'privileged' },
  { id: 'n9', type: 'external',  label: 'OAuth Provider',   x: 50, y: 8,  trust: 'internet' },
];

const DFD_EDGES: DfdEdge[] = [
  { id: 'e1', from: 'n1', to: 'n3', label: 'HTTPS',         encrypted: true },
  { id: 'e2', from: 'n2', to: 'n4', label: 'HTTPS/WSS',     encrypted: true },
  { id: 'e3', from: 'n3', to: 'n4', label: 'internal',      encrypted: true },
  { id: 'e4', from: 'n4', to: 'n5', label: 'JWT',           encrypted: true },
  { id: 'e5', from: 'n4', to: 'n6', label: 'RPC',           encrypted: true },
  { id: 'e6', from: 'n5', to: 'n7', label: 'SQL (TLS)',     encrypted: true },
  { id: 'e7', from: 'n6', to: 'n8', label: 'Redis proto',   encrypted: true },
  { id: 'e8', from: 'n5', to: 'n9', label: 'OAuth flow',    encrypted: true },
  { id: 'e9', from: 'n6', to: 'n7', label: 'SQL (TLS)',     encrypted: true },
];

const SEED_THREATS: Threat[] = [
  { id: 't1', stride: 'S', title: 'JWT Token Forgery', target: 'n4',
    description: '攻击者伪造 JWT token 绕过认证。可以通过修改 alg 字段为 "none" 或使用弱签名密钥实现。',
    likelihood: 3, impact: 5,
    mitigations: ['强制使用 RS256', '密钥定期轮换', '添加 issuer/audience 验证', '短期 access token + refresh token'],
    status: 'mitigated', owner: 'Alice Chen' },
  { id: 't2', stride: 'T', title: 'SQL 注入 (登录接口)', target: 'n5',
    description: '用户输入未参数化,可能注入恶意 SQL。OWASP Top 10 #1 风险。',
    likelihood: 4, impact: 5,
    mitigations: ['使用参数化查询', 'ORM (Prisma/TypeORM)', 'WAF 规则', 'SAST 扫描集成到 CI'],
    status: 'in_progress', owner: 'Bob Wang' },
  { id: 't3', stride: 'I', title: 'PII 数据泄露 (PostgreSQL)', target: 'n7',
    description: '数据库存储的明文 PII 数据,一旦入侵可全部获取。',
    likelihood: 3, impact: 5,
    mitigations: ['字段级加密 (PGP/列加密)', '脱敏 (参考 DataMasking)', '审计日志', '最小权限原则'],
    status: 'open', owner: 'Carol Liu' },
  { id: 't4', stride: 'D', title: 'API Gateway 洪水攻击', target: 'n4',
    description: 'DDoS 攻击使 API Gateway 不可用,影响所有下游服务。',
    likelihood: 4, impact: 4,
    mitigations: ['Cloudflare 防护', 'Rate limiting (令牌桶)', 'Auto-scaling', 'Circuit breaker'],
    status: 'mitigated', owner: 'David Zhang' },
  { id: 't5', stride: 'E', title: '水平越权 (IDOR)', target: 'n6',
    description: '用户通过修改 URL 中的 ID 访问他人资源 (例如 /users/123/profile)。',
    likelihood: 4, impact: 4,
    mitigations: ['服务端鉴权检查 (而非依赖前端)', '使用 UUID 替代自增 ID', '审计日志'],
    status: 'in_progress', owner: 'Eve' },
  { id: 't6', stride: 'R', title: '关键操作无法追溯', target: 'n6',
    description: '删除/支付等关键操作缺乏审计日志,事后无法追责。',
    likelihood: 3, impact: 3,
    mitigations: ['结构化审计日志 (含 user/action/timestamp/resource)', 'WORM 存储', '日志完整性签名'],
    status: 'open' },
  { id: 't7', stride: 'I', title: 'Redis 未授权访问', target: 'n8',
    description: 'Redis 暴露在公网且无密码,数据可被任意读取/修改。',
    likelihood: 2, impact: 5,
    mitigations: ['启用 AUTH', '绑定内网 IP', 'TLS 加密', '防火墙规则'],
    status: 'mitigated', owner: 'Alice Chen' },
  { id: 't8', stride: 'S', title: 'OAuth 重定向劫持', target: 'n9',
    description: 'OAuth redirect_uri 未严格校验,可重定向到攻击者域名窃取 code。',
    likelihood: 3, impact: 4,
    mitigations: ['redirect_uri 严格白名单', 'state 参数 + PKCE', '不返回 refresh_token 给前端'],
    status: 'mitigated' },
  { id: 't9', stride: 'T', title: 'CDN 资源被注入恶意 JS', target: 'n3',
    description: 'CDN 源站被入侵或 Bucket 权限失陷,攻击者上传恶意 JS。',
    likelihood: 2, impact: 5,
    mitigations: ['SRI (Subresource Integrity)', 'CSP 头部', 'CDN 端到端签名', '最小化 S3/Bucket 权限'],
    status: 'open' },
  { id: 't10',stride: 'D', title: '数据库连接池耗尽', target: 'n7',
    description: '慢查询导致连接池耗尽,所有请求被阻塞。',
    likelihood: 3, impact: 4,
    mitigations: ['连接池监控', '查询超时设置', '熔断降级', 'Read replica 分流'],
    status: 'in_progress' },
];

function riskLevel(l: number, i: number): RiskLevel {
  const score = l * i;
  if (score >= 20) return 'critical';
  if (score >= 12) return 'high';
  if (score >= 6)  return 'medium';
  if (score >= 3)  return 'low';
  return 'info';
}

function riskColor(r: RiskLevel): 'danger' | 'warning' | 'info' | 'success' | 'default' {
  return r === 'critical' ? 'danger' : r === 'high' ? 'warning' : r === 'medium' ? 'info' : r === 'low' ? 'success' : 'default';
}

function nodeIcon(t: DfdType): string {
  return t === 'process' ? 'settings' : t === 'datastore' ? 'storage' : t === 'external' ? 'public' : 'arrow_forward';
}

function nodeFill(t: DfdType): string {
  return t === 'process' ? 'fill-accent/20 stroke-accent' :
         t === 'datastore' ? 'fill-success/20 stroke-success' :
         'fill-warning/20 stroke-warning';
}

export function ThreatModel({ open, onClose }: Props) {
  const [tab, setTab] = useState<'dfd' | 'threats' | 'stride' | 'mitigations'>('dfd');
  const [strideFilter, setStrideFilter] = useState<'all' | Stride>('all');
  const [activeThreatId, setActiveThreatId] = useState<string>(SEED_THREATS[0].id);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const filtered = strideFilter === 'all' ? SEED_THREATS : SEED_THREATS.filter(t => t.stride === strideFilter);
  const activeThreat = SEED_THREATS.find(t => t.id === activeThreatId) || SEED_THREATS[0];

  const stats = useMemo(() => ({
    total: SEED_THREATS.length,
    critical: SEED_THREATS.filter(t => riskLevel(t.likelihood, t.impact) === 'critical').length,
    open: SEED_THREATS.filter(t => t.status === 'open').length,
    mitigated: SEED_THREATS.filter(t => t.status === 'mitigated').length,
  }), []);

  if (!open) return null;

  function nodeAt(id: string) { return DFD_NODES.find(n => n.id === id); }
  function nodeCenter(n: DfdNode) { return { x: 30 + n.x * 5.4, y: 30 + n.y * 2.4 }; }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">security</span>
          <h2 className="text-sm font-semibold text-text">威胁建模工具 (STRIDE)</h2>
          <Badge variant="danger">{stats.critical} 严重</Badge>
          <Badge variant="warning">{stats.open} 未处理</Badge>
          <Badge variant="success">{stats.mitigated} 已缓解</Badge>
          <Badge variant="info">{stats.total} 总计</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="download">导出报告</Button>
            <Button size="sm" icon="add" variant="primary">新增威胁</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'dfd',          l: '数据流图' },
            { k: 'threats',      l: `威胁清单 (${SEED_THREATS.length})` },
            { k: 'stride',       l: 'STRIDE 矩阵' },
            { k: 'mitigations',  l: '缓解措施' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-80 border-r border-border bg-bg overflow-y-auto">
            {tab === 'threats' && (
              <>
                <div className="px-3 py-2 border-b border-border-light flex items-center gap-1">
                  <select value={strideFilter} onChange={(e) => setStrideFilter(e.target.value as any)} className="flex-1 bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                    <option value="all">所有类别</option>
                    {Object.entries(STRIDE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                {filtered.map(t => {
                  const rl = riskLevel(t.likelihood, t.impact);
                  return (
                    <div key={t.id} onClick={() => setActiveThreatId(t.id)}
                      className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeThreatId === t.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                      <div className="flex items-center gap-1 mb-1">
                        <Badge variant={STRIDE_COLOR[t.stride] as any}>{t.stride}</Badge>
                        <Badge variant={riskColor(rl)}>{rl}</Badge>
                        <Badge variant={t.status === 'mitigated' ? 'success' : t.status === 'open' ? 'danger' : 'warning'}>{t.status}</Badge>
                      </div>
                      <div className="text-[11px] font-medium text-text">{t.title}</div>
                      <div className="text-[10px] text-text-secondary mt-0.5 flex items-center gap-1">
                        <span>目标: {nodeAt(t.target)?.label}</span>
                        <span>·</span>
                        <span>L{t.likelihood} × I{t.impact}</span>
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {tab === 'dfd' && (
              <div className="p-3 space-y-2">
                <h3 className="text-xs font-semibold text-text">图例</h3>
                <div className="space-y-1.5 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-base text-accent">settings</span>
                    <span className="text-text">进程 (Process)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-base text-success">storage</span>
                    <span className="text-text">数据存储 (Datastore)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-base text-warning">public</span>
                    <span className="text-text">外部实体 (External Entity)</span>
                  </div>
                </div>
                <h3 className="text-xs font-semibold text-text mt-3">信任边界</h3>
                <div className="space-y-1.5 text-[11px]">
                  <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-danger/40 border border-danger"></span><span className="text-text">Internet</span></div>
                  <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-warning/40 border border-warning"></span><span className="text-text">DMZ</span></div>
                  <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-info/40 border border-info"></span><span className="text-text">Internal</span></div>
                  <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-accent/40 border border-accent"></span><span className="text-text">Privileged</span></div>
                </div>
                <h3 className="text-xs font-semibold text-text mt-3">节点 ({DFD_NODES.length})</h3>
                <div className="space-y-1 text-[11px]">
                  {DFD_NODES.map(n => {
                    const threats = SEED_THREATS.filter(t => t.target === n.id);
                    return (
                      <div key={n.id} className="flex items-center gap-2 p-1 rounded hover:bg-surface-high cursor-pointer" onMouseEnter={() => setHoveredNode(n.id)} onMouseLeave={() => setHoveredNode(null)}>
                        <span className="material-symbols-outlined text-sm text-accent">{nodeIcon(n.type)}</span>
                        <span className="flex-1 text-text">{n.label}</span>
                        {threats.length > 0 && <Badge variant="warning">{threats.length}</Badge>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {tab === 'stride' && (
              <div className="p-3 space-y-2">
                {Object.entries(STRIDE_LABEL).map(([k, v]) => {
                  const list = SEED_THREATS.filter(t => t.stride === k);
                  return (
                    <div key={k} className="bg-surface-high rounded p-2">
                      <div className="flex items-center gap-1 mb-1">
                        <Badge variant={STRIDE_COLOR[k as Stride] as any}>{k}</Badge>
                        <span className="text-[11px] font-medium text-text">{v}</span>
                        <span className="ml-auto text-[10px] text-text-secondary">{list.length}</span>
                      </div>
                      {list.map(t => (
                        <p key={t.id} className="text-[10px] text-text-secondary truncate pl-1">• {t.title}</p>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}

            {tab === 'mitigations' && (
              <div className="p-3 space-y-1.5">
                {SEED_THREATS.map(t => (
                  <div key={t.id} className="bg-surface-high rounded p-2">
                    <div className="flex items-center gap-1 mb-1">
                      <Badge variant={STRIDE_COLOR[t.stride] as any}>{t.stride}</Badge>
                      <span className="text-[11px] font-medium text-text truncate">{t.title}</span>
                    </div>
                    <p className="text-[10px] text-text-secondary mb-1">{t.mitigations.length} 项措施</p>
                    <Badge variant={t.status === 'mitigated' ? 'success' : t.status === 'open' ? 'danger' : 'warning'}>{t.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-auto p-3">
            {tab === 'dfd' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">数据流图 (DFD)</h3>
                <svg viewBox="0 0 600 320" className="w-full bg-surface-high rounded" style={{ minHeight: 380 }}>
                  {/* Trust zones */}
                  <rect x="0"   y="0" width="120" height="320" fill="rgba(220,38,38,0.05)"  stroke="rgba(220,38,38,0.3)"  strokeDasharray="4 4" />
                  <rect x="120" y="0" width="120" height="320" fill="rgba(234,179,8,0.05)"  stroke="rgba(234,179,8,0.3)"  strokeDasharray="4 4" />
                  <rect x="240" y="0" width="180" height="320" fill="rgba(59,130,246,0.05)" stroke="rgba(59,130,246,0.3)" strokeDasharray="4 4" />
                  <rect x="420" y="0" width="180" height="320" fill="rgba(168,85,247,0.05)" stroke="rgba(168,85,247,0.3)" strokeDasharray="4 4" />
                  <text x="60"   y="20" fontSize="9" fill="#dc2626" fontWeight="600">Internet</text>
                  <text x="180"  y="20" fontSize="9" fill="#eab308" fontWeight="600">DMZ</text>
                  <text x="330"  y="20" fontSize="9" fill="#3b82f6" fontWeight="600">Internal</text>
                  <text x="510"  y="20" fontSize="9" fill="#a855f7" fontWeight="600">Privileged</text>

                  {/* Edges */}
                  {DFD_EDGES.map(e => {
                    const from = nodeAt(e.from); const to = nodeAt(e.to);
                    if (!from || !to) return null;
                    const a = nodeCenter(from); const b = nodeCenter(to);
                    const midX = (a.x + b.x) / 2; const midY = (a.y + b.y) / 2;
                    return (
                      <g key={e.id}>
                        <defs>
                          <marker id={`arr-${e.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                            <path d="M0,0 L10,5 L0,10 Z" fill={e.encrypted ? '#16a34a' : '#6b7280'} />
                          </marker>
                        </defs>
                        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={e.encrypted ? '#16a34a' : '#6b7280'} strokeWidth="1.5" markerEnd={`url(#arr-${e.id})`} />
                        <text x={midX} y={midY - 3} fontSize="8" fill="#9ca3af" textAnchor="middle">{e.label}</text>
                        {e.encrypted && <text x={midX} y={midY + 8} fontSize="7" fill="#16a34a" textAnchor="middle">🔒</text>}
                      </g>
                    );
                  })}

                  {/* Nodes */}
                  {DFD_NODES.map(n => {
                    const c = nodeCenter(n);
                    const isHover = hoveredNode === n.id;
                    const threatCount = SEED_THREATS.filter(t => t.target === n.id).length;
                    return (
                      <g key={n.id} onMouseEnter={() => setHoveredNode(n.id)} onMouseLeave={() => setHoveredNode(null)} style={{ cursor: 'pointer' }}>
                        {n.type === 'process' && (
                          <circle cx={c.x} cy={c.y} r="22" className={nodeFill(n.type)} strokeWidth="1.5" opacity={isHover ? 1 : 0.85} />
                        )}
                        {n.type === 'datastore' && (
                          <>
                            <ellipse cx={c.x} cy={c.y - 20} rx="22" ry="6" className={nodeFill(n.type)} strokeWidth="1.5" />
                            <line x1={c.x - 22} y1={c.y - 20} x2={c.x - 22} y2={c.y + 16} stroke="#16a34a" strokeWidth="1.5" />
                            <line x1={c.x + 22} y1={c.y - 20} x2={c.x + 22} y2={c.y + 16} stroke="#16a34a" strokeWidth="1.5" />
                            <ellipse cx={c.x} cy={c.y + 16} rx="22" ry="6" className={nodeFill(n.type)} strokeWidth="1.5" />
                          </>
                        )}
                        {n.type === 'external' && (
                          <rect x={c.x - 28} y={c.y - 16} width="56" height="32" className={nodeFill(n.type)} strokeWidth="1.5" rx="2" />
                        )}
                        <text x={c.x} y={c.y + (n.type === 'datastore' ? 32 : 4)} fontSize="9" fill="#1f2937" textAnchor="middle" fontWeight="500">{n.label}</text>
                        {threatCount > 0 && (
                          <g>
                            <circle cx={c.x + 24} cy={c.y - 24} r="9" fill="#dc2626" />
                            <text x={c.x + 24} y={c.y - 21} fontSize="10" fill="white" textAnchor="middle" fontWeight="700">{threatCount}</text>
                          </g>
                        )}
                      </g>
                    );
                  })}
                </svg>
              </div>
            )}

            {(tab === 'threats' || tab === 'mitigations') && (
              <div className="space-y-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant={STRIDE_COLOR[activeThreat.stride] as any}>{activeThreat.stride} - {STRIDE_LABEL[activeThreat.stride]}</Badge>
                    <Badge variant={riskColor(riskLevel(activeThreat.likelihood, activeThreat.impact)) as any}>{riskLevel(activeThreat.likelihood, activeThreat.impact)}</Badge>
                    <Badge variant={activeThreat.status === 'mitigated' ? 'success' : activeThreat.status === 'open' ? 'danger' : 'warning'}>{activeThreat.status}</Badge>
                    {activeThreat.owner && <span className="text-[10px] text-text-secondary ml-auto">负责人: {activeThreat.owner}</span>}
                  </div>
                  <h3 className="text-base font-semibold text-text mb-1">{activeThreat.title}</h3>
                  <p className="text-[11px] text-text-secondary mb-3">目标组件: <code className="text-accent font-mono">{nodeAt(activeThreat.target)?.label}</code></p>
                  <p className="text-[11px] text-text mb-3">{activeThreat.description}</p>

                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <p className="text-[10px] text-text-secondary mb-1">可能性 (Likelihood)</p>
                      <div className="flex items-center gap-1">
                        {[1, 2, 3, 4, 5].map(i => (
                          <div key={i} className={'flex-1 h-2 rounded ' + (i <= activeThreat.likelihood ? 'bg-warning' : 'bg-surface-high')}></div>
                        ))}
                        <span className="text-[11px] font-mono text-text ml-1.5">L{activeThreat.likelihood}</span>
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary mb-1">影响 (Impact)</p>
                      <div className="flex items-center gap-1">
                        {[1, 2, 3, 4, 5].map(i => (
                          <div key={i} className={'flex-1 h-2 rounded ' + (i <= activeThreat.impact ? 'bg-danger' : 'bg-surface-high')}></div>
                        ))}
                        <span className="text-[11px] font-mono text-text ml-1.5">I{activeThreat.impact}</span>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-border-light pt-3">
                    <p className="text-[10px] text-text-secondary mb-2">缓解措施 ({activeThreat.mitigations.length})</p>
                    <div className="space-y-1">
                      {activeThreat.mitigations.map((m, i) => (
                        <div key={i} className="flex items-start gap-2 text-[11px]">
                          <span className="material-symbols-outlined text-base text-success shrink-0">check_circle</span>
                          <span className="text-text">{m}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {tab === 'stride' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-3">STRIDE 威胁分类</h3>
                <div className="grid grid-cols-2 gap-3">
                  {Object.entries(STRIDE_LABEL).map(([k, v]) => {
                    const list = SEED_THREATS.filter(t => t.stride === k);
                    return (
                      <div key={k} className="bg-surface-high rounded p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <Badge variant={STRIDE_COLOR[k as Stride] as any}>{k}</Badge>
                          <span className="text-[11px] font-semibold text-text">{v}</span>
                          <span className="ml-auto text-[10px] text-text-secondary">{list.length} 个</span>
                        </div>
                        <div className="space-y-1.5">
                          {list.map(t => {
                            const rl = riskLevel(t.likelihood, t.impact);
                            return (
                              <div key={t.id} onClick={() => { setActiveThreatId(t.id); setTab('threats'); }} className="bg-bg rounded p-2 cursor-pointer hover:border-accent border border-border-light">
                                <div className="flex items-center gap-1">
                                  <Badge variant={riskColor(rl)}>{rl}</Badge>
                                  <span className="text-[11px] font-medium text-text truncate">{t.title}</span>
                                </div>
                                <p className="text-[10px] text-text-secondary mt-1">目标: {nodeAt(t.target)?.label}</p>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
