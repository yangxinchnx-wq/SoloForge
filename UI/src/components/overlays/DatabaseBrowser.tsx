// ─────────────────────────────────────────────────────────────────
// DatabaseBrowser — 通用数据库浏览器 (P1-9 重叠标记)
// ⚠️ 80% 与 SurrealExplorer 重叠 (但本组件是 mock 数据)
// 未来合并: 数据接入走 SurrealExplorer 的 /api/surreal/* 通道
// 当前定位: 通用 SQL 浏览,适合非 SurrealDB 后端
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Column {
  name: string;
  type: string;
  pk?: boolean;
  fk?: string;
  nullable?: boolean;
  default?: string;
  unique?: boolean;
  index?: string;
}

interface Table {
  schema: string;
  name: string;
  rows: number;
  size: string;
  columns: Column[];
  indexes: Array<{ name: string; cols: string[]; unique: boolean }>;
  sample: any[][];
}

const SAMPLE_USERS: any[][] = [
  [1, 'Alice',   'alice@example.com', 28, true],
  [2, 'Bob',     'bob@example.com',   32, true],
  [3, 'Charlie', 'charlie@example.com', 45, false],
  [4, 'Diana',   'diana@example.com',  24, true],
  [5, 'Eve',     'eve@example.com',    29, true],
];

const SAMPLE_POSTS: any[][] = [
  [1, 1, 'Hello World', '2024-01-15', 1240],
  [2, 1, 'TypeScript Tips', '2024-02-20', 854],
  [3, 2, 'Database Design', '2024-03-10', 2103],
  [4, 3, 'AI Thoughts', '2024-04-05', 5432],
];

const SAMPLE_ORDERS: any[][] = [
  [1, 1, 99.99,  'pending',   '2024-05-01'],
  [2, 2, 249.50, 'paid',      '2024-05-02'],
  [3, 1, 49.00,  'paid',      '2024-05-03'],
  [4, 4, 1024.00,'shipped',   '2024-05-04'],
];

const TABLES: Table[] = [
  {
    schema: 'public', name: 'users', rows: 1247, size: '128 KB',
    columns: [
      { name: 'id',    type: 'INT',         pk: true,  unique: true, index: 'PK' },
      { name: 'name',  type: 'VARCHAR(100)',nullable: false },
      { name: 'email', type: 'VARCHAR(255)',nullable: false, unique: true, index: 'UQ_email' },
      { name: 'age',   type: 'INT',         nullable: true },
      { name: 'active',type: 'BOOLEAN',     default: 'true' },
    ],
    indexes: [
      { name: 'PK',       cols: ['id'],    unique: true },
      { name: 'UQ_email', cols: ['email'], unique: true },
      { name: 'IX_name',  cols: ['name'],  unique: false },
    ],
    sample: SAMPLE_USERS,
  },
  {
    schema: 'public', name: 'posts', rows: 3421, size: '512 KB',
    columns: [
      { name: 'id',      type: 'INT',          pk: true, unique: true, index: 'PK' },
      { name: 'user_id', type: 'INT',          fk: 'users.id', index: 'IX_user' },
      { name: 'title',   type: 'VARCHAR(200)', nullable: false },
      { name: 'created', type: 'DATE' },
      { name: 'views',   type: 'INT',          default: '0' },
    ],
    indexes: [
      { name: 'PK',     cols: ['id'],      unique: true },
      { name: 'IX_user',cols: ['user_id'], unique: false },
    ],
    sample: SAMPLE_POSTS,
  },
  {
    schema: 'public', name: 'orders', rows: 892, size: '256 KB',
    columns: [
      { name: 'id',      type: 'INT',       pk: true, unique: true },
      { name: 'user_id', type: 'INT',       fk: 'users.id' },
      { name: 'amount',  type: 'DECIMAL' },
      { name: 'status',  type: 'VARCHAR(20)' },
      { name: 'created', type: 'TIMESTAMP' },
    ],
    indexes: [
      { name: 'PK', cols: ['id'], unique: true },
    ],
    sample: SAMPLE_ORDERS,
  },
];

