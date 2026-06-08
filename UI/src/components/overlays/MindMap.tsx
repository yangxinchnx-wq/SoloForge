// ─────────────────────────────────────────────────────────────────
// 思维导图 / 节点画布 — MindMap
// - 自由拖拽节点,SVG 连线
// - 4 种节点类型 (主/分支/子/注释)
// - 缩放/平移/自动布局
// - 导入/导出 (JSON / Markdown / OPML)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface MindNode {
  id: string;
  text: string;
  x: number;
  y: number;
  type: 'root' | 'branch' | 'child' | 'note';
  color: string;
  parent?: string;
  collapsed?: boolean;
}

interface MindEdge {
  from: string;
  to: string;
}

const STORAGE_KEY = 'soloforge.mindmap.v1';

const NODE_STYLE: Record<MindNode['type'], { bg: string; border: string; text: string; size: number }> = {
  root:   { bg: 'bg-accent',     border: 'border-accent',     text: 'text-on-accent',  size: 120 },
  branch: { bg: 'bg-primary',    border: 'border-primary',    text: 'text-on-primary', size: 90 },
  child:  { bg: 'bg-surface',    border: 'border-border',     text: 'text-text',       size: 70 },
  note:   { bg: 'bg-warning/20', border: 'border-warning/50', text: 'text-text',       size: 70 },
};

function load(): { nodes: MindNode[]; edges: MindEdge[] } {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  return defaultMap();
}

function defaultMap(): { nodes: MindNode[]; edges: MindEdge[] } {
  return {
    nodes: [
      { id: 'r',  text: 'SoloForge 架构',  x: 400, y: 240, type: 'root',   color: '#3b82f6' },
      { id: 'b1', text: '微内核 (TS)',     x: 150, y: 120, type: 'branch', color: '#8b5cf6', parent: 'r' },
      { id: 'b2', text: '调度器 (Rust)',   x: 150, y: 360, type: 'branch', color: '#10b981', parent: 'r' },
      { id: 'b3', text: '数据库 (Surreal)', x: 650, y: 120, type: 'branch', color: '#f59e0b', parent: 'r' },
      { id: 'b4', text: 'MARL 引擎',       x: 650, y: 360, type: 'branch', color: '#ec4899', parent: 'r' },
      { id: 'c1', text: '事件总线',        x: 50,  y: 60,  type: 'child',  color: '#06b6d4', parent: 'b1' },
      { id: 'c2', text: '业务编排',        x: 50,  y: 180, type: 'child',  color: '#06b6d4', parent: 'b1' },
      { id: 'c3', text: 'Aging 优先队列',  x: 50,  y: 300, type: 'child',  color: '#06b6d4', parent: 'b2' },
      { id: 'c4', text: 'RocksDB 存储',    x: 750, y: 60,  type: 'child',  color: '#06b6d4', parent: 'b3' },
      { id: 'c5', text: 'MAPPO 算法',      x: 750, y: 300, type: 'child',  color: '#06b6d4', parent: 'b4' },
      { id: 'n1', text: '注: 所有组件可独立部署', x: 400, y: 480, type: 'note', color: '#f59e0b' },
    ],
    edges: [
      { from: 'r', to: 'b1' }, { from: 'r', to: 'b2' }, { from: 'r', to: 'b3' }, { from: 'r', to: 'b4' },
      { from: 'b1', to: 'c1' }, { from: 'b1', to: 'c2' },
      { from: 'b2', to: 'c3' },
      { from: 'b3', to: 'c4' },
      { from: 'b4', to: 'c5' },
    ],
  };
}

function save(d: { nodes: MindNode[]; edges: MindEdge[] }) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch { /* ignore */ }
}

