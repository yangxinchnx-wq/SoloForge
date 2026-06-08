// ─────────────────────────────────────────────────────────────────
// DatabaseSeeder — 数据库种子生成器 (P1-9 重叠标记)
// ⚠️ 与 SurrealExplorer / DbDesigner 部分重叠
// 独立价值: 批量数据生成 + 多格式导出 (SQL/JSON/CSV)
// 未来合并: 数据生成后通过 SurrealExplorer 写入
// - 多表批量生成测试数据
// - 多种字段类型: id/name/email/int/float/date/bool/enum/lorem
// - 实时预览 SQL/JSON/CSV 三种导出
// - 引用外键 + 撤销/重做 + 保存为模板
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface FieldDef {
  name: string;
  type: 'id' | 'name' | 'email' | 'int' | 'float' | 'bool' | 'date' | 'enum' | 'lorem' | 'uuid' | 'phone' | 'url' | 'ip' | 'color' | 'ref';
  min?: number;
  max?: number;
  options?: string[];
  refTable?: string;
  refField?: string;
  nullable?: boolean;
}

interface TableDef {
  id: string;
  name: string;
  rowCount: number;
  fields: FieldDef[];
}

interface Template { id: string; name: string; tables: TableDef[]; }

const STORE = 'soloforge.db-seeder.v1';
const STORE_TPL = 'soloforge.db-seeder.tpl.v1';

const TYPES: Array<{ value: FieldDef['type']; label: string; icon: string }> = [
  { value: 'id',     label: 'ID (自增)',     icon: 'tag' },
  { value: 'uuid',   label: 'UUID',          icon: 'key' },
  { value: 'name',   label: '姓名',          icon: 'person' },
  { value: 'email',  label: '邮箱',          icon: 'mail' },
  { value: 'phone',  label: '电话',          icon: 'phone' },
  { value: 'url',    label: 'URL',           icon: 'link' },
  { value: 'ip',     label: 'IP 地址',       icon: 'router' },
  { value: 'int',    label: '整数',          icon: '123' },
  { value: 'float',  label: '浮点',          icon: 'decimal' },
  { value: 'bool',   label: '布尔',          icon: 'toggle_on' },
  { value: 'date',   label: '日期',          icon: 'calendar_today' },
  { value: 'enum',   label: '枚举',          icon: 'list' },
  { value: 'lorem',  label: 'Lorem 文本',    icon: 'subject' },
  { value: 'color',  label: '颜色',          icon: 'palette' },
  { value: 'ref',    label: '外键引用',      icon: 'key_vertical' },
];

const FIRST = ['张','王','李','赵','陈','刘','杨','黄','周','吴','徐','孙','胡','朱','高','林','何','郭','马','罗'];
const LAST = ['伟','芳','娜','秀英','敏','静','丽','强','磊','军','洋','勇','艳','杰','娟','涛','明','超','秀兰','霞'];

const DEFAULT_TABLES: TableDef[] = [
  {
    id: 't1', name: 'users', rowCount: 20,
    fields: [
      { name: 'id', type: 'id' },
      { name: 'name', type: 'name' },
      { name: 'email', type: 'email' },
      { name: 'age', type: 'int', min: 18, max: 65 },
      { name: 'active', type: 'bool' },
      { name: 'role', type: 'enum', options: ['admin', 'user', 'guest'] },
      { name: 'created_at', type: 'date' },
    ],
  },
  {
    id: 't2', name: 'posts', rowCount: 50,
    fields: [
      { name: 'id', type: 'id' },
      { name: 'user_id', type: 'ref', refTable: 'users', refField: 'id' },
      { name: 'title', type: 'lorem' },
      { name: 'views', type: 'int', min: 0, max: 10000 },
      { name: 'published', type: 'bool' },
    ],
  },
];

function loadTpl(): Template[] {
  try { const r = localStorage.getItem(STORE_TPL); if (r) return JSON.parse(r); } catch { /* */ }
  return [];
}
function saveTpl(t: Template[]) { try { localStorage.setItem(STORE_TPL, JSON.stringify(t)); } catch { /* */ } }

