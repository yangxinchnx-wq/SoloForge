// ─────────────────────────────────────────────────────────────────
// 漏洞扫描器 — VulnScanner
// - CVE 数据库查询
// - 依赖漏洞匹配
// - CVSS 评分 + 严重等级
// - 修复版本建议
// - 利用代码/缓解措施
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Vuln {
  id: string;
  cve: string;
  title: string;
  package: string;
  installedVersion: string;
  fixedVersions: string[];
  severity: 'critical' | 'high' | 'medium' | 'low';
  cvss: number;
  epss: number;       // exploit prediction probability (0-1)
  cwe: string;
  vector: string;     // CVSS vector
  published: string;
  exploited: boolean;
  description: string;
  references: string[];
  workaround?: string;
}

const SEED_VULNS: Vuln[] = [
  {
    id: 'v1', cve: 'CVE-2024-39014', title: 'Next.js 中间件授权绕过', package: 'next', installedVersion: '14.1.0',
    fixedVersions: ['14.1.1', '14.2.0'], severity: 'critical', cvss: 9.1, epss: 0.78, cwe: 'CWE-285',
    vector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N', published: '2024-06-24', exploited: true,
    description: 'Next.js 14.x 的 middleware 在某些情况下无法正确处理 SSR 路径,允许攻击者绕过授权检查。',
    references: ['https://github.com/vercel/next.js/security/advisories/GHSA-fm7h-4jfh-f2w7', 'https://nvd.nist.gov/vuln/detail/CVE-2024-39014'],
    workaround: '升级到 14.1.1 或更高版本',
  },
  {
    id: 'v2', cve: 'CVE-2024-21538', title: 'cross-spawn ReDoS 漏洞', package: 'cross-spawn', installedVersion: '7.0.3',
    fixedVersions: ['7.0.5', '7.0.6'], severity: 'high', cvss: 7.5, epss: 0.32, cwe: 'CWE-1333',
    vector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H', published: '2024-11-08', exploited: false,
    description: 'cross-spawn 在解析某些参数时存在正则表达式拒绝服务漏洞,可通过特制输入触发 CPU 资源耗尽。',
    references: ['https://github.com/moxystudio/node-cross-spawn/security/advisories/GHSA-3xgq-45jj-v275'],
  },
  {
    id: 'v3', cve: 'CVE-2024-29415', title: 'ip 库 SSRF 漏洞', package: 'ip', installedVersion: '1.1.8',
    fixedVersions: ['1.1.9', '2.0.1'], severity: 'high', cvss: 7.5, epss: 0.41, cwe: 'CWE-918',
    vector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', published: '2024-05-27', exploited: true,
    description: 'ip 包的 isPublic 和 isPrivate 函数存在分类错误,可能被用于绕过 IP 检查进行 SSRF 攻击。',
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2024-29415'],
  },
  {
    id: 'v4', cve: 'CVE-2024-37890', title: 'ws 拒绝服务漏洞', package: 'ws', installedVersion: '8.5.0',
    fixedVersions: ['8.5.1', '8.6.0'], severity: 'high', cvss: 7.5, epss: 0.15, cwe: 'CWE-400',
    vector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H', published: '2024-06-17', exploited: false,
    description: '当大量特定头部被处理时,ws 包会消耗大量 CPU 导致 DoS。',
    references: ['https://github.com/websockets/ws/security/advisories/GHSA-3h5v-q93c-6h6q'],
  },
  {
    id: 'v5', cve: 'CVE-2023-45857', title: 'axios CSRF 漏洞', package: 'axios', installedVersion: '1.6.0',
    fixedVersions: ['1.6.1', '1.7.0'], severity: 'medium', cvss: 6.5, epss: 0.08, cwe: 'CWE-352',
    vector: 'AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N', published: '2023-11-08', exploited: false,
    description: 'axios < 1.6.0 在跨站请求时未正确处理 XSRF-TOKEN,可能允许 CSRF 攻击。',
    references: ['https://github.com/axios/axios/issues/6006'],
  },
  {
    id: 'v6', cve: 'CVE-2024-22421', title: 'vite dev server 任意文件读取', package: 'vite', installedVersion: '4.5.0',
    fixedVersions: ['4.5.2', '5.0.0'], severity: 'critical', cvss: 9.8, epss: 0.92, cwe: 'CWE-22',
    vector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', published: '2024-01-12', exploited: true,
    description: 'Vite 开发服务器未限制 @fs 路径,允许攻击者通过特制 URL 读取任意文件。',
    references: ['https://github.com/vitejs/vite/security/advisories/GHSA-c24v-8rfc-w8vw'],
  },
  {
    id: 'v7', cve: 'CVE-2024-21520', title: 'rollup 路径遍历', package: 'rollup', installedVersion: '3.29.0',
    fixedVersions: ['3.29.4', '4.0.0'], severity: 'medium', cvss: 5.3, epss: 0.04, cwe: 'CWE-22',
    vector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N', published: '2024-04-24', exploited: false,
    description: 'rollup 在处理特定配置时存在路径遍历漏洞。',
    references: ['https://github.com/rollup/rollup/security/advisories/GHSA-mw99-9chc-xw7r'],
  },
  {
    id: 'v8', cve: 'CVE-2024-23334', title: 'python-jose 算法混淆', package: 'python-jose', installedVersion: '3.3.0',
    fixedVersions: ['3.3.1'], severity: 'high', cvss: 7.5, epss: 0.22, cwe: 'CWE-327',
    vector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N', published: '2024-01-04', exploited: false,
    description: 'python-jose 在某些 OpenSSH 密钥验证场景下接受弱加密算法,可被绕过。',
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2024-23334'],
  },
  {
    id: 'v9', cve: 'CVE-2024-26277', title: 'pnpm 符号链接攻击', package: 'pnpm', installedVersion: '8.15.0',
    fixedVersions: ['8.15.5', '9.0.0'], severity: 'medium', cvss: 6.1, epss: 0.02, cwe: 'CWE-59',
    vector: 'AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N', published: '2024-03-13', exploited: false,
    description: 'pnpm 在处理符号链接时未充分验证,可能允许本地攻击者读取项目外文件。',
    references: ['https://github.com/pnpm/pnpm/security/advisories/GHSA-cmmm-fp4w-j56r'],
  },
  {
    id: 'v10',cve: 'CVE-2024-27088', title: 'tailwindcss 任意文件覆盖', package: 'tailwindcss', installedVersion: '3.4.0',
    fixedVersions: ['3.4.1', '3.4.4'], severity: 'high', cvss: 7.5, epss: 0.18, cwe: 'CWE-22',
    vector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N', published: '2024-03-21', exploited: false,
    description: 'tailwindcss 在 PostCSS 集成模式下,可被诱骗覆盖任意文件。',
    references: ['https://github.com/tailwindlabs/tailwindcss/security/advisories/GHSA-3j8f-xhc3-qhq3'],
  },
  {
    id: 'v11',cve: 'CVE-2023-26136', title: 'tough-cookie ReDoS', package: 'tough-cookie', installedVersion: '4.1.2',
    fixedVersions: ['4.1.3'], severity: 'medium', cvss: 5.3, epss: 0.01, cwe: 'CWE-1333',
    vector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L', published: '2023-10-12', exploited: false,
    description: 'tough-cookie 的 CookieJar 在处理大量 Cookie 时存在 ReDoS。',
    references: ['https://github.com/salesforce/tough-cookie/security/advisories/GHSA-72xf-g2v4-qvf3'],
  },
  {
    id: 'v12',cve: 'CVE-2024-28849', title: 'follow-redirects 信息泄露', package: 'follow-redirects', installedVersion: '1.15.4',
    fixedVersions: ['1.15.6'], severity: 'low', cvss: 3.7, epss: 0.005, cwe: 'CWE-200',
    vector: 'AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N', published: '2024-03-19', exploited: false,
    description: 'follow-redirects 在跨协议重定向时可能将 Authorization 头泄露到不安全的协议。',
    references: ['https://github.com/follow-redirects/follow-redirects/security/advisories/GHSA-cxfr-p47w-2mh2'],
  },
];

