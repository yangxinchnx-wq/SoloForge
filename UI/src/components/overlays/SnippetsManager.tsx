// ─────────────────────────────────────────────────────────────────
// 代码片段管理 (Snippets)
// - 收藏常用代码模板,带触发前缀 (e.g. "log" + Tab 展开)
// - 变量占位符 $1, $2, $0 (光标终止位) 支持
// - 按语言/标签/收藏筛选
// - 导入 / 导出 (JSON)
// - 内置 10+ 常用片段 (log/foreach/try/useState/Pinia/...)
// - 历史插入记录 (最近 30 条)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';

// ── 类型 ──
export interface Snippet {
  id: string;
  name: string;
  prefix: string;          // 触发前缀 (e.g. "log", "feach", "ust")
  body: string;            // 多行模板,含 $1/$2/$0 占位符
  description: string;
  language: string;        // 'typescript' | 'python' | 'rust' | '*' (任意)
  tags: string[];
  scope: 'builtin' | 'user' | 'team';
  createdAt: number;
  updatedAt: number;
  usageCount: number;
  favorite: boolean;
  /** Tab stops 索引 (用于 UI 提示) */
  tabStops?: number[];
}

export interface SnippetInsertion {
  id: string;
  ts: number;
  snippetId: string;
  snippetName: string;
  prefix: string;
  language: string;
}

const STORAGE_KEY = 'soloforge.snippets.v1';
const HIST_KEY = 'soloforge.snippets.history.v1';
const MAX_HISTORY = 30;
const MAX_SNIPPETS = 200;

