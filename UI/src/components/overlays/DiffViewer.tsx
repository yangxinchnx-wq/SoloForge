// ─────────────────────────────────────────────────────────────────
// 差异对比查看器 — DiffViewer
// - 文本 diff (LCS 算法)
// - 行级高亮 (增/删/改/上下文)
// - 并排 / 内联 视图
// - 字符级 diff (子项修改高亮)
// - 统计 (增删行数)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type DiffOp = 'eq' | 'add' | 'del' | 'mod';

interface DiffLine { type: DiffOp; a?: string; b?: string; aLine?: number; bLine?: number; }

function lcs(a: string[], b: string[]): number[][] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function diff(a: string, b: string): DiffLine[] {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const dp = lcs(aLines, bLines);
  const out: DiffLine[] = [];
  let i = aLines.length, j = bLines.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      out.unshift({ type: 'eq', a: aLines[i - 1], b: bLines[j - 1], aLine: i, bLine: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.unshift({ type: 'add', b: bLines[j - 1], bLine: j });
      j--;
    } else if (i > 0) {
      out.unshift({ type: 'del', a: aLines[i - 1], aLine: i });
      i--;
    }
  }
  // 合并连续 add+del 为 mod
  const merged: DiffLine[] = [];
  for (let k = 0; k < out.length; k++) {
    if (out[k].type === 'add' && k + 1 < out.length && out[k + 1].type === 'del') {
      merged.push({ type: 'mod', a: out[k + 1].a, b: out[k].b, aLine: out[k + 1].aLine, bLine: out[k].bLine });
      k++;
    } else if (out[k].type === 'del' && k + 1 < out.length && out[k + 1].type === 'add') {
      merged.push({ type: 'mod', a: out[k].a, b: out[k + 1].b, aLine: out[k].aLine, bLine: out[k + 1].bLine });
      k++;
    } else {
      merged.push(out[k]);
    }
  }
  return merged;
}

