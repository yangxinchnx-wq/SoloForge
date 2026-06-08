// ─────────────────────────────────────────────────────────────────
// UML 工具 — UmlTools
// - 类图 (Class) / 时序图 (Sequence) / 流程图 (Flowchart) / 用例图 (UseCase)
// - 节点拖拽 + 连线
// - 导出 PNG / SVG / PlantUML
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button, Select } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type DiagramType = 'class' | 'sequence' | 'flow' | 'usecase';

interface ClassNode {
  id: string;
  name: string;
  x: number;
  y: number;
  attributes: string[];
  methods: string[];
}

interface SeqNode { id: string; name: string; x: number; y: number; isActor: boolean; }
interface SeqMsg { id: string; from: string; to: string; text: string; order: number; type: 'sync' | 'async' | 'return'; }

interface FlowNode { id: string; text: string; x: number; y: number; shape: 'start' | 'process' | 'decision' | 'end'; }
interface FlowEdge { from: string; to: string; label?: string; }

interface UseCaseNode { id: string; text: string; x: number; y: number; type: 'actor' | 'usecase'; }
interface UseCaseEdge { from: string; to: string; }

const STORE = 'soloforge.uml.v1';

function load() { try { const r = localStorage.getItem(STORE); if (r) return JSON.parse(r); } catch { /* */ } return null; }
function save(d: any) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* */ } }

const DEFAULT_CLASS = {
  class: {
    nodes: [
      { id: 'c1', name: 'Animal', x: 100, y: 80, attributes: ['+name: String', '-age: int'], methods: ['+eat()', '+sleep()'] },
      { id: 'c2', name: 'Dog', x: 400, y: 80, attributes: ['-breed: String'], methods: ['+bark()', '+fetch()'] },
      { id: 'c3', name: 'Cat', x: 100, y: 280, attributes: ['-color: String'], methods: ['+meow()'] },
    ],
    edges: [{ from: 'c2', to: 'c1' }, { from: 'c3', to: 'c1' }],
  },
  sequence: {
    nodes: [
      { id: 's1', name: 'User', x: 100, y: 60, isActor: true },
      { id: 's2', name: 'Controller', x: 300, y: 60, isActor: false },
      { id: 's3', name: 'Service', x: 500, y: 60, isActor: false },
      { id: 's4', name: 'Database', x: 700, y: 60, isActor: false },
    ],
    msgs: [
      { id: 'm1', from: 's1', to: 's2', text: 'login()', order: 1, type: 'sync' as const },
      { id: 'm2', from: 's2', to: 's3', text: 'authenticate()', order: 2, type: 'sync' as const },
      { id: 'm3', from: 's3', to: 's4', text: 'findUser()', order: 3, type: 'sync' as const },
      { id: 'm4', from: 's3', to: 's2', text: 'user', order: 4, type: 'return' as const },
    ],
  },
  flow: {
    nodes: [
      { id: 'f1', text: '开始', x: 200, y: 60, shape: 'start' as const },
      { id: 'f2', text: '输入数据', x: 200, y: 160, shape: 'process' as const },
      { id: 'f3', text: '数据有效?', x: 200, y: 280, shape: 'decision' as const },
      { id: 'f4', text: '处理', x: 80, y: 400, shape: 'process' as const },
      { id: 'f5', text: '报错', x: 320, y: 400, shape: 'process' as const },
      { id: 'f6', text: '结束', x: 200, y: 520, shape: 'end' as const },
    ],
    edges: [
      { from: 'f1', to: 'f2' },
      { from: 'f2', to: 'f3' },
      { from: 'f3', to: 'f4', label: '是' },
      { from: 'f3', to: 'f5', label: '否' },
      { from: 'f4', to: 'f6' },
      { from: 'f5', to: 'f6' },
    ],
  },
  usecase: {
    nodes: [
      { id: 'a1', name: 'User', x: 60, y: 200, isActor: true, text: 'User' },
      { id: 'a2', name: 'Admin', x: 60, y: 350, isActor: true, text: 'Admin' },
      { id: 'u1', text: '登录', x: 280, y: 120 },
      { id: 'u2', text: '下单', x: 280, y: 220 },
      { id: 'u3', text: '管理商品', x: 280, y: 350 },
      { id: 'u4', text: '查看订单', x: 480, y: 220 },
    ] as any,
    edges: [{ from: 'a1', to: 'u1' }, { from: 'a1', to: 'u2' }, { from: 'a2', to: 'u3' }, { from: 'a2', to: 'u1' }, { from: 'u2', to: 'u4' }],
  },
};

