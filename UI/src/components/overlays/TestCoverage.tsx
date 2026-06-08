// ─────────────────────────────────────────────────────────────────
// 测试覆盖率 — TestCoverage
// - 文件/行/分支覆盖率
// - 代码热力图 (模拟 Istanbul 风格)
// - 趋势图 + 未覆盖文件
// - 阈值告警
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface FileCov {
  path: string;
  statements: number; // %
  branches: number;
  functions: number;
  lines: number;
  linesTotal: number;
  linesCovered: number;
  // 用于热力图的行 (0=未覆盖, 1=部分, 2=完全)
  lineStatus: Array<0 | 1 | 2>;
  // 用作文本预览
  source: string;
  // 哪些行是 hit 多次 (用于热点)
  hitCounts?: number[];
}

const STORE = 'soloforge.test-cov.v1';
const STORE_THRESH = 'soloforge.test-cov.thresh.v1';

const SAMPLE_SRC = `import { useState } from 'react';
import axios from 'axios';

export function UserCard({ user, onUpdate }: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);

  if (!user) {
    return null;
  }

  const handleSave = async () => {
    if (name && email) {
      try {
        const res = await axios.put(\`/api/users/\${user.id}\`, { name, email });
        if (res.status === 200) {
          onUpdate(res.data);
          setEditing(false);
        } else {
          console.error('Update failed');
        }
      } catch (e) {
        console.error('Network error', e);
      }
    }
  };

  return (
    <div className="card">
      {editing ? (
        <form onSubmit={handleSave}>
          <input value={name} onChange={e => setName(e.target.value)} />
          <input value={email} onChange={e => setEmail(e.target.value)} />
          <button type="submit">保存</button>
        </form>
      ) : (
        <div>
          <h3>{user.name}</h3>
          <p>{user.email}</p>
          <button onClick={() => setEditing(true)}>编辑</button>
        </div>
      )}
    </div>
  );
}`;

const SEED_FILES: FileCov[] = [
  { path: 'src/components/UserCard.tsx',     statements: 88, branches: 75, functions: 100, lines: 88, linesTotal: 32, linesCovered: 28, lineStatus: [2,2,2,2,2,2,2,2,2,0,2,2,2,2,1,1,2,2,0,2,2,1,1,2,2,2,2,2,2,2,2,2], source: SAMPLE_SRC, hitCounts: [1,1,1,1,1,1,1,1,0,1,1,1,1,3,0,1,1,0,1,1,2,1,1,1,1,1,1,1,1,1,1,1] },
  { path: 'src/api/users.ts',                statements: 92, branches: 80, functions: 100, lines: 92, linesTotal: 25, linesCovered: 23, lineStatus: [2,2,2,2,2,2,2,1,2,2,2,2,2,2,0,2,2,2,2,2,2,2,2,2,2], source: SAMPLE_SRC, hitCounts: [5,3,2,1,1,1,1,0,1,1,1,1,1,1,0,1,1,1,1,1,1,1,1,1,1] },
  { path: 'src/hooks/useAuth.ts',            statements: 75, branches: 50, functions: 100, lines: 75, linesTotal: 16, linesCovered: 12, lineStatus: [2,2,2,1,1,2,0,0,2,2,0,2,2,1,2,2], source: SAMPLE_SRC },
  { path: 'src/utils/format.ts',             statements: 100,branches: 100,functions: 100,lines: 100,linesTotal: 12, linesCovered: 12, lineStatus: [2,2,2,2,2,2,2,2,2,2,2,2], source: SAMPLE_SRC },
  { path: 'src/components/Header.tsx',       statements: 60, branches: 40, functions: 50, lines: 60, linesTotal: 20, linesCovered: 12, lineStatus: [2,2,0,1,2,0,2,2,0,1,2,0,0,2,2,1,0,2,2,2], source: SAMPLE_SRC },
  { path: 'src/pages/Dashboard.tsx',         statements: 45, branches: 25, functions: 60, lines: 45, linesTotal: 40, linesCovered: 18, lineStatus: Array.from({length: 40}, (_, i) => (i % 3 === 0 ? 0 : i % 2 === 0 ? 1 : 2)), source: SAMPLE_SRC },
  { path: 'src/api/products.ts',             statements: 0,  branches: 0,  functions: 0,  lines: 0,  linesTotal: 30, linesCovered: 0,  lineStatus: Array.from({length: 30}, () => 0), source: SAMPLE_SRC },
  { path: 'src/components/Modal.tsx',        statements: 95, branches: 88, functions: 100, lines: 95, linesTotal: 22, linesCovered: 21, lineStatus: [2,2,2,2,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,0,2,2], source: SAMPLE_SRC },
];

