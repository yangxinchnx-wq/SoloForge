// ─────────────────────────────────────────────────────────────────
// 隐私合规扫描器 — PrivacyScanner
// - GDPR / CCPA / PIPL 合规检测
// - PII (个人可识别信息) 自动发现
// - Cookie / 第三方追踪审计
// - 数据流图 (收集→存储→使用→共享)
// - 修复清单 + 同意管理
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type Severity = 'critical' | 'high' | 'medium' | 'low';

interface PrivacyFinding {
  id: string;
  regulation: 'GDPR' | 'CCPA' | 'PIPL' | 'LGPD' | '通用';
  article: string;
  title: string;
  description: string;
  severity: Severity;
  category: '数据收集' | 'Cookie' | '第三方' | '存储' | '同意' | '用户权利' | '传输';
  evidence?: string;
  fix: string;
}

interface Cookie {
  name: string;
  purpose: 'necessary' | 'analytics' | 'marketing' | 'preference';
  duration: string;
  thirdParty: string;
  gdprCompliant: boolean;
}

const SAMPLE_COOKIES: Cookie[] = [
  { name: 'session_id',    purpose: 'necessary',  duration: 'Session',  thirdParty: 'self',     gdprCompliant: true },
  { name: 'csrf_token',    purpose: 'necessary',  duration: 'Session',  thirdParty: 'self',     gdprCompliant: true },
  { name: 'auth_token',    purpose: 'necessary',  duration: '7d',       thirdParty: 'self',     gdprCompliant: true },
  { name: '_ga',           purpose: 'analytics',  duration: '2 years',  thirdParty: 'Google',   gdprCompliant: false },
  { name: '_gid',          purpose: 'analytics',  duration: '24h',      thirdParty: 'Google',   gdprCompliant: false },
  { name: '_fbp',          purpose: 'marketing',  duration: '90d',      thirdParty: 'Facebook', gdprCompliant: false },
  { name: 'lang',          purpose: 'preference', duration: '365d',     thirdParty: 'self',     gdprCompliant: true },
  { name: 'theme',         purpose: 'preference', duration: '365d',     thirdParty: 'self',     gdprCompliant: true },
  { name: 'ajs_anonymous', purpose: 'analytics',  duration: '1 year',   thirdParty: 'Segment',  gdprCompliant: false },
  { name: 'IDE',           purpose: 'marketing',  duration: '13 months',thirdParty: 'Google',   gdprCompliant: false },
];

