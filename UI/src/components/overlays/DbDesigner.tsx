// ─────────────────────────────────────────────────────────────────
// DbDesigner — 数据库表结构设计器 (P1-9 重叠标记)
// ⚠️ 80% 与 SurrealExplorer 重叠 (本组件 mock 数据)
// 区别: 本组件专注于 ER 拖拽 + DDL 导出,不执行 SQL
// 未来合并: 视图层可复用 SurrealExplorer 的表结构渲染
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Field {
  id: string;
  name: string;
  type: string;
  pk: boolean;
  null_: boolean;
  unique: boolean;
  default?: string;
}

interface Table {
  id: string;
  name: string;
  x: number;
  y: number;
  fields: Field[];
  color: string;
  comment?: string;
}

interface Relation {
  from: string;
  to: string;
  fromField: string;
  toField: string;
  type: '1:1' | '1:N' | 'N:N';
}

const STORE_KEY = 'soloforge.db-designer.v1';

const FIELD_TYPES = [
  'INT', 'BIGINT', 'SERIAL', 'VARCHAR(255)', 'TEXT', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'FLOAT', 'DECIMAL(10,2)', 'JSON', 'UUID', 'BLOB',
] as const;

const DEFAULT_DATA: { tables: Table[]; relations: Relation[] } = {
  tables: [
    {
      id: 't_users', name: 'users', x: 80, y: 80, color: '#3b82f6',
      fields: [
        { id: 'f1', name: 'id', type: 'SERIAL', pk: true, null_: false, unique: true },
        { id: 'f2', name: 'email', type: 'VARCHAR(255)', pk: false, null_: false, unique: true },
        { id: 'f3', name: 'name', type: 'VARCHAR(255)', pk: false, null_: true, unique: false },
        { id: 'f4', name: 'created_at', type: 'TIMESTAMP', pk: false, null_: false, unique: false, default: 'NOW()' },
      ],
    },
    {
      id: 't_posts', name: 'posts', x: 480, y: 80, color: '#10b981',
      fields: [
        { id: 'p1', name: 'id', type: 'SERIAL', pk: true, null_: false, unique: true },
        { id: 'p2', name: 'user_id', type: 'INT', pk: false, null_: false, unique: false },
        { id: 'p3', name: 'title', type: 'VARCHAR(255)', pk: false, null_: false, unique: false },
        { id: 'p4', name: 'content', type: 'TEXT', pk: false, null_: true, unique: false },
      ],
    },
    {
      id: 't_tags', name: 'tags', x: 80, y: 360, color: '#f59e0b',
      fields: [
        { id: 'g1', name: 'id', type: 'SERIAL', pk: true, null_: false, unique: true },
        { id: 'g2', name: 'name', type: 'VARCHAR(50)', pk: false, null_: false, unique: true },
      ],
    },
  ],
  relations: [
    { from: 't_users', to: 't_posts', fromField: 'f1', toField: 'p2', type: '1:N' },
    { from: 't_users', to: 't_tags', fromField: 'f1', toField: 'g1', type: 'N:N' },
  ],
};

function load(): { tables: Table[]; relations: Relation[] } { try { const r = localStorage.getItem(STORE_KEY); if (r) return JSON.parse(r); } catch { /* */ } return DEFAULT_DATA; }
function save(d: any) { try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch { /* */ } }

function toDDL(d: { tables: Table[]; relations: Relation[] }, dialect: string): string {
  return d.tables.map(t => {
    const lines: string[] = [];
    if (dialect === 'surreal') {
      lines.push(`DEFINE TABLE ${t.name} SCHEMAFULL;`);
      t.fields.forEach(f => {
        let def = `  DEFINE FIELD ${f.name} ON TABLE ${t.name} TYPE ${f.type.replace(/\(.*\)/, '').toLowerCase()}`;
        if (f.null_) def += ' DEFAULT null';
        lines.push(def + ';');
      });
    } else {
      lines.push(`CREATE TABLE ${t.name} (`);
      const flds = t.fields.map(f => {
        let s = `  ${f.name} ${f.type}`;
        if (f.pk && dialect !== 'surreal') s += ' PRIMARY KEY';
        if (!f.null_) s += ' NOT NULL';
        if (f.unique && !f.pk) s += ' UNIQUE';
        if (f.default) s += ` DEFAULT ${f.default}`;
        return s;
      });
      lines.push(flds.join(',\n'));
      lines.push(');');
    }
    return lines.join('\n');
  }).join('\n\n');
}

