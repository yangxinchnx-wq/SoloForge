// ─────────────────────────────────────────────────────────────────
// JSON 工具 — JsonTools
// - 格式化/压缩/转义
// - JSONPath 查询 / 树视图
// - JSON ↔ CSV / YAML / XML / TypeScript
// - 差异对比 (diff)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

const SAMPLES: Array<{ name: string; json: string }> = [
  { name: '用户列表', json: '[{"id":1,"name":"Alice","age":28,"email":"alice@example.com"},{"id":2,"name":"Bob","age":34,"email":"bob@example.com","tags":["admin","dev"]}]' },
  { name: '嵌套配置', json: '{"app":{"name":"SoloForge","version":"1.0.0","features":{"ai":true,"db":{"type":"surreal","port":3000}}}}' },
  { name: 'GitHub API', json: '{"id":12345,"name":"hello-world","full_name":"octocat/Hello-World","owner":{"login":"octocat","id":1},"stargazers_count":80}' },
];

function jsonToCsv(jsonStr: string): string {
  try {
    const data = JSON.parse(jsonStr);
    const arr = Array.isArray(data) ? data : [data];
    if (arr.length === 0) return '';
    const keys = Array.from(new Set(arr.flatMap(o => typeof o === 'object' && o ? Object.keys(o) : [])));
    const lines = [keys.join(',')];
    arr.forEach(row => {
      lines.push(keys.map(k => {
        const v = row[k];
        if (v == null) return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','));
    });
    return lines.join('\n');
  } catch { return '/* invalid JSON */'; }
}

function jsonToYaml(jsonStr: string): string {
  try {
    const data = JSON.parse(jsonStr);
    const toYaml = (obj: any, indent = 0): string => {
      if (obj === null) return 'null';
      if (typeof obj !== 'object') return JSON.stringify(obj);
      if (Array.isArray(obj)) {
        return obj.map(v => `${'  '.repeat(indent)}- ${typeof v === 'object' ? '\n' + toYaml(v, indent + 1) : toYaml(v)}`).join('\n');
      }
      return Object.entries(obj).map(([k, v]) => {
        if (typeof v === 'object' && v !== null) return `${'  '.repeat(indent)}${k}:\n${toYaml(v, indent + 1)}`;
        return `${'  '.repeat(indent)}${k}: ${toYaml(v)}`;
      }).join('\n');
    };
    return toYaml(data);
  } catch { return '/* invalid JSON */'; }
}

function jsonToXml(jsonStr: string): string {
  try {
    const data = JSON.parse(jsonStr);
    const toXml = (obj: any, tag = 'root', indent = 0): string => {
      const pad = '  '.repeat(indent);
      if (obj === null || typeof obj !== 'object') return `${pad}<${tag}>${obj}</${tag}>`;
      if (Array.isArray(obj)) return obj.map(v => toXml(v, 'item', indent)).join('\n');
      const inner = Object.entries(obj).map(([k, v]) => toXml(v, k, indent + 1)).join('\n');
      return `${pad}<${tag}>\n${inner}\n${pad}</${tag}>`;
    };
    return `<?xml version="1.0"?>\n${toXml(data)}`;
  } catch { return '<!-- invalid JSON -->'; }
}

function jsonToTs(jsonStr: string): string {
  try {
    const data = JSON.parse(jsonStr);
    const infer = (val: any, depth = 0): string => {
      if (val === null) return 'null';
      if (typeof val === 'string') return 'string';
      if (typeof val === 'number') return 'number';
      if (typeof val === 'boolean') return 'boolean';
      if (Array.isArray(val)) {
        if (val.length === 0) return 'unknown[]';
        const e = val[0];
        if (val.every((v: any) => JSON.stringify(v) === JSON.stringify(e))) return `${infer(e, depth + 1)}[]`;
        return `Array<${infer(e, depth + 1)}>`;
      }
      if (typeof val === 'object') {
        if (depth > 2) return 'Record<string, any>';
        const fields = Object.entries(val).map(([k, v]) => `  ${k.replace(/[^a-zA-Z0-9_]/g, '_')}${k.match(/^[a-z]/) ? '?' : ''}: ${infer(v, depth + 1)};`).join('\n');
        return `{\n${fields}\n}`;
      }
      return 'any';
    };
    return `interface Root ${infer(data, 0)}`;
  } catch { return '/* invalid JSON */'; }
}

function jsonPath(jsonStr: string, path: string): { found: boolean; result: any; error?: string } {
  try {
    const data = JSON.parse(jsonStr);
    // 简易 JSONPath: $..key, $.a.b.c, $[0].name
    const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
    let cur: any = data;
    for (const p of parts) {
      if (cur == null) return { found: false, result: null, error: '路径不存在' };
      if (p.includes('[') && p.includes(']')) {
        const m = p.match(/(\w+)?\[(\d+)\]/);
        if (m) {
          if (m[1]) cur = cur[m[1]];
          if (cur && Array.isArray(cur)) cur = cur[Number(m[2])];
        }
      } else {
        cur = cur[p];
      }
    }
    return { found: true, result: cur };
  } catch (e: any) {
    return { found: false, result: null, error: e.message };
  }
}

function diff(a: any, b: any, path = '$'): Array<{ path: string; type: 'add' | 'remove' | 'change' | 'same'; a?: any; b?: any }> {
  const out: ReturnType<typeof diff> = [];
  if (a === b) { out.push({ path, type: 'same', a, b }); return out; }
  if (typeof a !== typeof b) { out.push({ path, type: 'change', a, b }); return out; }
  if (typeof a !== 'object' || a === null || b === null) { out.push({ path, type: 'change', a, b }); return out; }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push({ path, type: 'change', a, b }); return out; }
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  keys.forEach(k => {
    const hasA = k in a, hasB = k in b;
    if (hasA && !hasB) out.push({ path: `${path}.${k}`, type: 'remove', a: a[k] });
    else if (!hasA && hasB) out.push({ path: `${path}.${k}`, type: 'add', b: b[k] });
    else if (Array.isArray(a[k]) && Array.isArray(b[k])) {
      const len = Math.max(a[k].length, b[k].length);
      for (let i = 0; i < len; i++) {
        if (i >= a[k].length) out.push({ path: `${path}.${k}[${i}]`, type: 'add', b: b[k][i] });
        else if (i >= b[k].length) out.push({ path: `${path}.${k}[${i}]`, type: 'remove', a: a[k][i] });
        else out.push(...diff(a[k][i], b[k][i], `${path}.${k}[${i}]`));
      }
    } else if (typeof a[k] === 'object' && typeof b[k] === 'object') {
      out.push(...diff(a[k], b[k], `${path}.${k}`));
    } else if (a[k] !== b[k]) {
      out.push({ path: `${path}.${k}`, type: 'change', a: a[k], b: b[k] });
    }
  });
  return out;
}