const SEED_FINDINGS: PrivacyFinding[] = [
  { id: 'pf1', regulation: 'GDPR', article: 'Art. 6 (Lawful basis)', title: '未取得明确同意即收集分析数据', description: 'Google Analytics 在用户未明确同意前已开始追踪 _ga Cookie', severity: 'critical', category: '同意', fix: '实现 Cookie 同意横幅,默认拒绝所有非必要 Cookie' },
  { id: 'pf2', regulation: 'GDPR', article: 'Art. 7 (Conditions for consent)', title: '同意机制不符合规范', description: '未提供"拒绝"同等显著性的选项', severity: 'high', category: '同意', fix: '同意横幅的"接受"和"拒绝"按钮大小、颜色应一致' },
  { id: 'pf3', regulation: 'GDPR', article: 'Art. 13/14 (Information to be provided)', title: '隐私政策未涵盖第三方共享', description: '未在隐私政策中披露 Facebook Pixel 的数据共享', severity: 'high', category: '第三方', fix: '更新隐私政策,列出所有第三方接收方及数据种类' },
  { id: 'pf4', regulation: 'GDPR', article: 'Art. 17 (Right to erasure)', title: '缺少数据删除接口', description: '未提供"被遗忘权"实施接口 (DELETE /api/users/:id/erase)', severity: 'critical', category: '用户权利', fix: '实现用户数据擦除端点 + 管理面板删除流程' },
  { id: 'pf5', regulation: 'GDPR', article: 'Art. 20 (Data portability)', title: '缺少数据导出功能', description: '用户无法下载其所有数据', severity: 'medium', category: '用户权利', fix: '提供 JSON/CSV 格式的数据导出' },
  { id: 'pf6', regulation: 'GDPR', article: 'Art. 25 (Data protection by design)', title: 'IP 地址明文存储', description: '在用户登录日志中记录了明文 IP 地址', severity: 'high', category: '存储', fix: '对 IP 地址进行哈希或截断处理' },
  { id: 'pf7', regulation: 'GDPR', article: 'Art. 32 (Security of processing)', title: '数据库未加密', description: 'PII 数据以明文存储在 PostgreSQL', severity: 'critical', category: '存储', fix: '启用 pgcrypto 扩展,对敏感字段加密' },
  { id: 'pf8', regulation: 'CCPA', article: '§1798.105 (Right to delete)', title: '缺少"Do Not Sell"链接', description: '网站页脚没有提供"请勿出售我的个人信息"的链接入口', severity: 'high', category: '用户权利', fix: '在页脚添加"请勿出售我的个人信息"链接' },
  { id: 'pf9', regulation: 'CCPA', article: '§1798.130 (Right to know)', title: '未提供过去 12 个月数据收集清单', description: '未向用户披露过去 12 个月内收集的个人信息类别', severity: 'medium', category: '用户权利', fix: '在隐私政策中添加年度数据收集类别摘要' },
  { id: 'pf10',regulation: 'PIPL', article: '第 13 条 (同意)', title: '未单独获取敏感信息同意', description: '收集人脸/身份证等敏感信息时未单独同意', severity: 'high', category: '同意', fix: '对敏感个人信息(生物识别/身份证)实施单独同意流程' },
  { id: 'pf11',regulation: 'PIPL', article: '第 38 条 (跨境传输)', title: '未明示数据出境', description: '数据被传输到海外服务器,未告知用户', severity: 'critical', category: '传输', fix: '实施数据出境评估并签署标准合同' },
  { id: 'pf12',regulation: 'GDPR', article: 'Art. 33 (Breach notification)', title: '缺少 72 小时泄露通知流程', description: '未建立 72 小时内向监管机构通报数据泄露的流程', severity: 'high', category: '存储', fix: '建立数据泄露应急响应流程和 72h 通知机制' },
  { id: 'pf13',regulation: '通用', article: 'Best Practice', title: 'Cookie 横幅默认拒绝', description: '同意横幅默认勾选了所有选项', severity: 'high', category: 'Cookie', fix: '默认全部未勾选,需要用户主动开启' },
  { id: 'pf14',regulation: 'GDPR', article: 'Art. 30 (Records of processing)', title: '未维护处理活动记录 (ROPA)', description: '未维护所有处理活动的记录 (Records of Processing Activities)', severity: 'medium', category: '数据收集', fix: '维护所有处理活动的 ROPA 记录' },
  { id: 'pf15',regulation: 'LGPD', article: 'Art. 18 (Rights)', title: '未提供数据访问申诉渠道', description: '巴西 LGPD 法律要求提供清晰的数据访问和数据主体权利申诉渠道', severity: 'medium', category: '用户权利', fix: '设置 DPO 联系邮箱和处理时限' },
];

const DATA_FLOWS: Array<{ from: string; to: string; type: string; consent: boolean; region: string }> = [
  { from: '用户浏览器', to: 'Web App',           type: '邮箱/密码/IP',   consent: true,  region: 'CN' },
  { from: '用户浏览器', to: 'Google Analytics',  type: '行为/设备',      consent: false, region: 'US' },
  { from: '用户浏览器', to: 'Facebook Pixel',    type: '转化事件',       consent: false, region: 'US' },
  { from: '用户浏览器', to: 'Segment',           type: '事件流',         consent: false, region: 'US' },
  { from: 'Web App',     to: 'PostgreSQL',       type: '用户数据 PII',   consent: true,  region: 'CN' },
  { from: 'Web App',     to: 'Redis Cache',      type: '会话/Token',    consent: true,  region: 'CN' },
  { from: 'Web App',     to: 'S3 (US)',          type: '头像/文件',     consent: false, region: 'US' },
  { from: 'PostgreSQL',  to: 'Backup (US)',      type: '全量备份',      consent: false, region: 'US' },
  { from: 'Web App',     to: 'Stripe',           type: '支付卡',         consent: true,  region: 'US' },
  { from: 'Web App',     to: 'SendGrid',         type: '邮箱',           consent: true,  region: 'US' },
];

const STORE = 'soloforge.privacy-scanner.v1';