export function DbDesigner({ open, onClose }: Props) {
  const [data, setData] = useState(load);
  const [dialect, setDialect] = useState<'postgres' | 'mysql' | 'sqlite' | 'surreal'>('postgres');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; ox: number; oy: number; sx: number; sy: number } | null>(null);
  const [ddlPreview, setDdlPreview] = useState(false);

  useEffect(() => { save(data); }, [data]);

  const table = useMemo(() => data.tables.find(t => t.id === selectedTable) || null, [data, selectedTable]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      setData(prev => ({
        ...prev,
        tables: prev.tables.map(t => t.id === dragging.id ? { ...t, x: dragging.ox + (e.clientX - dragging.sx), y: dragging.oy + (e.clientY - dragging.sy) } : t),
      }));
    };
    const onUp = () => setDragging(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [dragging]);

  const addTable = useCallback(() => {
    const id = 't_' + Date.now().toString(36);
    setData(prev => ({
      ...prev,
      tables: [...prev.tables, {
        id, name: 'new_table', x: 100 + Math.random() * 300, y: 100 + Math.random() * 200,
        color: ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'][prev.tables.length % 5],
        fields: [
          { id: 'f_' + Date.now().toString(36), name: 'id', type: 'SERIAL', pk: true, null_: false, unique: true },
        ],
      }],
    }));
    setSelectedTable(id);
  }, []);

  const updateTable = useCallback((id: string, patch: Partial<Table>) => {
    setData(prev => ({ ...prev, tables: prev.tables.map(t => t.id === id ? { ...t, ...patch } : t) }));
  }, []);

  const delTable = useCallback((id: string) => {
    setData(prev => ({
      tables: prev.tables.filter(t => t.id !== id),
      relations: prev.relations.filter(r => r.from !== id && r.to !== id),
    }));
    if (selectedTable === id) setSelectedTable(null);
  }, [selectedTable]);

  const addField = useCallback((tableId: string) => {
    setData(prev => ({
      ...prev,
      tables: prev.tables.map(t => t.id === tableId ? {
        ...t,
        fields: [...t.fields, { id: 'f_' + Date.now().toString(36), name: 'field', type: 'VARCHAR(255)', pk: false, null_: true, unique: false }],
      } : t),
    }));
  }, []);

  const updateField = useCallback((tableId: string, fieldId: string, patch: Partial<Field>) => {
    setData(prev => ({
      ...prev,
      tables: prev.tables.map(t => t.id === tableId ? {
        ...t,
        fields: t.fields.map(f => f.id === fieldId ? { ...f, ...patch } : f),
      } : t),
    }));
  }, []);

  const delField = useCallback((tableId: string, fieldId: string) => {
    setData(prev => ({
      ...prev,
      tables: prev.tables.map(t => t.id === tableId ? { ...t, fields: t.fields.filter(f => f.id !== fieldId) } : t),
    }));
  }, []);

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'schema.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [data]);

  const exportDDL = useCallback(() => {
    const sql = toDDL(data, dialect);
    const blob = new Blob([sql], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `schema.${dialect === 'surreal' ? 'surql' : 'sql'}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [data, dialect]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">database</span>
          <h2 className="text-sm font-semibold text-text">数据库表结构设计器</h2>
          <Badge variant="primary">{data.tables.length} 表 · {data.relations.length} 关系</Badge>
          <Select
            value={dialect}
            options={[{ value: 'postgres', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL' }, { value: 'sqlite', label: 'SQLite' }, { value: 'surreal', label: 'SurrealQL' }]}
            onChange={(v) => setDialect(v as any)}
          />
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="add" onClick={addTable}>新建表</Button>
            <Button size="sm" icon="visibility" onClick={() => setDdlPreview(true)}>DDL 预览</Button>
            <Tooltip content="导出 JSON"><IconButton icon="code" onClick={exportJson} /></Tooltip>
            <Tooltip content="导出 DDL"><IconButton icon="download" onClick={exportDDL} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 relative bg-bg overflow-auto" style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, var(--color-border-light) 1px, transparent 0)',
            backgroundSize: '20px 20px',
          }}>
            <svg className="absolute inset-0 pointer-events-none" style={{ overflow: 'visible', width: '2000px', height: '2000px' }}>
              {data.relations.map((r, i) => {
                const from = data.tables.find(t => t.id === r.from);
                const to = data.tables.find(t => t.id === r.to);
                if (!from || !to) return null;
                return (
                  <g key={i}>
                    <line x1={from.x + 100} y1={from.y + 30} x2={to.x + 100} y2={to.y + 30} stroke="var(--color-accent)" strokeWidth={2} strokeDasharray={r.type === 'N:N' ? '5,3' : '0'} />
                    <text x={(from.x + to.x) / 2 + 100} y={(from.y + to.y) / 2 + 25} fontSize="10" fill="var(--color-accent)" className="select-none">{r.type}</text>
                  </g>
                );
              })}
            </svg>
            {data.tables.map(t => (
              <div key={t.id}
                onMouseDown={(e) => { setDragging({ id: t.id, ox: t.x, oy: t.y, sx: e.clientX, sy: e.clientY }); e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); setSelectedTable(t.id); }}
                className={'absolute bg-surface border-2 rounded-lg shadow-md cursor-move ' + (selectedTable === t.id ? 'border-accent' : 'border-border')}
                style={{ left: t.x, top: t.y, width: 240, borderTopColor: t.color, borderTopWidth: 4 }}>
                <div className="px-2 py-1.5 font-semibold text-text border-b border-border flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs" style={{ color: t.color }}>table_chart</span>
                  <span className="text-xs flex-1 truncate">{t.name}</span>
                  <span className="text-[10px] text-text-secondary">{t.fields.length} 字段</span>
                </div>
                <div className="text-[10px] font-mono">
                  {t.fields.map(f => (
                    <div key={f.id} className="px-2 py-0.5 flex items-center gap-1 border-b border-border-light hover:bg-surface-high">
                      {f.pk && <span className="material-symbols-outlined text-[10px] text-warning" title="PK">key</span>}
                      {f.unique && !f.pk && <span className="material-symbols-outlined text-[10px] text-accent" title="UNIQUE">stars</span>}
                      <span className="flex-1 text-text">{f.name}</span>
                      <span className="text-text-secondary">{f.type}</span>
                      {f.null_ && <span className="text-text-secondary">NULL</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* 详情 */}
          {table && (
            <div className="w-80 border-l border-border bg-bg p-3 overflow-y-auto">
              <h3 className="text-xs font-semibold text-text mb-2">表属性</h3>
              <input value={table.name} onChange={(e) => updateTable(table.id, { name: e.target.value })}
                className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs text-text mb-2" />
              <textarea value={table.comment || ''} onChange={(e) => updateTable(table.id, { comment: e.target.value })} placeholder="表注释"
                className="w-full bg-surface border border-border-light rounded p-2 text-xs text-text h-12 mb-2" />
              <div className="flex gap-1 mb-3 flex-wrap">
                {['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444'].map(c => (
                  <button key={c} onClick={() => updateTable(table.id, { color: c })}
                    className={'w-5 h-5 rounded ' + (table.color === c ? 'ring-2 ring-accent' : '')} style={{ background: c }} />
                ))}
              </div>

              <h3 className="text-xs font-semibold text-text mb-2 flex items-center justify-between">
                字段
                <Button size="xs" icon="add" onClick={() => addField(table.id)}>新增</Button>
              </h3>
              <div className="space-y-1">
                {table.fields.map(f => (
                  <div key={f.id} className="bg-surface border border-border-light rounded p-1.5 space-y-1">
                    <div className="flex gap-1">
                      <input value={f.name} onChange={(e) => updateField(table.id, f.id, { name: e.target.value })}
                        className="flex-1 bg-bg border border-border-light rounded px-1.5 h-6 text-[10px] font-mono" />
                      <Select
                        value={f.type}
                        options={FIELD_TYPES.map(t => ({ value: t, label: t }))}
                        onChange={(v) => updateField(table.id, f.id, { type: v })}
                        className="w-28"
                      />
                    </div>
                    <div className="flex items-center gap-2 text-[9px]">
                      <label className="flex items-center gap-0.5"><input type="checkbox" checked={f.pk} onChange={(e) => updateField(table.id, f.id, { pk: e.target.checked })} />PK</label>
                      <label className="flex items-center gap-0.5"><input type="checkbox" checked={f.null_} onChange={(e) => updateField(table.id, f.id, { null_: e.target.checked })} />NULL</label>
                      <label className="flex items-center gap-0.5"><input type="checkbox" checked={f.unique} onChange={(e) => updateField(table.id, f.id, { unique: e.target.checked })} />UQ</label>
                      <IconButton icon="delete" size="xs" onClick={() => delField(table.id, f.id)} className="ml-auto" />
                    </div>
                    <input value={f.default || ''} onChange={(e) => updateField(table.id, f.id, { default: e.target.value })} placeholder="DEFAULT"
                      className="w-full bg-bg border border-border-light rounded px-1.5 h-5 text-[9px] font-mono" />
                  </div>
                ))}
              </div>

              <Button size="sm" variant="danger" icon="delete" block onClick={() => delTable(table.id)} className="mt-3">删除表</Button>
            </div>
          )}
        </div>

        {/* DDL 预览 */}
        {ddlPreview && (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8" onClick={() => setDdlPreview(false)}>
            <div className="bg-surface border border-border rounded-xl shadow-2xl w-[700px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
                <h3 className="text-sm font-semibold text-text">DDL 预览 — {dialect}</h3>
                <IconButton icon="content_copy" size="xs" onClick={() => navigator.clipboard?.writeText(toDDL(data, dialect))} className="ml-auto" />
                <IconButton icon="close" size="xs" onClick={() => setDdlPreview(false)} />
              </div>
              <pre className="flex-1 overflow-auto p-3 text-[10px] font-mono text-text">{toDDL(data, dialect)}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
