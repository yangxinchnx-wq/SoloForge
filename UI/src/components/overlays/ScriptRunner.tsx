// ─────────────────────────────────────────────────────────────────
// 脚本执行器 — ScriptRunner
// - 内置 JavaScript REPL (Web Worker 沙箱)
// - 常用代码片段库
// - 多标签页
// - 控制台输出 (log/info/warn/error)
// - 导入/导出脚本
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface ConsoleEntry {
  id: string;
  type: 'log' | 'info' | 'warn' | 'error' | 'result';
  text: string;
  ts: number;
}

interface Script {
  id: string;
  name: string;
  code: string;
  pinned: boolean;
  lastRun?: number;
}

const STORE = 'soloforge.script-runner.v1';

const SNIPPETS: Script[] = [
  { id: 's1', name: '斐波那契', code: 'function fib(n) { return n < 2 ? n : fib(n-1) + fib(n-2); }\nlog(fib(10));', pinned: true },
  { id: 's2', name: '数组去重', code: 'const arr = [1, 2, 2, 3, 4, 4, 5];\nconst unique = [...new Set(arr)];\nlog(unique);', pinned: false },
  { id: 's3', name: '深拷贝', code: 'function deepClone(obj) {\n  return JSON.parse(JSON.stringify(obj));\n}\nconst orig = { a: 1, b: { c: 2 } };\nconst copy = deepClone(orig);\ncopy.b.c = 99;\nlog("orig:", orig.b.c, "copy:", copy.b.c);', pinned: false },
  { id: 's4', name: 'Promise.all', code: 'await Promise.all([\n  delay(100, "A"),\n  delay(200, "B"),\n  delay(50, "C"),\n]);\nlog("All done");', pinned: false },
];

function load(): Script[] { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return SNIPPETS; }
function save(d: Script[]) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* */ } }

function delay(ms: number, val: any): Promise<any> {
  return new Promise(r => setTimeout(() => r(val), ms));
}