export function PrivacyScanner({ open, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'findings' | 'cookies' | 'dataflow' | 'consent' | 'dpia'>('overview');
  const [findings] = useState(SEED_FINDINGS);
  const [filter, setFilter] = useState<'all' | Severity>('all');
  const [regFilter, setRegFilter] = useState<string>('all');

  const stats = useMemo(() => {
    const total = findings.length;
    const by = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Severity, number>;
    for (const f of findings) by[f.severity]++;
    const byReg: Record<string, number> = {};
    for (const f of findings) byReg[f.regulation] = (byReg[f.regulation] || 0) + 1;
    const byCat: Record<string, number> = {};
    for (const f of findings) byCat[f.category] = (byCat[f.category] || 0) + 1;
    const totalCookies = SAMPLE_COOKIES.length;
    const nonCompliantCookies = SAMPLE_COOKIES.filter(c => !c.gdprCompliant).length;
    return { total, by, byReg, byCat, totalCookies, nonCompliantCookies, score: Math.max(0, 100 - by.critical * 12 - by.high * 6 - by.medium * 2 - by.low * 1) };
  }, [findings]);

  const visible = useMemo(() => {
    return findings
      .filter(f => filter === 'all' || f.severity === filter)
      .filter(f => regFilter === 'all' || f.regulation === regFilter)
      .sort((a, b) => {
        const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        return order[a.severity] - order[b.severity];
      });
  }, [findings, filter, regFilter]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">shield_person</span>
          <h2 className="text-sm font-semibold text-text">隐私合规扫描器</h2>
          <Badge variant={stats.score >= 80 ? 'success' : stats.score >= 60 ? 'warning' : 'danger'}>合规分 {stats.score}/100</Badge>
          <Badge variant="danger">{stats.by.critical} critical</Badge>
          <Badge variant="warning">{stats.by.high} high</Badge>
          <Badge variant="info">{stats.totalCookies - stats.nonCompliantCookies}/{stats.totalCookies} Cookie 合规</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="file_download">合规报告</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'overview', l: '概览' },
            { k: 'findings', l: `发现 (${visible.length})` },
            { k: 'cookies',  l: `Cookie (${stats.totalCookies})` },
            { k: 'dataflow', l: '数据流' },
            { k: 'consent',  l: '同意管理' },
            { k: 'dpia',     l: 'DPIA 评估' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3">
          {tab === 'overview' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {(['GDPR', 'CCPA', 'PIPL', 'LGPD', '通用'] as const).map(r => (
                  <div key={r} className="bg-bg border border-border-light rounded-lg p-2">
                    <div className="flex items-center gap-1 mb-1">
                      <span className="material-symbols-outlined text-sm text-accent">policy</span>
                      <span className="text-xs font-semibold text-text">{r}</span>
                    </div>
                    <p className="text-lg font-bold text-text">{stats.byReg[r] || 0}</p>
                    <p className="text-[10px] text-text-secondary">相关问题</p>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">问题分布</h3>
                  {Object.entries(stats.byCat).map(([cat, n]) => (
                    <div key={cat} className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] text-text w-20">{cat}</span>
                      <div className="flex-1 h-2 bg-surface-high rounded overflow-hidden">
                        <div className="h-full bg-warning" style={{ width: (n / stats.total * 100) + '%' }} />
                      </div>
                      <span className="text-[10px] font-mono text-text w-8 text-right">{n}</span>
                    </div>
                  ))}
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">合规分数</h3>
                  <div className="flex items-center justify-center h-32">
                    <div className="relative w-28 h-28">
                      <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                        <circle cx="50" cy="50" r="40" fill="none" stroke="var(--surface-high)" strokeWidth="10" />
                        <circle cx="50" cy="50" r="40" fill="none"
                          stroke={stats.score >= 80 ? 'var(--success)' : stats.score >= 60 ? 'var(--warning)' : 'var(--danger)'}
                          strokeWidth="10" strokeDasharray={`${stats.score * 2.51} 251`} strokeLinecap="round" />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-2xl font-bold text-text">{stats.score}</span>
                        <span className="text-[9px] text-text-secondary">/ 100</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === 'findings' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-1 border-b border-border-light flex items-center gap-1">
                <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
                  {(['all', 'critical', 'high', 'medium', 'low'] as const).map(f => (
                    <button key={f} onClick={() => setFilter(f)} className={'px-2 h-5 rounded text-[10px] ' + (filter === f ? 'bg-surface-high text-text' : 'text-text-secondary')}>{f}</button>
                  ))}
                </div>
                <select value={regFilter} onChange={(e) => setRegFilter(e.target.value)} className="ml-1 bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                  <option value="all">所有法规</option>
                  <option value="GDPR">GDPR</option>
                  <option value="CCPA">CCPA</option>
                  <option value="PIPL">PIPL</option>
                  <option value="LGPD">LGPD</option>
                </select>
              </div>
              <div className="overflow-y-auto max-h-[60vh]">
                {visible.map(f => (
                  <div key={f.id} className={'p-3 border-b border-border-light ' + (f.severity === 'critical' ? 'bg-danger/5' : f.severity === 'high' ? 'bg-warning/5' : '')}>
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant={f.severity === 'critical' ? 'danger' : f.severity === 'high' ? 'warning' : f.severity === 'medium' ? 'info' : 'default'}>{f.severity}</Badge>
                      <Badge variant="default">{f.regulation}</Badge>
                      <code className="text-[10px] font-mono text-text-secondary">{f.article}</code>
                      <span className="text-[10px] text-text-secondary ml-auto">{f.category}</span>
                    </div>
                    <h4 className="text-sm font-semibold text-text">{f.title}</h4>
                    <p className="text-[11px] text-text-secondary mt-0.5">{f.description}</p>
                    <p className="text-[11px] text-success mt-1">→ 修复: {f.fix}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'cookies' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5">名称</th>
                    <th className="text-left px-2 py-1.5 w-24">用途</th>
                    <th className="text-left px-2 py-1.5 w-20">期限</th>
                    <th className="text-left px-2 py-1.5 w-24">第三方</th>
                    <th className="text-left px-2 py-1.5 w-20">GDPR</th>
                  </tr>
                </thead>
                <tbody>
                  {SAMPLE_COOKIES.map(c => (
                    <tr key={c.name} className="border-t border-border-light">
                      <td className="px-2 py-1 font-mono text-[10px] text-text">{c.name}</td>
                      <td className="px-2 py-1">
                        <Badge variant={c.purpose === 'necessary' ? 'success' : c.purpose === 'analytics' ? 'info' : c.purpose === 'marketing' ? 'warning' : 'default'}>{c.purpose}</Badge>
                      </td>
                      <td className="px-2 py-1 text-text-secondary">{c.duration}</td>
                      <td className="px-2 py-1 text-text-secondary">{c.thirdParty}</td>
                      <td className="px-2 py-1">
                        {c.gdprCompliant ? <Badge variant="success">合规</Badge> : <Badge variant="danger">违规</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'dataflow' && (
            <div className="bg-bg border border-border-light rounded-lg p-4">
              <h3 className="text-xs font-semibold text-text mb-3">数据流图 (PII 流向)</h3>
              <svg viewBox="0 0 900 500" className="w-full h-96">
                {(() => {
                  const nodes: Record<string, [number, number]> = {
                    '用户浏览器': [80, 80],
                    'Web App': [350, 80],
                    'PostgreSQL': [620, 60],
                    'Redis Cache': [620, 180],
                    'S3 (US)': [820, 200],
                    'Google Analytics': [80, 200],
                    'Facebook Pixel': [80, 320],
                    'Segment': [80, 440],
                    'Stripe': [350, 280],
                    'SendGrid': [350, 420],
                    'Backup (US)': [820, 60],
                  };
                  return (
                    <>
                      <defs>
                        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                          <path d="M0,0 L0,6 L7,3 Z" fill="#9ca3af" />
                        </marker>
                        <marker id="arrow-bad" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                          <path d="M0,0 L0,6 L7,3 Z" fill="#ef4444" />
                        </marker>
                      </defs>
                      {DATA_FLOWS.map((f, i) => {
                        const a = nodes[f.from], b = nodes[f.to];
                        if (!a || !b) return null;
                        return (
                          <g key={i}>
                            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={f.consent ? '#9ca3af' : '#ef4444'} strokeWidth="1.5" strokeDasharray={f.consent ? '0' : '4 4'} markerEnd={f.consent ? 'url(#arrow)' : 'url(#arrow-bad)'} />
                            <text x={(a[0]+b[0])/2} y={(a[1]+b[1])/2 - 4} fontSize="9" fill={f.consent ? 'var(--text-secondary)' : 'var(--danger)'} textAnchor="middle">{f.type}</text>
                          </g>
                        );
                      })}
                      {Object.entries(nodes).map(([name, [x, y]]) => (
                        <g key={name} transform={`translate(${x-60}, ${y-12})`}>
                          <rect width="120" height="24" fill="var(--bg)" stroke="var(--accent)" strokeWidth="1" rx="4" />
                          <text x="60" y="15" fontSize="10" fill="var(--text)" textAnchor="middle" fontFamily="monospace">{name}</text>
                        </g>
                      ))}
                    </>
                  );
                })()}
              </svg>
              <div className="mt-2 flex items-center gap-3 text-[10px] text-text-secondary">
                <div className="flex items-center gap-1"><span className="w-3 h-px bg-text-secondary"></span>已同意</div>
                <div className="flex items-center gap-1"><span className="w-3 h-px bg-danger border-t border-dashed border-danger"></span>未授权跨境</div>
              </div>
            </div>
          )}

          {tab === 'consent' && (
            <div className="space-y-3">
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">同意管理配置</h3>
                <div className="space-y-2">
                  {(['necessary', 'analytics', 'marketing', 'preference'] as const).map(p => (
                    <div key={p} className="flex items-center gap-2">
                      <input type="checkbox" defaultChecked={p === 'necessary'} />
                      <span className="text-xs text-text flex-1">{p}</span>
                      <span className="text-[10px] text-text-secondary">{SAMPLE_COOKIES.filter(c => c.purpose === p).length} Cookie</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">同意横幅设计</h3>
                <div className="border-2 border-dashed border-border-light rounded p-2 text-center">
                  <p className="text-xs text-text">🍪 我们使用 Cookie 提升您的体验</p>
                  <div className="flex justify-center gap-2 mt-2">
                    <button className="px-3 py-1 bg-surface border border-border-light rounded text-[10px]">全部拒绝</button>
                    <button className="px-3 py-1 bg-surface border border-border-light rounded text-[10px]">自定义</button>
                    <button className="px-3 py-1 bg-accent text-white rounded text-[10px]">全部接受</button>
                  </div>
                  <p className="text-[9px] text-text-secondary mt-1">预览 - 实际部署需符合 GDPR/CCPA 视觉对等要求</p>
                </div>
              </div>
            </div>
          )}

          {tab === 'dpia' && (
            <div className="bg-bg border border-border-light rounded-lg p-3">
              <h3 className="text-xs font-semibold text-text mb-2">数据保护影响评估 (DPIA)</h3>
              <p className="text-[10px] text-text-secondary mb-3">Data Protection Impact Assessment - GDPR Art. 35 要求</p>
              <div className="space-y-2 text-xs">
                {[
                  { step: '1. 描述处理活动', status: 'completed', detail: '用户注册、内容发布、行为分析' },
                  { step: '2. 评估必要性',     status: 'completed', detail: '核心功能必需,非必要功能可关闭' },
                  { step: '3. 评估风险',       status: 'in_progress', detail: '5 项高风险已识别,2 项待处理' },
                  { step: '4. 缓解措施',       status: 'in_progress', detail: '加密、匿名化、最小化原则' },
                  { step: '5. DPO 咨询',       status: 'pending', detail: '需 DPO 审阅并签署' },
                  { step: '6. 持续监控',       status: 'pending', detail: '季度复审,事件触发复审' },
                ].map((s, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 bg-bg border border-border-light rounded">
                    <span className="material-symbols-outlined text-base text-accent">{s.status === 'completed' ? 'check_circle' : s.status === 'in_progress' ? 'pending' : 'radio_button_unchecked'}</span>
                    <span className="text-text font-semibold flex-1">{s.step}</span>
                    <span className="text-[10px] text-text-secondary">{s.detail}</span>
                    <Badge variant={s.status === 'completed' ? 'success' : s.status === 'in_progress' ? 'warning' : 'default'}>{s.status === 'completed' ? '完成' : s.status === 'in_progress' ? '进行中' : '待开始'}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>{SEED_FINDINGS.length} 合规项检查</span>
          <span>·</span>
          <span>4 部法规覆盖</span>
          <span>·</span>
          <span>{stats.totalCookies} Cookie 审计</span>
          <span>·</span>
          <span>合规分 {stats.score}/100</span>
        </div>
      </div>
    </div>
  );
}