// ── 内置片段 ──
const BUILTIN_SNIPPETS: Omit<Snippet, 'createdAt' | 'updatedAt' | 'usageCount' | 'favorite'>[] = [
  {
    id: 'b_console_log', scope: 'builtin', name: 'console.log', prefix: 'log',
    language: 'javascript',
    tags: ['debug', 'log', 'console'],
    description: '标准 console.log 输出',
    body: 'console.log(${1:value}$0);',
  },
  {
    id: 'b_console_warn', scope: 'builtin', name: 'console.warn', prefix: 'warn',
    language: 'javascript',
    tags: ['debug', 'log'],
    description: 'console.warn 警告',
    body: 'console.warn(${1:message}$0);',
  },
  {
    id: 'b_try_catch', scope: 'builtin', name: 'try-catch', prefix: 'try',
    language: 'typescript',
    tags: ['error-handling', 'async'],
    description: 'try/catch 错误捕获',
    body: 'try {\n  ${1:tryBlock}\n} catch (err) {\n  console.error(err);\n  ${2:handleError}\n}$0',
  },
  {
    id: 'b_foreach', scope: 'builtin', name: 'forEach', prefix: 'feach',
    language: 'typescript',
    tags: ['array', 'loop'],
    description: '数组 forEach 遍历',
    body: '${1:arr}.forEach((${2:item}) => {\n  ${3:// body}\n});$0',
  },
  {
    id: 'b_useState', scope: 'builtin', name: 'useState', prefix: 'ust',
    language: 'typescript',
    tags: ['react', 'hook', 'state'],
    description: 'React useState 钩子',
    body: 'const [${1:state}, set${1/(.*)/${1:/capitalize}/}] = useState<${2:Type}>(${3:initial});$0',
  },
  {
    id: 'b_useEffect', scope: 'builtin', name: 'useEffect', prefix: 'uef',
    language: 'typescript',
    tags: ['react', 'hook', 'effect'],
    description: 'React useEffect 钩子',
    body: 'useEffect(() => {\n  ${1:// effect}\n  return () => {\n    ${2:// cleanup}\n  };\n}, [${3:deps}]);$0',
  },
  {
    id: 'b_async_fn', scope: 'builtin', name: 'async function', prefix: 'afn',
    language: 'typescript',
    tags: ['async', 'function'],
    description: 'async 异步函数',
    body: 'async function ${1:name}(${2:params}): Promise<${3:ReturnType}> {\n  ${4:body}\n  return ${5:result};\n}$0',
  },
  {
    id: 'b_fetch_json', scope: 'builtin', name: 'fetch JSON', prefix: 'fetch',
    language: 'typescript',
    tags: ['http', 'api', 'fetch'],
    description: 'fetch + JSON 解析',
    body: 'const res = await fetch(${1:url});\nif (!res.ok) throw new Error(${2:errMsg});\nconst data = await res.json();$0',
  },
  {
    id: 'b_pinia_store', scope: 'builtin', name: 'Pinia store', prefix: 'pinia',
    language: 'typescript',
    tags: ['vue', 'pinia', 'store'],
    description: 'Pinia defineStore',
    body: "export const use${1:Name}Store = defineStore('${1}', () => {\n  const ${2:state} = ref<${3:Type}>(${4:init});\n  const ${5:action} = () => { ${6:// impl} };\n  return { ${2}, ${5} };\n});$0",
  },
  {
    id: 'b_python_main', scope: 'builtin', name: 'if __name__', prefix: 'main',
    language: 'python',
    tags: ['python', 'entry', 'main'],
    description: 'Python 主入口保护',
    body: 'if __name__ == \'__main__\':\n    ${1:main()}$0',
  },
  {
    id: 'b_python_class', scope: 'builtin', name: 'class', prefix: 'class',
    language: 'python',
    tags: ['python', 'class', 'oop'],
    description: 'Python 类定义',
    body: 'class ${1:Name}(${2:Base}):\n    def __init__(self, ${3:params}):\n        super().__init__()\n        ${4:# init}\n\n    def ${5:method}(self):\n        ${6:pass}$0',
  },
  {
    id: 'b_rust_main', scope: 'builtin', name: 'fn main', prefix: 'fnmain',
    language: 'rust',
    tags: ['rust', 'main', 'entry'],
    description: 'Rust main 函数',
    body: 'fn main() {\n    ${1:println!("Hello, world!");}\n}$0',
  },
  {
    id: 'b_rust_struct', scope: 'builtin', name: 'struct', prefix: 'struct',
    language: 'rust',
    tags: ['rust', 'struct'],
    description: 'Rust 结构体',
    body: '#[derive(Debug, Clone)]\nstruct ${1:Name} {\n    ${2:field}: ${3:Type},\n}$0',
  },
  {
    id: 'b_curl', scope: 'builtin', name: 'curl', prefix: 'curl',
    language: '*',
    tags: ['http', 'curl', 'request'],
    description: 'curl 请求模板',
    body: 'curl -X ${1:GET} \\\n  -H "Content-Type: application/json" \\\n  -d \'${2:body}\' \\\n  ${3:url}$0',
  },
  {
    id: 'b_soloforge_court', scope: 'builtin', name: 'court submission', prefix: 'court',
    language: 'typescript',
    tags: ['soloforge', 'court', 'governance'],
    description: 'SoloForge 法庭提交',
    body: "await court.submit({\n  caseId: '${1:caseId}',\n  evidence: [\n    { kind: '${2:kind}', payload: ${3:payload} },\n  ],\n  reasoning: '${4:reasoning}',\n});$0",
  },
];

// ── 加载/保存 ──
function loadSnippets(): Snippet[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as Snippet[];
      const ids = new Set(data.map(s => s.id));
      // 合并新增的内置片段
      const merged: Snippet[] = [...data];
      const now = Date.now();
      BUILTIN_SNIPPETS.forEach(bs => {
        if (!ids.has(bs.id)) {
          merged.push({ ...bs, createdAt: now, updatedAt: now, usageCount: 0, favorite: false });
        }
      });
      return merged;
    }
  } catch { /* ignore */ }
  const now = Date.now();
  return BUILTIN_SNIPPETS.map(bs => ({ ...bs, createdAt: now, updatedAt: now, usageCount: 0, favorite: false }));
}

function saveSnippets(s: Snippet[]) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ } }

function loadHistory(): SnippetInsertion[] {
  try { const raw = localStorage.getItem(HIST_KEY); if (raw) return JSON.parse(raw); } catch { /* ignore */ }
  return [];
}
function saveHistory(h: SnippetInsertion[]) { try { localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, MAX_HISTORY))); } catch { /* ignore */ } }

