// ─────────────────────────────────────────────────────────────────
// SurrealExplorer — SurrealDB 浏览器
// - 4 个 DB overlay 中**唯一真接后端**的 (P1-9 标记)
// - 表格列表 / 记录浏览 / SQL 查询 / Schema 查看 / 导入导出
// - 与 DatabaseBrowser / DbDesigner / DatabaseSeeder 80% 重叠
// - 重叠清单: 通用只读浏览 / 模式设计 / 测试数据生成,均 mock 数据
// - 未来合并: 把另 3 个的视图迁过来,统一接 /api/surreal/*
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { API_BASE } from '../../api/client';

// ── 类型 ──
interface TableSchema {
  name: string;
  description: string;
  fields: Array<{ name: string; type: string; optional: boolean; indexed: boolean; example: string }>;
  indexes: Array<{ name: string; cols: string[]; unique: boolean }>;
  count: number;
  sizeKB: number;
  category: 'core' | 'decision' | 'court' | 'governor' | 'audit';
}

interface QueryResult {
  ok: boolean;
  rows: any[];
  fields: string[];
  durationMs: number;
  error?: string;
  mode: 'live' | 'mock';
}

// ── 模拟表 schema (基于 SoloForge 已知结构) ──
const MOCK_TABLES: TableSchema[] = [
  {
    name: 'decision', category: 'decision', count: 47, sizeKB: 23.5,
    description: 'AI 决策链路主表',
    fields: [
      { name: 'id',          type: 'record',   optional: false, indexed: true,  example: 'decision:abc123' },
      { name: 'created_at',  type: 'datetime', optional: false, indexed: true,  example: '2026-06-06T14:00:00Z' },
      { name: 'agent_id',    type: 'string',   optional: false, indexed: true,  example: 'agent-1' },
      { name: 'query',       type: 'string',   optional: false, indexed: false, example: '"分析用户行为"' },
      { name: 'candidates',  type: 'array',    optional: false, indexed: false, example: '[{...}, ...]' },
      { name: 'selected',    type: 'int',      optional: false, indexed: false, example: '2' },
      { name: 'confidence',  type: 'float',    optional: true,  indexed: false, example: '0.87' },
    ],
    indexes: [
      { name: 'idx_created', cols: ['created_at'], unique: false },
      { name: 'idx_agent',   cols: ['agent_id'],   unique: false },
    ],
  },
  {
    name: 'evidence', category: 'court', count: 124, sizeKB: 87.2,
    description: '法庭证据',
    fields: [
      { name: 'id',         type: 'record',   optional: false, indexed: true,  example: 'evidence:xyz' },
      { name: 'case_id',    type: 'string',   optional: false, indexed: true,  example: 'case-001' },
      { name: 'kind',       type: 'string',   optional: false, indexed: true,  example: 'log' },
      { name: 'payload',    type: 'object',   optional: false, indexed: false, example: '{...}' },
      { name: 'hash',       type: 'string',   optional: false, indexed: true,  example: '"sha256:..."' },
      { name: 'submitted_by', type: 'string', optional: true,  indexed: true,  example: 'agent-2' },
    ],
    indexes: [
      { name: 'idx_case', cols: ['case_id'], unique: false },
    ],
  },
  {
    name: 'court_verdict', category: 'court', count: 31, sizeKB: 18.0,
    description: '法庭裁决',
    fields: [
      { name: 'id',         type: 'record',  optional: false, indexed: true,  example: 'verdict:001' },
      { name: 'case_id',    type: 'string',  optional: false, indexed: true,  example: 'case-001' },
      { name: 'verdict',    type: 'string',  optional: false, indexed: false, example: 'approve' },
      { name: 'reasoning',  type: 'string',  optional: false, indexed: false, example: '"基于 X, Y, Z"' },
      { name: 'jurors',     type: 'array',   optional: false, indexed: false, example: '[juror-1, ...]' },
      { name: 'created_at', type: 'datetime', optional: false, indexed: true, example: '2026-06-06T14:00:00Z' },
    ],
    indexes: [],
  },
  {
    name: 'marl_episode', category: 'governor', count: 12, sizeKB: 156.0,
    description: 'MARL 训练 episode',
    fields: [
      { name: 'id',           type: 'record',  optional: false, indexed: true,  example: 'episode:0001' },
      { name: 'started_at',   type: 'datetime', optional: false, indexed: true,  example: '2026-06-05T10:00:00Z' },
      { name: 'steps',        type: 'int',     optional: false, indexed: false, example: '1024' },
      { name: 'total_reward', type: 'float',   optional: false, indexed: false, example: '142.5' },
      { name: 'agents',       type: 'array',   optional: false, indexed: false, example: '[...]' },
    ],
    indexes: [{ name: 'idx_started', cols: ['started_at'], unique: false }],
  },
  {
    name: 'policy_snapshot', category: 'governor', count: 8, sizeKB: 4.2,
    description: '策略快照',
    fields: [
      { name: 'id',        type: 'record', optional: false, indexed: true,  example: 'policy:001' },
      { name: 'episode_id', type: 'string', optional: false, indexed: true, example: 'episode:0001' },
      { name: 'params',    type: 'object', optional: false, indexed: false, example: '{...}' },
      { name: 'created_at', type: 'datetime', optional: false, indexed: true, example: '...' },
    ],
    indexes: [],
  },
  {
    name: 'event_log', category: 'audit', count: 1847, sizeKB: 412.0,
    description: '事件审计日志',
    fields: [
      { name: 'id',      type: 'record',   optional: false, indexed: true,  example: 'event:0001' },
      { name: 'ts',      type: 'datetime', optional: false, indexed: true,  example: '2026-06-06T14:00:00Z' },
      { name: 'kind',    type: 'string',   optional: false, indexed: true,  example: 'decision.made' },
      { name: 'level',   type: 'string',   optional: false, indexed: false, example: 'info' },
      { name: 'actor',   type: 'string',   optional: false, indexed: true,  example: 'agent-1' },
      { name: 'payload', type: 'object',   optional: true,  indexed: false, example: '{...}' },
    ],
    indexes: [
      { name: 'idx_ts',   cols: ['ts'],   unique: false },
      { name: 'idx_kind', cols: ['kind'], unique: false },
    ],
  },
  {
    name: 'system_config', category: 'core', count: 6, sizeKB: 0.8,
    description: '系统配置 KV',
    fields: [
      { name: 'key',   type: 'string', optional: false, indexed: true,  example: '"theme"' },
      { name: 'value', type: 'object', optional: false, indexed: false, example: '"dark"' },
    ],
    indexes: [{ name: 'idx_key', cols: ['key'], unique: true }],
  },
  {
    name: 'migration_history', category: 'core', count: 5, sizeKB: 1.2,
    description: '迁移历史',
    fields: [
      { name: 'version',  type: 'string',   optional: false, indexed: true,  example: '"v4_governor"' },
      { name: 'applied_at', type: 'datetime', optional: false, indexed: true, example: '...' },
      { name: 'status',   type: 'string',   optional: false, indexed: false, example: '"ok"' },
    ],
    indexes: [],
  },
];

