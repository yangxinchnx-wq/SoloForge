// ─────────────────────────────────────────────────────────────────
// 依赖图可视化 — DependencyGraph
// - npm/pip/cargo 依赖关系图
// - 力导向布局模拟
// - 循环依赖检测
// - 包大小/版本/许可
// - 搜索 + 上下游
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

interface Pkg {
  name: string;
  version: string;
  size: number; // KB
  license: string;
  type: 'prod' | 'dev' | 'peer' | 'optional';
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface Edge { from: string; to: string; }

const SEED_PKGS: Pkg[] = [
  { name: 'react',          version: '18.3.1', size: 6.4,  license: 'MIT',     type: 'prod' },
  { name: 'react-dom',      version: '18.3.1', size: 130,  license: 'MIT',     type: 'prod' },
  { name: 'typescript',     version: '5.4.5',  size: 63,   license: 'Apache-2.0', type: 'dev' },
  { name: 'vite',           version: '5.4.21', size: 120,  license: 'MIT',     type: 'dev' },
  { name: '@vitejs/plugin-react', version: '4.3.1', size: 12, license: 'MIT',  type: 'dev' },
  { name: 'tailwindcss',    version: '3.4.7',  size: 320,  license: 'MIT',     type: 'dev' },
  { name: 'autoprefixer',   version: '10.4.19',size: 24,   license: 'MIT',     type: 'dev' },
  { name: 'postcss',        version: '8.4.39', size: 90,   license: 'MIT',     type: 'dev' },
  { name: 'zustand',        version: '4.5.4',  size: 8,    license: 'MIT',     type: 'prod' },
  { name: 'react-router-dom',version: '6.26.0',size: 56,   license: 'MIT',     type: 'prod' },
  { name: 'axios',          version: '1.7.2',  size: 88,   license: 'MIT',     type: 'prod' },
  { name: 'lodash',         version: '4.17.21',size: 144,  license: 'MIT',     type: 'prod' },
  { name: 'date-fns',       version: '3.6.0',  size: 80,   license: 'MIT',     type: 'prod' },
  { name: 'monaco-editor',  version: '0.50.0', size: 4200, license: 'MIT',     type: 'prod' },
  { name: 'marked',         version: '13.0.0', size: 56,   license: 'MIT',     type: 'prod' },
  { name: 'dompurify',      version: '3.1.6',  size: 24,   license: 'MIT',     type: 'prod' },
  { name: 'jszip',          version: '3.10.1', size: 96,   license: 'MIT',     type: 'prod' },
  { name: 'prismjs',        version: '1.29.0', size: 48,   license: 'MIT',     type: 'prod' },
  { name: 'web-worker',     version: '1.3.0',  size: 4,    license: 'MIT',     type: 'prod' },
  { name: 'clsx',           version: '2.1.1',  size: 2,    license: 'MIT',     type: 'prod' },
];

const SEED_EDGES: Edge[] = [
  { from: 'react-dom', to: 'react' },
  { from: 'react-router-dom', to: 'react' },
  { from: 'react-router-dom', to: 'react-dom' },
  { from: 'zustand', to: 'react' },
  { from: '@vitejs/plugin-react', to: 'vite' },
  { from: '@vitejs/plugin-react', to: 'react' },
  { from: 'autoprefixer', to: 'postcss' },
  { from: 'tailwindcss', to: 'postcss' },
  { from: 'tailwindcss', to: 'autoprefixer' },
  { from: 'monaco-editor', to: 'marked' },
  { from: 'dompurify', to: 'marked' },
  // 故意造一个循环
  { from: 'lodash', to: 'lodash' },
];

const PRESETS: Record<string, { pkgs: Pkg[]; edges: Edge[]; label: string }> = {
  frontend: { pkgs: SEED_PKGS, edges: SEED_EDGES, label: '前端项目 (npm)' },
  python: {
    pkgs: [
      { name: 'fastapi',   version: '0.111.0', size: 420, license: 'MIT',       type: 'prod' },
      { name: 'uvicorn',   version: '0.30.1',  size: 64,  license: 'BSD-3',     type: 'prod' },
      { name: 'pydantic',  version: '2.7.4',   size: 380, license: 'MIT',       type: 'prod' },
      { name: 'sqlalchemy',version: '2.0.30',  size: 1240,license: 'MIT',       type: 'prod' },
      { name: 'aiohttp',   version: '3.9.5',   size: 540, license: 'Apache-2.0',type: 'prod' },
      { name: 'numpy',     version: '1.26.4',  size: 6200,license: 'BSD-3',     type: 'prod' },
      { name: 'pandas',    version: '2.2.2',   size: 12400,license: 'BSD-3',    type: 'prod' },
      { name: 'requests',  version: '2.32.3',  size: 220, license: 'Apache-2.0',type: 'prod' },
      { name: 'pytest',    version: '8.2.2',   size: 180, license: 'MIT',       type: 'dev' },
    ],
    edges: [
      { from: 'fastapi', to: 'pydantic' },
      { from: 'fastapi', to: 'uvicorn' },
      { from: 'fastapi', to: 'starlette' },
      { from: 'uvicorn', to: 'aiohttp' },
      { from: 'pandas', to: 'numpy' },
      { from: 'sqlalchemy', to: 'pydantic' },
    ],
    label: 'Python 后端 (pip)',
  },
  rust: {
    pkgs: [
      { name: 'tokio',     version: '1.38.0',  size: 320, license: 'MIT',  type: 'prod' },
      { name: 'serde',     version: '1.0.203', size: 80,  license: 'MIT',  type: 'prod' },
      { name: 'serde_json',version: '1.0.117', size: 96,  license: 'MIT',  type: 'prod' },
      { name: 'reqwest',   version: '0.12.5',  size: 240, license: 'MIT',  type: 'prod' },
      { name: 'axum',      version: '0.7.5',   size: 60,  license: 'MIT',  type: 'prod' },
      { name: 'clap',      version: '4.5.4',   size: 180, license: 'MIT',  type: 'prod' },
    ],
    edges: [
      { from: 'reqwest', to: 'tokio' },
      { from: 'axum', to: 'tokio' },
      { from: 'serde_json', to: 'serde' },
      { from: 'reqwest', to: 'serde_json' },
    ],
    label: 'Rust 项目 (cargo)',
  },
};

interface Adj { [k: string]: Set<string> }
function buildAdj(edges: Edge[]): Adj {
  const a: Adj = {};
  for (const e of edges) {
    (a[e.from] ||= new Set()).add(e.to);
    (a[e.to] ||= new Set()).add(e.from);
  }
  return a;
}
function detectCycles(pkgs: Pkg[], edges: Edge[]): string[][] {
  const adj: Record<string, string[]> = {};
  for (const e of edges) (adj[e.from] ||= []).push(e.to);
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  function dfs(u: string) {
    visited.add(u); onStack.add(u); stack.push(u);
    for (const v of adj[u] || []) {
      if (!visited.has(v)) dfs(v);
      else if (onStack.has(v)) {
        const i = stack.indexOf(v);
        if (i >= 0) cycles.push([...stack.slice(i), v]);
      }
    }
    onStack.delete(u); stack.pop();
  }
  for (const p of pkgs) if (!visited.has(p.name)) dfs(p.name);
  return cycles;
}

const W = 880, H = 560;

export function DependencyGraph({ open, onClose }: Props) {
  const [presetKey, setPresetKey] = useState<keyof typeof PRESETS>('frontend');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [view, setView] = useState<'graph' | 'tree' | 'list'>('graph');
  const [tick, setTick] = useState(0);
  const dragging = useRef<{ name: string; offX: number; offY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const preset = PRESETS[presetKey];
  const pkgs = preset.pkgs;
  const edges = preset.edges;

  // 初始化位置
  const posMap = useRef<Record<string, { x: number; y: number }>>({});
  useEffect(() => {
    const cx = W / 2, cy = H / 2;
    const n = pkgs.length;
    const r = Math.min(W, H) * 0.35;
    pkgs.forEach((p, i) => {
      const a = (i / n) * Math.PI * 2;
      posMap.current[p.name] = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
    });
    setTick(t => t + 1);
  }, [presetKey, pkgs.length]);

  // 力模拟
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const step = () => {
      const k = 0.05;
      const repulse = 4500;
      const ideal = 100;
      const center = 0.001;
      const drag = 0.7;
      const damping = 0.85;
      const names = pkgs.map(p => p.name);
      const force = new Map<string, { fx: number; fy: number }>();
      names.forEach(n => force.set(n, { fx: 0, fy: 0 }));
      // 排斥力
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const a = posMap.current[names[i]], b = posMap.current[names[j]];
          if (!a || !b) continue;
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.max(20, Math.hypot(dx, dy));
          const f = repulse / (d * d);
          const ux = dx / d, uy = dy / d;
          force.get(names[i])!.fx += ux * f;
          force.get(names[i])!.fy += uy * f;
          force.get(names[j])!.fx -= ux * f;
          force.get(names[j])!.fy -= uy * f;
        }
      }
      // 弹簧 (依赖边)
      for (const e of edges) {
        if (e.from === e.to) continue;
        const a = posMap.current[e.from], b = posMap.current[e.to];
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(20, Math.hypot(dx, dy));
        const f = (d - ideal) * k;
        const ux = dx / d, uy = dy / d;
        force.get(e.from)!.fx += ux * f;
        force.get(e.from)!.fy += uy * f;
        force.get(e.to)!.fx -= ux * f;
        force.get(e.to)!.fy -= uy * f;
      }
      // 中心引力
      for (const n of names) {
        const p = posMap.current[n];
        if (!p) continue;
        force.get(n)!.fx += (W / 2 - p.x) * center;
        force.get(n)!.fy += (H / 2 - p.y) * center;
      }
      // 拖拽
      if (dragging.current) {
        const f = force.get(dragging.current.name);
        if (f) { f.fx = 0; f.fy = 0; }
      }
      // 应用
      for (const n of names) {
        const p = posMap.current[n];
        const f = force.get(n);
        if (!p || !f) continue;
        if (dragging.current && dragging.current.name === n) continue;
        p.x += f.fx * drag;
        p.y += f.fy * drag;
        p.x = Math.max(20, Math.min(W - 20, p.x));
        p.y = Math.max(20, Math.min(H - 20, p.y));
      }
      setTick(t => (t + 1) % 1000000);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [open, presetKey, edges, pkgs]);