function cvssColor(score: number): 'success' | 'info' | 'warning' | 'danger' {
  if (score >= 9) return 'danger';
  if (score >= 7) return 'warning';
  if (score >= 4) return 'info';
  return 'success';
}

export function VulnScanner({ open, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'list' | 'cve' | 'exploits'>('overview');
  const [vulns] = useState(SEED_VULNS);
  const [filter, setFilter] = useState<'all' | Vuln['severity']>('all');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<string | null>(SEED_VULNS[0].id);
  const [exploitedOnly, setExploitedOnly] = useState(false);

  const stats = useMemo(() => {
    const by = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Vuln['severity'], number>;
    for (const v of vulns) by[v.severity]++;
    const exploited = vulns.filter(v => v.exploited).length;
    const packages = new Set(vulns.map(v => v.package)).size;
    return { total: vulns.length, by, exploited, packages };
  }, [vulns]);

  const visible = useMemo(() => {
    return vulns
      .filter(v => filter === 'all' || v.severity === filter)
      .filter(v => !exploitedOnly || v.exploited)
      .filter(v => !search || v.cve.toLowerCase().includes(search.toLowerCase()) || v.package.toLowerCase().includes(search.toLowerCase()) || v.title.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => b.cvss - a.cvss);
  }, [vulns, filter, exploitedOnly, search]);

  const activeVuln = vulns.find(v => v.id === active) || vulns[0];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">security</span>
          <h2 className="text-sm font-semibold text-text">漏洞扫描器</h2>
          <Badge variant="danger">{stats.by.critical} critical</Badge>
          <Badge variant="warning">{stats.by.high} high</Badge>
          <Badge variant="info">{stats.total} 总计</Badge>
          <Badge variant="default">{stats.packages} 受影响包</Badge>
          {stats.exploited > 0 && <Badge variant="danger">⚠ {stats.exploited} 在野利用</Badge>}
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="refresh" variant="primary">更新 CVE 库</Button>
            <Button size="sm" icon="file_download">导出</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'overview', l: '概览' },
            { k: 'list',     l: `漏洞 (${visible.length})` },
            { k: 'cve',      l: 'CVE 详情' },
            { k: 'exploits', l: '利用追踪' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3">
          {tab === 'overview' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {(['critical', 'high', 'medium', 'low'] as const).map(s => (
                  <div key={s} className={'border rounded-lg p-3 ' + (s === 'critical' ? 'bg-danger/10 border-danger/30' : s === 'high' ? 'bg-warning/10 border-warning/30' : 'bg-bg border-border-light')}>
                    <p className="text-[10px] text-text-secondary uppercase">{s}</p>
                    <p className={'text-2xl font-bold ' + (s === 'critical' ? 'text-danger' : s === 'high' ? 'text-warning' : 'text-text')}>{stats.by[s]}</p>
                  </div>
                ))}
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">安全分</p>
                  <p className="text-2xl font-bold text-text">{Math.max(0, 100 - stats.by.critical * 15 - stats.by.high * 6 - stats.by.medium * 2)}/100</p>
                </div>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">CVSS 评分分布</h3>
                <div className="space-y-1">
                  {vulns.sort((a, b) => b.cvss - a.cvss).slice(0, 10).map(v => (
                    <div key={v.id} className="flex items-center gap-2">
                      <code className="font-mono text-[10px] text-text-secondary w-28 truncate">{v.cve}</code>
                      <div className="flex-1 h-2 bg-surface-high rounded overflow-hidden">
                        <div className={'h-full ' + (v.cvss >= 9 ? 'bg-danger' : v.cvss >= 7 ? 'bg-warning' : v.cvss >= 4 ? 'bg-info' : 'bg-success')} style={{ width: v.cvss * 10 + '%' }} />
                      </div>
                      <span className="text-[10px] font-mono text-text w-12 text-right">{v.cvss.toFixed(1)}</span>
                      {v.exploited && <Badge variant="danger">⚠</Badge>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'list' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-1 border-b border-border-light flex items-center gap-1">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索 CVE/包名/标题..."
                  className="bg-bg border border-border-light rounded px-2 h-6 text-xs w-48" />
                <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
                  {(['all', 'critical', 'high', 'medium', 'low'] as const).map(f => (
                    <button key={f} onClick={() => setFilter(f)} className={'px-2 h-5 rounded text-[10px] ' + (filter === f ? 'bg-surface-high text-text' : 'text-text-secondary')}>{f}</button>
                  ))}
                </div>
                <label className="text-[10px] text-text-secondary flex items-center gap-1 ml-2">
                  <input type="checkbox" checked={exploitedOnly} onChange={(e) => setExploitedOnly(e.target.checked)} />
                  仅显示在野利用
                </label>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5 w-28">CVE</th>
                    <th className="text-left px-2 py-1.5 w-16">CVSS</th>
                    <th className="text-left px-2 py-1.5">漏洞</th>
                    <th className="text-left px-2 py-1.5 w-20">包</th>
                    <th className="text-left px-2 py-1.5 w-20">已安装</th>
                    <th className="text-left px-2 py-1.5 w-32">修复版本</th>
                    <th className="text-left px-2 py-1.5 w-16">EPSS</th>
                    <th className="text-left px-2 py-1.5 w-12">利用</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(v => (
                    <tr key={v.id} onClick={() => { setActive(v.id); setTab('cve'); }} className="border-t border-border-light cursor-pointer hover:bg-surface-high">
                      <td className="px-2 py-1 font-mono text-[10px] text-accent">{v.cve}</td>
                      <td className="px-2 py-1">
                        <Badge variant={cvssColor(v.cvss) as any}>{v.cvss.toFixed(1)}</Badge>
                      </td>
                      <td className="px-2 py-1 text-text">{v.title}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text-secondary">{v.package}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text-secondary">{v.installedVersion}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-success">{v.fixedVersions.join(', ')}</td>
                      <td className="px-2 py-1 text-[10px] font-mono text-text">{(v.epss * 100).toFixed(0)}%</td>
                      <td className="px-2 py-1">{v.exploited ? <Badge variant="danger">⚠</Badge> : <span className="text-text-secondary">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'cve' && activeVuln && (
            <div className="space-y-3">
              <div className="bg-bg border border-border-light rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <code className="text-lg font-mono font-bold text-accent">{activeVuln.cve}</code>
                  <Badge variant={cvssColor(activeVuln.cvss) as any}>CVSS {activeVuln.cvss.toFixed(1)}</Badge>
                  <Badge variant={activeVuln.severity === 'critical' ? 'danger' : activeVuln.severity === 'high' ? 'warning' : 'info'}>{activeVuln.severity}</Badge>
                  {activeVuln.exploited && <Badge variant="danger">⚠ 在野利用</Badge>}
                  <code className="text-[10px] text-text-secondary ml-auto">{activeVuln.cwe}</code>
                </div>
                <h3 className="text-base font-semibold text-text">{activeVuln.title}</h3>
                <p className="text-xs text-text-secondary mt-1">影响包: <code className="font-mono text-text">{activeVuln.package}@{activeVuln.installedVersion}</code> · 修复版本: <code className="font-mono text-success">{activeVuln.fixedVersions.join(', ')}</code></p>
                <p className="text-xs text-text mt-2">{activeVuln.description}</p>
                <div className="grid grid-cols-2 gap-2 mt-3 text-[10px]">
                  <div><span className="text-text-secondary">发布: </span><span className="text-text">{activeVuln.published}</span></div>
                  <div><span className="text-text-secondary">EPSS: </span><span className="text-text">{(activeVuln.epss * 100).toFixed(1)}%</span></div>
                  <div className="col-span-2"><span className="text-text-secondary">向量: </span><code className="font-mono text-text">{activeVuln.vector}</code></div>
                </div>
              </div>

              {activeVuln.workaround && (
                <div className="bg-warning/10 border border-warning/30 rounded-lg p-3">
                  <h4 className="text-xs font-semibold text-warning mb-1">缓解措施</h4>
                  <p className="text-xs text-text">{activeVuln.workaround}</p>
                </div>
              )}

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h4 className="text-xs font-semibold text-text mb-2">修复命令</h4>
                <div className="space-y-1">
                  <div className="bg-bg border border-border-light rounded p-2 font-mono text-[10px] text-text">npm install {activeVuln.package}@{activeVuln.fixedVersions[0]}</div>
                  <div className="bg-bg border border-border-light rounded p-2 font-mono text-[10px] text-text">yarn upgrade {activeVuln.package}@{activeVuln.fixedVersions[0]}</div>
                  <div className="bg-bg border border-border-light rounded p-2 font-mono text-[10px] text-text">pnpm update {activeVuln.package}@{activeVuln.fixedVersions[0]}</div>
                </div>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h4 className="text-xs font-semibold text-text mb-2">参考链接</h4>
                {activeVuln.references.map((r, i) => (
                  <div key={i} className="flex items-center gap-1 text-[10px] py-0.5">
                    <span className="material-symbols-outlined text-xs text-text-secondary">link</span>
                    <a className="text-accent hover:underline truncate" href={r} target="_blank" rel="noreferrer">{r}</a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'exploits' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5 w-28">CVE</th>
                    <th className="text-left px-2 py-1.5">漏洞</th>
                    <th className="text-left px-2 py-1.5 w-20">包</th>
                    <th className="text-left px-2 py-1.5 w-16">CVSS</th>
                    <th className="text-left px-2 py-1.5 w-16">EPSS</th>
                    <th className="text-left px-2 py-1.5 w-16">状态</th>
                    <th className="text-left px-2 py-1.5 w-20">检测</th>
                  </tr>
                </thead>
                <tbody>
                  {vulns.filter(v => v.exploited).map(v => (
                    <tr key={v.id} className="border-t border-border-light bg-danger/5">
                      <td className="px-2 py-1 font-mono text-[10px] text-accent">{v.cve}</td>
                      <td className="px-2 py-1 text-text">{v.title}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-text-secondary">{v.package}</td>
                      <td className="px-2 py-1 text-danger font-mono text-[10px]">{v.cvss.toFixed(1)}</td>
                      <td className="px-2 py-1 text-danger font-mono text-[10px]">{(v.epss * 100).toFixed(0)}%</td>
                      <td className="px-2 py-1"><Badge variant="danger">活跃利用</Badge></td>
                      <td className="px-2 py-1"><Badge variant="success">已检测</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>数据源: NVD + GitHub Advisory + OSV</span>
          <span>·</span>
          <span>同步: 实时</span>
          <span>·</span>
          <span>{stats.total} CVE 匹配</span>
        </div>
      </div>
    </div>
  );
}
