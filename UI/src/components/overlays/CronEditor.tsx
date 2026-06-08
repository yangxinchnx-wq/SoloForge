// ─────────────────────────────────────────────────────────────────
// Cron 表达式编辑器 — CronEditor
// - 6 字段 cron (秒 分 时 日 月 周) + 5 字段传统 cron
// - 下次执行预览 (next 5 runs)
// - 常用预设 (每分钟/每小时/每天/每周/每月)
// - 自然语言解释 ("每天 9 点" → "0 0 9 * * *")
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface FieldDef {
  name: string;
  label: string;
  min: number;
  max: number;
  alias?: Record<string, number>;
}

const FIELDS_6: FieldDef[] = [
  { name: 'second', label: '秒', min: 0, max: 59 },
  { name: 'minute', label: '分', min: 0, max: 59 },
  { name: 'hour',   label: '时', min: 0, max: 23 },
  { name: 'day',    label: '日', min: 1, max: 31 },
  { name: 'month',  label: '月', min: 1, max: 12 },
  { name: 'week',   label: '周', min: 0, max: 6 },
];

const FIELDS_5: FieldDef[] = [
  { name: 'minute', label: '分', min: 0, max: 59 },
  { name: 'hour',   label: '时', min: 0, max: 23 },
  { name: 'day',    label: '日', min: 1, max: 31 },
  { name: 'month',  label: '月', min: 1, max: 12 },
  { name: 'week',   label: '周', min: 0, max: 6 },
];

const PRESETS: Array<{ name: string; expr6: string; expr5: string }> = [
  { name: '每分钟',     expr6: '* * * * * *', expr5: '* * * * *' },
  { name: '每 5 分钟',  expr6: '0 */5 * * * *', expr5: '*/5 * * * *' },
  { name: '每小时整点', expr6: '0 0 * * * *', expr5: '0 * * * *' },
  { name: '每天 9 点',  expr6: '0 0 9 * * *', expr5: '0 9 * * *' },
  { name: '工作日 9 点',expr6: '0 0 9 * * 1-5', expr5: '0 9 * * 1-5' },
  { name: '每周一 8 点',expr6: '0 0 8 * * 1', expr5: '0 8 * * 1' },
  { name: '每月 1 号',  expr6: '0 0 0 1 * *', expr5: '0 0 1 * *' },
  { name: '每周日午夜', expr6: '0 0 0 * * 0', expr5: '0 0 * * 0' },
];

const NATURAL_PRESETS = [
  { desc: '每分钟',     expr: '* * * * * *' },
  { desc: '每 5 分钟',  desc_alt: '每五分钟', expr: '0 */5 * * * *' },
  { desc: '每 30 分钟', expr: '0 */30 * * * *' },
  { desc: '每小时整点', expr: '0 0 * * * *' },
  { desc: '每天凌晨 3 点', expr: '0 0 3 * * *' },
  { desc: '每天上午 9 点', expr: '0 0 9 * * *' },
  { desc: '工作日上午 9 点', expr: '0 0 9 * * 1-5' },
  { desc: '每周一上午 8 点', expr: '0 0 8 * * 1' },
  { desc: '每月 1 号 0 点', expr: '0 0 0 1 * *' },
  { desc: '每周五下午 5 点', expr: '0 0 17 * * 5' },
];

function explain(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  const fields = parts.length === 6 ? FIELDS_6 : FIELDS_5;
  if (parts.length !== fields.length) return '无效 cron 表达式';

  const explanations: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const p = parts[i];
    const f = fields[i];
    if (p === '*') explanations.push(`每${f.label}`);
    else if (p.startsWith('*/')) explanations.push(`每 ${p.slice(2)} ${f.label}`);
    else if (p.includes(',')) explanations.push(`${f.label} ${p}`);
    else if (p.includes('-')) explanations.push(`${f.label} ${p}`);
    else if (p.includes('/')) explanations.push(`${f.label} ${p}`);
    else explanations.push(`${f.label} ${p}`);
  }
  return explanations.join(', ');
}

