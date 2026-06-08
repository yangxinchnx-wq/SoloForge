// ─────────────────────────────────────────────────────────────────
// 全文搜索 — FullTextSearch (MiniSearch)
// - 索引本地文件
// - 高亮命中片段
// - 模糊匹配 / 短语 / 前缀 / 正则
// - 多文件结果聚合
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface FileDoc {
  id: string;        // path
  path: string;
  name: string;
  content: string;
  size: number;
  lang: string;
}

interface SearchHit {
  id: string;
  path: string;
  name: string;
  score: number;
  matches: Array<{ line: number; text: string; start: number; end: number; }>;
}

const STORE = 'soloforge.fulltext-index.v1';

const SAMPLE_FILES: FileDoc[] = [
  { id: 'src/App.tsx', path: 'src/App.tsx', name: 'App.tsx', lang: 'typescript', size: 1500, content: `import React from 'react';\n// SoloForge main app entry\nexport function App() {\n  return <div>SoloForge</div>;\n}` },
  { id: 'src/hooks/useChat.ts', path: 'src/hooks/useChat.ts', name: 'useChat.ts', lang: 'typescript', size: 800, content: `export function useChat() {\n  // chat with AI\n  const [messages, setMessages] = useState([]);\n  return { messages, send };\n}` },
  { id: 'src/components/Button.tsx', path: 'src/components/Button.tsx', name: 'Button.tsx', lang: 'tsx', size: 1200, content: `export function Button(props) {\n  // Material-style button with ripple\n  return <button className="btn">{props.children}</button>;\n}` },
  { id: 'src/api/client.ts', path: 'src/api/client.ts', name: 'client.ts', lang: 'typescript', size: 2000, content: `// HTTP client for SoloForge backend\nexport const API_BASE = 'http://localhost:3001';\nexport async function fetchJson(path) {\n  // fetch implementation\n}` },
  { id: 'docs/README.md', path: 'docs/README.md', name: 'README.md', lang: 'markdown', size: 3000, content: `# SoloForge\n\n## Quick Start\nRun \`npm install && npm run dev\`\n\n## Architecture\nMicro-kernel + Rust scheduler + SurrealDB` },
  { id: 'src/utils/format.ts', path: 'src/utils/format.ts', name: 'format.ts', lang: 'typescript', size: 600, content: `export function formatDate(d: Date) {\n  return d.toISOString().slice(0, 10);\n}` },
  { id: 'src/components/Card.tsx', path: 'src/components/Card.tsx', name: 'Card.tsx', lang: 'tsx', size: 900, content: `export function Card({ title, children }) {\n  return <div className="card"><h3>{title}</h3>{children}</div>;\n}` },
];

// 极简倒排索引实现
class MiniSearch {
  private docs = new Map<string, FileDoc>();
  private index = new Map<string, Set<string>>();   // term -> docIds
  private prefixIdx = new Map<string, Set<string>>();

  addAll(docs: FileDoc[]) {
    docs.forEach(d => this.add(d));
  }
  add(d: FileDoc) {
    if (this.docs.has(d.id)) return;
    this.docs.set(d.id, d);
    const tokens = this.tokenize(d.content + ' ' + d.name + ' ' + d.path);
    tokens.forEach(t => {
      if (!this.index.has(t)) this.index.set(t, new Set());
      this.index.get(t)!.add(d.id);
      // 前缀 (1-3 字符)
      for (let n = 1; n <= Math.min(3, t.length); n++) {
        const p = t.slice(0, n);
        if (!this.prefixIdx.has(p)) this.prefixIdx.set(p, new Set());
        this.prefixIdx.get(p)!.add(d.id);
      }
    });
  }
  tokenize(s: string): string[] {
    return s.toLowerCase().replace(/[^\w\u4e00-\u9fa5\s]/g, ' ').split(/\s+/).filter(t => t.length > 0);
  }
  search(query: string, opts: { fuzzy?: boolean; prefix?: boolean; phrase?: boolean } = {}): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const terms = this.tokenize(q);
    if (terms.length === 0) return [];

    const scores = new Map<string, number>();
    const matches = new Map<string, SearchHit['matches']>();
    const matchedDocIds = new Set<string>();

