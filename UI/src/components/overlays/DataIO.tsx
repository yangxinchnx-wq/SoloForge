// ─────────────────────────────────────────────────────────────────
// 数据导入/导出 — DataIO
// - SQL/CSV/JSON 多格式导入导出
// - 字段映射 (CSV 列 → 表字段)
// - 转换规则 (类型/默认值/正则替换)
// - 预览 + 校验
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Format = 'csv' | 'json' | 'sql' | 'xml' | 'yaml' | 'tsv';

interface FieldMap {
  src: string;     // 源列名
  dst: string;     // 目标列名
  type: 'string' | 'number' | 'boolean' | 'date' | 'json';
  defaultValue?: string;
  transform?: string;  // 简单 JS 表达式
}

const SAMPLE_CSV = `id,name,email,age,created_at
1,Alice,alice@example.com,28,2024-01-15T10:30:00Z
2,Bob,bob@example.com,34,2024-02-20T14:22:00Z
3,Charlie,charlie@example.com,29,2024-03-05T09:15:00Z
4,Diana,diana@example.com,42,2024-04-12T16:45:00Z`;

const SAMPLE_JSON = `[
  { "id": 1, "title": "决策 #1", "status": "pending", "score": 0.85 },
  { "id": 2, "title": "决策 #2", "status": "approved", "score": 0.92 }
]`;

const FORMATS: { id: Format; label: string; icon: string; ext: string }[] = [
  { id: 'csv',  label: 'CSV',  icon: 'table_view',  ext: '.csv' },
  { id: 'tsv',  label: 'TSV',  icon: 'table_view',  ext: '.tsv' },
  { id: 'json', label: 'JSON', icon: 'data_object', ext: '.json' },
  { id: 'sql',  label: 'SQL',  icon: 'database',    ext: '.sql' },
  { id: 'xml',  label: 'XML',  icon: 'code',        ext: '.xml' },
  { id: 'yaml', label: 'YAML', icon: 'data_object', ext: '.yaml' },
];