  const adj = useMemo(() => buildAdj(edges), [edges]);
  const cycles = useMemo(() => detectCycles(pkgs, edges), [pkgs, edges]);

  const filtered = useMemo(() => {
    if (!search) return null;
    const q = search.toLowerCase();
    return new Set(pkgs.filter(p => p.name.toLowerCase().includes(q)).map(p => p.name));
  }, [search, pkgs]);

  const downstream = useMemo(() => {
    if (!active) return null;
    const visited = new Set<string>();
    const queue = [active];
    while (queue.length) {
      const u = queue.shift()!;
      if (visited.has(u)) continue;
      visited.add(u);
      for (const v of adj[u] || []) if (!visited.has(v)) queue.push(v);
    }
    visited.delete(active);
    return visited;
  }, [active, adj]);

  const upstream = useMemo(() => {
    if (!active) return null;
    const visited = new Set<string>();
    const queue = [active];
    const reverse: Record<string, string[]> = {};
    for (const e of edges) (reverse[e.to] ||= []).push(e.from);
    while (queue.length) {
      const u = queue.shift()!;
      if (visited.has(u)) continue;
      visited.add(u);
      for (const v of reverse[u] || []) if (!visited.has(v)) queue.push(v);
    }
    visited.delete(active);
    return visited;
  }, [active, edges]);

