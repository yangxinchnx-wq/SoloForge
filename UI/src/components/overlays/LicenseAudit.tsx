// ─────────────────────────────────────────────────────────────────
// 许可证审计 — LicenseAudit
// - 扫描依赖的许可证
// - 兼容性矩阵 (MIT/Apache/GPL/BSD/...)
// - 黑名单/白名单
// - 合规报告 (CSV/Markdown)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface License {
  id: string;
  name: string;
  family: 'Permissive' | 'Copyleft' | 'Weak Copyleft' | 'Public Domain' | 'Proprietary' | 'Unknown';
  osiApproved: boolean;
  commercial: 'allowed' | 'restricted' | 'forbidden' | 'review';
  attribution: boolean;
  sourceDisclosure: boolean;
  patentGrant: boolean;
  // 兼容性矩阵: 与其他许可证组合时的判定
  compat: Record<string, 'ok' | 'warn' | 'fail'>;
}

const LICENSES: License[] = [
  { id: 'MIT',  name: 'MIT',  family: 'Permissive',  osiApproved: true,  commercial: 'allowed',    attribution: true,  sourceDisclosure: false, patentGrant: false,
    compat: { MIT: 'ok', Apache: 'ok', BSD: 'ok', GPL: 'ok', LGPL: 'ok', MPL: 'ok', ISC: 'ok', Unlicense: 'ok', Proprietary: 'warn' } },
  { id: 'Apache', name: 'Apache-2.0', family: 'Permissive', osiApproved: true, commercial: 'allowed', attribution: true, sourceDisclosure: false, patentGrant: true,
    compat: { MIT: 'ok', Apache: 'ok', BSD: 'ok', GPL: 'ok', LGPL: 'ok', MPL: 'ok', ISC: 'ok', Unlicense: 'ok', Proprietary: 'warn' } },
  { id: 'BSD', name: 'BSD-3-Clause', family: 'Permissive', osiApproved: true, commercial: 'allowed', attribution: true, sourceDisclosure: false, patentGrant: false,
    compat: { MIT: 'ok', Apache: 'ok', BSD: 'ok', GPL: 'ok', LGPL: 'ok', MPL: 'ok', ISC: 'ok', Unlicense: 'ok', Proprietary: 'warn' } },
  { id: 'ISC', name: 'ISC',  family: 'Permissive',  osiApproved: true,  commercial: 'allowed',    attribution: true,  sourceDisclosure: false, patentGrant: false,
    compat: { MIT: 'ok', Apache: 'ok', BSD: 'ok', GPL: 'ok', LGPL: 'ok', MPL: 'ok', ISC: 'ok', Unlicense: 'ok', Proprietary: 'warn' } },
  { id: 'GPL', name: 'GPL-3.0', family: 'Copyleft', osiApproved: true, commercial: 'restricted', attribution: true, sourceDisclosure: true,  patentGrant: true,
    compat: { MIT: 'ok', Apache: 'ok', BSD: 'ok', GPL: 'ok', LGPL: 'fail', MPL: 'fail', ISC: 'ok', Unlicense: 'fail', Proprietary: 'fail' } },
  { id: 'LGPL', name: 'LGPL-3.0', family: 'Weak Copyleft', osiApproved: true, commercial: 'review', attribution: true, sourceDisclosure: false, patentGrant: true,
    compat: { MIT: 'ok', Apache: 'ok', BSD: 'ok', GPL: 'ok', LGPL: 'ok', MPL: 'warn', ISC: 'ok', Unlicense: 'ok', Proprietary: 'warn' } },
  { id: 'MPL', name: 'MPL-2.0', family: 'Weak Copyleft', osiApproved: true, commercial: 'review', attribution: true, sourceDisclosure: false, patentGrant: true,
    compat: { MIT: 'ok', Apache: 'ok', BSD: 'ok', GPL: 'ok', LGPL: 'warn', MPL: 'ok', ISC: 'ok', Unlicense: 'ok', Proprietary: 'warn' } },
  { id: 'Unlicense', name: 'Unlicense', family: 'Public Domain', osiApproved: true, commercial: 'allowed', attribution: false, sourceDisclosure: false, patentGrant: false,
    compat: { MIT: 'ok', Apache: 'ok', BSD: 'ok', GPL: 'ok', LGPL: 'ok', MPL: 'ok', ISC: 'ok', Unlicense: 'ok', Proprietary: 'warn' } },
  { id: 'Proprietary', name: 'Proprietary', family: 'Proprietary', osiApproved: false, commercial: 'forbidden', attribution: false, sourceDisclosure: false, patentGrant: false,
    compat: { MIT: 'warn', Apache: 'warn', BSD: 'warn', GPL: 'fail', LGPL: 'fail', MPL: 'fail', ISC: 'warn', Unlicense: 'warn', Proprietary: 'warn' } },
];