// ── 模拟查询结果 ──
const SAMPLE_QUERIES: Array<{ name: string; sql: string }> = [
  { name: '所有表名',        sql: "INFO FOR DB;" },
  { name: '最近 10 决策',     sql: "SELECT * FROM decision ORDER BY created_at DESC LIMIT 10;" },
  { name: '证据数 > 5 的案件', sql: "SELECT case_id, count() AS evidence_count FROM evidence GROUP BY case_id HAVING count() > 5;" },
  { name: '本周事件统计',     sql: "SELECT kind, count() AS n FROM event_log WHERE ts > time::now() - 7d GROUP BY kind ORDER BY n DESC;" },
  { name: '未结案件',        sql: "SELECT * FROM court_verdict WHERE verdict = 'pending';" },
];

function generateMockResult(sql: string): QueryResult {
  const start = Date.now();
  const normalized = sql.toLowerCase().trim();
  let rows: any[] = [];
  let fields: string[] = [];

  if (normalized.startsWith('select * from decision')) {
    fields = ['id', 'created_at', 'agent_id', 'query', 'selected', 'confidence'];
    rows = Array.from({ length: 8 }, (_, i) => ({
      id: 'decision:' + (Math.random().toString(36).slice(2, 8)),
      created_at: new Date(Date.now() - i * 60000).toISOString(),
      agent_id: 'agent-' + ((i % 3) + 1),
      query: ['优化数据库查询', '生成 API 文档', '修复内存泄漏', '重构用户模块', '添加单元测试'][i % 5],
      selected: i % 3,
      confidence: 0.5 + Math.random() * 0.5,
    }));
  } else if (normalized.includes('evidence')) {
    fields = ['case_id', 'evidence_count'];
    rows = [
      { case_id: 'case-001', evidence_count: 12 },
      { case_id: 'case-002', evidence_count: 7 },
      { case_id: 'case-007', evidence_count: 6 },
    ];
  } else if (normalized.includes('event_log')) {
    fields = ['kind', 'n'];
    rows = [
      { kind: 'decision.made', n: 47 },
      { kind: 'agent.spawned', n: 23 },
      { kind: 'court.opened', n: 15 },
      { kind: 'verdict.issued', n: 11 },
    ];
  } else if (normalized.includes('court_verdict')) {
    fields = ['id', 'case_id', 'verdict', 'created_at'];
    rows = [
      { id: 'verdict:001', case_id: 'case-099', verdict: 'pending', created_at: new Date().toISOString() },
    ];
  } else if (normalized.includes('info for db')) {
    fields = ['tables', 'count'];
    rows = MOCK_TABLES.map(t => ({ tables: t.name, count: t.count }));
  } else {
    fields = ['result'];
    rows = [{ result: 'OK' }];
  }

  return {
    ok: true, rows, fields, durationMs: Date.now() - start + Math.floor(Math.random() * 50) + 5,
    mode: 'mock',
  };
}

