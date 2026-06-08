// ─────────────────────────────────────────────────────────────────
// 分屏对比 / 多窗口视图
// - 支持 2/3/4 个面板
// - 每个面板可独立选择: 文件 / Git diff / 后端数据 / 终端 / 设置/统计
// - 内容区支持差异高亮 (line diff)
// - 可拖拽调整面板宽度
// - 持久化: 上次布局 / 选中文件
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { FileNode } from '../../types';
import { Tooltip, IconButton, Button } from '../ui/Button';
import { pushToast } from './Notifications';
import { openDetachedWindow } from './DetachedWindow';

export type PaneKind = 'file' | 'terminal' | 'stream' | 'court' | 'git' | 'kernel' | 'agents';

interface PaneConfig {
  id: string;
  kind: PaneKind;
  filePath?: string;
  /** 数据源(JSON 文本)  */
  data?: string;
  /** 自定义标题 */
  customTitle?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  tree: FileNode;
  contents: Record<string, string>;
  sessions?: any[];
  agents?: any[];
  events?: any[];
}

const KIND_META: Record<PaneKind, { label: string; icon: string; color: string }> = {
  file:     { label: '文件', icon: 'description', color: 'text-primary' },
  terminal: { label: '终端', icon: 'terminal',    color: 'text-success' },
  stream:   { label: '流送', icon: 'stream',      color: 'text-accent' },
  court:    { label: '法庭', icon: 'gavel',       color: 'text-warning' },
  git:      { label: 'Git', icon: 'commit',      color: 'text-success' },
  kernel:   { label: '内核', icon: 'memory',      color: 'text-primary' },
  agents:   { label: '智能体', icon: 'smart_toy', color: 'text-accent' },
};

const LAYOUT_KEY = 'soloforge.split.layout';
const DEFAULT_PANES: PaneConfig[] = [
  { id: 'p1', kind: 'file', filePath: '/src/index.ts' },
  { id: 'p2', kind: 'file', filePath: '/src/api-server.ts' },
];

function loadLayout(): { panes: PaneConfig[]; count: number } {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { panes: DEFAULT_PANES, count: 2 };
}
function saveLayout(v: { panes: PaneConfig[]; count: number }) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(v)); } catch { /* ignore */ }
}