const QUERY_HISTORY: Array<{ id: string; sql: string; ts: number; ms: number; rows: number }> = [
  { id: 'q1', sql: 'SELECT * FROM users WHERE active = true LIMIT 10;', ts: Date.now() - 60000, ms: 12, rows: 5 },
  { id: 'q2', sql: 'SELECT p.title, u.name FROM posts p JOIN users u ON p.user_id = u.id;', ts: Date.now() - 120000, ms: 28, rows: 4 },
  { id: 'q3', sql: 'INSERT INTO orders (user_id, amount, status) VALUES (1, 99.99, \'pending\');', ts: Date.now() - 300000, ms: 8, rows: 1 },
  { id: 'q4', sql: 'UPDATE users SET active = false WHERE age < 18;', ts: Date.now() - 600000, ms: 15, rows: 0 },
];

const STORE = 'soloforge.db-browser.v1';

function loadHist() { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return []; }
function saveHist(v: any[]) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* */ } }

const KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'ON', 'GROUP', 'BY', 'ORDER', 'LIMIT', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'ALTER', 'DROP', 'INDEX', 'VIEW', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX'];

export function DatabaseBrowser({ open, onClose }: Props) {
  const [tab, setTab] = useState<'schema' | 'data' | 'query' | 'history' | 'relations'>('schema');
  const [activeTableName, setActiveTableName] = useState('users');
  const [query, setQuery] = useState('SELECT * FROM users LIMIT 10;');
  const [result, setResult] = useState<{ columns: string[]; rows: any[][]; ms: number; rowCount: number } | null>(null);
  const [history, setHistory] = useState<Array<{ id: string; sql: string; ts: number; ms: number; rows: number }>>(loadHist);
  const [showSuggest, setShowSuggest] = useState(false);
  const [page, setPage] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const activeTable = TABLES.find(t => t.name === activeTableName) || TABLES[0];
  const PAGE_SIZE = 10;

  useEffect(() => { saveHist(history); }, [history]);

  const runQuery = useCallback(() => {
    const t0 = performance.now();
    const sql = query.trim();
    let newRes: typeof result = null;
    if (/^select\s+\*\s+from\s+(\w+)/i.test(sql)) {
      const m = sql.match(/from\s+(\w+)/i);
      const name = m?.[1].toLowerCase();
      const t = TABLES.find(x => x.name === name);
      if (t) {
        newRes = { columns: t.columns.map(c => c.name), rows: t.sample, ms: performance.now() - t0, rowCount: t.sample.length };
      } else {
        newRes = { columns: ['错误'], rows: [['表 ' + name + ' 不存在']], ms: 0, rowCount: 0 };
      }
    } else if (/^insert/i.test(sql) || /^update/i.test(sql) || /^delete/i.test(sql)) {
      newRes = { columns: ['result'], rows: [['OK']], ms: performance.now() - t0, rowCount: 1 };
    } else {
      newRes = { columns: ['result'], rows: [['OK']], ms: performance.now() - t0, rowCount: 0 };
    }
    setResult(newRes);
    setHistory(prev => [{ id: 'q_' + Date.now().toString(36), sql, ts: Date.now(), ms: newRes?.ms || 0, rows: newRes?.rowCount || 0 }, ...prev].slice(0, 50));
  }, [query]);

  // 简单的关键字高亮
  const highlighted = useMemo(() => {
    return query.split(/(\s+)/).map((tok, i) => {
      if (KEYWORDS.includes(tok.toUpperCase())) {
        return <span key={i} className="text-accent font-semibold">{tok}</span>;
      }
      if (/^['"].*['"]$/.test(tok)) {
        return <span key={i} className="text-success">{tok}</span>;
      }
      if (/^-?\d+(\.\d+)?$/.test(tok)) {
        return <span key={i} className="text-warning">{tok}</span>;
      }
      return <span key={i} className="text-text">{tok}</span>;
    });
  }, [query]);

  // 简单的自动补全提示
  const suggestions = useMemo(() => {
    const cursor = taRef.current?.selectionStart || 0;
    const before = query.slice(0, cursor);
    const lastWord = before.split(/\s+/).pop() || '';
    if (!lastWord || lastWord.length < 1) return [];
    const all = [...KEYWORDS, ...TABLES.map(t => t.name), ...TABLES.flatMap(t => t.columns.map(c => c.name))];
    return all.filter(w => w.toLowerCase().startsWith(lastWord.toLowerCase()) && w.toLowerCase() !== lastWord.toLowerCase()).slice(0, 8);
  }, [query]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runQuery();
    }
  }, [runQuery]);

  const insertSuggestion = useCallback((s: string) => {
    if (!taRef.current) return;
    const cursor = taRef.current.selectionStart;
    const before = query.slice(0, cursor);
    const after = query.slice(cursor);
    const parts = before.split(/\s+/);
    parts[parts.length - 1] = s + ' ';
    setQuery(parts.join(' ') + after);
  }, [query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">storage</span>
          <h2 className="text-sm font-semibold text-text">数据库浏览器</h2>
          <Badge variant="primary">postgres @ localhost:5432</Badge>
          <Badge variant="info">db: soloforge</Badge>
          <Badge variant="success">已连接</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="play_arrow" onClick={runQuery} variant="primary">执行 (Ctrl+↵)</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'schema', l: '模式' },
            { k: 'data',   l: '数据' },
            { k: 'query',  l: 'SQL 查询' },
            { k: 'history',l: `历史 (${history.length})` },
            { k: 'relations', l: '关系图' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-56 border-r border-border bg-bg overflow-y-auto">
            <h3 className="px-2 py-1 text-[10px] font-semibold text-text-secondary">模式 (1)</h3>
            {(['public', 'auth', 'audit', 'analytics'] as const).map(s => (
              <div key={s} className="px-2 py-1 text-[10px] text-text">
                <span className="material-symbols-outlined text-xs">folder</span> {s}
              </div>
            ))}
            <div className="px-2 py-1 text-[10px] text-text mt-1 font-semibold text-text-secondary">表 ({TABLES.length})</div>
            {TABLES.map(t => (
              <div key={t.name} onClick={() => { setActiveTableName(t.name); setTab('data'); }}
                className={'group px-2 py-1.5 cursor-pointer flex items-center gap-1 text-[11px] ' + (activeTableName === t.name ? 'bg-accent/15 text-accent' : 'hover:bg-surface-high text-text')}>
                <span className="material-symbols-outlined text-xs">table_chart</span>
                <span className="flex-1">{t.name}</span>
                <span className="text-[10px] text-text-secondary">{t.rows}</span>
              </div>
            ))}
            <div className="px-2 py-1 text-[10px] text-text-secondary mt-2 font-semibold">视图 (0)</div>
            <div className="px-2 py-1 text-[10px] text-text-secondary mt-2 font-semibold">存储过程 (0)</div>
          </div>

          <div className="flex-1 overflow-auto p-3">
            {tab === 'schema' && (
              <div>
                <h3 className="text-sm font-semibold text-text mb-2">表: {activeTable.name}</h3>
                <div className="bg-bg border border-border rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-high text-text-secondary text-[10px]">
                      <tr>
                        <th className="text-left px-2 py-1.5">列名</th>
                        <th className="text-left px-2 py-1.5 w-24">类型</th>
                        <th className="text-left px-2 py-1.5 w-16">主键</th>
                        <th className="text-left px-2 py-1.5 w-20">外键</th>
                        <th className="text-left px-2 py-1.5 w-16">空</th>
                        <th className="text-left px-2 py-1.5 w-20">默认</th>
                        <th className="text-left px-2 py-1.5 w-20">索引</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeTable.columns.map(c => (
                        <tr key={c.name} className="border-t border-border-light">
                          <td className="px-2 py-1 font-mono text-text">
                            {c.pk && <span className="material-symbols-outlined text-xs text-warning inline-block mr-1">key</span>}
                            {c.name}
                          </td>
                          <td className="px-2 py-1 font-mono text-[10px] text-accent">{c.type}</td>
                          <td className="px-2 py-1">{c.pk && <Badge variant="warning">PK</Badge>}</td>
                          <td className="px-2 py-1 font-mono text-[10px] text-text-secondary">{c.fk || '—'}</td>
                          <td className="px-2 py-1 text-[10px] text-text-secondary">{c.nullable ? 'YES' : 'NO'}</td>
                          <td className="px-2 py-1 font-mono text-[10px] text-text-secondary">{c.default || '—'}</td>
                          <td className="px-2 py-1 text-[10px] text-text-secondary">{c.index || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <h3 className="text-sm font-semibold text-text mb-2 mt-4">索引 ({activeTable.indexes.length})</h3>
                <div className="bg-bg border border-border rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-high text-text-secondary text-[10px]">
                      <tr>
                        <th className="text-left px-2 py-1.5">名称</th>
                        <th className="text-left px-2 py-1.5">列</th>
                        <th className="text-left px-2 py-1.5 w-16">唯一</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeTable.indexes.map(i => (
                        <tr key={i.name} className="border-t border-border-light">
                          <td className="px-2 py-1 font-mono text-text">{i.name}</td>
                          <td className="px-2 py-1 font-mono text-[10px] text-text-secondary">{i.cols.join(', ')}</td>
                          <td className="px-2 py-1">{i.unique && <Badge variant="info">UNIQUE</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {tab === 'data' && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-sm font-semibold text-text">{activeTable.name}</h3>
                  <Badge variant="info">{activeTable.rows} 行 · {activeTable.size}</Badge>
                  <Button size="xs" icon="add">插入</Button>
                </div>
                <div className="bg-bg border border-border rounded-lg overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-high text-text-secondary text-[10px] sticky top-0">
                      <tr>
                        {activeTable.columns.map(c => (
                          <th key={c.name} className="text-left px-2 py-1.5 font-mono whitespace-nowrap">{c.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {activeTable.sample.map((row, ri) => (
                        <tr key={ri} className="border-t border-border-light hover:bg-surface-high">
                          {row.map((v, ci) => (
                            <td key={ci} className="px-2 py-1 font-mono text-[10px] text-text">{String(v)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {tab === 'query' && (
              <div className="flex flex-col h-full">
                <div className="bg-bg border border-border rounded-lg overflow-hidden flex-shrink-0">
                  <div className="px-3 py-1 bg-surface-high border-b border-border-light flex items-center gap-1">
                    <span className="text-[10px] text-text-secondary">SQL 编辑器</span>
                    <span className="text-[10px] text-text-secondary ml-auto">Ctrl+↵ 执行</span>
                  </div>
                  <div className="relative">
                    <textarea ref={taRef} value={query} onChange={(e) => { setQuery(e.target.value); setShowSuggest(true); }} onKeyDown={handleKeyDown}
                      className="w-full bg-bg p-2 text-xs font-mono text-transparent caret-text outline-none resize-none h-32 relative" style={{ caretColor: 'currentColor' }} />
                    <pre className="absolute inset-0 p-2 text-xs font-mono whitespace-pre-wrap break-all pointer-events-none">
                      {highlighted}
                    </pre>
                    {showSuggest && suggestions.length > 0 && (
                      <div className="absolute z-10 bg-surface border border-border rounded shadow-lg mt-1 left-2 max-h-40 overflow-y-auto">
                        {suggestions.map(s => (
                          <div key={s} onClick={() => insertSuggestion(s)} className="px-2 py-1 text-[10px] font-mono text-text cursor-pointer hover:bg-accent/15">
                            {s}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex-1 bg-bg border border-border rounded-lg overflow-hidden mt-2">
                  <div className="px-3 py-1 bg-surface-high border-b border-border-light flex items-center gap-2">
                    <span className="text-[10px] text-text-secondary">结果</span>
                    {result && (
                      <>
                        <Badge variant="info">{result.rowCount} 行</Badge>
                        <Badge variant="default">{result.ms.toFixed(1)} ms</Badge>
                      </>
                    )}
                  </div>
                  {result ? (
                    <div className="overflow-auto max-h-96">
                      <table className="w-full text-xs">
                        <thead className="bg-surface-high text-text-secondary text-[10px] sticky top-0">
                          <tr>
                            {result.columns.map(c => (
                              <th key={c} className="text-left px-2 py-1.5 font-mono">{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {result.rows.map((row, ri) => (
                            <tr key={ri} className="border-t border-border-light">
                              {row.map((v: any, ci: number) => (
                                <td key={ci} className="px-2 py-1 font-mono text-[10px] text-text">{String(v)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="p-4 text-center text-xs text-text-secondary">按 Ctrl+↵ 执行查询</p>
                  )}
                </div>
              </div>
            )}

            {tab === 'history' && (
              <div className="bg-bg border border-border rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-surface-high text-text-secondary text-[10px]">
                    <tr>
                      <th className="text-left px-2 py-1.5">SQL</th>
                      <th className="text-left px-2 py-1.5 w-16">行</th>
                      <th className="text-left px-2 py-1.5 w-20">耗时</th>
                      <th className="text-left px-2 py-1.5 w-32">时间</th>
                      <th className="text-left px-2 py-1.5 w-20"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...QUERY_HISTORY, ...history].map(h => (
                      <tr key={h.id} onClick={() => { setQuery(h.sql); setTab('query'); }} className="border-t border-border-light cursor-pointer hover:bg-surface-high">
                        <td className="px-2 py-1 font-mono text-[10px] text-text truncate max-w-0">{h.sql}</td>
                        <td className="px-2 py-1 text-text-secondary">{h.rows}</td>
                        <td className="px-2 py-1 text-text-secondary">{h.ms.toFixed(1)}ms</td>
                        <td className="px-2 py-1 text-text-secondary">{new Date(h.ts).toLocaleTimeString()}</td>
                        <td className="px-2 py-1">
                          <Button size="xs" icon="replay">回填</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'relations' && (
              <div className="bg-bg border border-border rounded-lg p-4 relative" style={{ height: 480 }}>
                <svg viewBox="0 0 800 440" className="w-full h-full">
                  {TABLES.map((t, i) => {
                    const positions: Record<string, [number, number]> = {
                      users:  [150, 100],
                      posts:  [400, 200],
                      orders: [650, 100],
                    };
                    const [x, y] = positions[t.name] || [100 + i * 200, 100];
                    return (
                      <g key={t.name} transform={`translate(${x}, ${y})`}>
                        <rect width="160" height={30 + t.columns.length * 18} fill="var(--bg)" stroke="var(--border)" rx="4" />
                        <rect width="160" height="22" fill="var(--accent)" rx="4" />
                        <text x="8" y="15" fontSize="11" fill="white" fontFamily="monospace">{t.name}</text>
                        {t.columns.map((c, ci) => (
                          <g key={c.name} transform={`translate(0, ${30 + ci * 18})`}>
                            <text x="8" y="12" fontSize="9" fill="var(--text)" fontFamily="monospace">
                              {c.pk ? '🔑 ' : c.fk ? '🔗 ' : '  '}{c.name}: {c.type}
                            </text>
                          </g>
                        ))}
                      </g>
                    );
                  })}
                  {/* FK relations */}
                  {(() => {
                    const pos: Record<string, [number, number]> = {
                      users: [150, 100],
                      posts: [400, 200],
                      orders: [650, 100],
                    };
                    return (
                      <>
                        <line x1={pos.posts[0]} y1={pos.posts[1] + 80} x2={pos.users[0] + 160} y2={pos.users[1] + 50} stroke="var(--accent)" strokeWidth="1.5" markerEnd="url(#arrow)" />
                        <line x1={pos.orders[0]} y1={pos.orders[1] + 50} x2={pos.users[0] + 160} y2={pos.users[1] + 80} stroke="var(--accent)" strokeWidth="1.5" markerEnd="url(#arrow)" />
                        <defs>
                          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                            <path d="M0,0 L0,6 L6,3 Z" fill="var(--accent)" />
                          </marker>
                        </defs>
                      </>
                    );
                  })()}
                </svg>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
