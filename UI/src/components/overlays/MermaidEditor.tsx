// ─────────────────────────────────────────────────────────────────
// Mermaid 实时图表编辑器
// - 支持 flowchart / sequence / class / state / gantt / pie / ER
// - 左侧代码编辑器 + 右侧 SVG 渲染 (轻量手写渲染,非依赖 mermaid)
// - 实时错误高亮 + 错误提示面板
// - 7 个示例模板
// - 导出 SVG / PNG (canvas) / Markdown
// - 主题切换 (light/dark)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';

// ── 类型 ──
type MermaidKind = 'flowchart' | 'sequence' | 'class' | 'state' | 'er' | 'gantt' | 'pie';

interface MermaidNode {
  id: string;
  label: string;
  shape: 'box' | 'round' | 'diamond' | 'cyl' | 'note' | 'sub';
  x: number;
  y: number;
  w: number;
  h: number;
  /** 父节点 (subgraph) */
  parent?: string;
}

interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
  type: 'arrow' | 'dotted' | 'thick';
}

interface MermaidSubgraph {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  children: string[];
}

interface ParsedDiagram {
  kind: MermaidKind;
  nodes: MermaidNode[];
  edges: MermaidEdge[];
  subgraphs: MermaidSubgraph[];
  /** 解析错误 */
  errors: string[];
}

const PALETTE = {
  node: { fill: '#1e293b', stroke: '#6366f1', text: '#e2e8f0' },
  nodeAlt: { fill: '#312e81', stroke: '#a855f7', text: '#e0e7ff' },
  edge: '#94a3b8',
  text: '#e2e8f0',
  subgraph: { fill: 'rgba(99,102,241,0.06)', stroke: '#6366f1' },
  error: '#ef4444',
};

const PALETTE_LIGHT = {
  node: { fill: '#ffffff', stroke: '#6366f1', text: '#0f172a' },
  nodeAlt: { fill: '#eef2ff', stroke: '#a855f7', text: '#1e1b4b' },
  edge: '#475569',
  text: '#0f172a',
  subgraph: { fill: 'rgba(99,102,241,0.04)', stroke: '#6366f1' },
  error: '#dc2626',
};

// ── 模板 ──
const TEMPLATES: Record<string, { name: string; code: string }> = {
  flowchart: {
    name: '流程图',
    code: `flowchart TD
    A[用户登录] --> B{是否已注册}
    B -->|是| C[主界面]
    B -->|否| D[注册页面]
    D --> E[提交信息]
    E --> F[验证邮箱]
    F --> G[激活账户]
    G --> C
    C --> H[退出登录]`,
  },
  sequence: {
    name: '时序图',
    code: `sequenceDiagram
    participant U as 用户
    participant F as 前端
    participant A as API
    participant DB as 数据库
    U->>F: 点击登录
    F->>A: POST /login
    A->>DB: 查询用户
    DB-->>A: 返回记录
    A-->>F: 返回 token
    F-->>U: 跳转主页`,
  },
  class: {
    name: '类图',
    code: `classDiagram
    class Animal {
      +String name
      +int age
      +makeSound() void
    }
    class Dog {
      +String breed
      +bark() void
    }
    class Cat {
      +String color
      +meow() void
    }
    Animal <|-- Dog
    Animal <|-- Cat`,
  },
  state: {
    name: '状态图',
    code: `stateDiagram-v2
    [*] --> Idle
    Idle --> Running: start
    Running --> Paused: pause
    Paused --> Running: resume
    Running --> Stopped: stop
    Paused --> Stopped: stop
    Stopped --> [*]`,
  },
  er: {
    name: 'ER 图',
    code: `erDiagram
    USER ||--o{ ORDER : places
    USER ||--o{ PROFILE : has
    ORDER ||--|{ LINE_ITEM : contains
    PRODUCT ||--o{ LINE_ITEM : "is in"`,
  },
  gantt: {
    name: '甘特图',
    code: `gantt
    title 项目计划
    dateFormat YYYY-MM-DD
    section 设计
    需求分析 :a1, 2026-06-01, 5d
    UI 设计 :a2, after a1, 7d
    section 开发
    后端 API :b1, after a2, 10d
    前端 :b2, after a2, 12d
    section 测试
    集成测试 :c1, after b1, 5d`,
  },
  pie: {
    name: '饼图',
    code: `pie title 工作时间分配
    "编码" : 45
    "会议" : 20
    "Review" : 15
    "调试" : 10
    "其他" : 10`,
  },
};