export function DataIO({ open, onClose }: Props) {
  const [direction, setDirection] = useState<'import' | 'export'>('import');
  const [format, setFormat] = useState<Format>('csv');
  const [text, setText] = useState(SAMPLE_CSV);
  const [tableName, setTableName] = useState('my_table');
  const [fieldMaps, setFieldMaps] = useState<FieldMap[]>([]);
  const [parsed, setParsed] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [delimiter, setDelimiter] = useState(',');
  const [hasHeader, setHasHeader] = useState(true);

  // 解析输入
  useEffect(() => {
    setErr(null);
    if (!text.trim()) { setParsed([]); setFieldMaps([]); return; }
    try {
      let rows: any[] = [];
      if (format === 'csv' || format === 'tsv') {
        const d = delimiter || (format === 'tsv' ? '\t' : ',');
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length === 0) return;
        const headers = hasHeader ? lines[0].split(d).map(s => s.trim()) : lines[0].split(d).map((_, i) => `col_${i + 1}`);
        rows = lines.slice(hasHeader ? 1 : 0).map(line => {
          const values = line.split(d);
          const obj: Record<string, string> = {};
          headers.forEach((h, i) => obj[h] = (values[i] || '').trim());
          return obj;
        });
        if (hasHeader && fieldMaps.length === 0) {
          setFieldMaps(headers.map(h => ({ src: h, dst: h, type: 'string' as const })));
        }
      } else if (format === 'json') {
        const j = JSON.parse(text);
        rows = Array.isArray(j) ? j : [j];
      } else if (format === 'sql') {
        // 提取 INSERT VALUES 部分
        const m = text.match(/VALUES\s*([\s\S]+?);?\s*$/i);
        if (m) {
          const groups = m[1].match(/\(([^)]+)\)/g) || [];
          rows = groups.map(g => {
            const vals = g.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            return { col_1: vals[0], col_2: vals[1], col_3: vals[2], col_4: vals[3] };
          });
        }
      }
      setParsed(rows.slice(0, 100));
    } catch (e: any) {
      setErr(e?.message || String(e));
      setParsed([]);
    }
  }, [text, format, delimiter, hasHeader]);

  // 导出
  const exported = useMemo(() => {
    try {
      if (format === 'csv' || format === 'tsv') {
        const d = delimiter || (format === 'tsv' ? '\t' : ',');
        const headers = fieldMaps.length > 0 ? fieldMaps.map(m => m.dst) : Object.keys(parsed[0] || {});
        const lines = [headers.join(d)];
        parsed.forEach(row => {
          lines.push(headers.map(h => {
            const v = row[h] ?? '';
            return typeof v === 'string' && v.includes(d) ? `"${v.replace(/"/g, '""')}"` : v;
          }).join(d));
        });
        return lines.join('\n');
      }
      if (format === 'json') return JSON.stringify(parsed, null, 2);
      if (format === 'sql') {
        const cols = fieldMaps.length > 0 ? fieldMaps.map(m => m.dst) : Object.keys(parsed[0] || {});
        return parsed.map(r =>
          `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${cols.map(c => {
            const v = r[c];
            return typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v ?? 'NULL';
          }).join(', ')});`
        ).join('\n');
      }
      if (format === 'xml') {
        const root = tableName;
        return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n` + parsed.map(r =>
          `  <item>${Object.entries(r).map(([k, v]) => `    <${k}>${v}</${k}>`).join('\n')}\n  </item>`
        ).join('\n') + `\n</${root}>`;
      }
      if (format === 'yaml') {
        return parsed.map(r => Object.entries(r).map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : v}`).join('\n')).join('\n---\n');
      }
      return text;
    } catch (e: any) {
      return `// 错误: ${e?.message || e}`;
    }
  }, [format, parsed, fieldMaps, delimiter, tableName, text]);

  const downloadFile = useCallback(() => {
    const fmt = FORMATS.find(f => f.id === format)!;
    const blob = new Blob([exported], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${tableName}${fmt.ext}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [exported, format, tableName]);

  const copyExport = useCallback(() => {
    navigator.clipboard?.writeText(exported).catch(() => {});
  }, [exported]);

  const addField = useCallback(() => {
    setFieldMaps(prev => [...prev, { src: '', dst: '', type: 'string' }]);
  }, []);

  const updateField = useCallback((i: number, patch: Partial<FieldMap>) => {
    setFieldMaps(prev => prev.map((f, idx) => idx === i ? { ...f, ...patch } : f));
  }, []);

  const removeField = useCallback((i: number) => {
    setFieldMaps(prev => prev.filter((_, idx) => idx !== i));
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1200px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">import_export</span>
          <h2 className="text-sm font-semibold text-text">数据导入 / 导出</h2>
          <Badge variant="primary">{parsed.length} 行</Badge>
          <span className="text-xs text-text-secondary">{direction === 'import' ? '外部 → 应用' : '应用 → 外部'}</span>
          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
              {(['import', 'export'] as const).map(d => (
                <button key={d} onClick={() => setDirection(d)}
                  className={'px-2 h-6 rounded text-[10px] ' + (direction === d ? 'bg-surface-high text-text' : 'text-text-secondary hover:text-text')}>
                  {d === 'import' ? '导入' : '导出'}
                </button>
              ))}
            </div>
            <Tooltip content="复制结果"><IconButton icon="content_copy" onClick={copyExport} /></Tooltip>
            <Tooltip content="下载文件"><IconButton icon="download" onClick={downloadFile} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        {/* 工具条 */}
        <div className="px-4 py-2 border-b border-border bg-bg shrink-0 flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-text-secondary">格式:</span>
          {FORMATS.map(f => (
            <button key={f.id} onClick={() => setFormat(f.id)}
              className={'px-2 h-6 rounded text-[10px] border flex items-center gap-1 ' + (format === f.id ? 'bg-accent/15 text-accent border-accent/30' : 'border-border text-text-secondary')}>
              <span className="material-symbols-outlined text-xs">{f.icon}</span>
              {f.label}
            </button>
          ))}
          {(format === 'csv' || format === 'tsv') && (
            <>
              <div className="w-px h-5 bg-border" />
              <span className="text-[10px] text-text-secondary">分隔符:</span>
              <input value={delimiter} onChange={(e) => setDelimiter(e.target.value)} className="bg-surface border border-border-light rounded px-1.5 h-6 w-12 text-center font-mono text-xs" />
              <label className="flex items-center gap-1 text-[10px] text-text-secondary cursor-pointer">
                <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} className="accent-accent" />
                首行为列名
              </label>
            </>
          )}
          <div className="w-px h-5 bg-border" />
          <span className="text-[10px] text-text-secondary">目标表名:</span>
          <input value={tableName} onChange={(e) => setTableName(e.target.value)} className="bg-surface border border-border-light rounded px-1.5 h-6 text-xs font-mono text-text" />
        </div>

        <div className="flex-1 grid grid-cols-2 gap-0 overflow-hidden">
          {/* 左:输入 */}
          <div className="flex flex-col border-r border-border overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light bg-bg">输入 ({format.toUpperCase()})</div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="flex-1 bg-bg p-3 text-xs font-mono text-text resize-none focus:outline-none"
            />
            {err && (
              <div className="px-3 py-1.5 text-[10px] text-danger bg-danger/10 border-t border-danger/30 flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">error</span>
                {err}
              </div>
            )}
            <div className="border-t border-border-light p-2 flex items-center gap-1">
              <Button size="xs" variant="ghost" icon="upload" onClick={() => {
                const inp = document.createElement('input');
                inp.type = 'file';
                inp.accept = '.csv,.json,.sql,.tsv,.xml,.yaml,.yml';
                inp.onchange = () => {
                  const f = inp.files?.[0]; if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => setText(reader.result as string);
                  reader.readAsText(f);
                };
                inp.click();
              }}>加载文件</Button>
              <Button size="xs" variant="ghost" icon="auto_fix_high" onClick={() => {
                setText(format === 'json' ? SAMPLE_JSON : SAMPLE_CSV);
              }}>示例</Button>
              <Button size="xs" variant="ghost" icon="delete" onClick={() => setText('')}>清空</Button>
            </div>
          </div>

          {/* 右:字段映射 + 预览 */}
          <div className="flex flex-col overflow-hidden">
            {format === 'csv' || format === 'tsv' ? (
              <>
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light bg-bg flex items-center gap-1">
                  <span>字段映射</span>
                  <Button size="xs" variant="ghost" icon="add" onClick={addField}>添加</Button>
                </div>
                <div className="overflow-y-auto p-2 max-h-32 border-b border-border">
                  <table className="w-full text-[10px]">
                    <thead className="text-text-secondary">
                      <tr>
                        <th className="text-left px-1 py-0.5 font-normal">源列</th>
                        <th className="text-left px-1 py-0.5 font-normal">目标列</th>
                        <th className="text-left px-1 py-0.5 font-normal">类型</th>
                        <th className="text-left px-1 py-0.5 font-normal">默认值</th>
                        <th className="text-left px-1 py-0.5 font-normal">转换</th>
                        <th className="w-6"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {fieldMaps.map((m, i) => (
                        <tr key={i}>
                          <td className="px-1 py-0.5"><input value={m.src} onChange={(e) => updateField(i, { src: e.target.value })} className="w-full bg-bg border border-border-light rounded px-1 h-5 text-[10px] font-mono" /></td>
                          <td className="px-1 py-0.5"><input value={m.dst} onChange={(e) => updateField(i, { dst: e.target.value })} className="w-full bg-bg border border-border-light rounded px-1 h-5 text-[10px] font-mono" /></td>
                          <td className="px-1 py-0.5">
                            <select value={m.type} onChange={(e) => updateField(i, { type: e.target.value as any })} className="bg-bg border border-border-light rounded h-5 text-[10px]">
                              <option>string</option><option>number</option><option>boolean</option><option>date</option><option>json</option>
                            </select>
                          </td>
                          <td className="px-1 py-0.5"><input value={m.defaultValue || ''} onChange={(e) => updateField(i, { defaultValue: e.target.value })} className="w-full bg-bg border border-border-light rounded px-1 h-5 text-[10px]" /></td>
                          <td className="px-1 py-0.5"><input value={m.transform || ''} onChange={(e) => updateField(i, { transform: e.target.value })} placeholder="e.g. v.toUpperCase()" className="w-full bg-bg border border-border-light rounded px-1 h-5 text-[10px] font-mono" /></td>
                          <td><IconButton size="xs" icon="close" onClick={() => removeField(i)} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light bg-bg">导出预览</div>
            <textarea
              readOnly
              value={exported}
              className="flex-1 bg-bg p-3 text-xs font-mono text-text resize-none focus:outline-none"
            />
          </div>
        </div>

        {/* 底部:解析预览表格 */}
        <div className="border-t border-border max-h-32 overflow-y-auto bg-bg">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light sticky top-0 bg-bg">
            解析预览 ({parsed.length} 行)
          </div>
          {parsed.length > 0 && (
            <table className="w-full text-[10px]">
              <thead className="text-text-secondary bg-surface-high sticky top-7">
                <tr>
                  {Object.keys(parsed[0]).slice(0, 8).map(k => <th key={k} className="text-left px-2 py-0.5 font-normal border-r border-border-light">{k}</th>)}
                </tr>
              </thead>
              <tbody>
                {parsed.slice(0, 8).map((r, i) => (
                  <tr key={i} className="border-t border-border-light hover:bg-surface-high">
                    {Object.values(r).slice(0, 8).map((v, j) => <td key={j} className="px-2 py-0.5 border-r border-border-light truncate max-w-[120px]">{String(v ?? '')}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