// ── 工具: 解析 $1/$0 占位符 ──
interface TabStop { index: number; start: number; end: number; }
function parseTabStops(body: string): TabStop[] {
  const stops: TabStop[] = [];
  const re = /\$(\d+|\$0)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const idx = m[1] === '$0' ? 0 : parseInt(m[1], 10);
    stops.push({ index: idx, start: m.index, end: m.index + m[0].length });
  }
  return stops;
}

// ── 按前缀匹配 (考虑缩写) ──
function matchPrefix(snippets: Snippet[], prefix: string): Snippet[] {
  if (!prefix) return [];
  const p = prefix.toLowerCase();
  return snippets
    .filter(s => s.prefix.toLowerCase().startsWith(p))
    .sort((a, b) => {
      // 完全匹配 > 前缀匹配,使用次数降序
      if (a.prefix.toLowerCase() === p && b.prefix.toLowerCase() !== p) return -1;
      if (b.prefix.toLowerCase() === p && a.prefix.toLowerCase() !== p) return 1;
      if (a.usageCount !== b.usageCount) return b.usageCount - a.usageCount;
      return a.prefix.length - b.prefix.length;
    })
    .slice(0, 8);
}

// ─── 主组件 ───
interface Props {
  open: boolean;
  onClose: () => void;
  /** 调用方传当前编辑器上下文 (语言/当前前缀) */
  currentLanguage?: string;
  currentPrefix?: string;
  /** 插入片段到调用方 */
  onInsert?: (snippet: Snippet) => void;
}