export function SplitCompare({ open, onClose, tree, contents, sessions = [], agents = [], events = [] }: Props) {
  const initial = loadLayout();
  const [panes, setPanes] = useState<PaneConfig[]>(initial.panes);
  const [activePane, setActivePane] = useState<string | null>(panes[0]?.id ?? null);
  const [count, setCount] = useState(initial.count);
  const [filePickerFor, setFilePickerFor] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState('');
  const [diffMode, setDiffMode] = useState(true);

  useEffect(() => { saveLayout({ panes, count }); }, [panes, count]);

  // 重置 pane 数量
  useEffect(() => {
    setPanes(prev => {
      if (prev.length < count) {
        const need = count - prev.length;
        const add: PaneConfig[] = [];
        for (let i = 0; i < need; i++) {
          add.push({ id: 'p_' + Date.now().toString(36) + i, kind: 'file', filePath: '/src/index.ts' });
        }
        return [...prev, ...add];
      }
      return prev.slice(0, count);
    });
  }, [count]);

  // 扁平化文件
  const flatFiles = useMemo(() => {
    const out: { path: string; name: string; ext: string }[] = [];
    const walk = (n: FileNode) => {
      if (n.type === 'file') {
        out.push({ path: n.path, name: n.name, ext: n.name.split('.').pop() || '' });
      }
      n.children?.forEach(walk);
    };
    walk(tree);
    return out;
  }, [tree]);

  const filteredFiles = useMemo(() => {
    const q = fileQuery.trim().toLowerCase();
    if (!q) return flatFiles;
    return flatFiles.filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
  }, [flatFiles, fileQuery]);

  // 调整 pane 内容
  const setPane = useCallback((id: string, patch: Partial<PaneConfig>) => {
    setPanes(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }, []);

  // 拖拽调整宽度
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ paneIdx: number; startX: number; startWidths: number[] } | null>(null);
  const [widths, setWidths] = useState<number[]>([]);
  useEffect(() => {
    setWidths(prev => {
      if (prev.length === count) return prev;
      return Array.from({ length: count }, () => 100 / count);
    });
  }, [count]);
  const onSplitterDown = (idx: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    dragRef.current = { paneIdx: idx, startX: e.clientX, startWidths: [...widths] };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = (ev.clientX - dragRef.current.startX) / rect.width * 100;
      const left = dragRef.current.startWidths[dragRef.current.paneIdx];
      const right = dragRef.current.startWidths[dragRef.current.paneIdx + 1];
      const min = 12;
      const newL = Math.max(min, Math.min(100 - min, left + dx));
      const newR = right + (left - newL);
      if (newR < min) return;
      const next = [...dragRef.current.startWidths];
      next[dragRef.current.paneIdx] = newL;
      next[dragRef.current.paneIdx + 1] = newR;
      setWidths(next);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!open) return null;

  // 计算差异 (2 个文件 pane 之间的 line diff)
  const filePanes = panes.filter(p => p.kind === 'file' && p.filePath);
  let diffMatrix: Record<string, Set<number>> = {};
  if (diffMode && filePanes.length === 2) {
    const [a, b] = filePanes;
    const aLines = (contents[a.filePath!] || '').split('\n');
    const bLines = (contents[b.filePath!] || '').split('\n');
    // 简单行级 diff: 标注 a 中独有行, b 中独有行
    const bSet = new Set(bLines);
    const aSet = new Set(aLines);
    const onlyA = new Set<number>();
    const onlyB = new Set<number>();
    aLines.forEach((l, i) => { if (!bSet.has(l)) onlyA.add(i); });
    bLines.forEach((l, i) => { if (!aSet.has(l)) onlyB.add(i); });
    diffMatrix[a.id] = onlyA;
    diffMatrix[b.id] = onlyB;
  }

  return (
    <div
      className="fixed inset-0 z-[210] flex flex-col bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="flex-1 flex flex-col bg-bg m-3 rounded-xl border border-border shadow-2xl overflow-hidden animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* 顶栏 */}
        <div className="flex items-center gap-2 px-4 h-11 border-b border-border bg-surface shrink-0">
          <span className="material-symbols-outlined text-primary">splitscreen</span>
          <span className="text-sm font-display font-semibold text-text">分屏对比</span>
          <span className="text-[10px] text-text-secondary font-mono">
            · {count} 面板 · {panes.filter(p => p.kind === 'file').length} 文件
          </span>
          <div className="flex-1" />
          {/* pane 数量切换 */}
          <div className="flex items-center gap-0.5 p-0.5 rounded bg-bg-dim border border-border-light">
            {[1, 2, 3, 4].map(n => (
              <button
                key={n}
                onClick={() => setCount(n)}
                className={`w-6 h-6 text-[10px] rounded font-mono ${
                  count === n ? 'bg-primary text-on-primary' : 'text-text-secondary hover:text-text'
                }`}
                title={`${n} 面板`}
              >
                {n}
              </button>
            ))}
          </div>
          {filePanes.length === 2 && (
            <Tooltip content={diffMode ? '隐藏行级差异高亮' : '高亮两文件的差异行'}>
              <button
                onClick={() => setDiffMode(d => !d)}
                className={`flex items-center gap-1 px-2 h-7 text-[10px] rounded border ${
                  diffMode
                    ? 'bg-primary/15 text-primary border-primary/40'
                    : 'bg-bg-dim text-text-secondary border-border-light hover:text-text'
                }`}
              >
                <span className="material-symbols-outlined text-sm">difference</span>
                {diffMode ? '差异: 开' : '差异: 关'}
              </button>
            </Tooltip>
          )}
          <Button variant="ghost" size="sm" icon="restart_alt" onClick={() => {
            setPanes(DEFAULT_PANES);
            setCount(2);
            pushToast({ level: 'info', title: '已重置布局', duration: 1200 });
          }}>
            重置
          </Button>
          <Tooltip content="导出 (Markdown)">
            <IconButton icon="download" size="sm" onClick={() => {
              const md = panes.map(p => {
                const meta = KIND_META[p.kind];
                const title = p.customTitle || meta.label;
                if (p.kind === 'file' && p.filePath) {
                  return `## ${title} · ${p.filePath}\n\n\`\`\`\n${contents[p.filePath] || ''}\n\`\`\``;
                }
                return `## ${title}\n\n${p.data || '(no data)'}`;
              }).join('\n\n---\n\n');
              navigator.clipboard?.writeText(md);
              pushToast({ level: 'success', title: '已复制 Markdown', message: `${panes.length} 个面板`, duration: 1500 });
            }} />
          </Tooltip>
          <IconButton icon="close" size="sm" onClick={onClose} />
        </div>

        {/* 面板容器 */}
        <div ref={containerRef} className="flex-1 flex overflow-hidden p-2 gap-0">
          {panes.map((p, idx) => {
            const w = widths[idx] ?? (100 / count);
            const isActive = activePane === p.id;
            const meta = KIND_META[p.kind];
            return (
              <div key={p.id} className="flex items-stretch" style={{ width: `${w}%` }}>
                <div
                  className={`flex-1 flex flex-col rounded-lg overflow-hidden border transition-colors ${
                    isActive ? 'border-primary' : 'border-border'
                  } bg-surface`}
                  onClick={() => setActivePane(p.id)}
                >
                  {/* pane header */}
                  <div className="flex items-center gap-1.5 px-2 h-8 bg-surface-low border-b border-border-light shrink-0">
                    <span className={`material-symbols-outlined text-sm ${meta.color}`}>{meta.icon}</span>
                    <span className="text-[11px] font-semibold text-text">{meta.label}</span>
                    {p.kind === 'file' && p.filePath && (
                      <span className="text-[10px] text-text-secondary font-mono truncate flex-1" title={p.filePath}>
                        {p.filePath}
                      </span>
                    )}
                    {p.kind !== 'file' && <span className="text-[10px] text-text-secondary truncate flex-1">{p.customTitle || meta.label + ' 视图'}</span>}
                    {/* 切换文件/类型 */}
                    <select
                      value={p.kind}
                      onChange={(e) => {
                        const k = e.target.value as PaneKind;
                        if (k === 'file') {
                          setPane(p.id, { kind: k, filePath: p.filePath || '/src/index.ts' });
                        } else {
                          setPane(p.id, { kind: k, filePath: undefined, data: sampleData(k, { sessions, agents, events }) });
                        }
                      }}
                      className="text-[9px] h-5 bg-bg-dim text-text-secondary border border-border-light rounded px-1"
                    >
                      {Object.entries(KIND_META).map(([k, m]) => (
                        <option key={k} value={k}>{m.label}</option>
                      ))}
                    </select>
                    {p.kind === 'file' && (
                      <Tooltip content="选择文件">
                        <IconButton icon="folder_open" size="xs" onClick={(e) => { e.stopPropagation(); setFilePickerFor(p.id); setFileQuery(''); }} />
                      </Tooltip>
                    )}
                    <Tooltip content="复制内容">
                      <IconButton icon="content_copy" size="xs" onClick={(e) => {
                        e.stopPropagation();
                        const text = p.kind === 'file' && p.filePath ? (contents[p.filePath] || '') : (p.data || '');
                        navigator.clipboard?.writeText(text);
                        pushToast({ level: 'success', title: '已复制', duration: 1000 });
                      }} />
                    </Tooltip>
                    <Tooltip content="拖出为独立窗口">
                      <IconButton icon="open_in_new" size="xs" onClick={(e) => {
                        e.stopPropagation();
                        const id = 'p_' + Date.now().toString(36);
                        const win = openDetachedWindow({
                          id,
                          kind: p.kind === 'file' ? 'preview' : p.kind === 'terminal' ? 'terminal' : p.kind === 'stream' ? 'stream' : p.kind === 'court' ? 'court' : 'git',
                          title: p.customTitle || KIND_META[p.kind].label,
                          width: 720,
                          height: 540,
                        });
                        if (win) pushToast({ level: 'success', title: '已弹出窗口', duration: 1200 });
                      }} />
                    </Tooltip>
                  </div>
                  {/* pane body */}
                  <div className="flex-1 overflow-auto bg-bg-dim/20 text-[11px] font-mono">
                    <PaneBody pane={p} contents={contents} diffLines={diffMatrix[p.id]} />
                  </div>
                </div>
                {idx < panes.length - 1 && (
                  <div
                    onMouseDown={(e) => onSplitterDown(idx, e)}
                    className="w-2 cursor-col-resize flex items-center justify-center group"
                  >
                    <div className="w-px h-full bg-border group-hover:bg-primary transition-colors" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 底栏 */}
        <div className="flex items-center justify-between px-4 h-8 bg-surface-low border-t border-border text-[10px] text-text-secondary shrink-0">
          <div className="flex items-center gap-3">
            <span>支持文件 / 终端 / 流送 / 法庭 / Git / 内核 / 智能体 7 种面板</span>
            <span className="text-text-secondary/40">·</span>
            <span>拖拽分隔条调整宽度</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono">{panes.length} 面板 · 布局已持久化</span>
            <kbd className="px-1.5 py-0.5 rounded bg-bg-dim border border-border-light">ESC</kbd>
            <span>关闭</span>
          </div>
        </div>

        {/* 文件选择器 */}
        {filePickerFor && (
          <div
            className="absolute inset-0 z-[220] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in p-4"
            onClick={() => setFilePickerFor(null)}
          >
            <div
              className="w-[480px] max-w-[90vw] max-h-[70vh] bg-surface border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden animate-slide-in-up"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 px-3 h-10 border-b border-border">
                <span className="material-symbols-outlined text-primary text-sm">folder_open</span>
                <input
                  autoFocus
                  value={fileQuery}
                  onChange={e => setFileQuery(e.target.value)}
                  placeholder="选择文件..."
                  className="flex-1 bg-transparent outline-none text-sm text-text placeholder-text-secondary"
                />
                <span className="text-[10px] text-text-secondary font-mono">{filteredFiles.length}</span>
              </div>
              <div className="flex-1 overflow-y-auto scrollbar-thin py-1">
                {filteredFiles.slice(0, 200).map(f => (
                  <button
                    key={f.path}
                    onClick={() => {
                      setPane(filePickerFor, { filePath: f.path });
                      setFilePickerFor(null);
                    }}
                    className="w-full flex items-center gap-2 px-3 h-7 text-left hover:bg-surface-high transition-colors group"
                  >
                    <span className="material-symbols-outlined text-text-secondary text-xs">description</span>
                    <span className="text-[11px] text-text truncate flex-1">{f.name}</span>
                    <span className="text-[9px] text-text-secondary/70 font-mono truncate shrink-0 max-w-[200px]">{f.path}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PaneBody({ pane, contents, diffLines }: { pane: PaneConfig; contents: Record<string, string>; diffLines?: Set<number> }) {
  if (pane.kind === 'file' && pane.filePath) {
    const text = contents[pane.filePath] || `// 文件 ${pane.filePath} 不存在或为空\n// 这是 mock 内容用于演示\n\nimport { useState } from 'react';\n\nexport function example() {\n  return <div>Hello {pane.filePath}</div>;\n}`;
    const lines = text.split('\n');
    return (
      <div>
        {lines.map((l, i) => {
          const isDiff = diffLines?.has(i);
          return (
            <div
              key={i}
              className={`flex items-start gap-2 px-2 ${
                isDiff
                  ? 'bg-warning/15 border-l-2 border-warning pl-1.5'
                  : 'hover:bg-surface-high'
              }`}
            >
              <span className="text-text-secondary/50 text-[10px] tabular-nums w-8 text-right shrink-0 select-none">{i + 1}</span>
              <pre className="flex-1 text-text whitespace-pre-wrap break-all">{l || ' '}</pre>
            </div>
          );
        })}
      </div>
    );
  }
  if (pane.data) {
    return <pre className="p-2 text-text-secondary whitespace-pre-wrap break-all">{pane.data}</pre>;
  }
  return <div className="p-3 text-text-secondary/60">无数据</div>;
}

function sampleData(kind: PaneKind, ctx: { sessions: any[]; agents: any[]; events: any[] }): string {
  switch (kind) {
    case 'terminal':
      return `$ tail -f /var/log/soloforge.log\n[12:34:01] kernel: ready (v1.4.2)\n[12:34:02] scheduler: 8 tasks queued\n[12:34:05] governor: episode 142 reward=0.87\n[12:34:12] court: verdict "approved" 0.92\n[12:34:18] db: insert decision_001 0.3ms`;
    case 'stream':
      return ctx.events.length
        ? ctx.events.slice(0, 30).map(e => `[${new Date(e.timestamp || Date.now()).toLocaleTimeString()}] ${e.type}: ${(e.content || e.text || '').slice(0, 80)}`).join('\n')
        : '// 暂无事件';
    case 'court':
      return `法庭案件 (${ctx.sessions.length} 会话相关)\n- case_001: 决策评估 · verdict: approved · 0.92\n- case_002: 代码审查 · verdict: revised · 0.71\n- case_003: 工具调用 · verdict: approved · 0.95`;
    case 'git':
      return `Git 状态 (mock)\nM src/index.ts\nM src/api-server.ts\nA rust_core/src/scheduler.rs\n?? src/data/repositories/surreal-repositories.ts`;
    case 'kernel':
      return `内核状态\n- v1.4.2\n- uptime 2h 14m\n- tasks 8 pending\n- memory 312 episodes`;
    case 'agents':
      return ctx.agents.length
        ? ctx.agents.map(a => `${a.id || a.name || 'agent'}: ${a.role || a.type || '—'}  ${a.status || 'idle'}`).join('\n')
        : '5 active · 12 idle\nAIRuntime-1 · runtime · active\nGovernor-1 · train · active\nCourt-1 · judge · idle\nEngineer-1 · code · active\nPlanner-1 · plan · idle';
    default:
      return '';
  }
}