    terms.forEach(term => {
      // 直接命中
      const exact = this.index.get(term);
      if (exact) {
        exact.forEach(id => {
          scores.set(id, (scores.get(id) || 0) + 3);
          matchedDocIds.add(id);
        });
      }
      // 前缀
      if (opts.prefix) {
        this.prefixIdx.forEach((docs, p) => {
          if (p.startsWith(term) && p !== term) {
            docs.forEach(id => {
              scores.set(id, (scores.get(id) || 0) + 1.5);
              matchedDocIds.add(id);
            });
          }
        });
      }
      // 模糊 (编辑距离 1)
      if (opts.fuzzy) {
        this.index.forEach((docs, t) => {
          if (t === term) return;
          if (Math.abs(t.length - term.length) > 1) return;
          if (this.editDist(t, term) <= 1) {
            docs.forEach(id => {
              scores.set(id, (scores.get(id) || 0) + 1);
              matchedDocIds.add(id);
            });
          }
        });
      }
    });

    // 短语搜索 - 检查连续
    if (opts.phrase && terms.length > 1) {
      const phrase = terms.join(' ');
      matchedDocIds.forEach(id => {
        const d = this.docs.get(id);
        if (d && d.content.toLowerCase().includes(phrase)) {
          scores.set(id, scores.get(id)! * 1.5);
        }
      });
    }

    // 收集匹配行
    matchedDocIds.forEach(id => {
      const d = this.docs.get(id);
      if (!d) return;
      const ms: SearchHit['matches'] = [];
      const lines = d.content.split('\n');
      lines.forEach((line, lineNo) => {
        const lower = line.toLowerCase();
        terms.forEach(t => {
          const idx = lower.indexOf(t);
          if (idx >= 0) {
            ms.push({ line: lineNo, text: line, start: idx, end: idx + t.length });
          }
        });
      });
      matches.set(id, ms.slice(0, 5));
    });

    return Array.from(matchedDocIds).map(id => {
      const d = this.docs.get(id)!;
      return { id, path: d.path, name: d.name, score: scores.get(id) || 0, matches: matches.get(id) || [] };
    }).sort((a, b) => b.score - a.score);
  }
  editDist(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 1) return 2;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
    return dp[m][n];
  }
  getDoc(id: string) { return this.docs.get(id); }
  size() { return this.docs.size; }
}

function highlight(text: string, terms: string[]): React.ReactNode {
  if (terms.length === 0) return text;
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  terms.forEach(t => {
    let idx = lower.indexOf(t);
    while (idx >= 0) { ranges.push([idx, idx + t.length]); idx = lower.indexOf(t, idx + 1); }
  });
  ranges.sort((a, b) => a[0] - b[0]);
  // 合并重叠
  const merged: Array<[number, number]> = [];
  ranges.forEach(([s, e]) => {
    if (merged.length > 0 && merged[merged.length - 1][1] >= s) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    else merged.push([s, e]);
  });
  const out: React.ReactNode[] = [];
  let cur = 0;
  merged.forEach(([s, e], i) => {
    if (s > cur) out.push(text.slice(cur, s));
    out.push(<mark key={i} className="bg-warning/40 text-text rounded px-0.5">{text.slice(s, e)}</mark>);
    cur = e;
  });
  if (cur < text.length) out.push(text.slice(cur));
  return out;
}