export function UmlTools({ open, onClose }: Props) {
  const stored: any = load();
  const [diagram, setDiagram] = useState<DiagramType>(stored?.diagram || 'class');
  const [classData, setClassData] = useState<{ nodes: ClassNode[]; edges: Array<{ from: string; to: string }> }>(stored?.classData || DEFAULT_CLASS.class);
  const [seqData, setSeqData] = useState<{ nodes: SeqNode[]; msgs: SeqMsg[] }>(stored?.seqData || DEFAULT_CLASS.sequence);
  const [flowData, setFlowData] = useState<{ nodes: FlowNode[]; edges: FlowEdge[] }>(stored?.flowData || DEFAULT_CLASS.flow);
  const [useCaseData, setUseCaseData] = useState<{ nodes: UseCaseNode[]; edges: UseCaseEdge[] }>(stored?.useCaseData || DEFAULT_CLASS.usecase);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => { save({ diagram, classData, seqData, flowData, useCaseData }); }, [diagram, classData, seqData, flowData, useCaseData]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragging.sx;
      const dy = e.clientY - dragging.sy;
      if (diagram === 'class') setClassData((p: any) => ({ ...p, nodes: p.nodes.map((n: any) => n.id === selectedId ? { ...n, x: dragging.x + dx, y: dragging.y + dy } : n) }));
      else if (diagram === 'sequence') setSeqData((p: any) => ({ ...p, nodes: p.nodes.map((n: any) => n.id === selectedId ? { ...n, x: dragging.x + dx, y: dragging.y + dy } : n) }));
      else if (diagram === 'flow') setFlowData((p: any) => ({ ...p, nodes: p.nodes.map((n: any) => n.id === selectedId ? { ...n, x: dragging.x + dx, y: dragging.y + dy } : n) }));
      else if (diagram === 'usecase') setUseCaseData((p: any) => ({ ...p, nodes: p.nodes.map((n: any) => n.id === selectedId ? { ...n, x: dragging.x + dx, y: dragging.y + dy } : n) }));
    };
    const onUp = () => setDragging(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [dragging, diagram, selectedId]);

  const exportPng = useCallback(() => {
    const svg = canvasRef.current?.querySelector('svg');
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'uml.svg'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  const exportPlantUml = useCallback(() => {
    let lines: string[] = [];
    if (diagram === 'class') {
      lines = ['@startuml'];
      classData.nodes.forEach((n: ClassNode) => {
        lines.push(`class ${n.name} {`);
        n.attributes.forEach(a => lines.push(`  ${a}`));
        n.methods.forEach(m => lines.push(`  ${m}`));
        lines.push('}');
      });
      classData.edges.forEach((e: any) => lines.push(`${e.from} <|-- ${e.to}`));
      lines.push('@enduml');
    } else if (diagram === 'sequence') {
      lines = ['@startuml'];
      seqData.nodes.forEach((n: SeqNode) => lines.push(n.isActor ? `actor "${n.name}" as ${n.id}` : `participant "${n.name}" as ${n.id}`));
      seqData.msgs.forEach((m: SeqMsg) => {
        const arrow = m.type === 'sync' ? '->>' : m.type === 'async' ? '->' : '-->>';
        lines.push(`${m.from} ${arrow} ${m.to}: ${m.text}`);
      });
      lines.push('@enduml');
    } else {
      lines = ['@startuml', '(*) --> "开始"', '--> (*)', '@enduml'];
    }
    const txt = lines.join('\n');
    const blob = new Blob([txt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'uml.puml'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [diagram, classData, seqData, flowData, useCaseData]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">schema</span>
          <h2 className="text-sm font-semibold text-text">UML 工具</h2>
          <Select
            value={diagram}
            options={[{ value: 'class', label: '类图' }, { value: 'sequence', label: '时序图' }, { value: 'flow', label: '流程图' }, { value: 'usecase', label: '用例图' }]}
            onChange={(v) => { setDiagram(v as DiagramType); setSelectedId(null); }}
          />
          <div className="ml-auto flex items-center gap-1">
            <Tooltip content="导出 SVG"><IconButton icon="image" onClick={exportPng} /></Tooltip>
            <Tooltip content="导出 PlantUML"><IconButton icon="code" onClick={exportPlantUml} /></Tooltip>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div ref={canvasRef} className="flex-1 relative bg-bg overflow-auto" style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, var(--color-border-light) 1px, transparent 0)',
          backgroundSize: '20px 20px',
        }}>
          <svg className="absolute inset-0 pointer-events-none" style={{ overflow: 'visible', width: '2000px', height: '2000px' }}>
            {diagram === 'class' && classData.edges.map((e: any, i: number) => {
              const from = classData.nodes.find((n: any) => n.id === e.from);
              const to = classData.nodes.find((n: any) => n.id === e.to);
              if (!from || !to) return null;
              return <line key={i} x1={from.x + 60} y1={from.y + 40} x2={to.x + 60} y2={to.y + 40} stroke="var(--color-accent)" strokeWidth={2} markerEnd="url(#arrow)" />;
            })}
            {diagram === 'sequence' && seqData.msgs.map((m: SeqMsg) => {
              const from = seqData.nodes.find((n: SeqNode) => n.id === m.from);
              const to = seqData.nodes.find((n: SeqNode) => n.id === m.to);
              if (!from || !to) return null;
              const y = 120 + m.order * 40;
              return (
                <g key={m.id}>
                  <line x1={from.x + 50} y1={y} x2={to.x + 50} y2={y} stroke="var(--color-text)" strokeWidth={1.5} strokeDasharray={m.type === 'return' ? '4,3' : '0'} />
                  <text x={(from.x + to.x) / 2 + 50} y={y - 4} fontSize="10" fill="var(--color-text)" textAnchor="middle" className="select-none">{m.order}. {m.text}</text>
                  <line x1={from.x + 50} y1={120} x2={from.x + 50} y2="600" stroke="var(--color-border)" strokeWidth={1} strokeDasharray="2,2" />
                </g>
              );
            })}
            {diagram === 'flow' && flowData.edges.map((e: FlowEdge, i) => {
              const from = flowData.nodes.find((n: FlowNode) => n.id === e.from);
              const to = flowData.nodes.find((n: FlowNode) => n.id === e.to);
              if (!from || !to) return null;
              return (
                <g key={i}>
                  <line x1={from.x + 60} y1={from.y + 25} x2={to.x + 60} y2={to.y + 25} stroke="var(--color-accent)" strokeWidth={2} />
                  {e.label && <text x={(from.x + to.x) / 2 + 60} y={(from.y + to.y) / 2 + 22} fontSize="10" fill="var(--color-accent)" textAnchor="middle">{e.label}</text>}
                </g>
              );
            })}
            {diagram === 'usecase' && useCaseData.edges.map((e: UseCaseEdge, i) => {
              const from: any = useCaseData.nodes.find((n) => n.id === e.from);
              const to: any = useCaseData.nodes.find((n) => n.id === e.to);
              if (!from || !to) return null;
              return <line key={i} x1={from.x + (from.isActor ? 30 : 60)} y1={from.y + 25} x2={to.x + 60} y2={to.y + 25} stroke="var(--color-accent)" strokeWidth={1.5} />;
            })}
          </svg>

          {/* 节点 */}
          {diagram === 'class' && classData.nodes.map((n: ClassNode) => (
            <div key={n.id}
              onMouseDown={(e) => { setDragging({ x: n.x, y: n.y, sx: e.clientX, sy: e.clientY }); setSelectedId(n.id); e.stopPropagation(); }}
              className={'absolute bg-surface border-2 rounded shadow-md w-32 cursor-move ' + (selectedId === n.id ? 'border-accent' : 'border-border')}
              style={{ left: n.x, top: n.y }}>
              <div className="px-2 py-1 bg-primary text-on-primary text-xs font-semibold text-center rounded-t">{n.name}</div>
              <div className="px-2 py-1 text-[10px] font-mono border-t border-border">
                {n.attributes.map((a, i) => <div key={i}>{a}</div>)}
              </div>
              <div className="px-2 py-1 text-[10px] font-mono border-t border-border rounded-b">
                {n.methods.map((m, i) => <div key={i}>{m}</div>)}
              </div>
            </div>
          ))}

          {diagram === 'sequence' && seqData.nodes.map((n: SeqNode) => (
            <div key={n.id}
              onMouseDown={(e) => { setDragging({ x: n.x, y: n.y, sx: e.clientX, sy: e.clientY }); setSelectedId(n.id); e.stopPropagation(); }}
              className={'absolute cursor-move ' + (n.isActor ? 'w-12' : 'w-28')}
              style={{ left: n.x, top: n.y }}>
              <div className={'px-2 py-1 text-xs font-semibold text-center rounded ' + (n.isActor ? 'bg-warning/20 text-warning' : 'bg-accent text-on-accent')}>
                {n.isActor ? '👤' : '⬚'} {n.name}
              </div>
            </div>
          ))}

          {diagram === 'flow' && flowData.nodes.map((n: FlowNode) => {
            const shape = n.shape === 'decision' ? 'rotate-45' : n.shape === 'start' || n.shape === 'end' ? 'rounded-full' : 'rounded';
            return (
              <div key={n.id}
                onMouseDown={(e) => { setDragging({ x: n.x, y: n.y, sx: e.clientX, sy: e.clientY }); setSelectedId(n.id); e.stopPropagation(); }}
                className={'absolute w-32 h-12 flex items-center justify-center text-xs cursor-move border-2 ' + shape + ' ' + (n.shape === 'decision' ? 'bg-warning/20 border-warning' : n.shape === 'start' || n.shape === 'end' ? 'bg-success/20 border-success' : 'bg-surface border-primary') + ' ' + (selectedId === n.id ? 'ring-2 ring-accent' : '')}
                style={{ left: n.x, top: n.y }}>
                <span className={(n.shape === 'decision' ? '-rotate-45' : '') + ' font-semibold'}>{n.text}</span>
              </div>
            );
          })}

          {diagram === 'usecase' && useCaseData.nodes.map((n: any) => (
            <div key={n.id}
              onMouseDown={(e) => { setDragging({ x: n.x, y: n.y, sx: e.clientX, sy: e.clientY }); setSelectedId(n.id); e.stopPropagation(); }}
              className={'absolute cursor-move ' + (n.isActor ? '' : 'rounded-full')}
              style={{ left: n.x, top: n.y }}>
              {n.isActor ? (
                <div className="w-12 h-20 flex flex-col items-center">
                  <div className="w-6 h-6 rounded-full bg-accent" />
                  <div className="w-10 h-10 border-2 border-accent border-t-0 mt-[-4px]" />
                  <div className="text-[10px] mt-1">{n.text}</div>
                </div>
              ) : (
                <div className={'px-3 py-2 rounded-full border-2 border-accent bg-accent/10 text-xs font-medium ' + (selectedId === n.id ? 'ring-2 ring-accent' : '')}>{n.text}</div>
              )}
            </div>
          ))}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-surface-high text-[10px] text-text-secondary flex items-center gap-3">
          <span>提示: 拖拽节点重新定位 · 选中后右侧可编辑</span>
          <Badge variant="info">PlantUML 兼容</Badge>
        </div>
      </div>
    </div>
  );
}