export function JsonTools({ open, onClose }: Props) {
  const [input, setInput] = useState(SAMPLES[0].json);
  const [converted, setConverted] = useState('');
  const [format, setFormat] = useState<'json' | 'csv' | 'yaml' | 'xml' | 'ts'>('json');
  const [path, setPath] = useState('$.0.name');
  const [diffA, setDiffA] = useState(SAMPLES[0].json);
  const [diffB, setDiffB] = useState(SAMPLES[1].json);
  const [indent, setIndent] = useState(2);

  const valid = useMemo(() => { try { JSON.parse(input); return true; } catch { return false; } }, [input]);
  const tree = useMemo(() => { try { return JSON.parse(input); } catch { return null; } }, [input]);

  const formatJson = useCallback(() => {
    try {
      const parsed = JSON.parse(input);
      setInput(JSON.stringify(parsed, null, indent));
    } catch { /* */ }
  }, [input, indent]);

  const minify = useCallback(() => {
    try {
      setInput(JSON.stringify(JSON.parse(input)));
    } catch { /* */ }
  }, [input]);

  const convert = useCallback(() => {
    if (format === 'json') {
      try { setConverted(JSON.stringify(JSON.parse(input), null, indent)); } catch { setConverted('/* invalid */'); }
    } else if (format === 'csv') setConverted(jsonToCsv(input));
    else if (format === 'yaml') setConverted(jsonToYaml(input));
    else if (format === 'xml') setConverted(jsonToXml(input));
    else if (format === 'ts') setConverted(jsonToTs(input));
  }, [input, format]);

  const pathResult = useMemo(() => jsonPath(input, path), [input, path]);
  const diffResult = useMemo(() => {
    try { return diff(JSON.parse(diffA), JSON.parse(diffB)); } catch { return []; }
  }, [diffA, diffB]);

  const copy = (txt: string) => { navigator.clipboard?.writeText(txt).catch(() => {}); };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">data_object</span>
          <h2 className="text-sm font-semibold text-text">JSON 工具</h2>
          <Badge variant={valid ? 'success' : 'danger'}>{valid ? '有效 JSON' : '无效 JSON'}</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Select
              value={String(indent)}
              options={['2', '4', 'tab'].map(i => ({ value: i, label: i === 'tab' ? 'Tab' : `${i} 空格` }))}
              onChange={(v) => setIndent(v === 'tab' ? '\t' as any : Number(v))}
            />
            <Tooltip content="格式化"><IconButton icon="format_align_left" onClick={formatJson} /></Tooltip>
            <Tooltip content="压缩"><IconButton icon="compress" onClick={minify} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 输入 */}
          <div className="flex-1 flex flex-col p-3 border-r border-border min-w-0">
            <div className="flex items-center gap-1 mb-1">
              <span className="text-xs font-semibold text-text">输入</span>
              <div className="ml-auto flex gap-0.5">
                {SAMPLES.map(s => (
                  <button key={s.name} onClick={() => setInput(s.json)} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-high text-text-secondary hover:text-text">{s.name}</button>
                ))}
              </div>
            </div>
            <textarea value={input} onChange={(e) => setInput(e.target.value)} className="flex-1 bg-bg border border-border-light rounded p-2 text-[10px] font-mono text-text resize-none" />
            {/* JSONPath */}
            <div className="mt-2">
              <div className="flex items-center gap-1 mb-1">
                <span className="material-symbols-outlined text-xs text-accent">search</span>
                <span className="text-xs font-semibold text-text">JSONPath 查询</span>
                <span className="text-[10px] text-text-secondary">e.g. $.0.name · $..email · $.app.features.db.port</span>
              </div>
              <input value={path} onChange={(e) => setPath(e.target.value)} className="w-full bg-bg border border-border-light rounded px-2 h-7 text-xs font-mono text-text" />
              {pathResult.found && (
                <pre className="mt-1 bg-surface border border-border-light rounded p-2 text-[10px] font-mono text-text max-h-32 overflow-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(pathResult.result, null, 2)}
                </pre>
              )}
            </div>
          </div>

          {/* 转换 */}
          <div className="flex-1 flex flex-col p-3 border-r border-border min-w-0">
            <div className="flex items-center gap-1 mb-1">
              <span className="text-xs font-semibold text-text">转换</span>
              <Select
                value={format}
                options={[{ value: 'json', label: 'JSON (美化)' }, { value: 'csv', label: 'CSV' }, { value: 'yaml', label: 'YAML' }, { value: 'xml', label: 'XML' }, { value: 'ts', label: 'TypeScript' }]}
                onChange={(v) => setFormat(v as any)}
                className="ml-2"
              />
              <Button size="xs" icon="play_arrow" onClick={convert}>转换</Button>
              <IconButton icon="content_copy" size="xs" tooltip="复制" onClick={() => copy(converted)} className="ml-auto" />
            </div>
            <pre className="flex-1 bg-bg border border-border-light rounded p-2 text-[10px] font-mono text-text overflow-auto whitespace-pre-wrap break-all">{converted || '点击「转换」生成结果'}</pre>
          </div>

          {/* 差异对比 */}
          <div className="flex-1 flex flex-col p-3 min-w-0">
            <div className="flex items-center gap-1 mb-1">
              <span className="text-xs font-semibold text-text">差异 (A vs B)</span>
            </div>
            <div className="grid grid-cols-2 gap-1 h-32">
              <textarea value={diffA} onChange={(e) => setDiffA(e.target.value)} placeholder="JSON A" className="bg-bg border border-border-light rounded p-1 text-[10px] font-mono text-text resize-none" />
              <textarea value={diffB} onChange={(e) => setDiffB(e.target.value)} placeholder="JSON B" className="bg-bg border border-border-light rounded p-1 text-[10px] font-mono text-text resize-none" />
            </div>
            <div className="mt-1 flex-1 overflow-y-auto bg-bg border border-border-light rounded">
              {diffResult.length === 0 && <p className="p-2 text-[10px] text-text-secondary">无差异或输入无效</p>}
              {diffResult.map((d, i) => (
                <div key={i} className={'px-2 py-1 text-[10px] font-mono border-b border-border-light ' + (d.type === 'add' ? 'bg-success/10' : d.type === 'remove' ? 'bg-danger/10' : d.type === 'change' ? 'bg-warning/10' : '')}>
                  <span className="text-text-secondary">{d.path}</span>
                  <span className={'ml-2 px-1 rounded ' + (d.type === 'add' ? 'bg-success/20 text-success' : d.type === 'remove' ? 'bg-danger/20 text-danger' : d.type === 'change' ? 'bg-warning/20 text-warning' : 'text-text-secondary')}>{d.type}</span>
                  {d.a !== undefined && <span className="ml-2 text-danger">− {JSON.stringify(d.a)}</span>}
                  {d.b !== undefined && <span className="ml-2 text-success">+ {JSON.stringify(d.b)}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