export function ScriptRunner({ open, onClose }: Props) {
  const [scripts, setScripts] = useState<Script[]>(load);
  const [activeId, setActiveId] = useState(scripts[0]?.id || '');
  const [code, setCode] = useState(scripts[0]?.code || '');
  const [output, setOutput] = useState<ConsoleEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<'console' | 'result'>('console');
  const workerRef = useRef<Worker | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => { save(scripts); }, [scripts]);

  useEffect(() => {
    if (!open) {
      if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null; }
      return;
    }
    // 创建 web worker 沙箱
    const workerCode = `
      let _ctx = { logs: [] };
      self.onmessage = function(e) {
        const { code, id } = e.data;
        const log = (...args) => self.postMessage({ type: 'log', args, id });
        const info = (...args) => self.postMessage({ type: 'info', args, id });
        const warn = (...args) => self.postMessage({ type: 'warn', args, id });
        const error = (...args) => self.postMessage({ type: 'error', args, id });
        const delay = (ms, val) => new Promise(r => setTimeout(() => r(val), ms));
        try {
          const fn = new Function('log', 'info', 'warn', 'error', 'delay', \`return (async () => { \${code} })()\`);
          Promise.resolve(fn(log, info, warn, error, delay)).then(result => {
            self.postMessage({ type: 'done', result, id });
          }).catch(err => {
            self.postMessage({ type: 'error', args: [err.message || String(err), err.stack], id });
          });
        } catch (err) {
          self.postMessage({ type: 'error', args: [err.message, err.stack], id });
        }
      };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    workerRef.current = new Worker(URL.createObjectURL(blob));
    workerRef.current.onmessage = (e) => {
      const { type, args, result } = e.data;
      if (type === 'log' || type === 'info' || type === 'warn' || type === 'error') {
        setOutput(prev => [...prev, {
          id: 'o_' + Date.now().toString(36) + Math.random(),
          type,
          text: args.map((a: any) => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' '),
          ts: Date.now(),
        }]);
      } else if (type === 'done') {
        setOutput(prev => [...prev, {
          id: 'r_' + Date.now().toString(36),
          type: 'result',
          text: result !== undefined ? JSON.stringify(result, null, 2) : 'undefined',
          ts: Date.now(),
        }]);
        setRunning(false);
      }
    };
    return () => { if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null; } };
  }, [open]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  const active = useMemo(() => scripts.find(s => s.id === activeId), [scripts, activeId]);

  const run = useCallback(() => {
    if (!workerRef.current || running) return;
    setOutput([]);
    setRunning(true);
    setScripts(prev => prev.map(s => s.id === activeId ? { ...s, lastRun: Date.now() } : s));
    workerRef.current.postMessage({ code, id: activeId });
  }, [code, activeId, running]);

  const stop = useCallback(() => {
    if (workerRef.current) workerRef.current.terminate();
    setRunning(false);
    setOutput(prev => [...prev, { id: 's_' + Date.now(), type: 'warn', text: '[已停止]', ts: Date.now() }]);
  }, []);

  const newScript = useCallback(() => {
    const id = 's_' + Date.now().toString(36);
    const s: Script = { id, name: '新脚本', code: '// 在此输入 JavaScript\nlog("Hello, SoloForge!");', pinned: false };
    setScripts(prev => [s, ...prev]);
    setActiveId(id);
    setCode(s.code);
  }, []);

  const delScript = useCallback((id: string) => {
    setScripts(prev => prev.filter(s => s.id !== id));
    if (activeId === id) {
      const first = scripts.find(s => s.id !== id);
      if (first) { setActiveId(first.id); setCode(first.code); }
    }
  }, [activeId, scripts]);

  const togglePin = useCallback((id: string) => {
    setScripts(prev => prev.map(s => s.id === id ? { ...s, pinned: !s.pinned } : s));
  }, []);

  const updateActiveCode = useCallback((newCode: string) => {
    setCode(newCode);
    setScripts(prev => prev.map(s => s.id === activeId ? { ...s, code: newCode } : s));
  }, [activeId]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">terminal</span>
          <h2 className="text-sm font-semibold text-text">脚本执行器</h2>
          <Badge variant="primary">JS Sandbox</Badge>
          <Badge variant="info">Web Worker</Badge>
          {running && <Badge variant="warning">运行中...</Badge>}
          <div className="ml-auto flex items-center gap-1">
            {running ? <Button size="sm" icon="stop" variant="danger" onClick={stop}>停止</Button> : <Button size="sm" icon="play_arrow" variant="primary" onClick={run}>运行 (Ctrl+↵)</Button>}
            <Button size="sm" icon="add" onClick={newScript}>新建</Button>
            <Button size="sm" icon="delete" onClick={() => setOutput([])}>清空</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-48 border-r border-border bg-bg p-2 overflow-y-auto">
            <h3 className="text-xs font-semibold text-text mb-1">脚本</h3>
            {scripts.map(s => (
              <div key={s.id} onClick={() => { setActiveId(s.id); setCode(s.code); }}
                className={'group px-2 py-1.5 rounded cursor-pointer mb-0.5 flex items-center gap-1 ' + (activeId === s.id ? 'bg-accent/15' : 'hover:bg-surface-high')}>
                {s.pinned && <span className="material-symbols-outlined text-xs filled text-yellow-500">push_pin</span>}
                <span className="text-xs text-text flex-1 truncate">{s.name}</span>
                <IconButton icon="push_pin" size="xs" tooltip="置顶" onClick={(e) => { e.stopPropagation(); togglePin(s.id); }} className="opacity-0 group-hover:opacity-100" />
                <IconButton icon="close" size="xs" tooltip="删除" onClick={(e) => { e.stopPropagation(); delScript(s.id); }} className="opacity-0 group-hover:opacity-100" />
              </div>
            ))}
          </div>

          <div className="flex-1 flex flex-col">
            <div className="px-3 py-1.5 border-b border-border bg-bg flex items-center gap-2">
              <input value={active?.name || ''} onChange={(e) => setScripts(prev => prev.map(s => s.id === activeId ? { ...s, name: e.target.value } : s))}
                className="bg-transparent text-xs font-semibold text-text outline-none flex-1" />
              {active?.lastRun && <span className="text-[10px] text-text-secondary">上次运行: {new Date(active.lastRun).toLocaleTimeString()}</span>}
            </div>
            <div className="flex-1 flex overflow-hidden">
              <div className="flex-1 flex flex-col">
                <textarea
                  value={code}
                  onChange={(e) => updateActiveCode(e.target.value)}
                  onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } }}
                  className="flex-1 bg-bg p-3 text-xs font-mono text-text outline-none resize-none"
                  spellCheck={false}
                />
                <div className="px-3 py-1 border-t border-border bg-surface-high text-[10px] text-text-secondary">
                  Ctrl+↵ 运行 · 输出 {output.length} 行
                </div>
              </div>

              <div className="w-1/2 border-l border-border bg-bg flex flex-col">
                <div className="px-3 py-1.5 border-b border-border flex items-center gap-1">
                  <div className="flex items-center gap-0.5 p-0.5 bg-surface rounded-md border border-border-light">
                    {(['console', 'result'] as const).map(t => (
                      <button key={t} onClick={() => setTab(t)} className={'px-2 h-5 rounded text-[10px] ' + (tab === t ? 'bg-surface-high text-text' : 'text-text-secondary')}>
                        {t === 'console' ? '控制台' : '结果'}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10px] text-text-secondary ml-2">{output.length} 条</span>
                </div>
                <div ref={outputRef} className="flex-1 overflow-auto p-2 font-mono text-[11px] space-y-0.5">
                  {output.length === 0 ? (
                    <p className="text-text-secondary text-center py-4">点击「运行」执行脚本</p>
                  ) : output.map(e => (
                    <div key={e.id} className={'flex gap-2 ' + (e.type === 'error' ? 'text-danger' : e.type === 'warn' ? 'text-warning' : e.type === 'result' ? 'text-success' : e.type === 'info' ? 'text-info' : 'text-text')}>
                      <span className="text-text-secondary shrink-0 w-12">{new Date(e.ts).toLocaleTimeString()}</span>
                      <span className="font-bold shrink-0 w-12">[{e.type}]</span>
                      <pre className="flex-1 whitespace-pre-wrap break-all">{e.text}</pre>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>沙箱: Web Worker (隔离环境)</span>
          <span>·</span>
          <span>可用: log / info / warn / error / delay</span>
          <span>·</span>
          <span>支持 async/await + Promise</span>
        </div>
      </div>
    </div>
  );
}