const TREND_DATA = Array.from({ length: 14 }, (_, i) => 60 + Math.sin(i * 0.3) * 8 + i * 1.2 + (Math.random() - 0.5) * 3);

function loadThresh(): { stmts: number; br: number; fn: number; ln: number } {
  try { const r = localStorage.getItem(STORE_THRESH); if (r) return JSON.parse(r); } catch { /* */ }
  return { stmts: 80, br: 70, fn: 80, ln: 80 };
}
function saveThresh(t: { stmts: number; br: number; fn: number; ln: number }) { try { localStorage.setItem(STORE_THRESH, JSON.stringify(t)); } catch { /* */ } }

export function TestCoverage({ open, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'files' | 'source' | 'thresh'>('overview');
  const [activeFile, setActiveFile] = useState(SEED_FILES[0].path);
  const [thresh, setThresh] = useState(loadThresh);
  const [search, setSearch] = useState('');

  useEffect(() => { saveThresh(thresh); }, [thresh]);

  const overall = useMemo(() => {
    const totalLines = SEED_FILES.reduce((a, f) => a + f.linesTotal, 0);
    const coveredLines = SEED_FILES.reduce((a, f) => a + f.linesCovered, 0);
    const weighted = (k: 'statements' | 'branches' | 'functions' | 'lines') =>
      SEED_FILES.reduce((a, f) => a + f[k] * f.linesTotal, 0) / totalLines;
    return {
      stmts: weighted('statements'),
      br: weighted('branches'),
      fn: weighted('functions'),
      ln: weighted('lines'),
      totalLines, coveredLines,
    };
  }, []);

  const sorted = useMemo(() => {
    return [...SEED_FILES].sort((a, b) => a.lines - b.lines);
  }, []);

  const activeFc = SEED_FILES.find(f => f.path === activeFile) || SEED_FILES[0];
  const sourceLines = activeFc.source.split('\n');

  const filteredFiles = useMemo(() => {
    if (!search) return sorted;
    const q = search.toLowerCase();
    return sorted.filter(f => f.path.toLowerCase().includes(q));
  }, [sorted, search]);

  const belowThresh = useMemo(() => {
    return SEED_FILES.filter(f => f.statements < thresh.stmts || f.branches < thresh.br || f.lines < thresh.ln);
  }, [thresh]);

  const passStmts = overall.stmts >= thresh.stmts;
  const passBr = overall.br >= thresh.br;
  const passFn = overall.fn >= thresh.fn;
  const passLn = overall.ln >= thresh.ln;

  const runTests = useCallback(() => {
    alert('运行测试中...');
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">health_and_safety</span>
          <h2 className="text-sm font-semibold text-text">测试覆盖率</h2>
          <Badge variant={passStmts ? 'success' : 'danger'}>语句 {overall.stmts.toFixed(1)}%</Badge>
          <Badge variant={passBr ? 'success' : 'danger'}>分支 {overall.br.toFixed(1)}%</Badge>
          <Badge variant={passFn ? 'success' : 'danger'}>函数 {overall.fn.toFixed(1)}%</Badge>
          <Badge variant={passLn ? 'success' : 'danger'}>行 {overall.ln.toFixed(1)}%</Badge>
          {belowThresh.length > 0 && <Badge variant="warning">⚠ {belowThresh.length} 文件未达标</Badge>}
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="play_arrow" onClick={runTests} variant="primary">运行测试</Button>
            <Button size="sm" icon="file_download">导出报告</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'overview', l: '概览' },
            { k: 'files',    l: `文件 (${SEED_FILES.length})` },
            { k: 'source',   l: '源码视图' },
            { k: 'thresh',   l: '阈值' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3">
          {tab === 'overview' && (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-3">
                {([
                  { k: 'stmts', label: '语句', val: overall.stmts, pass: passStmts },
                  { k: 'br',    label: '分支', val: overall.br,    pass: passBr },
                  { k: 'fn',    label: '函数', val: overall.fn,    pass: passFn },
                  { k: 'ln',    label: '行',   val: overall.ln,    pass: passLn },
                ] as const).map(m => (
                  <div key={m.k} className="bg-bg border border-border-light rounded-lg p-3">
                    <p className="text-[10px] text-text-secondary mb-1">{m.label}</p>
                    <p className={'text-2xl font-bold ' + (m.pass ? 'text-success' : 'text-danger')}>{m.val.toFixed(1)}%</p>
                    <div className="h-1.5 bg-surface-high rounded overflow-hidden mt-1">
                      <div className={'h-full ' + (m.pass ? 'bg-success' : 'bg-danger')} style={{ width: m.val + '%' }} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">近 14 次运行趋势</h3>
                <div className="flex items-end gap-1 h-32">
                  {TREND_DATA.map((v, i) => (
                    <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                      <div className="w-full bg-accent/70 hover:bg-accent rounded-t" style={{ height: (v / 100 * 100) + '%' }} title={`Run ${i + 1}: ${v.toFixed(1)}%`} />
                      <span className="text-[9px] text-text-secondary">{i + 1}</span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-[10px] text-text-secondary mt-1">
                  <span>14 次前</span>
                  <span>本次: <strong className="text-text">{TREND_DATA[TREND_DATA.length - 1].toFixed(1)}%</strong></span>
                </div>
              </div>

              {belowThresh.length > 0 && (
                <div className="bg-warning/5 border border-warning/30 rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-warning mb-2">未达阈值 ({belowThresh.length})</h3>
                  {belowThresh.slice(0, 5).map(f => (
                    <div key={f.path} onClick={() => { setActiveFile(f.path); setTab('source'); }} className="cursor-pointer flex items-center gap-2 text-[11px] py-1 hover:bg-warning/10 rounded px-1">
                      <code className="font-mono text-text flex-1 truncate">{f.path}</code>
                      <Badge variant="danger">{f.statements.toFixed(0)}%</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'files' && (
            <div className="bg-bg border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 border-b border-border-light">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索文件..."
                  className="w-full bg-surface border border-border-light rounded px-2 h-6 text-xs" />
              </div>
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px]">
                  <tr>
                    <th className="text-left px-2 py-1.5">文件</th>
                    <th className="text-right px-2 py-1.5 w-16">语句</th>
                    <th className="text-right px-2 py-1.5 w-16">分支</th>
                    <th className="text-right px-2 py-1.5 w-16">函数</th>
                    <th className="text-right px-2 py-1.5 w-16">行</th>
                    <th className="text-left px-2 py-1.5 w-32">进度</th>
                    <th className="text-left px-2 py-1.5 w-20">热力图</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFiles.map(f => (
                    <tr key={f.path} onClick={() => { setActiveFile(f.path); setTab('source'); }} className="border-t border-border-light cursor-pointer hover:bg-surface-high">
                      <td className="px-2 py-1 font-mono text-[10px] text-text">{f.path}</td>
                      <td className={'px-2 py-1 text-right text-[10px] font-mono ' + (f.statements >= thresh.stmts ? 'text-success' : 'text-danger')}>{f.statements.toFixed(1)}%</td>
                      <td className={'px-2 py-1 text-right text-[10px] font-mono ' + (f.branches >= thresh.br ? 'text-success' : 'text-danger')}>{f.branches.toFixed(1)}%</td>
                      <td className={'px-2 py-1 text-right text-[10px] font-mono ' + (f.functions >= thresh.fn ? 'text-success' : 'text-danger')}>{f.functions.toFixed(1)}%</td>
                      <td className={'px-2 py-1 text-right text-[10px] font-mono ' + (f.lines >= thresh.ln ? 'text-success' : 'text-danger')}>{f.lines.toFixed(1)}%</td>
                      <td className="px-2 py-1">
                        <div className="h-1.5 bg-surface-high rounded overflow-hidden">
                          <div className={'h-full ' + (f.statements >= thresh.stmts ? 'bg-success' : 'bg-danger')} style={{ width: f.statements + '%' }} />
                        </div>
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex gap-px">
                          {f.lineStatus.slice(0, 30).map((s, i) => (
                            <div key={i} className={'w-1 h-3 ' + (s === 2 ? 'bg-success' : s === 1 ? 'bg-warning' : 'bg-danger/40')} />
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'source' && (
            <div className="flex gap-3 h-full">
              <div className="w-64 bg-bg border border-border rounded-lg overflow-y-auto">
                <div className="p-2 border-b border-border-light">
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索文件..."
                    className="w-full bg-surface border border-border-light rounded px-2 h-6 text-[10px]" />
                </div>
                {filteredFiles.map(f => (
                  <div key={f.path} onClick={() => setActiveFile(f.path)} className={'px-2 py-1 cursor-pointer text-[10px] font-mono ' + (activeFile === f.path ? 'bg-accent/15 text-accent' : 'hover:bg-surface-high text-text-secondary')}>
                    <div className="truncate">{f.path}</div>
                    <div className="flex gap-px mt-0.5">
                      {f.lineStatus.slice(0, 20).map((s, i) => (
                        <div key={i} className={'w-1 h-1 ' + (s === 2 ? 'bg-success' : s === 1 ? 'bg-warning' : 'bg-danger/40')} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex-1 bg-bg border border-border rounded-lg overflow-auto font-mono text-[10px]">
                <div className="sticky top-0 bg-surface-high px-3 py-1 border-b border-border-light flex items-center gap-2">
                  <span className="text-xs text-text">{activeFc.path}</span>
                  <Badge variant="info">{activeFc.statements}%</Badge>
                  <span className="text-[10px] text-text-secondary ml-auto">
                    {activeFc.linesCovered}/{activeFc.linesTotal} 行已覆盖
                  </span>
                </div>
                <table className="w-full">
                  <tbody>
                    {sourceLines.map((line, i) => {
                      const status = activeFc.lineStatus[i] ?? 1;
                      const hits = activeFc.hitCounts?.[i] ?? (status === 2 ? 1 : 0);
                      const bg = status === 2 ? 'bg-success/5' : status === 0 ? 'bg-danger/15' : 'bg-warning/10';
                      return (
                        <tr key={i} className={bg}>
                          <td className="text-text-secondary text-right pr-2 select-none w-8 align-top text-[9px]">{i + 1}</td>
                          <td className="text-text-secondary text-right pr-2 select-none w-12 align-top text-[9px]">{hits || ''}</td>
                          <td className="text-text pl-2 whitespace-pre">{line || ' '}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'thresh' && (
            <div className="max-w-2xl space-y-3">
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">覆盖率阈值</h3>
                <p className="text-[10px] text-text-secondary mb-3">低于阈值的文件/分支将无法合并到主分支</p>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { k: 'stmts', label: '语句覆盖率' },
                    { k: 'br',    label: '分支覆盖率' },
                    { k: 'fn',    label: '函数覆盖率' },
                    { k: 'ln',    label: '行覆盖率' },
                  ] as const).map(m => (
                    <div key={m.k}>
                      <label className="text-[10px] text-text-secondary">{m.label} (%)</label>
                      <input type="number" min="0" max="100" value={(thresh as any)[m.k]}
                        onChange={(e) => setThresh({ ...thresh, [m.k]: parseInt(e.target.value) || 0 })}
                        className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs mt-1" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>{SEED_FILES.length} 文件</span>
          <span>·</span>
          <span>{overall.coveredLines}/{overall.totalLines} 行</span>
          <span>·</span>
          <span>引擎: Istanbul (v8)</span>
        </div>
      </div>
    </div>
  );
}