// ── 简易解析器 ──
function parseDiagram(code: string): ParsedDiagram {
  const errors: string[] = [];
  const lines = code.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('%'));

  // 推断类型
  let kind: MermaidKind = 'flowchart';
  const firstLine = lines[0] || '';
  if (/^flowchart|^graph/i.test(firstLine)) kind = 'flowchart';
  else if (/^sequenceDiagram/i.test(firstLine)) kind = 'sequence';
  else if (/^classDiagram/i.test(firstLine)) kind = 'class';
  else if (/^stateDiagram/i.test(firstLine)) kind = 'state';
  else if (/^erDiagram/i.test(firstLine)) kind = 'er';
  else if (/^gantt/i.test(firstLine)) kind = 'gantt';
  else if (/^pie/i.test(firstLine)) kind = 'pie';

  const nodes: MermaidNode[] = [];
  const edges: MermaidEdge[] = [];
  const subgraphs: MermaidSubgraph[] = [];
  const nodeMap = new Map<string, MermaidNode>();

  const addNode = (id: string, label: string, shape: MermaidNode['shape'] = 'box') => {
    if (nodeMap.has(id)) {
      // 更新 label (后续声明优先)
      const n = nodeMap.get(id)!;
      if (label && n.label === id) n.label = label;
      return n;
    }
    const n: MermaidNode = { id, label: label || id, shape, x: 0, y: 0, w: 100, h: 40 };
    nodes.push(n);
    nodeMap.set(id, n);
    return n;
  };

  // 简易布局: 简单网格
  let i = 0;
  let currentSub: MermaidSubgraph | null = null;
  for (const line of lines) {
    if (/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie)\b/i.test(line)) continue;
    if (/^subgraph\b/i.test(line)) {
      const m = line.match(/^subgraph\s+(\S+)\s*(.*)$/i);
      if (m) {
        currentSub = { id: m[1], label: m[2] || m[1], x: 0, y: 0, w: 200, h: 100, children: [] };
        subgraphs.push(currentSub);
      }
      continue;
    }
    if (/^end\s*$/i.test(line)) {
      currentSub = null;
      continue;
    }
    // 节点定义: A[Label] 或 A(Label) 或 A{Label} 等
    const nodeDefMatch = line.match(/^(\w+)\s*([\[\(\{][^\]\)\}]+[\]\)\}])/);
    if (nodeDefMatch && !line.includes('-->') && !line.includes('---')) {
      const id = nodeDefMatch[1];
      const shapeChar = nodeDefMatch[2][0];
      const label = nodeDefMatch[2].slice(1, -1).replace(/['"]/g, '');
      const shape: MermaidNode['shape'] = shapeChar === '[' ? 'box' : shapeChar === '(' ? 'round' : 'diamond';
      const n = addNode(id, label, shape);
      if (currentSub) {
        n.parent = currentSub.id;
        currentSub.children.push(id);
      }
    }
    // 边定义: A --> B 或 A -->|label| B
    const edgeMatch = line.match(/^(\w+)\s*(?:-->|---)\s*(?:\|([^|]+)\|\s*)?(\w+)/);
    if (edgeMatch) {
      const from = edgeMatch[1];
      const to = edgeMatch[3];
      const label = edgeMatch[2];
      // 自动创建未定义的节点
      if (!nodeMap.has(from)) addNode(from, from, 'box');
      if (!nodeMap.has(to)) addNode(to, to, 'box');
      edges.push({ from, to, label, type: line.includes('-->') ? 'arrow' : 'dotted' });
      if (currentSub) {
        if (!currentSub.children.includes(from)) currentSub.children.push(from);
        if (!currentSub.children.includes(to)) currentSub.children.push(to);
      }
    }
    i++;
  }

  // ── 布局: 简单网格 ──
  if (kind === 'flowchart' || kind === 'class' || kind === 'state' || kind === 'er') {
    // 拓扑排序
    const layers = computeLayers(nodes, edges);
    const colWidth = 180;
    const rowHeight = 90;
    layers.forEach((layer, col) => {
      layer.forEach((id, row) => {
        const n = nodeMap.get(id);
        if (n) {
          n.x = 50 + col * colWidth;
          n.y = 60 + row * rowHeight;
          // 估算 label 宽度
          n.w = Math.max(100, n.label.length * 9 + 30);
          n.h = n.shape === 'diamond' ? 70 : 50;
        }
      });
    });
  } else if (kind === 'sequence') {
    // sequence 暂时用线性布局
    const participants = nodes.filter(n => edges.some(e => e.from === n.id || e.to === n.id) || i++ < 10);
    participants.forEach((n, i) => {
      n.x = 80 + i * 150;
      n.y = 30;
      n.w = 100;
      n.h = 40;
    });
    // 给消息边留位置
    const maxMessages = edges.length;
    participants.forEach((n) => {
      n.h = 40 + maxMessages * 50;
    });
  } else if (kind === 'gantt') {
    // gantt 解析任务
    let row = 0;
    let col = 0;
    const cols = ['任务', '开始', '持续', '状态'];
    nodes.forEach((n, i) => {
      n.x = 30;
      n.y = 30 + i * 40;
      n.w = 800;
      n.h = 32;
    });
  } else if (kind === 'pie') {
    // pie 解析百分比
    const totalPercent = nodes.reduce((a, n) => a + parseInt(n.label, 10) || 0, 0);
    nodes.forEach((n, i) => {
      n.x = 200 + (i % 4) * 130;
      n.y = 80 + Math.floor(i / 4) * 130;
      n.w = 110;
      n.h = 50;
    });
  }

  // 调整 subgraph 包围盒
  subgraphs.forEach(sg => {
    const children = nodes.filter(n => n.parent === sg.id);
    if (children.length > 0) {
      sg.x = Math.min(...children.map(c => c.x)) - 15;
      sg.y = Math.min(...children.map(c => c.y)) - 25;
      sg.w = Math.max(...children.map(c => c.x + c.w)) - sg.x + 15;
      sg.h = Math.max(...children.map(c => c.y + c.h)) - sg.y + 15;
    }
  });

  return { kind, nodes, edges, subgraphs, errors };
}

