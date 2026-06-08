// ─────────────────────────────────────────────────────────────────
// 高级搜索 — AdvancedSearch
// - 文件名 / 内容 / 正则 多模式搜索
// - 文件类型过滤 / 时间过滤 / 包含/排除
// - 批量替换预览
// - 搜索历史
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  tree?: any[];
  contents?: Record<string, string>;
  onJumpToFile?: (path: string, line?: number) => void;
}

interface SearchResult {
  file: string;
  line: number;
  col: number;
  text: string;
  match: string;
  before: string;
  after: string;
}

interface HistoryEntry {
  id: string;
  ts: number;
  query: string;
  mode: 'name' | 'content' | 'regex';
  results: number;
}

const STORAGE_KEY = 'soloforge.adv-search.history.v1';

function loadHistory(): HistoryEntry[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  return [];
}
function saveHistory(arr: HistoryEntry[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(-50))); } catch { /* ignore */ }
}

// 提取所有文件路径
function extractFiles(tree: any[] | undefined, base = ''): string[] {
  if (!tree) return [];
  const out: string[] = [];
  const walk = (nodes: any[], p: string) => {
    for (const n of nodes) {
      const path = p ? `${p}/${n.name}` : n.name;
      if (n.type === 'file') out.push(path);
      else if (n.children) walk(n.children, path);
    }
  };
  walk(tree, base);
  return out;
}