function nextRuns(expr: string, count = 5): Date[] {
  const parts = expr.trim().split(/\s+/);
  const use6 = parts.length === 6;
  const fields = use6 ? FIELDS_6 : FIELDS_5;
  if (parts.length !== fields.length) return [];

  // 解析每个字段
  const match: Array<(d: Date) => boolean> = parts.map((p, i) => {
    const f = fields[i];
    if (p === '*') return () => true;
    if (p.startsWith('*/')) {
      const step = Number(p.slice(2));
      if (i === 0) return (d: Date) => d.getSeconds() % step === 0;
      if (i === 1) return (d: Date) => d.getMinutes() % step === 0;
      if (i === 2) return (d: Date) => d.getHours() % step === 0;
      if (i === 3) return (d: Date) => d.getDate() % step === 0;
      if (i === 4) return (d: Date) => (d.getMonth() + 1) % step === 0;
      if (i === 5) return (d: Date) => d.getDay() % step === 0;
    }
    if (p.includes(',')) {
      const vals = p.split(',').flatMap(v => {
        if (v.includes('-')) {
          const [s, e] = v.split('-').map(Number);
          return Array.from({ length: e - s + 1 }, (_, j) => s + j);
        }
        return [Number(v)];
      });
      if (i === 0) return (d: Date) => vals.includes(d.getSeconds());
      if (i === 1) return (d: Date) => vals.includes(d.getMinutes());
      if (i === 2) return (d: Date) => vals.includes(d.getHours());
      if (i === 3) return (d: Date) => vals.includes(d.getDate());
      if (i === 4) return (d: Date) => vals.includes(d.getMonth() + 1);
      if (i === 5) return (d: Date) => vals.includes(d.getDay());
    }
    if (p.includes('-')) {
      const [s, e] = p.split('-').map(Number);
      if (i === 0) return (d: Date) => d.getSeconds() >= s && d.getSeconds() <= e;
      if (i === 1) return (d: Date) => d.getMinutes() >= s && d.getMinutes() <= e;
      if (i === 2) return (d: Date) => d.getHours() >= s && d.getHours() <= e;
      if (i === 3) return (d: Date) => d.getDate() >= s && d.getDate() <= e;
      if (i === 4) return (d: Date) => (d.getMonth() + 1) >= s && (d.getMonth() + 1) <= e;
      if (i === 5) return (d: Date) => d.getDay() >= s && d.getDay() <= e;
    }
    if (p.includes('/')) {
      const [base, step] = p.split('/').map(Number);
      if (i === 0) return (d: Date) => d.getSeconds() >= base && d.getSeconds() % step === 0;
      if (i === 1) return (d: Date) => d.getMinutes() >= base && d.getMinutes() % step === 0;
      if (i === 2) return (d: Date) => d.getHours() >= base && d.getHours() % step === 0;
    }
    const v = Number(p);
    if (i === 0) return (d: Date) => d.getSeconds() === v;
    if (i === 1) return (d: Date) => d.getMinutes() === v;
    if (i === 2) return (d: Date) => d.getHours() === v;
    if (i === 3) return (d: Date) => d.getDate() === v;
    if (i === 4) return (d: Date) => d.getMonth() + 1 === v;
    if (i === 5) return (d: Date) => d.getDay() === v;
    return () => false;
  });

  const results: Date[] = [];
  let d = new Date();
  d.setSeconds(d.getSeconds() + 1);
  d.setMilliseconds(0);
  let attempts = 0;
  while (results.length < count && attempts < 366 * 24 * 3600) {
    if (match.every((fn, i) => {
      if (i === 0) return fn(d);
      if (i === 1) return fn(d);
      if (i === 2) return fn(d);
      if (i === 3) return fn(d);
      if (i === 4) return fn(d);
      if (i === 5) return fn(d);
      return false;
    })) {
      results.push(new Date(d));
    }
    if (use6) d.setSeconds(d.getSeconds() + 1);
    else d.setMinutes(d.getMinutes() + 1);
    attempts++;
  }
  return results;
}