// 字符级 LCS - 简单实现
function charDiff(a: string, b: string): Array<{ type: 'eq' | 'add' | 'del'; text: string }> {
  const m = a.length, n = b.length;
  if (m === 0) return [{ type: 'add', text: b }];
  if (n === 0) return [{ type: 'del', text: a }];
  // Myers diff 简化版
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
  const out: Array<{ type: 'eq' | 'add' | 'del'; text: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { out.unshift({ type: 'eq', text: a[i - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { out.unshift({ type: 'add', text: b[j - 1] }); j--; }
    else { out.unshift({ type: 'del', text: a[i - 1] }); i--; }
  }
  // 合并连续相同 type
  const merged: typeof out = [];
  for (const c of out) {
    if (merged.length > 0 && merged[merged.length - 1].type === c.type) merged[merged.length - 1].text += c.text;
    else merged.push({ ...c });
  }
  return merged;
}

const SAMPLES = {
  a: `function greet(name) {
  console.log("Hello, " + name);
  return name;
}

const user = "Alice";
const result = greet(user);
console.log(result);`,
  b: `function greet(name, greeting = "Hello") {
  console.log(\`\${greeting}, \${name}!\`);
  return name;
}

const user = "Alice";
const result = greet(user, "Hi");
console.log("Done:", result);`,
};

export function DiffViewer({ open, onClose }: Props) {
  const [a, setA] = useState(SAMPLES.a);
  const [b, setB] = useState(SAMPLES.b);
  const [view, setView] = useState<'split' | 'inline'>('split');
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [ignoreWS, setIgnoreWS] = useState(false);

  const lines = useMemo(() => {
    let aNorm = a, bNorm = b;
    if (ignoreCase) { aNorm = aNorm.toLowerCase(); bNorm = bNorm.toLowerCase(); }
    if (ignoreWS) { aNorm = aNorm.replace(/\s+/g, ' '); bNorm = bNorm.replace(/\s+/g, ' '); }
    return diff(aNorm, bNorm);
  }, [a, b, ignoreCase, ignoreWS]);

  const stats = useMemo(() => {
    const s = { add: 0, del: 0, mod: 0, eq: 0 };
    lines.forEach(l => { s[l.type]++; });
    return s;
  }, [lines]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">difference</span>
          <h2 className="text-sm font-semibold text-text">差异对比</h2>
          <Badge variant="success">+{stats.add} 新增</Badge>
          <Badge variant="danger">−{stats.del} 删除</Badge>
          <Badge variant="warning">~{stats.mod} 修改</Badge>
          <Badge variant="default">={stats.eq} 相同</Badge>
          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
              {(['split', 'inline'] as const).map(v => (
                <button key={v} onClick={() => setView(v)} className={'px-2 h-6 rounded text-[10px] ' + (view === v ? 'bg-surface-high text-text' : 'text-text-secondary')}>
                  {v === 'split' ? '并排' : '内联'}
                </button>
              ))}
            </div>
            <Tooltip content="忽略大小写"><button onClick={() => setIgnoreCase(!ignoreCase)} className={'px-2 h-6 rounded text-[10px] ' + (ignoreCase ? 'bg-accent/15 text-accent' : 'text-text-secondary')}>Aa</button></Tooltip>
            <Tooltip content="忽略空白"><button onClick={() => setIgnoreWS(!ignoreWS)} className={'px-2 h-6 rounded text-[10px] ' + (ignoreWS ? 'bg-accent/15 text-accent' : 'text-text-secondary')}>␣</button></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-80 border-r border-border bg-bg p-2 flex flex-col">
            <h3 className="text-xs font-semibold text-text mb-1">原始 (A)</h3>
            <textarea value={a} onChange={(e) => setA(e.target.value)} className="flex-1 bg-surface border border-border-light rounded p-2 text-[10px] font-mono text-text resize-none" />
            <h3 className="text-xs font-semibold text-text mb-1 mt-2">新版本 (B)</h3>
            <textarea value={b} onChange={(e) => setB(e.target.value)} className="flex-1 bg-surface border border-border-light rounded p-2 text-[10px] font-mono text-text resize-none" />
          </div>

          <div className="flex-1 overflow-auto bg-bg">
            {view === 'split' ? (
              <table className="w-full text-[10px] font-mono">
                <thead className="bg-surface-high text-text-secondary sticky top-0">
                  <tr>
                    <th className="text-right px-1 w-8">A</th>
                    <th className="text-left px-1">原文</th>
                    <th className="text-right px-1 w-8">B</th>
                    <th className="text-left px-1">新文</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const aBg = l.type === 'del' || l.type === 'mod' ? 'bg-danger/10' : '';
                    const bBg = l.type === 'add' || l.type === 'mod' ? 'bg-success/10' : '';
                    return (
                      <tr key={i} className="border-b border-border-light">
                        <td className={'text-right pr-1 text-text-secondary ' + aBg}>{l.aLine || ''}</td>
                        <td className={'px-1 whitespace-pre-wrap break-all ' + aBg}>
                          {l.type === 'mod' && l.a ? (
                            <>{charDiff(l.a, l.b || '').map((c, j) => c.type === 'del' ? <span key={j} className="bg-danger/30 text-danger rounded px-0.5">{c.text}</span> : c.type === 'eq' ? <span key={j} className="text-text-secondary opacity-50">{c.text}</span> : null)}</>
                          ) : (l.a || '')}
                        </td>
                        <td className={'text-right pr-1 text-text-secondary ' + bBg}>{l.bLine || ''}</td>
                        <td className={'px-1 whitespace-pre-wrap break-all ' + bBg}>
                          {l.type === 'mod' && l.b ? (
                            <>{charDiff(l.a || '', l.b).map((c, j) => c.type === 'add' ? <span key={j} className="bg-success/30 text-success rounded px-0.5">{c.text}</span> : c.type === 'eq' ? <span key={j} className="text-text-secondary opacity-50">{c.text}</span> : null)}</>
                          ) : (l.b || '')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="text-[10px] font-mono">
                {lines.map((l, i) => {
                  const bg = l.type === 'add' ? 'bg-success/15 border-l-2 border-success' : l.type === 'del' ? 'bg-danger/15 border-l-2 border-danger' : l.type === 'mod' ? 'bg-warning/15 border-l-2 border-warning' : 'border-l-2 border-transparent';
                  const sign = l.type === 'add' ? '+' : l.type === 'del' ? '−' : l.type === 'mod' ? '~' : ' ';
                  return (
                    <div key={i} className={'flex px-2 py-0.5 ' + bg}>
                      <span className="w-6 text-text-secondary font-bold shrink-0">{sign}</span>
                      <span className="w-8 text-text-secondary shrink-0">{l.aLine || l.bLine}</span>
                      <span className="flex-1 whitespace-pre-wrap break-all text-text">{l.b || l.a || ''}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