export function SnippetsManager({ open, onClose, currentLanguage = 'typescript', currentPrefix = '', onInsert }: Props) {
  const [snippets, setSnippets] = useState<Snippet[]>(loadSnippets);
  const [history, setHistory] = useState<SnippetInsertion[]>(loadHistory);
  const [search, setSearch] = useState(currentPrefix);
  const [scopeFilter, setScopeFilter] = useState<'all' | Snippet['scope']>('all');
  const [langFilter, setLangFilter] = useState<string>('all');
  const [favOnly, setFavOnly] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<Partial<Snippet> | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [tab, setTab] = useState<'browse' | 'history' | 'import'>('browse');
  const [importText, setImportText] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { saveSnippets(snippets); }, [snippets]);
  useEffect(() => { saveHistory(history); }, [history]);

  // 自动 focus 搜索框
  useEffect(() => {
    if (open) {
      setSearch(currentPrefix);
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open, currentPrefix]);

  // 同步 search 当 currentPrefix 变化
  useEffect(() => {
    if (open && currentPrefix && !search) setSearch(currentPrefix);
  }, [open, currentPrefix, search]);

  // ── 操作 ──
  const insertSnippet = useCallback((s: Snippet) => {
    setSnippets(prev => prev.map(x => x.id === s.id ? { ...x, usageCount: x.usageCount + 1, updatedAt: Date.now() } : x));
    const ins: SnippetInsertion = {
      id: 'ins_' + Date.now().toString(36),
      ts: Date.now(),
      snippetId: s.id,
      snippetName: s.name,
      prefix: s.prefix,
      language: s.language,
    };
    setHistory(prev => [ins, ...prev].slice(0, MAX_HISTORY));
    onInsert?.(s);
  }, [onInsert]);

  const toggleFav = useCallback((id: string) => {
    setSnippets(prev => prev.map(s => s.id === id ? { ...s, favorite: !s.favorite, updatedAt: Date.now() } : s));
  }, []);

  const deleteSnippet = useCallback((id: string) => {
    const s = snippets.find(x => x.id === id);
    if (!s || s.scope === 'builtin') return;
    if (!confirm(`确认删除片段 "${s.name}"?`)) return;
    setSnippets(prev => prev.filter(x => x.id !== id));
  }, [snippets]);

  const newSnippet = useCallback(() => {
    const id = 'u_' + Date.now().toString(36);
    const draft: Snippet = {
      id, scope: 'user', name: '新片段', prefix: 'newprefix', body: '$0', description: '',
      language: currentLanguage, tags: [], createdAt: Date.now(), updatedAt: Date.now(),
      usageCount: 0, favorite: false,
    };
    setSnippets(prev => [draft, ...prev].slice(0, MAX_SNIPPETS));
    setEditingId(id);
    setEditingDraft(draft);
  }, [currentLanguage]);

  const saveEdit = useCallback(() => {
    if (!editingId || !editingDraft) return;
    setSnippets(prev => prev.map(s => s.id === editingId ? { ...s, ...editingDraft, updatedAt: Date.now() } as Snippet : s));
    setEditingId(null);
    setEditingDraft(null);
  }, [editingId, editingDraft]);

  const cancelEdit = useCallback(() => { setEditingId(null); setEditingDraft(null); }, []);

  const exportSnippets = useCallback(() => {
    const exportable = snippets.filter(s => s.scope !== 'builtin');
    const json = JSON.stringify({
      __type: 'soloforge.snippets', version: 1, exportedAt: Date.now(),
      count: exportable.length, snippets: exportable,
    }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'soloforge-snippets-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [snippets]);

  const importSnippets = useCallback(() => {
    try {
      const data = JSON.parse(importText);
      if (data.__type !== 'soloforge.snippets' || !Array.isArray(data.snippets)) {
        throw new Error('格式不匹配');
      }
      const ids = new Set(snippets.map(s => s.id));
      const newOnes: Snippet[] = data.snippets.filter((s: Snippet) => !ids.has(s.id));
      if (newOnes.length === 0) {
        alert('没有新片段可导入');
        return;
      }
      setSnippets(prev => [...newOnes, ...prev].slice(0, MAX_SNIPPETS));
      setImportText('');
      setTab('browse');
      alert('已导入 ' + newOnes.length + ' 个片段');
    } catch (e) {
      alert('导入失败: ' + (e as Error).message);
    }
  }, [importText, snippets]);

  // ── 派生 ──
  const matched = useMemo(() => matchPrefix(snippets, search), [snippets, search]);

  const filtered = useMemo(() => {
    return snippets.filter(s => {
      if (scopeFilter !== 'all' && s.scope !== scopeFilter) return false;
      if (langFilter !== 'all' && s.language !== langFilter && s.language !== '*') return false;
      if (favOnly && !s.favorite) return false;
      if (search && !matched.find(m => m.id === s.id)) {
        // 模糊搜索 (匹配 name / description / tags)
        const q = search.toLowerCase();
        if (!s.name.toLowerCase().includes(q) &&
            !s.description.toLowerCase().includes(q) &&
            !s.tags.some(t => t.toLowerCase().includes(q))) return false;
      }
      return true;
    }).sort((a, b) => b.usageCount - a.usageCount);
  }, [snippets, scopeFilter, langFilter, favOnly, search, matched]);

  const languages = useMemo(() => {
    const s = new Set(snippets.map(x => x.language));
    return ['all', ...Array.from(s).sort()];
  }, [snippets]);

  if (!open) return null;

  const preview = previewId ? snippets.find(s => s.id === previewId) : null;
  const editing = editingId ? snippets.find(s => s.id === editingId) : null;
  const stats = useMemo(() => ({
    total: snippets.length,
    builtin: snippets.filter(s => s.scope === 'builtin').length,
    user: snippets.filter(s => s.scope === 'user').length,
    team: snippets.filter(s => s.scope === 'team').length,
    totalUses: snippets.reduce((a, s) => a + s.usageCount, 0),
  }), [snippets]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(96vw,1100px)] h-[min(92vh,780px)] bg-bg-elevated border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">code_blocks</span>
            <h2 className="text-base font-semibold">代码片段</h2>
            <span className="text-xs text-text-secondary ml-2">
              {stats.user + stats.team} 自定义 · {stats.builtin} 内置 · {stats.totalUses} 次插入
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {([
              { id: 'browse',  label: '浏览', icon: 'list' },
              { id: 'history', label: '历史', icon: 'history' },
              { id: 'import',  label: '导入', icon: 'upload' },
            ] as const).map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={'px-2.5 py-1 text-xs rounded border flex items-center gap-1 ' +
                  (tab === t.id ? 'border-primary text-primary bg-primary/10' : 'border-border hover:bg-bg-dim')}
              >
                <span className="material-symbols-outlined text-sm">{t.icon}</span>
                {t.label}
              </button>
            ))}
            {tab === 'browse' && (
              <>
                <button onClick={newSnippet} className="px-2.5 py-1 text-xs rounded bg-primary text-bg flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">add</span>
                  新建
                </button>
                <button onClick={exportSnippets} className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1" title="导出自定义片段">
                  <span className="material-symbols-outlined text-sm">download</span>
                  导出
                </button>
              </>
            )}
            <button onClick={onClose} className="px-2 py-1 rounded hover:bg-bg-dim text-text-secondary ml-1">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>

        {tab === 'browse' && (
          <div className="flex-1 flex min-h-0">
            {/* 左: 筛选 + 列表 */}
            <div className="w-80 border-r border-border flex flex-col shrink-0">
              {/* 搜索框 */}
              <div className="p-3 border-b border-border">
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary text-base">search</span>
                  <input
                    ref={searchRef}
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="输入前缀或关键字..."
                    className="w-full pl-8 pr-2 py-1.5 rounded border border-border bg-bg text-sm font-mono"
                  />
                </div>
                {/* 前缀匹配建议 */}
                {search && matched.length > 0 && (
                  <div className="mt-2 max-h-40 overflow-auto rounded border border-border bg-bg">
                    {matched.map(m => (
                      <button
                        key={m.id}
                        onClick={() => insertSnippet(m)}
                        className="w-full px-2 py-1.5 flex items-center gap-2 hover:bg-primary/10 text-left"
                      >
                        <span className="material-symbols-outlined text-sm text-primary">bolt</span>
                        <span className="font-mono text-sm font-medium text-text">{m.prefix}</span>
                        <span className="text-xs text-text-secondary truncate flex-1">{m.name}</span>
                        <span className="text-[10px] text-text-secondary/70">{m.usageCount > 0 && `×${m.usageCount}`}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 筛选条 */}
              <div className="px-3 py-2 border-b border-border flex flex-wrap gap-1">
                {(['all', 'builtin', 'user', 'team'] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setScopeFilter(s)}
                    className={'px-1.5 py-0.5 text-[11px] rounded ' +
                      (scopeFilter === s ? 'bg-primary/20 text-primary' : 'hover:bg-bg-dim text-text-secondary')}
                  >
                    {s === 'all' ? '全部' : s === 'builtin' ? '内置' : s === 'user' ? '用户' : '团队'}
                  </button>
                ))}
                <button
                  onClick={() => setFavOnly(v => !v)}
                  className={'px-1.5 py-0.5 text-[11px] rounded inline-flex items-center gap-0.5 ' +
                    (favOnly ? 'bg-warning/20 text-warning' : 'hover:bg-bg-dim text-text-secondary')}
                >
                  <span className="material-symbols-outlined text-xs">star</span>
                  收藏
                </button>
              </div>
              <div className="px-3 py-1.5 border-b border-border flex gap-1 overflow-auto">
                {languages.map(l => (
                  <button
                    key={l}
                    onClick={() => setLangFilter(l)}
                    className={'px-1.5 py-0.5 text-[10px] rounded shrink-0 ' +
                      (langFilter === l ? 'bg-primary/20 text-primary' : 'hover:bg-bg-dim text-text-secondary')}
                  >
                    {l === 'all' ? '所有' : l}
                  </button>
                ))}
              </div>

              {/* 列表 */}
              <div className="flex-1 overflow-auto">
                {filtered.length === 0 && (
                  <div className="px-3 py-6 text-center text-xs text-text-secondary">无匹配片段</div>
                )}
                {filtered.map(s => (
                  <div
                    key={s.id}
                    onClick={() => setPreviewId(s.id)}
                    onDoubleClick={() => insertSnippet(s)}
                    className={'px-3 py-2 border-b border-border/50 cursor-pointer hover:bg-bg-dim group ' +
                      (previewId === s.id ? 'bg-primary/10 border-l-2 border-l-primary' : '')}
                  >
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={e => { e.stopPropagation(); toggleFav(s.id); }}
                        className="text-text-secondary hover:text-warning"
                      >
                        <span className="material-symbols-outlined text-sm" style={{ color: s.favorite ? '#f59e0b' : undefined }}>
                          {s.favorite ? 'star' : 'star_outline'}
                        </span>
                      </button>
                      <span className="font-mono text-sm font-medium text-text truncate">{s.prefix}</span>
                      <span className="ml-auto text-[10px] text-text-secondary shrink-0">{s.language}</span>
                    </div>
                    <div className="text-xs text-text-secondary truncate mt-0.5 ml-6">{s.name}</div>
                    {s.usageCount > 0 && (
                      <div className="text-[10px] text-text-secondary/70 ml-6 mt-0.5">使用 × {s.usageCount}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* 右: 预览 / 编辑 */}
            <div className="flex-1 flex flex-col min-w-0">
              {editing && editingDraft ? (
                /* 编辑模式 */
                <div className="flex-1 overflow-auto p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary">edit</span>
                    <h3 className="text-base font-semibold">编辑片段</h3>
                    <div className="ml-auto flex gap-1.5">
                      <button onClick={cancelEdit} className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim">取消</button>
                      <button onClick={saveEdit} className="px-2.5 py-1 text-xs rounded bg-primary text-bg">保存</button>
                    </div>
                  </div>
                  <Field label="名称">
                    <input type="text" value={editingDraft.name || ''} onChange={e => setEditingDraft({ ...editingDraft, name: e.target.value })} className="w-full px-2 py-1 rounded border border-border bg-bg text-sm" />
                  </Field>
                  <Field label="前缀 (在编辑器中输入)">
                    <input type="text" value={editingDraft.prefix || ''} onChange={e => setEditingDraft({ ...editingDraft, prefix: e.target.value })} className="w-full px-2 py-1 rounded border border-border bg-bg text-sm font-mono" />
                  </Field>
                  <Field label="描述">
                    <input type="text" value={editingDraft.description || ''} onChange={e => setEditingDraft({ ...editingDraft, description: e.target.value })} className="w-full px-2 py-1 rounded border border-border bg-bg text-sm" />
                  </Field>
                  <Field label="语言">
                    <select value={editingDraft.language || 'typescript'} onChange={e => setEditingDraft({ ...editingDraft, language: e.target.value })} className="w-full px-2 py-1 rounded border border-border bg-bg text-sm">
                      {['typescript', 'javascript', 'python', 'rust', 'go', 'java', 'cpp', 'html', 'css', 'sql', 'shell', '*'].map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </Field>
                  <Field label={`模板 (使用 $1, $2, $0 标记占位符,光标终止于 $0)  [ ${(editingDraft.body || '').split('\n').length} 行 ]`}>
                    <textarea
                      value={editingDraft.body || ''}
                      onChange={e => setEditingDraft({ ...editingDraft, body: e.target.value })}
                      className="w-full h-64 px-3 py-2 rounded border border-border bg-bg text-xs font-mono resize-none"
                    />
                  </Field>
                  <Field label="标签 (逗号分隔)">
                    <input type="text" value={(editingDraft.tags || []).join(',')} onChange={e => setEditingDraft({ ...editingDraft, tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })} className="w-full px-2 py-1 rounded border border-border bg-bg text-sm" />
                  </Field>
                </div>
              ) : preview ? (
                /* 预览模式 */
                <div className="flex-1 overflow-auto">
                  <div className="px-5 py-3 border-b border-border flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary">code_blocks</span>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base font-semibold truncate">{preview.name}</h3>
                      <div className="text-xs text-text-secondary flex items-center gap-2">
                        <span className="font-mono">{preview.prefix}</span>
                        <span>·</span>
                        <span>{preview.language}</span>
                        <span>·</span>
                        <span>使用 {preview.usageCount} 次</span>
                        <span>·</span>
                        <span>{preview.scope === 'builtin' ? '内置' : preview.scope === 'user' ? '用户' : '团队'}</span>
                      </div>
                    </div>
                    <button onClick={() => insertSnippet(preview)} className="px-3 py-1.5 text-sm rounded bg-primary text-bg flex items-center gap-1">
                      <span className="material-symbols-outlined text-sm">content_paste</span>
                      插入
                    </button>
                    {preview.scope !== 'builtin' && (
                      <>
                        <button
                          onClick={() => { setEditingId(preview.id); setEditingDraft({ ...preview }); }}
                          className="px-2.5 py-1.5 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1"
                        >
                          <span className="material-symbols-outlined text-sm">edit</span>
                          编辑
                        </button>
                        <button
                          onClick={() => deleteSnippet(preview.id)}
                          className="px-2.5 py-1.5 text-xs rounded border border-border hover:bg-danger/15 hover:text-danger hover:border-danger/30 flex items-center gap-1"
                        >
                          <span className="material-symbols-outlined text-sm">delete</span>
                        </button>
                      </>
                    )}
                  </div>
                  {preview.description && (
                    <div className="px-5 py-2 text-sm text-text-secondary border-b border-border/50">{preview.description}</div>
                  )}
                  {preview.tags.length > 0 && (
                    <div className="px-5 py-2 flex flex-wrap gap-1 border-b border-border/50">
                      {preview.tags.map(t => (
                        <span key={t} className="px-1.5 py-0.5 rounded text-[10px] bg-bg-dim text-text-secondary">#{t}</span>
                      ))}
                    </div>
                  )}
                  <pre className="px-5 py-3 text-xs font-mono whitespace-pre-wrap break-all text-text leading-5">
                    {preview.body}
                  </pre>
                  <div className="px-5 py-3 border-t border-border">
                    <div className="text-xs text-text-secondary mb-1.5">占位符提示</div>
                    <div className="flex gap-2 flex-wrap text-xs">
                      {parseTabStops(preview.body).map((ts, i) => (
                        <span key={i} className="px-1.5 py-0.5 rounded bg-primary/15 text-primary font-mono">${ts.index === 0 ? '0' : ts.index}</span>
                      ))}
                      {parseTabStops(preview.body).length === 0 && (
                        <span className="text-text-secondary/70">无占位符</span>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                /* 空状态 */
                <div className="flex-1 flex items-center justify-center text-text-secondary flex-col gap-2">
                  <span className="material-symbols-outlined text-4xl opacity-30">code_blocks</span>
                  <div className="text-sm">从左侧选择一个片段查看详情</div>
                  <div className="text-xs">或双击直接插入编辑器</div>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'history' && (
          <div className="flex-1 overflow-auto p-4">
            {history.length === 0 && (
              <div className="text-center py-12 text-text-secondary text-sm">暂无插入历史</div>
            )}
            {history.length > 0 && (
              <div className="max-w-2xl mx-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-text-secondary border-b border-border">
                    <tr>
                      <th className="text-left py-2 px-2">时间</th>
                      <th className="text-left py-2 px-2">片段</th>
                      <th className="text-left py-2 px-2">前缀</th>
                      <th className="text-left py-2 px-2">语言</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map(h => (
                      <tr key={h.id} className="border-b border-border/50 hover:bg-bg-dim/50">
                        <td className="py-1.5 px-2 text-text-secondary text-xs">{new Date(h.ts).toLocaleString('zh-CN')}</td>
                        <td className="py-1.5 px-2">{h.snippetName}</td>
                        <td className="py-1.5 px-2 font-mono text-primary">{h.prefix}</td>
                        <td className="py-1.5 px-2 text-text-secondary">{h.language}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3 text-center">
                  <button onClick={() => setHistory([])} className="text-xs text-text-secondary hover:text-danger">清空历史</button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'import' && (
          <div className="flex-1 p-4 flex flex-col">
            <div className="text-sm text-text-secondary mb-2">粘贴之前导出的 JSON (格式: <code className="font-mono text-primary">soloforge.snippets</code>)</div>
            <textarea
              value={importText}
              onChange={e => setImportText(e.target.value)}
              placeholder='{ "__type": "soloforge.snippets", "version": 1, ... }'
              className="flex-1 px-3 py-2 rounded border border-border bg-bg text-xs font-mono resize-none"
            />
            <div className="mt-2 flex justify-end gap-1.5">
              <button onClick={() => setImportText('')} className="px-3 py-1 text-sm rounded border border-border hover:bg-bg-dim">清空</button>
              <button onClick={importSnippets} disabled={!importText.trim()} className="px-3 py-1 text-sm rounded bg-primary text-bg disabled:opacity-50">导入</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-text-secondary mb-1 block">{label}</label>
      {children}
    </div>
  );
}