export function CronEditor({ open, onClose }: Props) {
  const [mode, setMode] = useState<'6' | '5'>('6');
  const [fields, setFields] = useState<string[]>(['0', '0', '9', '*', '*', '1-5']);
  const [tab, setTab] = useState<'editor' | 'natural'>('editor');

  useEffect(() => {
    if (mode === '6') setFields(['0', '0', '9', '*', '*', '1-5']);
    else setFields(['0', '9', '*', '*', '1-5']);
  }, [mode]);

  const expr = fields.join(' ');
  const defs = mode === '6' ? FIELDS_6 : FIELDS_5;
  const runs = useMemo(() => nextRuns(expr, 5), [expr]);
  const desc = useMemo(() => explain(expr), [expr]);

  const applyPreset = (p: typeof PRESETS[0]) => {
    setFields((mode === '6' ? p.expr6 : p.expr5).split(' '));
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1000px] max-w-[95vw] h-[80vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">timer</span>
          <h2 className="text-sm font-semibold text-text">Cron 表达式编辑器</h2>
          <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
            {(['6', '5'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)} className={'px-2 h-6 rounded text-[10px] ' + (mode === m ? 'bg-surface-high text-text' : 'text-text-secondary')}>{m} 字段</button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light ml-2">
            {(['editor', 'natural'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} className={'px-2 h-6 rounded text-[10px] ' + (tab === t ? 'bg-surface-high text-text' : 'text-text-secondary')}>{t === 'editor' ? '字段' : '自然语言'}</button>
            ))}
          </div>
          <IconButton icon="close" onClick={onClose} className="ml-auto" />
        </div>

        {tab === 'editor' && (
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 p-3 overflow-y-auto">
              {/* 表达式展示 */}
              <div className="bg-bg border border-border-light rounded p-3 mb-3">
                <code className="text-base font-mono text-accent">{fields.map((f, i) => (
                  <span key={i}>
                    <span className="text-text-secondary text-[10px] mr-1">{defs[i]?.label}</span>
                    <span>{f}</span>
                    {i < fields.length - 1 && <span className="text-text-secondary mx-1">·</span>}
                  </span>
                ))}</code>
                <p className="text-xs text-text-secondary mt-2">📖 {desc}</p>
              </div>

              {/* 字段编辑 */}
              <div className="grid grid-cols-2 gap-2 mb-3">
                {defs.map((d, i) => (
                  <div key={d.name} className="bg-surface border border-border-light rounded p-2">
                    <div className="flex items-center gap-2 mb-1">
                      <label className="text-xs font-medium text-text">{d.label}</label>
                      <span className="text-[10px] text-text-secondary">({d.min}-{d.max})</span>
                    </div>
                    <input value={fields[i] || ''} onChange={(e) => setFields(prev => prev.map((f, j) => j === i ? e.target.value : f))}
                      className="w-full bg-bg border border-border-light rounded px-2 h-7 text-xs font-mono text-text" />
                    <div className="flex gap-1 mt-1 flex-wrap">
                      <button onClick={() => setFields(prev => prev.map((f, j) => j === i ? '*' : f))} className="text-[10px] px-1.5 py-0.5 rounded bg-bg text-text-secondary hover:text-text">*</button>
                      <button onClick={() => setFields(prev => prev.map((f, j) => j === i ? `*/${d.name === 'second' || d.name === 'minute' ? 5 : 1}` : f))} className="text-[10px] px-1.5 py-0.5 rounded bg-bg text-text-secondary hover:text-text">*/5</button>
                      <button onClick={() => setFields(prev => prev.map((f, j) => j === i ? '0' : f))} className="text-[10px] px-1.5 py-0.5 rounded bg-bg text-text-secondary hover:text-text">0</button>
                      {d.name === 'week' && (
                        <>
                          <button onClick={() => setFields(prev => prev.map((f, j) => j === i ? '1-5' : f))} className="text-[10px] px-1.5 py-0.5 rounded bg-bg text-text-secondary hover:text-text">1-5</button>
                          <button onClick={() => setFields(prev => prev.map((f, j) => j === i ? '0,6' : f))} className="text-[10px] px-1.5 py-0.5 rounded bg-bg text-text-secondary hover:text-text">0,6</button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* 预设 */}
              <h3 className="text-xs font-semibold text-text mb-1">预设</h3>
              <div className="grid grid-cols-2 gap-1">
                {PRESETS.map(p => (
                  <button key={p.name} onClick={() => applyPreset(p)} className="text-left bg-bg border border-border-light rounded p-2 hover:bg-surface-high">
                    <div className="text-xs font-medium text-text">{p.name}</div>
                    <code className="text-[10px] font-mono text-text-secondary">{mode === '6' ? p.expr6 : p.expr5}</code>
                  </button>
                ))}
              </div>
            </div>

            {/* 下次执行 */}
            <div className="w-72 border-l border-border bg-bg p-3">
              <h3 className="text-xs font-semibold text-text mb-2 flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">event</span> 下次 5 次执行
              </h3>
              {runs.length === 0 ? <p className="text-xs text-danger">表达式无效</p> : (
                <div className="space-y-1">
                  {runs.map((d, i) => (
                    <div key={i} className="bg-surface border border-border-light rounded p-2">
                      <div className="flex items-center gap-1">
                        <Badge variant="primary" className="text-[9px]">#{i + 1}</Badge>
                        <span className="text-[10px] text-text-secondary">{d.toLocaleDateString()}</span>
                      </div>
                      <div className="text-sm font-mono font-semibold text-text">{d.toLocaleTimeString()}</div>
                      <div className="text-[9px] text-text-secondary mt-0.5">距今 {Math.round((d.getTime() - Date.now()) / 60000)} 分钟</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'natural' && (
          <div className="flex-1 overflow-y-auto p-3">
            <h3 className="text-xs font-semibold text-text mb-2">自然语言 → Cron</h3>
            <div className="grid grid-cols-2 gap-2">
              {NATURAL_PRESETS.map(p => (
                <div key={p.desc} className="bg-bg border border-border-light rounded p-3">
                  <div className="text-sm font-medium text-text mb-1">"{p.desc}"</div>
                  <code className="block bg-surface border border-border-light rounded px-2 py-1 text-[10px] font-mono text-accent mb-1">{p.expr}</code>
                  <p className="text-[10px] text-text-secondary">{explain(p.expr)}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