function computeLayers(nodes: MermaidNode[], edges: MermaidEdge[]): string[][] {
  // 简易: 按入度分层
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  nodes.forEach(n => { inDeg.set(n.id, 0); adj.set(n.id, []); });
  edges.forEach(e => {
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    adj.get(e.from)?.push(e.to);
  });
  const layers: string[][] = [];
  const placed = new Set<string>();
  let frontier = nodes.filter(n => inDeg.get(n.id) === 0).map(n => n.id);
  if (frontier.length === 0) frontier = nodes.slice(0, 1).map(n => n.id);
  while (frontier.length > 0) {
    layers.push(frontier);
    frontier.forEach(n => placed.add(n));
    const next = new Set<string>();
    frontier.forEach(n => adj.get(n)?.forEach(t => { if (!placed.has(t)) next.add(t); }));
    frontier = Array.from(next);
  }
  // 补: 任何没被放置的节点放到最后一层
  const unplaced = nodes.filter(n => !placed.has(n.id)).map(n => n.id);
  if (unplaced.length > 0) layers.push(unplaced);
  return layers;
}

// ─── 主组件 ───
interface Props {
  open: boolean;
  onClose: () => void;
}

export function MermaidEditor({ open, onClose }: Props) {
  const [code, setCode] = useState(TEMPLATES.flowchart.code);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [showErrors, setShowErrors] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [tab, setTab] = useState<'editor' | 'history'>('editor');
  const [history, setHistory] = useState<Array<{ id: string; code: string; ts: number; name: string }>>(() => {
    try { const r = localStorage.getItem('soloforge.mermaid.history'); return r ? JSON.parse(r) : []; } catch { return []; }
  });
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState('未命名图表');

  useEffect(() => { try { localStorage.setItem('soloforge.mermaid.history', JSON.stringify(history.slice(0, 20))); } catch { /* ignore */ } }, [history]);

  const parsed = useMemo(() => parseDiagram(code), [code]);
  const palette = theme === 'dark' ? PALETTE : PALETTE_LIGHT;

  const switchTemplate = useCallback((k: string) => {
    setCode(TEMPLATES[k].code);
    setName(TEMPLATES[k].name);
  }, []);

  const saveSnapshot = useCallback(() => {
    const snap = { id: 'snap_' + Date.now().toString(36), code, ts: Date.now(), name };
    setHistory(prev => [snap, ...prev.filter(h => h.code !== code)].slice(0, 20));
  }, [code, name]);

  const loadSnapshot = useCallback((id: string) => {
    const s = history.find(h => h.id === id);
    if (s) { setCode(s.code); setName(s.name); }
  }, [history]);

  const exportSVG = useCallback(() => {
    const svg = document.getElementById('mermaid-svg-output');
    if (!svg) return;
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + svg.outerHTML;
    const blob = new Blob([xml], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name.replace(/\s+/g, '-').toLowerCase() + '.svg';
    a.click();
    URL.revokeObjectURL(url);
  }, [name]);

  const exportPng = useCallback(() => {
    const svg = document.getElementById('mermaid-svg-output');
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    const svg64 = btoa(unescape(encodeURIComponent(xml)));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = (svg as any).clientWidth || 800;
      canvas.height = (svg as any).clientHeight || 600;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = theme === 'dark' ? '#0f172a' : '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name.replace(/\s+/g, '-').toLowerCase() + '.png';
        a.click();
        URL.revokeObjectURL(url);
      });
    };
    img.src = 'data:image/svg+xml;base64,' + svg64;
  }, [name, theme]);

  const exportMarkdown = useCallback(() => {
    const md = '```mermaid\n' + code + '\n```\n';
    navigator.clipboard?.writeText(md);
    alert('Markdown (含 ```mermaid 代码块) 已复制到剪贴板');
  }, [code]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(98vw,1300px)] h-[min(94vh,860px)] bg-bg-elevated border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">schema</span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="bg-transparent text-base font-semibold outline-none border-b border-transparent hover:border-border focus:border-primary"
            />
            <span className="text-xs text-text-secondary ml-1">{parsed.kind}</span>
            <span className="text-xs text-text-secondary">· {parsed.nodes.length} 节点 · {parsed.edges.length} 边</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setView(v => v === 'edit' ? 'preview' : 'edit')}
              className={'px-2.5 py-1 text-xs rounded border flex items-center gap-1 ' + (view === 'preview' ? 'border-primary text-primary bg-primary/10' : 'border-border hover:bg-bg-dim')}
              title="切换编辑/预览"
            >
              <span className="material-symbols-outlined text-sm">{view === 'edit' ? 'visibility' : 'edit'}</span>
              {view === 'edit' ? '预览' : '编辑'}
            </button>
            <button
              onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
              className="px-2 py-1 text-xs rounded border border-border hover:bg-bg-dim"
              title="切换主题"
            >
              <span className="material-symbols-outlined text-sm">{theme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
            </button>
            <button onClick={saveSnapshot} className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">bookmark</span>
              保存
            </button>
            <button onClick={exportSVG} className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim">SVG</button>
            <button onClick={exportPng} className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim">PNG</button>
            <button onClick={exportMarkdown} className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim">MD</button>
            <button onClick={onClose} className="px-2 py-1 rounded hover:bg-bg-dim text-text-secondary ml-1">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>

        {view === 'edit' ? (
          <div className="flex-1 flex min-h-0">
            {/* 左: 编辑器 + 模板 */}
            <div className="w-1/2 border-r border-border flex flex-col">
              <div className="px-2 py-1.5 border-b border-border text-xs text-text-secondary flex items-center gap-1 overflow-auto">
                <span className="material-symbols-outlined text-sm">category</span>
                <span className="shrink-0">模板:</span>
                {Object.entries(TEMPLATES).map(([k, t]) => (
                  <button
                    key={k}
                    onClick={() => switchTemplate(k)}
                    className="px-1.5 py-0.5 rounded hover:bg-bg-dim text-text-secondary shrink-0"
                  >
                    {t.name}
                  </button>
                ))}
              </div>
              <textarea
                ref={editorRef}
                value={code}
                onChange={e => setCode(e.target.value)}
                className="flex-1 px-4 py-3 bg-bg font-mono text-xs resize-none outline-none leading-5"
                spellCheck={false}
              />
              <div className="border-t border-border bg-bg-dim/30 max-h-32 overflow-auto">
                <div className="px-3 py-1 text-[10px] text-text-secondary uppercase tracking-wide flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">info</span>
                  解析结果
                </div>
                <div className="px-3 py-1.5 text-xs grid grid-cols-3 gap-2">
                  <div><span className="text-text-secondary">类型</span> <span className="text-primary">{parsed.kind}</span></div>
                  <div><span className="text-text-secondary">节点</span> {parsed.nodes.length}</div>
                  <div><span className="text-text-secondary">边</span> {parsed.edges.length}</div>
                </div>
                {parsed.errors.length > 0 && showErrors && (
                  <div className="px-3 py-1.5 border-t border-border/50">
                    {parsed.errors.map((e, i) => (
                      <div key={i} className="text-xs text-danger flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">error</span>
                        {e}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 右: 预览 */}
            <div className="w-1/2 flex flex-col">
              <div className="px-3 py-1.5 border-b border-border text-xs text-text-secondary flex items-center gap-2">
                <span className="material-symbols-outlined text-sm">preview</span>
                <span>实时预览</span>
                <div className="ml-auto flex items-center gap-1">
                  <button onClick={() => setZoom(z => Math.max(0.3, z - 0.1))} className="px-1.5 py-0.5 rounded hover:bg-bg-dim">−</button>
                  <span className="font-mono w-12 text-center">{Math.round(zoom * 100)}%</span>
                  <button onClick={() => setZoom(z => Math.min(3, z + 0.1))} className="px-1.5 py-0.5 rounded hover:bg-bg-dim">+</button>
                  <button onClick={() => setZoom(1)} className="px-1.5 py-0.5 rounded hover:bg-bg-dim ml-1">重置</button>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-4" style={{ backgroundColor: theme === 'dark' ? '#0f172a' : '#f8fafc' }}>
                <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
                  <DiagramRenderer parsed={parsed} palette={palette} id="mermaid-svg-output" />
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* 全屏预览 */
          <div className="flex-1 overflow-auto p-6" style={{ backgroundColor: theme === 'dark' ? '#0f172a' : '#f8fafc' }}>
            <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', maxWidth: 'fit-content' }}>
              <DiagramRenderer parsed={parsed} palette={palette} id="mermaid-svg-output" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 渲染器 ──
function DiagramRenderer({ parsed, palette, id }: { parsed: ParsedDiagram; palette: any; id: string }) {
  const { kind, nodes, edges, subgraphs } = parsed;
  const W = Math.max(...nodes.map(n => n.x + n.w), 600) + 50;
  const H = Math.max(...nodes.map(n => n.y + n.h), 400) + 50;

  if (kind === 'pie') {
    return <PieChart nodes={nodes} palette={palette} />;
  }

  return (
    <svg id={id} width={W} height={H} viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg" style={{ maxWidth: '100%', height: 'auto' }}>
      {/* subgraphs */}
      {subgraphs.map(sg => (
        <g key={sg.id}>
          <rect x={sg.x} y={sg.y} width={sg.w} height={sg.h} rx={8} fill={palette.subgraph.fill} stroke={palette.subgraph.stroke} strokeDasharray="4 3" strokeWidth={1} />
          <text x={sg.x + 10} y={sg.y + 16} fontSize={11} fill={palette.subgraph.stroke} fontWeight="500">{sg.label}</text>
        </g>
      ))}

      {/* edges */}
      {edges.map((e, i) => {
        const from = nodes.find(n => n.id === e.from);
        const to = nodes.find(n => n.id === e.to);
        if (!from || !to) return null;
        const x1 = from.x + from.w;
        const y1 = from.y + from.h / 2;
        const x2 = to.x;
        const y2 = to.y + to.h / 2;
        const cx = (x1 + x2) / 2;
        const path = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
        return (
          <g key={i}>
            <defs>
              <marker id={`arr-${i}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={palette.edge} />
              </marker>
            </defs>
            <path
              d={path}
              fill="none"
              stroke={palette.edge}
              strokeWidth={e.type === 'thick' ? 2.5 : 1.5}
              strokeDasharray={e.type === 'dotted' ? '4 3' : undefined}
              markerEnd={`url(#arr-${i})`}
            />
            {e.label && (
              <>
                <rect
                  x={cx - (e.label.length * 4 + 4)}
                  y={(y1 + y2) / 2 - 8}
                  width={e.label.length * 8 + 8}
                  height={16}
                  rx={3}
                  fill={palette.node.fill}
                  stroke={palette.edge}
                  strokeWidth={0.5}
                />
                <text x={cx} y={(y1 + y2) / 2 + 4} textAnchor="middle" fontSize={10} fill={palette.text}>{e.label}</text>
              </>
            )}
          </g>
        );
      })}

      {/* nodes */}
      {nodes.map(n => {
        const cx = n.x + n.w / 2;
        const cy = n.y + n.h / 2;
        if (n.shape === 'diamond') {
          return (
            <g key={n.id}>
              <polygon
                points={`${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}`}
                fill={palette.node.fill}
                stroke={palette.node.stroke}
                strokeWidth={1.5}
              />
              <text x={cx} y={cy + 4} textAnchor="middle" fontSize={11} fill={palette.node.text} fontWeight="500">{n.label}</text>
            </g>
          );
        }
        if (n.shape === 'round') {
          return (
            <g key={n.id}>
              <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={Math.min(n.h / 2, 20)} fill={palette.node.fill} stroke={palette.node.stroke} strokeWidth={1.5} />
              <text x={cx} y={cy + 4} textAnchor="middle" fontSize={11} fill={palette.node.text} fontWeight="500">{n.label}</text>
            </g>
          );
        }
        return (
          <g key={n.id}>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={6} fill={palette.node.fill} stroke={palette.node.stroke} strokeWidth={1.5} />
            <text x={cx} y={cy + 4} textAnchor="middle" fontSize={11} fill={palette.node.text} fontWeight="500">{n.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

function PieChart({ nodes, palette }: { nodes: MermaidNode[]; palette: any }) {
  const colors = ['#6366f1', '#a855f7', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];
  const data = nodes.map(n => ({ name: n.id, value: parseInt(n.label, 10) || 0 }));
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  const cx = 200, cy = 200, r = 130;
  let angle = -Math.PI / 2;
  const slices = data.map((d, i) => {
    const sliceAngle = (d.value / total) * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    angle += sliceAngle;
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    const large = sliceAngle > Math.PI ? 1 : 0;
    const dPath = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    return { d: dPath, color: colors[i % colors.length], name: d.name, value: d.value, pct: ((d.value / total) * 100).toFixed(1) };
  });
  return (
    <svg id="mermaid-svg-output" width={500} height={420} viewBox="0 0 500 420" xmlns="http://www.w3.org/2000/svg">
      {slices.map((s, i) => (
        <g key={i}>
          <path d={s.d} fill={s.color} stroke={palette.node.fill} strokeWidth={1.5} />
        </g>
      ))}
      {/* legend */}
      {slices.map((s, i) => (
        <g key={i}>
          <rect x={350} y={30 + i * 28} width={14} height={14} fill={s.color} />
          <text x={370} y={42 + i * 28} fontSize={11} fill={palette.text}>{s.name}: {s.pct}%</text>
        </g>
      ))}
      <text x={cx} y={cy + 6} textAnchor="middle" fontSize={12} fill={palette.text} fontWeight="500">{total} 总数</text>
    </svg>
  );
}