export function MindMap({ open, onClose }: Props) {
  const [data, setData] = useState(load);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState<'select' | 'add-child' | 'add-note' | 'connect'>('select');
  const [dragging, setDragging] = useState<{ id: string; ox: number; oy: number; sx: number; sy: number } | null>(null);
  const [panning, setPanning] = useState<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => { save(data); }, [data]);

  // 自动布局 (放射状)
  const autoLayout = useCallback(() => {
    setData(prev => {
      const root = prev.nodes.find(n => n.type === 'root');
      if (!root) return prev;
      const branches = prev.nodes.filter(n => n.type === 'branch' && n.parent === root.id);
      const branchCount = branches.length || 1;
      const R = 220;
      const newNodes = prev.nodes.map(n => {
        if (n.id === root.id) return { ...n, x: 500, y: 300 };
        if (n.type === 'branch' && n.parent === root.id) {
          const idx = branches.findIndex(b => b.id === n.id);
          const angle = (idx / branchCount) * Math.PI * 2 - Math.PI / 2;
          const children = prev.nodes.filter(c => c.parent === n.id);
          return {
            ...n,
            x: 500 + Math.cos(angle) * R,
            y: 300 + Math.sin(angle) * R,
            // 子节点相对分支
            ...(children.length > 0 ? {} : {}),
          };
        }
        if (n.type === 'child' && n.parent) {
          const parent = prev.nodes.find(p => p.id === n.parent);
          if (parent) {
            const siblings = prev.nodes.filter(s => s.parent === parent.id);
            const idx = siblings.findIndex(s => s.id === n.id);
            const dx = (idx - (siblings.length - 1) / 2) * 100;
            const r = Math.sqrt((parent.x - 500) ** 2 + (parent.y - 300) ** 2);
            const a = Math.atan2(parent.y - 300, parent.x - 500);
            const r2 = r + 120;
            return {
              ...n,
              x: 500 + Math.cos(a) * r2 + dx,
              y: 300 + Math.sin(a) * r2,
            };
          }
        }
        return n;
      });
      return { ...prev, nodes: newNodes };
    });
  }, []);

  // 拖拽
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dx = (e.clientX - dragging.sx) / zoom;
      const dy = (e.clientY - dragging.sy) / zoom;
      setData(prev => ({
        ...prev,
        nodes: prev.nodes.map(n => n.id === dragging.id ? { ...n, x: dragging.ox + dx, y: dragging.oy + dy } : n),
      }));
    };
    const onUp = () => setDragging(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, zoom]);

  // 平移
  useEffect(() => {
    if (!panning) return;
    const onMove = (e: MouseEvent) => {
      setPan({ x: panning.px + (e.clientX - panning.sx), y: panning.py + (e.clientY - panning.sy) });
    };
    const onUp = () => setPanning(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [panning]);

  const addNode = useCallback((parentId: string | null, type: MindNode['type']) => {
    const id = 'n_' + Date.now().toString(36);
    const parent = parentId ? data.nodes.find(n => n.id === parentId) : null;
    const x = parent ? parent.x + 100 : 400;
    const y = parent ? parent.y + 80 : 240;
    const newNode: MindNode = {
      id, text: type === 'note' ? '注释' : '新节点', x, y, type,
      color: type === 'root' ? '#3b82f6' : type === 'branch' ? '#8b5cf6' : type === 'note' ? '#f59e0b' : '#06b6d4',
      parent: parentId || undefined,
    };
    setData(prev => ({
      nodes: [...prev.nodes, newNode],
      edges: parentId ? [...prev.edges, { from: parentId, to: id }] : prev.edges,
    }));
    setEditingId(id);
  }, [data.nodes]);

  const updateNode = useCallback((id: string, patch: Partial<MindNode>) => {
    setData(prev => ({
      ...prev,
      nodes: prev.nodes.map(n => n.id === id ? { ...n, ...patch } : n),
    }));
  }, []);

  const removeNode = useCallback((id: string) => {
    setData(prev => ({
      nodes: prev.nodes.filter(n => n.id !== id && n.parent !== id),
      edges: prev.edges.filter(e => e.from !== id && e.to !== id),
    }));
    if (selectedId === id) setSelectedId(null);
  }, [selectedId]);

  const handleNodeClick = useCallback((n: MindNode, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tool === 'add-child') { addNode(n.id, 'child'); return; }
    if (tool === 'add-note') { addNode(n.id, 'note'); return; }
    if (tool === 'connect') {
      if (connectFrom == null) {
        setConnectFrom(n.id);
      } else if (connectFrom !== n.id) {
        setData(prev => ({ ...prev, edges: [...prev.edges, { from: connectFrom, to: n.id }] }));
        setConnectFrom(null);
      }
      return;
    }
    setSelectedId(n.id);
  }, [tool, addNode, connectFrom]);

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'mindmap.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [data]);

  const exportMd = useCallback(() => {
    const lines: string[] = [];
    const root = data.nodes.find(n => n.type === 'root');
    if (!root) return;
    const walk = (id: string, depth: number) => {
      const n = data.nodes.find(x => x.id === id);
      if (!n) return;
      lines.push(`${'  '.repeat(depth)}- ${n.text}`);
      data.nodes.filter(c => c.parent === id).forEach(c => walk(c.id, depth + 1));
    };
    walk(root.id, 0);
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'mindmap.md'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [data]);

  const importJson = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result as string);
        if (d.nodes && d.edges) setData(d);
      } catch { /* ignore */ }
    };
    reader.readAsText(file);
  }, []);

  if (!open) return null;

  const visibleNodes = data.nodes.filter(n => {
    if (!n.parent) return true;
    const parent = data.nodes.find(p => p.id === n.parent);
    if (parent?.collapsed) return false;
    let cur = parent;
    while (cur?.parent) {
      const pp = data.nodes.find(p => p.id === cur!.parent);
      if (pp?.collapsed) return false;
      cur = pp;
    }
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">hub</span>
          <h2 className="text-sm font-semibold text-text">思维导图</h2>
          <Badge variant="primary">{data.nodes.length} 节点 · {data.edges.length} 边</Badge>
          <span className="text-xs text-text-secondary">缩放 {(zoom * 100).toFixed(0)}%</span>
          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center gap-0.5 p-0.5 bg-bg rounded-md border border-border-light">
              {(['select', 'add-child', 'add-note', 'connect'] as const).map(t => (
                <button key={t} onClick={() => { setTool(t); setConnectFrom(null); }}
                  className={'px-2 h-6 rounded text-[10px] flex items-center gap-1 ' + (tool === t ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:text-text')}>
                  <span className="material-symbols-outlined text-xs">
                    {t === 'select' ? 'arrow_selector_tool' : t === 'add-child' ? 'add_circle' : t === 'add-note' ? 'sticky_note_2' : 'link'}
                  </span>
                  {t === 'select' ? '选择' : t === 'add-child' ? '添加子' : t === 'add-note' ? '注释' : '连线'}
                </button>
              ))}
            </div>
            <Tooltip content="自动布局"><IconButton icon="auto_awesome_motion" onClick={autoLayout} /></Tooltip>
            <Tooltip content="放大"><IconButton icon="zoom_in" onClick={() => setZoom(z => Math.min(2, z + 0.1))} /></Tooltip>
            <Tooltip content="缩小"><IconButton icon="zoom_out" onClick={() => setZoom(z => Math.max(0.3, z - 0.1))} /></Tooltip>
            <Tooltip content="重置视图"><IconButton icon="center_focus_strong" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} /></Tooltip>
            <Tooltip content="导出 JSON"><IconButton icon="code" onClick={exportJson} /></Tooltip>
            <Tooltip content="导出 Markdown"><IconButton icon="description" onClick={exportMd} /></Tooltip>
            <Tooltip content="导入"><IconButton icon="upload" onClick={() => {
              const inp = document.createElement('input');
              inp.type = 'file'; inp.accept = '.json';
              inp.onchange = () => { const f = inp.files?.[0]; if (f) importJson(f); };
              inp.click();
            }} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 画布 */}
          <div
            ref={canvasRef}
            className="flex-1 relative bg-bg overflow-hidden"
            style={{
              backgroundImage: 'radial-gradient(circle at 1px 1px, var(--color-border-light) 1px, transparent 0)',
              backgroundSize: '20px 20px',
              cursor: panning ? 'grabbing' : 'default',
            }}
            onMouseDown={(e) => {
              if (e.button === 1 || e.button === 2 || e.shiftKey) {
                e.preventDefault();
                setPanning({ sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y });
              }
            }}
            onClick={() => { setSelectedId(null); setConnectFrom(null); }}
          >
            <div
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: '0 0',
                position: 'absolute',
                inset: 0,
              }}
            >
              {/* SVG 连线 */}
              <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: 'visible' }}>
                {data.edges.map((e, i) => {
                  const from = data.nodes.find(n => n.id === e.from);
                  const to = data.nodes.find(n => n.id === e.to);
                  if (!from || !to) return null;
                  const dx = to.x - from.x, dy = to.y - from.y;
                  const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
                  return (
                    <g key={i}>
                      <path
                        d={`M ${from.x} ${from.y} Q ${mx} ${from.y} ${mx} ${my} T ${to.x} ${to.y}`}
                        fill="none"
                        stroke="var(--color-border)"
                        strokeWidth={2}
                      />
                    </g>
                  );
                })}
              </svg>
              {/* 节点 */}
              {visibleNodes.map(n => {
                const style = NODE_STYLE[n.type];
                const isSelected = selectedId === n.id;
                const isConnecting = connectFrom === n.id;
                return (
                  <div
                    key={n.id}
                    onMouseDown={(e) => {
                      if (tool === 'select') {
                        e.stopPropagation();
                        setDragging({ id: n.id, ox: n.x, oy: n.y, sx: e.clientX, sy: e.clientY });
                      }
                    }}
                    onClick={(e) => handleNodeClick(n, e)}
                    onDoubleClick={(e) => { e.stopPropagation(); setEditingId(n.id); }}
                    className={`absolute ${style.bg} ${style.border} border-2 rounded-lg shadow-md flex items-center justify-center text-center cursor-pointer transition-all
                      ${isSelected ? 'ring-2 ring-accent shadow-xl' : ''}
                      ${isConnecting ? 'ring-2 ring-success animate-pulse' : ''}
                    `}
                    style={{
                      left: n.x - style.size / 2,
                      top: n.y - 22,
                      width: style.size,
                      minHeight: 44,
                      padding: 8,
                    }}
                  >
                    {editingId === n.id ? (
                      <input
                        autoFocus
                        value={n.text}
                        onChange={(e) => updateNode(n.id, { text: e.target.value })}
                        onBlur={() => setEditingId(null)}
                        onKeyDown={(e) => e.key === 'Enter' && setEditingId(null)}
                        className={`bg-transparent text-center text-xs font-medium outline-none w-full ${style.text}`}
                      />
                    ) : (
                      <span className={`text-xs font-medium ${style.text} break-words leading-tight`}>{n.text}</span>
                    )}
                    {n.type === 'branch' && data.nodes.some(c => c.parent === n.id) && (
                      <button
                        onClick={(e) => { e.stopPropagation(); updateNode(n.id, { collapsed: !n.collapsed }); }}
                        className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-surface-high border border-border text-[10px] flex items-center justify-center"
                      >
                        {n.collapsed ? '+' : '−'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 缩放控制 */}
            <div className="absolute bottom-3 right-3 flex flex-col gap-1 bg-surface border border-border rounded p-1">
              <button onClick={() => setZoom(z => Math.min(2, z + 0.1))} className="w-6 h-6 hover:bg-surface-high rounded text-text-secondary">+</button>
              <div className="text-[9px] text-center text-text-secondary">{(zoom * 100).toFixed(0)}%</div>
              <button onClick={() => setZoom(z => Math.max(0.3, z - 0.1))} className="w-6 h-6 hover:bg-surface-high rounded text-text-secondary">−</button>
            </div>
          </div>

          {/* 右侧:节点详情 */}
          {selectedId && (() => {
            const n = data.nodes.find(x => x.id === selectedId);
            if (!n) return null;
            return (
              <div className="w-72 border-l border-border bg-bg p-3 space-y-2">
                <h3 className="text-xs font-semibold text-text">节点详情</h3>
                <div>
                  <label className="text-[10px] text-text-secondary">文本</label>
                  <input
                    value={n.text}
                    onChange={(e) => updateNode(n.id, { text: e.target.value })}
                    className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs text-text"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-text-secondary">类型</label>
                  <select value={n.type} onChange={(e) => updateNode(n.id, { type: e.target.value as any })}
                    className="w-full bg-surface border border-border-light rounded px-2 h-7 text-xs text-text">
                    <option value="root">根</option>
                    <option value="branch">分支</option>
                    <option value="child">子</option>
                    <option value="note">注释</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-text-secondary">颜色</label>
                  <div className="flex gap-1 flex-wrap">
                    {['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#ef4444', '#a78bfa'].map(c => (
                      <button key={c} onClick={() => updateNode(n.id, { color: c })}
                        className={'w-6 h-6 rounded ' + (n.color === c ? 'ring-2 ring-accent' : '')}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                </div>
                <div className="text-[10px] text-text-secondary">位置: ({Math.round(n.x)}, {Math.round(n.y)})</div>
                <Button size="sm" variant="danger" icon="delete" block onClick={() => removeNode(n.id)}>删除节点</Button>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