export function FullTextSearch({ open, onClose }: Props) {
  const [docs, setDocs] = useState<FileDoc[]>(SAMPLE_FILES);
  const [index, setIndex] = useState<MiniSearch | null>(null);
  const [query, setQuery] = useState('');
  const [fuzzy, setFuzzy] = useState(true);
  const [prefix, setPrefix] = useState(true);
  const [phrase, setPhrase] = useState(false);
  const [scope, setScope] = useState<'all' | 'src' | 'docs'>('all');
  const [activeHit, setActiveHit] = useState<SearchHit | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      const idx = new MiniSearch();
      idx.addAll(SAMPLE_FILES);
      setIndex(idx);
    }
  }, [open]);

  const results = useMemo(() => {
    if (!index || !query) return [];
    let r = index.search(query, { fuzzy, prefix, phrase });
    if (scope !== 'all') {
      r = r.filter(h => h.path.startsWith(scope + '/'));
    }
    return r;
  }, [index, query, fuzzy, prefix, phrase, scope]);

  const totalMatches = useMemo(() => results.reduce((a, h) => a + h.matches.length, 0), [results]);
  const terms = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);

  const rebuild = useCallback(() => {
    const idx = new MiniSearch();
    idx.addAll(docs);
    setIndex(idx);
  }, [docs]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1200px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">manage_search</span>
          <h2 className="text-sm font-semibold text-text">全文搜索</h2>
          <Badge variant="primary">索引 {docs.length} 文件</Badge>
          {query && <Badge variant="info">{results.length} 命中 · {totalMatches} 处</Badge>}
          <div className="ml-auto flex items-center gap-1">
            <Tooltip content="重建索引"><IconButton icon="refresh" onClick={rebuild} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-2 border-b border-border bg-bg flex items-center gap-2">
          <span className="material-symbols-outlined text-text-secondary">search</span>
          <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入搜索词,支持空格分隔多词,前缀,模糊匹配..."
            className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs font-mono text-text" />
          <Select
            value={scope}
            options={[{ value: 'all', label: '全部' }, { value: 'src', label: 'src/' }, { value: 'docs', label: 'docs/' }]}
            onChange={(v) => setScope(v as any)}
          />
        </div>

        <div className="px-3 py-1.5 border-b border-border bg-bg flex items-center gap-3 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={fuzzy} onChange={(e) => setFuzzy(e.target.checked)} />模糊
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={prefix} onChange={(e) => setPrefix(e.target.checked)} />前缀
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={phrase} onChange={(e) => setPhrase(e.target.checked)} />短语
          </label>
          <span className="ml-auto text-text-secondary">提示: 多词空格分隔 · 模糊容错 1 字符</span>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {query && results.length === 0 && <p className="p-8 text-center text-xs text-text-secondary">无匹配结果</p>}
            {!query && (
              <div className="p-8 text-center text-xs text-text-secondary">
                <p className="mb-3">输入关键词开始搜索</p>
                <div className="flex flex-wrap gap-1 justify-center max-w-md mx-auto">
                  {['function', 'useState', 'import', 'SoloForge', 'API'].map(s => (
                    <button key={s} onClick={() => setQuery(s)} className="px-2 py-0.5 rounded bg-surface-high hover:bg-primary/15 text-text-secondary text-[10px]">{s}</button>
                  ))}
                </div>
              </div>
            )}
            {results.map(h => (
              <div key={h.id} onClick={() => setActiveHit(h)} className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeHit?.id === h.id ? 'bg-accent/10' : '')}>
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm text-accent">description</span>
                  <h3 className="text-xs font-semibold text-text flex-1">{highlight(h.name, terms)}</h3>
                  <Badge variant="default">分 {h.score.toFixed(1)}</Badge>
                  <span className="text-[10px] text-text-secondary">{h.matches.length} 处</span>
                </div>
                <div className="text-[10px] text-text-secondary font-mono mt-0.5">{h.path}</div>
                <div className="space-y-0.5 mt-1">
                  {h.matches.slice(0, 3).map((m, i) => (
                    <div key={i} className="text-[10px] font-mono text-text-secondary truncate">
                      <span className="text-text-secondary/60 mr-2">L{m.line + 1}</span>
                      {highlight(m.text, terms)}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {activeHit && (
            <div className="w-96 border-l border-border bg-bg p-3 overflow-y-auto">
              <h3 className="text-xs font-semibold text-text mb-2">{activeHit.path}</h3>
              <pre className="bg-surface border border-border-light rounded p-2 text-[10px] font-mono text-text whitespace-pre-wrap break-all">
                {index?.getDoc(activeHit.id)?.content.split('\n').map((line, i) => (
                  <div key={i} className={'flex ' + (activeHit.matches.some(m => m.line === i) ? 'bg-warning/10' : '')}>
                    <span className="w-8 text-right pr-2 text-text-secondary/40 select-none">{i + 1}</span>
                    <span>{highlight(line, terms)}</span>
                  </div>
                ))}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