function randInt(a: number, b: number): number { return Math.floor(Math.random() * (b - a + 1)) + a; }
function randFloat(a: number, b: number, d = 2): number { return parseFloat((Math.random() * (b - a) + a).toFixed(d)); }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
function lorem(): string {
  const words = ['lorem','ipsum','dolor','sit','amet','consectetur','adipiscing','elit','sed','do','eiusmod','tempor','incididunt','ut','labore','magna','aliqua','enim','ad','minim','veniam','quis','nostrud','exercitation','ullamco','laboris','nisi','aliquip','ex','ea','commodo','consequat'];
  return Array.from({ length: randInt(3, 10) }, () => pick(words)).join(' ');
}
function genName(): string { return pick(FIRST) + pick(LAST); }
function genEmail(name: string): string {
  const domains = ['example.com', 'test.org', 'demo.net', 'mail.io'];
  return name.toLowerCase().replace(/\s/g, '') + randInt(1, 99) + '@' + pick(domains);
}
function genPhone(): string { return '1' + randInt(3, 9) + Array.from({length: 9}, () => randInt(0, 9)).join(''); }
function genIp(): string { return `${randInt(1,255)}.${randInt(0,255)}.${randInt(0,255)}.${randInt(1,254)}`; }
function genColor(): string { return '#' + randInt(0, 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase(); }
function genDate(): string {
  const d = new Date(Date.now() - randInt(0, 365) * 86400000);
  return d.toISOString().split('T')[0];
}
function genUrl(): string {
  const slugs = ['post', 'article', 'item', 'product', 'blog'];
  return `https://example.com/${pick(slugs)}/${randInt(1, 1000)}`;
}

function genValue(f: FieldDef, refIds?: Map<string, number[]>): any {
  if (f.nullable && Math.random() < 0.1) return null;
  switch (f.type) {
    case 'id':     return 0; // 填充时再赋值
    case 'uuid':   return uuid();
    case 'name':   return genName();
    case 'email':  return genEmail(genName());
    case 'phone':  return genPhone();
    case 'url':    return genUrl();
    case 'ip':     return genIp();
    case 'int':    return randInt(f.min ?? 0, f.max ?? 100);
    case 'float':  return randFloat(f.min ?? 0, f.max ?? 1);
    case 'bool':   return Math.random() < 0.5;
    case 'date':   return genDate();
    case 'enum':   return pick(f.options || ['a','b','c']);
    case 'lorem':  return lorem();
    case 'color':  return genColor();
    case 'ref':    {
      const ids = refIds?.get(f.refTable || '') || [];
      return ids.length > 0 ? pick(ids) : null;
    }
  }
}

function escapeSql(v: any): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
function csvEscape(v: any): string {
  if (v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function DatabaseSeeder({ open, onClose }: Props) {
  const [tables, setTables] = useState<TableDef[]>(DEFAULT_TABLES);
  const [activeTableId, setActiveTableId] = useState(tables[0]?.id || '');
  const [exportFmt, setExportFmt] = useState<'sql' | 'json' | 'csv'>('sql');
  const [history, setHistory] = useState<TableDef[][]>([DEFAULT_TABLES]);
  const [histIdx, setHistIdx] = useState(0);
  const [tpl, setTpl] = useState<Template[]>(loadTpl);
  const [showTpl, setShowTpl] = useState(false);

  useEffect(() => { saveTpl(tpl); }, [tpl]);

  const activeTable = useMemo(() => tables.find(t => t.id === activeTableId), [tables, activeTableId]);

  const pushHistory = useCallback((next: TableDef[]) => {
    setHistory(prev => [...prev.slice(0, histIdx + 1), next]);
    setHistIdx(prev => prev + 1);
    setTables(next);
  }, [histIdx]);

  const undo = useCallback(() => {
    if (histIdx > 0) { setHistIdx(histIdx - 1); setTables(history[histIdx - 1]); }
  }, [histIdx, history]);
  const redo = useCallback(() => {
    if (histIdx < history.length - 1) { setHistIdx(histIdx + 1); setTables(history[histIdx + 1]); }
  }, [histIdx, history]);

  // 生成实际数据
  const generated = useMemo(() => {
    const refIds = new Map<string, number[]>();
    const result: Record<string, any[][]> = {};
    // 第一遍: 收集所有 ref 表的 ID
    for (const t of tables) {
      const ids: number[] = [];
      for (let i = 1; i <= t.rowCount; i++) ids.push(i);
      refIds.set(t.name, ids);
    }
    // 第二遍: 生成每行
    for (const t of tables) {
      const rows: any[][] = [];
      for (let r = 1; r <= t.rowCount; r++) {
        const row = t.fields.map(f => {
          if (f.type === 'id') return r;
          return genValue(f, refIds);
        });
        rows.push(row);
      }
      result[t.name] = rows;
    }
    return result;
  }, [tables]);

  // 导出
  const exportText = useMemo(() => {
    if (exportFmt === 'sql') {
      const lines: string[] = ['-- Auto-generated seed data', ''];
      for (const t of tables) {
        lines.push(`-- Table: ${t.name} (${t.rowCount} rows)`);
        const cols = t.fields.map(f => f.name).join(', ');
        for (const row of generated[t.name] || []) {
          const vals = row.map(escapeSql).join(', ');
          lines.push(`INSERT INTO ${t.name} (${cols}) VALUES (${vals});`);
        }
        lines.push('');
      }
      return lines.join('\n');
    }
    if (exportFmt === 'json') {
      const out: Record<string, any[]> = {};
      for (const t of tables) {
        out[t.name] = (generated[t.name] || []).map(row => {
          const obj: Record<string, any> = {};
          t.fields.forEach((f, i) => { obj[f.name] = row[i]; });
          return obj;
        });
      }
      return JSON.stringify(out, null, 2);
    }
    // CSV
    const lines: string[] = [];
    for (const t of tables) {
      lines.push(`# ${t.name}`);
      lines.push(t.fields.map(f => f.name).join(','));
      for (const row of generated[t.name] || []) {
        lines.push(row.map(csvEscape).join(','));
      }
      lines.push('');
    }
    return lines.join('\n');
  }, [tables, generated, exportFmt]);

  const addTable = useCallback(() => {
    const id = 't_' + Date.now().toString(36);
    const t: TableDef = { id, name: 'new_table', rowCount: 10, fields: [{ name: 'id', type: 'id' }] };
    pushHistory([...tables, t]);
    setActiveTableId(id);
  }, [tables, pushHistory]);

  const delTable = useCallback((id: string) => {
    const next = tables.filter(t => t.id !== id);
    pushHistory(next);
    if (activeTableId === id) setActiveTableId(next[0]?.id || '');
  }, [tables, activeTableId, pushHistory]);

  const updateTable = useCallback((id: string, patch: Partial<TableDef>) => {
    pushHistory(tables.map(t => t.id === id ? { ...t, ...patch } : t));
  }, [tables, pushHistory]);

  const addField = useCallback(() => {
    if (!activeTable) return;
    const f: FieldDef = { name: 'field_' + (activeTable.fields.length + 1), type: 'lorem' };
    updateTable(activeTable.id, { fields: [...activeTable.fields, f] });
  }, [activeTable, updateTable]);

  const delField = useCallback((idx: number) => {
    if (!activeTable) return;
    updateTable(activeTable.id, { fields: activeTable.fields.filter((_, i) => i !== idx) });
  }, [activeTable, updateTable]);

  const updateField = useCallback((idx: number, patch: Partial<FieldDef>) => {
    if (!activeTable) return;
    updateTable(activeTable.id, { fields: activeTable.fields.map((f, i) => i === idx ? { ...f, ...patch } : f) });
  }, [activeTable, updateTable]);

  const saveAsTemplate = useCallback(() => {
    const name = prompt('模板名:', 'my-template-' + Date.now().toString(36));
    if (!name) return;
    setTpl(prev => [...prev, { id: 'tpl_' + Date.now().toString(36), name, tables }]);
  }, [tables]);

  const loadTemplate = useCallback((t: Template) => {
    pushHistory(t.tables);
    setActiveTableId(t.tables[0]?.id || '');
    setShowTpl(false);
  }, [pushHistory]);

  const copyExport = useCallback(() => {
    navigator.clipboard?.writeText(exportText).catch(() => {});
  }, [exportText]);

  const downloadExport = useCallback(() => {
    const ext = exportFmt === 'sql' ? 'sql' : exportFmt === 'json' ? 'json' : 'csv';
    const blob = new Blob([exportText], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `seed.${ext}`;
    a.click();
  }, [exportText, exportFmt]);

  const totalRows = tables.reduce((a, t) => a + t.rowCount, 0);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">science</span>
          <h2 className="text-sm font-semibold text-text">数据库种子生成器</h2>
          <Badge variant="primary">{tables.length} 表</Badge>
          <Badge variant="info">{totalRows} 行</Badge>
          <div className="ml-auto flex items-center gap-1">
            <IconButton icon="undo" size="sm" tooltip="撤销" onClick={undo} />
            <IconButton icon="redo" size="sm" tooltip="重做" onClick={redo} />
            <Button size="sm" icon="bookmark" onClick={() => setShowTpl(!showTpl)}>模板</Button>
            <Button size="sm" icon="save" onClick={saveAsTemplate}>存为模板</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-48 border-r border-border bg-bg p-2 overflow-y-auto">
            <div className="flex items-center justify-between mb-1 px-1">
              <span className="text-xs font-semibold text-text">表</span>
              <IconButton icon="add" size="xs" onClick={addTable} />
            </div>
            {tables.map(t => (
              <div key={t.id} onClick={() => setActiveTableId(t.id)}
                className={'group px-2 py-1.5 rounded cursor-pointer mb-0.5 flex items-center gap-1 ' + (activeTableId === t.id ? 'bg-accent/15' : 'hover:bg-surface-high')}>
                <span className="material-symbols-outlined text-xs text-accent">table_chart</span>
                <span className="text-xs text-text flex-1 truncate">{t.name}</span>
                <span className="text-[10px] text-text-secondary">{t.rowCount}</span>
                <IconButton icon="close" size="xs" onClick={(e) => { e.stopPropagation(); delTable(t.id); }} className="opacity-0 group-hover:opacity-100" />
              </div>
            ))}
          </div>

          {activeTable && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="px-3 py-2 border-b border-border bg-bg flex items-center gap-2">
                <span className="text-xs text-text-secondary">表名</span>
                <input value={activeTable.name} onChange={(e) => updateTable(activeTable.id, { name: e.target.value })}
                  className="bg-surface border border-border-light rounded px-2 h-6 text-xs font-mono w-32" />
                <span className="text-xs text-text-secondary">行数</span>
                <input type="number" value={activeTable.rowCount}
                  onChange={(e) => updateTable(activeTable.id, { rowCount: Math.max(1, Math.min(10000, parseInt(e.target.value) || 1)) })}
                  className="bg-surface border border-border-light rounded px-2 h-6 text-xs font-mono w-20" />
                <Button size="xs" icon="add" onClick={addField}>添加字段</Button>
                <Button size="xs" icon="casino" onClick={() => {
                  // 重新生成: 触发 useMemo 重新计算 (直接 toggle 一个无用 state)
                  pushHistory([...tables]);
                }}>重新生成</Button>
              </div>

              <div className="flex-1 overflow-y-auto p-2">
                <table className="w-full text-xs">
                  <thead className="bg-surface-high text-text-secondary text-[10px]">
                    <tr>
                      <th className="text-left px-2 py-1 w-8">#</th>
                      <th className="text-left px-2 py-1">字段名</th>
                      <th className="text-left px-2 py-1 w-32">类型</th>
                      <th className="text-left px-2 py-1 w-24">参数</th>
                      <th className="text-left px-2 py-1 w-12">空</th>
                      <th className="text-left px-2 py-1 w-12"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeTable.fields.map((f, i) => (
                      <tr key={i} className="border-t border-border-light">
                        <td className="px-2 py-1 text-text-secondary">{i + 1}</td>
                        <td className="px-2 py-1">
                          <input value={f.name} onChange={(e) => updateField(i, { name: e.target.value })}
                            className="w-full bg-surface border border-border-light rounded px-1.5 h-5 text-[10px] font-mono" />
                        </td>
                        <td className="px-2 py-1">
                          <select value={f.type} onChange={(e) => updateField(i, { type: e.target.value as FieldDef['type'] })}
                            className="w-full bg-surface border border-border-light rounded px-1.5 h-5 text-[10px]">
                            {TYPES.map(t => <option key={t.value} value={t.value}>{t.icon} {t.label}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          {(f.type === 'int' || f.type === 'float') ? (
                            <div className="flex gap-0.5">
                              <input type="number" value={f.min ?? 0} onChange={(e) => updateField(i, { min: parseInt(e.target.value) || 0 })}
                                className="w-1/2 bg-surface border border-border-light rounded px-1 h-5 text-[10px]" placeholder="min" />
                              <input type="number" value={f.max ?? 100} onChange={(e) => updateField(i, { max: parseInt(e.target.value) || 100 })}
                                className="w-1/2 bg-surface border border-border-light rounded px-1 h-5 text-[10px]" placeholder="max" />
                            </div>
                          ) : f.type === 'enum' ? (
                            <input value={f.options?.join(',') || ''} onChange={(e) => updateField(i, { options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                              className="w-full bg-surface border border-border-light rounded px-1.5 h-5 text-[10px]" placeholder="a,b,c" />
                          ) : f.type === 'ref' ? (
                            <div className="flex gap-0.5">
                              <select value={f.refTable || ''} onChange={(e) => updateField(i, { refTable: e.target.value })}
                                className="w-1/2 bg-surface border border-border-light rounded px-1 h-5 text-[10px]">
                                <option value="">表</option>
                                {tables.filter(t => t.id !== activeTable.id).map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                              </select>
                              <input value={f.refField || 'id'} onChange={(e) => updateField(i, { refField: e.target.value })}
                                className="w-1/2 bg-surface border border-border-light rounded px-1 h-5 text-[10px]" placeholder="字段" />
                            </div>
                          ) : null}
                        </td>
                        <td className="px-2 py-1 text-center">
                          <input type="checkbox" checked={!!f.nullable} onChange={(e) => updateField(i, { nullable: e.target.checked })} />
                        </td>
                        <td className="px-2 py-1">
                          <IconButton icon="close" size="xs" onClick={() => delField(i)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="w-1/2 border-l border-border bg-bg flex flex-col">
            <div className="px-3 py-1.5 border-b border-border bg-surface-high flex items-center gap-1">
              <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
                {(['sql', 'json', 'csv'] as const).map(f => (
                  <button key={f} onClick={() => setExportFmt(f)} className={'px-2 h-5 rounded text-[10px] uppercase ' + (exportFmt === f ? 'bg-surface-high text-text' : 'text-text-secondary')}>
                    {f}
                  </button>
                ))}
              </div>
              <span className="text-[10px] text-text-secondary ml-2">{exportText.length} 字符 · {tables.reduce((a, t) => a + t.rowCount, 0)} 行</span>
              <Button size="xs" icon="content_copy" onClick={copyExport} className="ml-auto">复制</Button>
              <Button size="xs" icon="download" onClick={downloadExport}>下载</Button>
            </div>
            <pre className="flex-1 overflow-auto p-2 font-mono text-[10px] text-text whitespace-pre">{exportText}</pre>
          </div>
        </div>

        {showTpl && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center" onClick={() => setShowTpl(false)}>
            <div className="bg-surface border border-border rounded-lg p-4 w-96" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-text mb-2">模板库</h3>
              {tpl.length === 0 ? <p className="text-xs text-text-secondary py-4 text-center">暂无模板,点击「存为模板」保存当前配置</p> : (
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {tpl.map(t => (
                    <div key={t.id} onClick={() => loadTemplate(t)} className="bg-bg border border-border-light rounded p-2 cursor-pointer hover:bg-surface-high flex items-center gap-2">
                      <span className="material-symbols-outlined text-sm text-accent">bookmark</span>
                      <div className="flex-1">
                        <div className="text-xs font-medium text-text">{t.name}</div>
                        <div className="text-[10px] text-text-secondary">{t.tables.length} 表 · {t.tables.reduce((a, x) => a + x.rowCount, 0)} 行</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>实时生成</span>
          <span>·</span>
          <span>支持类型: {TYPES.length} 种</span>
          <span>·</span>
          <span>外键自动引用</span>
          <span>·</span>
          <span>导出 SQL/JSON/CSV</span>
        </div>
      </div>
    </div>
  );
}