export function AdvancedSearch({ open, onClose, tree, contents = {}, onJumpToFile }: Props) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'name' | 'content' | 'regex'>('content');
  const [filePattern, setFilePattern] = useState('*');
  const [excludePattern, setExcludePattern] = useState('node_modules/**, dist/**, .git/**');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [includeExt, setIncludeExt] = useState<string[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [replaceText, setReplaceText] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [previewReplace, setPreviewReplace] = useState<SearchResult[]>([]);

  useEffect(() => { saveHistory(history); }, [history]);

  const allFiles = useMemo(() => extractFiles(tree), [tree]);

  const allExts = useMemo(() => {
    const s = new Set<string>();
    allFiles.forEach(f => {
      const e = f.split('.').pop();
      if (e && e.length < 6) s.add(e);
    });
    return Array.from(s).sort();
  }, [allFiles]);

  const search = useCallback(() => {
    if (!query.trim()) { setResults([]); return; }
    setSearching(true);
    setTimeout(() => {
      const out: SearchResult[] = [];
      const flags = caseSensitive ? 'g' : 'gi';
      const excluded = excludePattern.split(',').map(s => s.trim()).filter(Boolean);
      const isExcluded = (file: string) => excluded.some(pat => {
        const re = new RegExp('^' + pat.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
        return re.test(file);
      });

      if (mode === 'name') {
        // 文件名搜索
        const re = new RegExp(query, flags);
        allFiles.forEach(f => {
          if (isExcluded(f)) return;
          if (includeExt.length > 0 && !includeExt.includes(f.split('.').pop() || '')) return;
          if (re.test(f)) {
            out.push({ file: f, line: 0, col: 0, text: f, match: f, before: '', after: '' });
          }
        });
      } else {
        // 内容搜索
        let re: RegExp;
        try {
          if (mode === 'regex') {
            re = new RegExp(query, flags);
          } else {
            const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = wholeWord ? `\\b${escaped}\\b` : escaped;
            re = new RegExp(pattern, flags);
          }
        } catch {
          setSearching(false);
          return;
        }
        for (const [file, content] of Object.entries(contents)) {
          if (isExcluded(file)) return;
          if (includeExt.length > 0 && !includeExt.includes(file.split('.').pop() || '')) return;
          const lines = content.split('\n');
          lines.forEach((line, idx) => {
            let m: RegExpExecArray | null;
            re.lastIndex = 0;
            while ((m = re.exec(line)) !== null) {
              out.push({
                file,
                line: idx + 1,
                col: m.index + 1,
                text: line,
                match: m[0],
                before: line.slice(0, m.index),
                after: line.slice(m.index + m[0].length),
              });
              if (m[0].length === 0) re.lastIndex++;
              if (out.length > 2000) return;
            }
          });
          if (out.length > 2000) break;
        }
      }
      setResults(out);
      setHistory(prev => [{
        id: 'h_' + Date.now().toString(36),
        ts: Date.now(),
        query,
        mode,
        results: out.length,
      }, ...prev].slice(0, 50));
      setSearching(false);
    }, 100);
  }, [query, mode, caseSensitive, wholeWord, excludePattern, includeExt, allFiles, contents]);

  // 替换预览
  useEffect(() => {
    if (!showReplace) { setPreviewReplace([]); return; }
    setPreviewReplace(results.map(r => ({ ...r, match: replaceText })));
  }, [showReplace, replaceText, results]);

  const exportResults = useCallback(() => {
    const lines = results.map(r => `${r.file}:${r.line}:${r.col}: ${r.text}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `search-results-${new Date().toISOString().slice(0, 10)}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [results]);

  const toggleExt = (ext: string) => {
    setIncludeExt(prev => prev.includes(ext) ? prev.filter(e => e !== ext) : [...prev, ext]);
  };

  if (!open) return null;

  const groupedResults = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    results.forEach(r => {
      const list = map.get(r.file) || [];
      list.push(r);
      map.set(r.file, list);
    });
    return Array.from(map.entries());
  }, [results]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1100px] max-w-[95vw] h-[82vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">manage_search</span>
          <h2 className="text-sm font-semibold text-text">高级搜索</h2>
          <Badge variant="primary">{results.length} 结果</Badge>
          <span className="text-xs text-text-secondary">共 {allFiles.length} 文件</span>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip content="替换"><IconButton icon="find_replace" onClick={() => setShowReplace(p => !p)} active={showReplace} /></Tooltip>
            <Tooltip content="导出"><IconButton icon="download" onClick={exportResults} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        {/* 搜索条件 */}
        <div className="px-4 py-3 border-b border-border bg-bg shrink-0 space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 p-0.5 bg-surface rounded-md border border-border-light">
              {(['content', 'name', 'regex'] as const).map(m => (
                <button key={m} onClick={() => setMode(m)}
                  className={'px-2 h-6 rounded text-[10px] ' + (mode === m ? 'bg-surface-high text-text' : 'text-text-secondary hover:text-text')}>
                  {m === 'content' ? '内容' : m === 'name' ? '文件名' : '正则'}
                </button>
              ))}
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
              placeholder={mode === 'regex' ? '正则表达式... 如 function\\s+\\w+' : mode === 'name' ? '文件名片段...' : '搜索文本...'}
              className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs text-text font-mono focus:border-accent outline-none"
            />
            <Button variant="primary" size="sm" icon="search" onClick={search} loading={searching}>搜索</Button>
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <label className="flex items-center gap-1 text-text-secondary cursor-pointer">
              <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} className="accent-accent" />
              大小写敏感
            </label>
            <label className="flex items-center gap-1 text-text-secondary cursor-pointer">
              <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} className="accent-accent" />
              全词匹配
            </label>
            <div className="flex items-center gap-1">
              <span className="text-text-secondary">排除:</span>
              <input
                value={excludePattern}
                onChange={(e) => setExcludePattern(e.target.value)}
                className="bg-surface border border-border-light rounded px-1.5 h-5 text-[10px] font-mono w-64"
              />
            </div>
          </div>
          <div>
            <div className="text-[10px] text-text-secondary mb-0.5">文件类型 ({includeExt.length === 0 ? '全部' : includeExt.join(', ')})</div>
            <div className="flex flex-wrap gap-0.5">
              {allExts.slice(0, 20).map(e => (
                <button
                  key={e}
                  onClick={() => toggleExt(e)}
                  className={'px-1.5 h-5 rounded text-[10px] font-mono border ' + (includeExt.includes(e) ? 'bg-accent/15 text-accent border-accent/30' : 'border-border text-text-secondary')}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 替换栏 */}
        {showReplace && (
          <div className="px-4 py-2 border-b border-border bg-warning/5 flex items-center gap-2 shrink-0">
            <span className="material-symbols-outlined text-sm text-warning">find_replace</span>
            <input
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              placeholder="替换为..."
              className="flex-1 bg-surface border border-border-light rounded px-2 h-6 text-xs text-text"
            />
            <span className="text-[10px] text-text-secondary">仅预览,不直接修改文件</span>
          </div>
        )}

        {/* 主体:结果 + 历史 */}
        <div className="flex-1 grid grid-cols-4 gap-0 overflow-hidden">
          <div className="col-span-3 border-r border-border overflow-y-auto">
            {searching ? (
              <div className="flex items-center justify-center h-32 text-text-secondary text-sm">搜索中...</div>
            ) : results.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-text-secondary text-sm">
                <span className="material-symbols-outlined text-4xl opacity-30">search</span>
                <p className="mt-2">输入查询开始搜索</p>
              </div>
            ) : (
              <div className="divide-y divide-border-light">
                {groupedResults.map(([file, list]) => (
                  <div key={file} className="bg-bg">
                    <div className="sticky top-0 px-3 py-1 bg-surface-high text-[10px] text-text font-mono border-b border-border-light flex items-center gap-2">
                      <span className="material-symbols-outlined text-xs">description</span>
                      <span className="truncate flex-1">{file}</span>
                      <span className="text-text-secondary">{list.length} 处</span>
                    </div>
                    {list.map((r, i) => (
                      <div
                        key={i}
                        onClick={() => onJumpToFile?.(r.file, r.line)}
                        className="px-3 py-1 hover:bg-surface-high cursor-pointer text-[11px] font-mono"
                      >
                        <div className="flex items-baseline gap-2">
                          <span className="text-text-secondary w-12 text-right shrink-0">{r.line}:</span>
                          <span className="text-text-secondary shrink-0">{r.before}</span>
                          <mark className="bg-warning/40 text-text rounded px-0.5 shrink-0">{r.match}</mark>
                          <span className="text-text-secondary truncate">{r.after}</span>
                        </div>
                        {showReplace && r.match !== replaceText && (
                          <div className="ml-12 text-[10px] text-success">
                            → {r.before}<mark className="bg-success/30 text-success rounded px-0.5">{replaceText}</mark>{r.after}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* 历史侧栏 */}
          <div className="flex flex-col overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light bg-bg">搜索历史</div>
            <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
              {history.length === 0 ? (
                <div className="text-center text-text-secondary text-xs py-4">无历史</div>
              ) : (
                history.map(h => (
                  <div
                    key={h.id}
                    onClick={() => { setQuery(h.query); setMode(h.mode); }}
                    className="px-2 py-1 rounded hover:bg-surface-high cursor-pointer"
                  >
                    <div className="text-xs text-text truncate font-mono">{h.query}</div>
                    <div className="flex items-center gap-1 text-[9px] text-text-secondary">
                      <Badge variant="info">{h.mode}</Badge>
                      <span>{h.results} 结果</span>
                      <span className="ml-auto">{new Date(h.ts).toLocaleTimeString().slice(0, 5)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