// ─── 主组件 ───
interface Props {
  open: boolean;
  onClose: () => void;
}

export function SurrealExplorer({ open, onClose }: Props) {
  const [tables] = useState<TableSchema[]>(MOCK_TABLES);
  const [selectedTable, setSelectedTable] = useState<string | null>(MOCK_TABLES[0].name);
  const [mode, setMode] = useState<'live' | 'mock'>('mock');
  const [query, setQuery] = useState(SAMPLE_QUERIES[1].sql);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<'data' | 'schema' | 'sql'>('data');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [filter, setFilter] = useState('');
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [queryHistory, setQueryHistory] = useState<Array<{ sql: string; ts: number; ok: boolean; ms: number }>>(() => {
    try { const r = localStorage.getItem('soloforge.surreal.history'); return r ? JSON.parse(r) : []; } catch { return []; }
  });
  const queryRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    if (mode === 'live') {
      // 真实模式: ping 后端确认
      fetch(API_BASE + '/api/health', { method: 'GET' })
        .then(r => r.ok ? setMode('live') : setMode('mock'))
        .catch(() => setMode('mock'));
    }
  }, [open, mode]);

  useEffect(() => { try { localStorage.setItem('soloforge.surreal.history', JSON.stringify(queryHistory.slice(0, 30))); } catch { /* ignore */ } }, [queryHistory]);

  const table = useMemo(() => tables.find(t => t.name === selectedTable) || null, [tables, selectedTable]);

  const filteredRows = useMemo(() => {
    if (!result) return [];
    let r = [...result.rows];
    if (filter) {
      const q = filter.toLowerCase();
      r = r.filter(row => Object.values(row).some(v => String(v).toLowerCase().includes(q)));
    }
    if (sortField) {
      r.sort((a, b) => {
        const av = a[sortField], bv = b[sortField];
        if (av === bv) return 0;
        const c = av > bv ? 1 : -1;
        return sortDir === 'asc' ? c : -c;
      });
    }
    return r;
  }, [result, filter, sortField, sortDir]);

  const pagedRows = useMemo(() => filteredRows.slice(page * pageSize, (page + 1) * pageSize), [filteredRows, page, pageSize]);
  const totalPages = Math.ceil(filteredRows.length / pageSize);

  // ── 执行查询 ──
  const runQuery = useCallback(async (sql?: string) => {
    const target = (sql || query).trim();
    if (!target) return;
    setRunning(true);
    const startTime = Date.now();
    try {
      if (mode === 'live') {
        const res = await fetch(API_BASE + '/api/db/query', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: target }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const fields = data.result?.[0]?.result ? Object.keys(data.result[0].result) : [];
        setResult({ ok: true, rows: data.result || [], fields, durationMs: Date.now() - startTime, mode: 'live' });
        setQueryHistory(prev => [{ sql: target, ts: Date.now(), ok: true, ms: Date.now() - startTime }, ...prev.filter(x => x.sql !== target)].slice(0, 30));
      } else {
        // 模拟
        await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
        const r = generateMockResult(target);
        setResult(r);
        setQueryHistory(prev => [{ sql: target, ts: Date.now(), ok: r.ok, ms: r.durationMs }, ...prev.filter(x => x.sql !== target)].slice(0, 30));
      }
    } catch (e) {
      const msg = (e as Error).message;
      setResult({ ok: false, rows: [], fields: [], durationMs: Date.now() - startTime, error: msg, mode });
      setQueryHistory(prev => [{ sql: target, ts: Date.now(), ok: false, ms: Date.now() - startTime }, ...prev].slice(0, 30));
    } finally {
      setRunning(false);
    }
  }, [query, mode]);

  // 当选中表时,自动填入查询
  useEffect(() => {
    if (selectedTable && view === 'data') {
      setQuery(`SELECT * FROM ${selectedTable} LIMIT 50;`);
    }
  }, [selectedTable, view]);

  // 自动首次执行
  useEffect(() => {
    if (open && view === 'sql' && !result) {
      runQuery(SAMPLE_QUERIES[1].sql);
    }
  }, [open, view, runQuery, result]);

  // ── 排序 ──
  const toggleSort = useCallback((f: string) => {
    if (sortField === f) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(f); setSortDir('asc'); }
  }, [sortField]);

  // ── 导出 ──
  const exportResult = useCallback((format: 'json' | 'csv') => {
    if (!result) return;
    let content: string, mime: string, ext: string;
    if (format === 'json') {
      content = JSON.stringify(result.rows, null, 2);
      mime = 'application/json';
      ext = 'json';
    } else {
      const headers = result.fields.join(',');
      const rows = result.rows.map(r => result.fields.map(f => {
        const v = r[f];
        if (v === null || v === undefined) return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','));
      content = [headers, ...rows].join('\n');
      mime = 'text/csv';
      ext = 'csv';
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `surreal_${selectedTable || 'result'}_${Date.now()}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }, [result, selectedTable]);

  if (!open) return null;

  const totalSize = tables.reduce((a, t) => a + t.sizeKB, 0);
  const totalCount = tables.reduce((a, t) => a + t.count, 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(98vw,1240px)] h-[min(94vh,820px)] bg-bg-elevated border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">database</span>
            <h2 className="text-base font-semibold">SurrealDB 浏览器</h2>
            <span className="text-xs text-text-secondary ml-2">
              {tables.length} 表 · {totalCount} 条记录 · {totalSize.toFixed(1)} KB
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setMode(m => m === 'live' ? 'mock' : 'live')}
              className={'px-2.5 py-1 text-xs rounded border flex items-center gap-1 ' +
                (mode === 'live' ? 'border-success text-success bg-success/10' : 'border-border hover:bg-bg-dim')}
              title="切换真实/模拟模式"
            >
              <span className="material-symbols-outlined text-sm">{mode === 'live' ? 'cloud_done' : 'cloud_off'}</span>
              {mode === 'live' ? '真实' : '模拟'}
            </button>
            <button onClick={onClose} className="px-2 py-1 rounded hover:bg-bg-dim text-text-secondary ml-1">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* 左: 表列表 */}
          <div className="w-56 border-r border-border flex flex-col shrink-0">
            <div className="px-3 py-2 text-xs text-text-secondary uppercase tracking-wide border-b border-border">表</div>
            <div className="flex-1 overflow-auto">
              {(['core', 'decision', 'court', 'governor', 'audit'] as const).map(cat => {
                const sub = tables.filter(t => t.category === cat);
                if (sub.length === 0) return null;
                return (
                  <div key={cat}>
                    <div className="px-3 py-1 text-[10px] text-text-secondary uppercase tracking-wide bg-bg-dim/30">
                      {cat === 'core' ? '核心' : cat === 'decision' ? '决策' : cat === 'court' ? '法庭' : cat === 'governor' ? 'Governor' : '审计'}
                    </div>
                    {sub.map(t => (
                      <button
                        key={t.name}
                        onClick={() => { setSelectedTable(t.name); setView('data'); setPage(0); }}
                        className={
                          'w-full px-3 py-1.5 text-left text-sm flex items-center gap-1.5 hover:bg-bg-dim ' +
                          (selectedTable === t.name ? 'bg-primary/10 text-primary border-l-2 border-primary' : '')
                        }
                      >
                        <span className="material-symbols-outlined text-sm">table_chart</span>
                        <span className="flex-1 truncate font-mono text-xs">{t.name}</span>
                        <span className="text-[10px] text-text-secondary">{t.count}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 中: 主区 */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Tab 栏 */}
            <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border shrink-0">
              {([
                { id: 'data',   label: '数据',   icon: 'table' },
                { id: 'schema', label: '结构',   icon: 'schema' },
                { id: 'sql',    label: 'SQL',    icon: 'terminal' },
              ] as const).map(t => (
                <button
                  key={t.id}
                  onClick={() => setView(t.id)}
                  className={
                    'px-3 py-1 text-xs rounded flex items-center gap-1 ' +
                    (view === t.id ? 'bg-primary/20 text-primary' : 'hover:bg-bg-dim text-text-secondary')
                  }
                >
                  <span className="material-symbols-outlined text-sm">{t.icon}</span>
                  {t.label}
                </button>
              ))}
              {view === 'data' && table && (
                <span className="ml-3 text-xs text-text-secondary">{table.name} · {table.description}</span>
              )}
            </div>

            <div className="flex-1 overflow-auto">
              {/* 数据视图 */}
              {view === 'data' && table && (
                <div className="flex flex-col h-full">
                  <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
                    <input
                      type="text"
                      value={filter}
                      onChange={e => { setFilter(e.target.value); setPage(0); }}
                      placeholder="筛选行..."
                      className="flex-1 px-2 py-1 rounded border border-border bg-bg text-xs"
                    />
                    <button
                      onClick={() => runQuery(`SELECT * FROM ${table.name} LIMIT 100;`)}
                      disabled={running}
                      className="px-2.5 py-1 text-xs rounded bg-primary text-bg disabled:opacity-50 flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-sm">{running ? 'progress_activity' : 'refresh'}</span>
                      {running ? '加载中' : '刷新'}
                    </button>
                    <button onClick={() => exportResult('json')} className="px-2 py-1 text-xs rounded border border-border hover:bg-bg-dim" title="JSON">JSON</button>
                    <button onClick={() => exportResult('csv')} className="px-2 py-1 text-xs rounded border border-border hover:bg-bg-dim" title="CSV">CSV</button>
                  </div>

                  <div className="flex-1 overflow-auto">
                    {!result && <div className="p-6 text-center text-sm text-text-secondary">点击"刷新"加载数据</div>}
                    {result && result.rows.length === 0 && <div className="p-6 text-center text-sm text-text-secondary">表为空</div>}
                    {result && result.rows.length > 0 && (
                      <table className="w-full text-xs font-mono">
                        <thead className="bg-bg-dim sticky top-0 z-10">
                          <tr>
                            {result.fields.map(f => (
                              <th
                                key={f}
                                onClick={() => toggleSort(f)}
                                className="text-left px-3 py-1.5 border-b border-border cursor-pointer hover:bg-bg-dim whitespace-nowrap"
                              >
                                <span className="text-primary">{f}</span>
                                {sortField === f && (
                                  <span className="ml-1 text-text-secondary">{sortDir === 'asc' ? '↑' : '↓'}</span>
                                )}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {pagedRows.map((row, i) => (
                            <tr key={i} className="border-b border-border/30 hover:bg-bg-dim/40">
                              {result.fields.map(f => (
                                <td key={f} className="px-3 py-1 whitespace-nowrap max-w-xs truncate" title={String(row[f])}>
                                  {typeof row[f] === 'object' ? JSON.stringify(row[f]) : String(row[f])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {result && result.rows.length > 0 && (
                    <div className="px-3 py-1.5 border-t border-border text-xs text-text-secondary flex items-center gap-2 shrink-0">
                      <span>{filteredRows.length} 行</span>
                      <span>·</span>
                      <span>用时 {result.durationMs}ms</span>
                      <span>·</span>
                      <span>模式 {result.mode}</span>
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          onClick={() => setPage(p => Math.max(0, p - 1))}
                          disabled={page === 0}
                          className="px-1.5 py-0.5 rounded border border-border disabled:opacity-30"
                        >
                          ‹
                        </button>
                        <span>第 {page + 1}/{totalPages || 1} 页</span>
                        <button
                          onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                          disabled={page >= totalPages - 1}
                          className="px-1.5 py-0.5 rounded border border-border disabled:opacity-30"
                        >
                          ›
                        </button>
                        <select value={pageSize} onChange={e => { setPageSize(parseInt(e.target.value)); setPage(0); }} className="ml-1 px-1 py-0.5 rounded border border-border bg-bg text-xs">
                          {[10, 20, 50, 100].map(n => <option key={n} value={n}>{n}/页</option>)}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 结构视图 */}
              {view === 'schema' && table && (
                <div className="p-4 space-y-4">
                  <div>
                    <h3 className="text-base font-semibold flex items-center gap-2">
                      <span className="font-mono text-primary">{table.name}</span>
                      <span className="text-xs text-text-secondary">· {table.description}</span>
                    </h3>
                    <div className="text-xs text-text-secondary mt-1">
                      {table.count.toLocaleString()} 条记录 · {table.sizeKB.toFixed(1)} KB
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-text-secondary uppercase mb-1.5">字段</div>
                    <table className="w-full text-xs">
                      <thead className="bg-bg-dim">
                        <tr>
                          <th className="text-left px-2 py-1">字段</th>
                          <th className="text-left px-2 py-1">类型</th>
                          <th className="text-left px-2 py-1">可空</th>
                          <th className="text-left px-2 py-1">索引</th>
                          <th className="text-left px-2 py-1">示例</th>
                        </tr>
                      </thead>
                      <tbody>
                        {table.fields.map(f => (
                          <tr key={f.name} className="border-b border-border/30 hover:bg-bg-dim/40">
                            <td className="px-2 py-1 font-mono text-text font-medium">{f.name}</td>
                            <td className="px-2 py-1 text-primary">{f.type}</td>
                            <td className="px-2 py-1">{f.optional ? 'YES' : <span className="text-danger">NO</span>}</td>
                            <td className="px-2 py-1">{f.indexed && <span className="material-symbols-outlined text-xs text-success">check</span>}</td>
                            <td className="px-2 py-1 text-text-secondary font-mono truncate max-w-md" title={f.example}>{f.example}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {table.indexes.length > 0 && (
                    <div>
                      <div className="text-xs text-text-secondary uppercase mb-1.5">索引 ({table.indexes.length})</div>
                      <div className="space-y-1">
                        {table.indexes.map(idx => (
                          <div key={idx.name} className="px-2 py-1 rounded bg-bg-dim text-xs flex items-center gap-2">
                            <span className="material-symbols-outlined text-sm text-primary">key</span>
                            <span className="font-mono">{idx.name}</span>
                            <span className="text-text-secondary">on</span>
                            <span className="font-mono">[{idx.cols.join(', ')}]</span>
                            {idx.unique && <span className="ml-auto text-[10px] px-1.5 rounded bg-warning/15 text-warning">UNIQUE</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* SQL 视图 */}
              {view === 'sql' && (
                <div className="flex flex-col h-full">
                  <div className="px-3 py-2 border-b border-border shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-secondary">示例:</span>
                      <div className="flex gap-1 flex-wrap">
                        {SAMPLE_QUERIES.map(s => (
                          <button
                            key={s.name}
                            onClick={() => { setQuery(s.sql); setTimeout(() => runQuery(s.sql), 50); }}
                            className="px-1.5 py-0.5 text-[10px] rounded border border-border hover:bg-bg-dim text-text-secondary"
                          >
                            {s.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="p-3 border-b border-border shrink-0">
                    <textarea
                      ref={queryRef}
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      onKeyDown={e => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                          e.preventDefault();
                          runQuery();
                        }
                      }}
                      className="w-full h-24 px-3 py-2 rounded border border-border bg-bg text-xs font-mono resize-none"
                      placeholder="输入 SurrealQL (Ctrl+Enter 运行)"
                    />
                    <div className="mt-1.5 flex items-center gap-2">
                      <button
                        onClick={() => runQuery()}
                        disabled={running || !query.trim()}
                        className="px-3 py-1 text-xs rounded bg-primary text-bg disabled:opacity-50 flex items-center gap-1"
                      >
                        <span className="material-symbols-outlined text-sm">{running ? 'progress_activity' : 'play_arrow'}</span>
                        {running ? '运行中' : '运行 (Ctrl+Enter)'}
                      </button>
                      {result && (
                        <>
                          <span className="text-xs text-text-secondary">
                            {result.ok
                              ? <span className="text-success">✓ {result.rows.length} 行 · {result.durationMs}ms</span>
                              : <span className="text-danger">✗ {result.error}</span>
                            }
                          </span>
                          <div className="ml-auto flex gap-1">
                            <button onClick={() => exportResult('json')} className="px-2 py-0.5 text-xs rounded border border-border hover:bg-bg-dim">JSON</button>
                            <button onClick={() => exportResult('csv')} className="px-2 py-0.5 text-xs rounded border border-border hover:bg-bg-dim">CSV</button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {result && result.rows.length > 0 && (
                    <div className="flex-1 overflow-auto">
                      <table className="w-full text-xs font-mono">
                        <thead className="bg-bg-dim sticky top-0">
                          <tr>
                            {result.fields.map(f => (
                              <th key={f} className="text-left px-3 py-1.5 border-b border-border text-primary">{f}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {result.rows.map((row, i) => (
                            <tr key={i} className="border-b border-border/30 hover:bg-bg-dim/40">
                              {result.fields.map(f => (
                                <td key={f} className="px-3 py-1 whitespace-nowrap max-w-xs truncate">
                                  {typeof row[f] === 'object' ? JSON.stringify(row[f]) : String(row[f])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {queryHistory.length > 0 && (
                    <div className="border-t border-border max-h-32 overflow-auto shrink-0">
                      <div className="px-3 py-1 text-[10px] text-text-secondary uppercase tracking-wide bg-bg-dim/30">查询历史</div>
                      {queryHistory.slice(0, 10).map((h, i) => (
                        <button
                          key={i}
                          onClick={() => setQuery(h.sql)}
                          className="w-full px-3 py-1 text-left text-xs font-mono hover:bg-bg-dim flex items-center gap-2 border-b border-border/30"
                        >
                          <span className={h.ok ? 'text-success' : 'text-danger'}>{h.ok ? '✓' : '✗'}</span>
                          <span className="text-text-secondary shrink-0">{h.ms}ms</span>
                          <span className="truncate flex-1">{h.sql}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