const SEED_DEPS: Array<{ name: string; version: string; license: string; type: 'prod' | 'dev' }> = [
  { name: 'react',              version: '18.3.1',  license: 'MIT',  type: 'prod' },
  { name: 'react-dom',          version: '18.3.1',  license: 'MIT',  type: 'prod' },
  { name: 'typescript',         version: '5.4.5',   license: 'Apache', type: 'dev' },
  { name: 'vite',               version: '5.4.21',  license: 'MIT',  type: 'dev' },
  { name: 'tailwindcss',        version: '3.4.7',   license: 'MIT',  type: 'dev' },
  { name: 'react-router-dom',   version: '6.26.0',  license: 'MIT',  type: 'prod' },
  { name: 'axios',              version: '1.7.2',   license: 'MIT',  type: 'prod' },
  { name: 'lodash',             version: '4.17.21', license: 'MIT',  type: 'prod' },
  { name: 'monaco-editor',      version: '0.50.0',  license: 'MIT',  type: 'prod' },
  { name: 'marked',             version: '13.0.0',  license: 'MIT',  type: 'prod' },
  { name: 'dompurify',          version: '3.1.6',   license: 'MPL',  type: 'prod' },
  { name: 'video.js',           version: '8.10.0',  license: 'Apache', type: 'prod' },
  { name: 'ffmpeg.wasm',        version: '0.12.10', license: 'LGPL', type: 'prod' },
  { name: 'libtesseract',       version: '0.0.5',   license: 'Apache', type: 'prod' },
  { name: 'busybox',            version: '1.36.1',  license: 'GPL',  type: 'prod' },
  { name: 'chart.js',           version: '4.4.3',   license: 'MIT',  type: 'prod' },
  { name: 'prismjs',            version: '1.29.0',  license: 'MIT',  type: 'prod' },
  { name: 'quill',              version: '2.0.2',   license: 'BSD',  type: 'prod' },
  { name: 'jest',               version: '29.7.0',  license: 'MIT',  type: 'dev' },
  { name: '@babel/core',        version: '7.24.7',  license: 'MIT',  type: 'dev' },
];

const STORE = 'soloforge.license-audit.v1';
const STORE_DENY = 'soloforge.license-audit.deny.v1';
const STORE_ALLOW = 'soloforge.license-audit.allow.v1';

function loadList(k: string): string[] { try { const r = localStorage.getItem(k); if (r) return JSON.parse(r); } catch { /* */ } return []; }
function saveList(k: string, v: string[]) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } }

export function LicenseAudit({ open, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'deps' | 'matrix' | 'policy'>('overview');
  const [deny, setDeny] = useState<string[]>(() => loadList(STORE_DENY));
  const [allow, setAllow] = useState<string[]>(() => loadList(STORE_ALLOW));
  const [projectLicense, setProjectLicense] = useState('MIT');
  const [search, setSearch] = useState('');

  useEffect(() => { saveList(STORE_DENY, deny); }, [deny]);
  useEffect(() => { saveList(STORE_ALLOW, allow); }, [allow]);

  const stats = useMemo(() => {
    const grouped: Record<string, number> = {};
    for (const d of SEED_DEPS) grouped[d.license] = (grouped[d.license] || 0) + 1;
    return grouped;
  }, []);

  const findings = useMemo(() => {
    const out: Array<{ dep: string; severity: 'ok' | 'warn' | 'fail'; msg: string }> = [];
    for (const d of SEED_DEPS) {
      if (deny.includes(d.license)) {
        out.push({ dep: d.name, severity: 'fail', msg: `${d.license} 在黑名单中` });
      } else if (allow.length > 0 && !allow.includes(d.license)) {
        out.push({ dep: d.name, severity: 'warn', msg: `${d.license} 不在白名单中` });
      } else {
        const lic = LICENSES.find(l => l.id === d.license);
        if (lic) {
          const compat = lic.compat[projectLicense] || 'ok';
          if (compat === 'fail') out.push({ dep: d.name, severity: 'fail', msg: `${d.license} 与项目许可证 (${projectLicense}) 不兼容` });
          else if (compat === 'warn') out.push({ dep: d.name, severity: 'warn', msg: `${d.license} 与项目许可证 (${projectLicense}) 兼容性需审核` });
        }
      }
    }
    return out;
  }, [deny, allow, projectLicense]);

  const fail = findings.filter(f => f.severity === 'fail');
  const warn = findings.filter(f => f.severity === 'warn');
  const ok = findings.filter(f => f.severity === 'ok');

  const filteredDeps = useMemo(() => {
    if (!search) return SEED_DEPS;
    const q = search.toLowerCase();
    return SEED_DEPS.filter(d => d.name.toLowerCase().includes(q) || d.license.toLowerCase().includes(q));
  }, [search]);

  const exportReport = useCallback(() => {
    const lines = [
      '# License Audit Report',
      '',
      `项目许可证: ${projectLicense}`,
      `日期: ${new Date().toLocaleString()}`,
      '',
      '## 摘要',
      `- 通过: ${ok.length}`,
      `- 警告: ${warn.length}`,
      `- 失败: ${fail.length}`,
      '',
      '## 详细',
      '',
      '| 依赖 | 版本 | 许可证 | 类型 | 状态 |',
      '|------|------|--------|------|------|',
      ...SEED_DEPS.map(d => {
        const f = findings.find(x => x.dep === d.name);
        return `| ${d.name} | ${d.version} | ${d.license} | ${d.type} | ${f ? f.severity : 'ok'} |`;
      }),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'license-audit.md';
    a.click();
  }, [projectLicense, findings, ok, warn, fail]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">verified_user</span>
          <h2 className="text-sm font-semibold text-text">许可证审计</h2>
          <Badge variant="success">✓ {ok.length}</Badge>
          <Badge variant="warning">⚠ {warn.length}</Badge>
          <Badge variant="danger">✕ {fail.length}</Badge>
          <span className="text-[10px] text-text-secondary ml-2">项目许可证</span>
          <select value={projectLicense} onChange={(e) => setProjectLicense(e.target.value)} className="bg-bg border border-border-light rounded px-2 h-7 text-xs">
            {LICENSES.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="download" onClick={exportReport}>导出报告</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'overview', l: '概览' },
            { k: 'deps',    l: `依赖 (${SEED_DEPS.length})` },
            { k: 'matrix',  l: '兼容性矩阵' },
            { k: 'policy',  l: '策略' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3">
          {tab === 'overview' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <p className="text-[10px] text-text-secondary">总依赖</p>
                  <p className="text-2xl font-bold text-text">{SEED_DEPS.length}</p>
                </div>
                <div className="bg-success/10 border border-success/30 rounded-lg p-3">
                  <p className="text-[10px] text-success">合规</p>
                  <p className="text-2xl font-bold text-success">{ok.length}</p>
                </div>
                <div className="bg-warning/10 border border-warning/30 rounded-lg p-3">
                  <p className="text-[10px] text-warning">警告</p>
                  <p className="text-2xl font-bold text-warning">{warn.length}</p>
                </div>
                <div className="bg-danger/10 border border-danger/30 rounded-lg p-3">
                  <p className="text-[10px] text-danger">违规</p>
                  <p className="text-2xl font-bold text-danger">{fail.length}</p>
                </div>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">许可证分布</h3>
                <div className="space-y-1">
                  {Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([lic, count]) => {
                    const l = LICENSES.find(x => x.id === lic);
                    return (
                      <div key={lic} className="flex items-center gap-2">
                        <div className="w-16 text-[10px] font-mono text-text">{lic}</div>
                        <div className="flex-1 h-4 bg-surface-high rounded overflow-hidden relative">
                          <div className="h-full bg-accent/60" style={{ width: (count / SEED_DEPS.length * 100) + '%' }} />
                          <span className="absolute inset-0 flex items-center px-2 text-[10px] text-text">{count} ({Math.round(count / SEED_DEPS.length * 100)}%)</span>
                        </div>
                        <div className="w-32 text-[10px] text-text-secondary">{l?.family}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {findings.length > 0 && (
                <div className="bg-bg border border-border-light rounded-lg overflow-hidden">
                  <h3 className="px-3 py-2 text-xs font-semibold text-text bg-surface-high">合规问题</h3>
                  {findings.map((f, i) => (
                    <div key={i} className={'px-3 py-1.5 border-t border-border-light flex items-center gap-2 text-[11px] ' + (f.severity === 'fail' ? 'bg-danger/5' : f.severity === 'warn' ? 'bg-warning/5' : '')}>
                      <Badge variant={f.severity === 'fail' ? 'danger' : f.severity === 'warn' ? 'warning' : 'success'}>{f.severity}</Badge>
                      <code className="font-mono text-text">{f.dep}</code>
                      <span className="text-text-secondary">{f.msg}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'deps' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 border-b border-border-light">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索依赖..."
                  className="w-full bg-surface border border-border-light rounded px-2 h-6 text-xs" />
              </div>
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5">依赖</th>
                    <th className="text-left px-2 py-1.5 w-20">版本</th>
                    <th className="text-left px-2 py-1.5 w-20">许可证</th>
                    <th className="text-left px-2 py-1.5 w-12">类型</th>
                    <th className="text-left px-2 py-1.5 w-32">商用</th>
                    <th className="text-left px-2 py-1.5">兼容性</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDeps.map(d => {
                    const lic = LICENSES.find(l => l.id === d.license);
                    const compat = lic?.compat[projectLicense] || 'ok';
                    return (
                      <tr key={d.name} className="border-t border-border-light">
                        <td className="px-2 py-1 font-mono text-[10px] text-text">{d.name}</td>
                        <td className="px-2 py-1 text-text-secondary">{d.version}</td>
                        <td className="px-2 py-1"><Badge variant="info">{d.license}</Badge></td>
                        <td className="px-2 py-1 text-text-secondary">{d.type}</td>
                        <td className="px-2 py-1 text-[10px]">
                          <Badge variant={lic?.commercial === 'allowed' ? 'success' : lic?.commercial === 'restricted' ? 'warning' : lic?.commercial === 'forbidden' ? 'danger' : 'default'}>
                            {lic?.commercial}
                          </Badge>
                        </td>
                        <td className="px-2 py-1">
                          <Badge variant={compat === 'ok' ? 'success' : compat === 'warn' ? 'warning' : 'danger'}>{compat}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'matrix' && (
            <div className="bg-bg border border-border rounded-lg overflow-x-auto">
              <table className="text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="px-2 py-1.5 text-left">许可证 ↓ \\ →</th>
                    {LICENSES.map(l => <th key={l.id} className="px-2 py-1.5 w-20">{l.id}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {LICENSES.map(row => (
                    <tr key={row.id} className="border-t border-border-light">
                      <td className="px-2 py-1 font-semibold text-text">{row.id}</td>
                      {LICENSES.map(col => {
                        const r = row.compat[col.id] || 'ok';
                        return (
                          <td key={col.id} className="px-2 py-1 text-center">
                            <span className={'inline-block w-3 h-3 rounded ' + (r === 'ok' ? 'bg-success' : r === 'warn' ? 'bg-warning' : 'bg-danger')} title={r} />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'policy' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">黑名单 (禁用)</h3>
                <p className="text-[10px] text-text-secondary mb-2">出现以下许可证的依赖将被标记为违规</p>
                <div className="space-y-1 mb-2">
                  {deny.length === 0 ? <p className="text-[10px] text-text-secondary italic">无</p> : deny.map(d => (
                    <div key={d} className="flex items-center gap-1 bg-danger/10 border border-danger/30 rounded px-2 py-1">
                      <span className="text-[10px] font-mono text-danger flex-1">{d}</span>
                      <IconButton icon="close" size="xs" onClick={() => setDeny(deny.filter(x => x !== d))} />
                    </div>
                  ))}
                </div>
                <div className="flex gap-1">
                  <select onChange={(e) => { if (e.target.value) { setDeny([...deny, e.target.value]); e.target.value = ''; } }} className="flex-1 bg-surface border border-border-light rounded px-1.5 h-6 text-[10px]">
                    <option value="">+ 添加许可证</option>
                    {LICENSES.filter(l => !deny.includes(l.id)).map(l => <option key={l.id} value={l.id}>{l.id} ({l.family})</option>)}
                  </select>
                </div>
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">白名单 (允许)</h3>
                <p className="text-[10px] text-text-secondary mb-2">留空表示允许所有;非白名单项将被警告</p>
                <div className="space-y-1 mb-2">
                  {allow.length === 0 ? <p className="text-[10px] text-text-secondary italic">空 (允许所有)</p> : allow.map(d => (
                    <div key={d} className="flex items-center gap-1 bg-success/10 border border-success/30 rounded px-2 py-1">
                      <span className="text-[10px] font-mono text-success flex-1">{d}</span>
                      <IconButton icon="close" size="xs" onClick={() => setAllow(allow.filter(x => x !== d))} />
                    </div>
                  ))}
                </div>
                <div className="flex gap-1">
                  <select onChange={(e) => { if (e.target.value) { setAllow([...allow, e.target.value]); e.target.value = ''; } }} className="flex-1 bg-surface border border-border-light rounded px-1.5 h-6 text-[10px]">
                    <option value="">+ 添加许可证</option>
                    {LICENSES.filter(l => !allow.includes(l.id)).map(l => <option key={l.id} value={l.id}>{l.id} ({l.family})</option>)}
                  </select>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>{SEED_DEPS.length} 依赖扫描</span>
          <span>·</span>
          <span>支持 {LICENSES.length} 种许可证</span>
          <span>·</span>
          <span>黑白名单 + 兼容性矩阵</span>
        </div>
      </div>
    </div>
  );
}