  const totalSize = pkgs.reduce((a, p) => a + p.size, 0);
  const activePkg = active ? pkgs.find(p => p.name === active) : null;

  const nodeColor = (p: Pkg) => {
    if (filtered && !filtered.has(p.name)) return '#9ca3af';
    if (active && !downstream?.has(p.name) && p.name !== active) return '#9ca3af';
    if (active && downstream?.has(p.name)) return '#22c55e';
    if (active && upstream?.has(p.name)) return '#3b82f6';
    if (p.type === 'dev') return '#a855f7';
    if (p.type === 'peer') return '#eab308';
    if (p.type === 'optional') return '#9ca3af';
    return '#06b6d4';
  };
  const nodeSize = (p: Pkg) => Math.max(8, Math.min(28, 6 + Math.log2(p.size + 1) * 2.5));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">account_tree</span>
          <h2 className="text-sm font-semibold text-text">依赖关系图</h2>
          <Badge variant="primary">{pkgs.length} 包</Badge>
          <Badge variant="info">{(totalSize / 1024).toFixed(1)} MB</Badge>
          {cycles.length > 0 && <Badge variant="danger">⚠ {cycles.length} 循环</Badge>}
          <select value={presetKey} onChange={(e) => setPresetKey(e.target.value as any)} className="ml-2 bg-bg border border-border-light rounded px-2 h-7 text-xs">
            {Object.entries(PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索包..."
            className="ml-auto bg-bg border border-border-light rounded px-2 h-7 text-xs w-40" />
          <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
            {(['graph', 'tree', 'list'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} className={'px-2 h-6 rounded text-[10px] ' + (view === v ? 'bg-surface-high text-text' : 'text-text-secondary')}>
                {v === 'graph' ? '图' : v === 'tree' ? '树' : '列表'}
              </button>
            ))}
          </div>
          <IconButton icon="close" onClick={onClose} />
        </div>

        <div className="flex-1 flex overflow-hidden">
          {view === 'graph' && (
            <>
              <div className="flex-1 bg-bg overflow-hidden relative">
                <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-full" key={tick + '-' + presetKey}>
                  {edges.map((e, i) => {
                    const a = posMap.current[e.from], b = posMap.current[e.to];
                    if (!a || !b) return null;
                    const isCycle = e.from === e.to;
                    const color = isCycle ? '#ef4444' : (active && (e.from === active || e.to === active)) ? '#06b6d4' : '#4b5563';
                    if (isCycle) {
                      return (
                        <g key={i}>
                          <circle cx={a.x} cy={a.y} r={20} fill="none" stroke={color} strokeWidth="1.5" />
                          <text x={a.x} y={a.y - 25} fontSize="9" fill={color} textAnchor="middle">⤾ self</text>
                        </g>
                      );
                    }
                    return (
                      <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth="1" opacity="0.5" />
                    );
                  })}
                  {pkgs.map(p => {
                    const pos = posMap.current[p.name];
                    if (!pos) return null;
                    const r = nodeSize(p);
                    const color = nodeColor(p);
                    return (
                      <g key={p.name} transform={`translate(${pos.x}, ${pos.y})`}
                        onMouseDown={(e) => {
                          const pt = svgRef.current!.createSVGPoint();
                          pt.x = e.clientX; pt.y = e.clientY;
                          const ctm = svgRef.current!.getScreenCTM()!.inverse();
                          const local = pt.matrixTransform(ctm);
                          dragging.current = { name: p.name, offX: local.x - pos.x, offY: local.y - pos.y };
                        }}
                        onMouseUp={() => { dragging.current = null; }}
                        onClick={() => setActive(active === p.name ? null : p.name)}
                        className="cursor-pointer">
                        <circle r={r} fill={color} stroke="#fff" strokeWidth="1.5" />
                        <text y={r + 11} fontSize="9" fill="currentColor" textAnchor="middle" className="text-text">{p.name}</text>
                      </g>
                    );
                  })}
                </svg>
                <div className="absolute top-2 left-2 bg-surface/80 backdrop-blur-sm border border-border-light rounded p-2 text-[10px] space-y-0.5">
                  <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cyan-500"></span>生产依赖</div>
                  <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-500"></span>开发依赖</div>
                  <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500"></span>下游</div>
                  <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500"></span>上游</div>
                  <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500"></span>循环</div>
                </div>
              </div>

              {activePkg && (
                <div className="w-72 border-l border-border bg-bg p-3 overflow-y-auto">
                  <h3 className="text-sm font-semibold text-text mb-1">{activePkg.name}</h3>
                  <code className="text-[10px] text-text-secondary">v{activePkg.version}</code>
                  <div className="text-[10px] text-text-secondary mt-2 space-y-0.5">
                    <div>类型: {activePkg.type}</div>
                    <div>大小: {activePkg.size} KB ({(activePkg.size/1024).toFixed(2)} MB)</div>
                    <div>许可: {activePkg.license}</div>
                    <div>上游: {Array.from(upstream || []).length} 个</div>
                    <div>下游: {Array.from(downstream || []).length} 个</div>
                  </div>
                  <div className="mt-2">
                    <p className="text-[10px] text-text-secondary mb-0.5">直接依赖:</p>
                    <div className="space-y-0.5">
                      {Array.from(adj[activePkg.name] || []).map(d => (
                        <div key={d} className="text-[10px] bg-bg border border-border-light rounded px-1.5 py-0.5 font-mono text-text">{d}</div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {view === 'tree' && (
            <div className="flex-1 p-3 overflow-y-auto font-mono text-[11px]">
              {pkgs.map(p => (
                <div key={p.name} className="mb-1">
                  <div onClick={() => setActive(p.name)} className={'cursor-pointer hover:text-accent ' + (active === p.name ? 'text-accent font-semibold' : 'text-text')}>
                    {p.name} <span className="text-text-secondary">@{p.version}</span> <span className="text-[9px] text-text-secondary">({p.size}KB)</span>
                  </div>
                  {(adj[p.name] || new Set()).size > 0 && (
                    <div className="ml-4 border-l border-border-light pl-2">
                      {Array.from(adj[p.name]).map(d => (
                        <div key={d} className="text-text-secondary">└─ {d}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {view === 'list' && (
            <div className="flex-1 p-3 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-surface-high text-text-secondary text-[10px] sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1.5">包</th>
                    <th className="text-left px-2 py-1.5 w-20">版本</th>
                    <th className="text-left px-2 py-1.5 w-16">类型</th>
                    <th className="text-left px-2 py-1.5 w-16">大小</th>
                    <th className="text-left px-2 py-1.5 w-24">许可</th>
                    <th className="text-left px-2 py-1.5 w-12">依赖</th>
                  </tr>
                </thead>
                <tbody>
                  {[...pkgs].sort((a, b) => b.size - a.size).map(p => (
                    <tr key={p.name} onClick={() => setActive(p.name)} className="border-t border-border-light cursor-pointer hover:bg-surface-high">
                      <td className="px-2 py-1 font-mono text-text">{p.name}</td>
                      <td className="px-2 py-1 text-text-secondary">{p.version}</td>
                      <td className="px-2 py-1"><Badge variant={p.type === 'prod' ? 'info' : p.type === 'dev' ? 'default' : 'warning'}>{p.type}</Badge></td>
                      <td className="px-2 py-1 text-text-secondary">{p.size} KB</td>
                      <td className="px-2 py-1 text-text-secondary">{p.license}</td>
                      <td className="px-2 py-1 text-text-secondary">{(adj[p.name] || new Set()).size}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>布局: 力导向</span>
          <span>·</span>
          <span>节点大小 ∝ log(包大小)</span>
          <span>·</span>
          <span>点击节点高亮上下游,拖拽可重排</span>
          {cycles.length > 0 && <><span>·</span><span className="text-danger">检测到循环: {cycles.map(c => c.join(' → ')).join('; ')}</span></>}
        </div>
      </div>
    </div>
  );
}
