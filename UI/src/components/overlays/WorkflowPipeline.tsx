// ─────────────────────────────────────────────────────────────────
// AI 工作流 Pipeline — 可视化多 agent 链式调用
// - 节点: 输入 / 提示词模板 / LLM / 工具 / 条件分支 / 输出
// - 边: 数据流 (支持 transform 表达式)
// - 实时执行: 数据从上游节点流向下游,可视化动画
// - 4 个预置工作流: 摘要生成 / 翻译 + 校对 / 决策路由 / 数据清洗
// - 保存 / 加载 / 导入 / 导出 (JSON)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';

// ── 类型 ──
type NodeKind = 'input' | 'prompt' | 'llm' | 'tool' | 'condition' | 'output' | 'merge' | 'transform';

interface PipelineNode {
  id: string;
  kind: NodeKind;
  label: string;
  x: number;
  y: number;
  width: number;
  config: Record<string, any>;
  /** 执行时状态 */
  status: 'idle' | 'running' | 'done' | 'error' | 'skipped';
  /** 输出 (用于边传送) */
  output?: any;
  /** 错误信息 */
  error?: string;
  /** 耗时 ms */
  durationMs?: number;
}

interface PipelineEdge {
  id: string;
  from: string;
  to: string;
  /** 条件分支: 'true' / 'false' (只对 condition 节点有意义) */
  branch?: 'true' | 'false' | 'data';
  label?: string;
}

interface Pipeline {
  id: string;
  name: string;
  description: string;
  icon: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

// ── 节点样式 ──
const NODE_META: Record<NodeKind, { label: string; icon: string; color: string; bg: string }> = {
  input:     { label: '输入',  icon: 'input',         color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
  prompt:    { label: '模板',  icon: 'code',          color: '#a855f7', bg: 'rgba(168,85,247,0.12)' },
  llm:       { label: 'LLM',   icon: 'auto_awesome',  color: '#6366f1', bg: 'rgba(99,102,241,0.12)' },
  tool:      { label: '工具',  icon: 'build',         color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  condition: { label: '条件',  icon: 'call_split',    color: '#06b6d4', bg: 'rgba(6,182,212,0.12)' },
  output:    { label: '输出',  icon: 'output',        color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  merge:     { label: '合并',  icon: 'merge',         color: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
  transform: { label: '转换',  icon: 'transform',     color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
};

// ── 预置工作流 ──
const SUMMARIZE_PIPELINE: Pipeline = {
  id: 'summarize', name: '文档摘要', icon: 'summarize', description: '输入长文 → 摘要 → 关键词提取 → 输出',
  nodes: [
    { id: 'in',  kind: 'input',     label: '用户输入',     x: 60,  y: 180, width: 160, config: { placeholder: '粘贴文章...' }, status: 'idle' },
    { id: 'p1',  kind: 'prompt',    label: '摘要 Prompt', x: 260, y: 180, width: 160, config: { template: '用一句话总结:\n\n{{in}}' }, status: 'idle' },
    { id: 'l1',  kind: 'llm',       label: 'GPT-4o',       x: 460, y: 120, width: 160, config: { model: 'gpt-4o', temperature: 0.3 }, status: 'idle' },
    { id: 'p2',  kind: 'prompt',    label: '关键词 Prompt', x: 460, y: 240, width: 160, config: { template: '提取 5 个关键词:\n\n{{in}}' }, status: 'idle' },
    { id: 'l2',  kind: 'llm',       label: 'Claude Haiku', x: 660, y: 240, width: 160, config: { model: 'haiku', temperature: 0.2 }, status: 'idle' },
    { id: 'm1',  kind: 'merge',     label: '合并结果',     x: 860, y: 180, width: 160, config: { format: 'markdown' }, status: 'idle' },
    { id: 'out', kind: 'output',    label: '最终输出',     x: 1060, y: 180, width: 160, config: {}, status: 'idle' },
  ],
  edges: [
    { id: 'e1', from: 'in',  to: 'p1' },
    { id: 'e2', from: 'p1',  to: 'l1' },
    { id: 'e3', from: 'in',  to: 'p2' },
    { id: 'e4', from: 'p2',  to: 'l2' },
    { id: 'e5', from: 'l1',  to: 'm1' },
    { id: 'e6', from: 'l2',  to: 'm1' },
    { id: 'e7', from: 'm1',  to: 'out' },
  ],
};

const TRANSLATE_PIPELINE: Pipeline = {
  id: 'translate', name: '翻译 + 校对', icon: 'translate', description: '多语言翻译 + 质量评估 + 重译回路',
  nodes: [
    { id: 'in',  kind: 'input',     label: '原文',          x: 60,  y: 200, width: 160, config: {}, status: 'idle' },
    { id: 'p1',  kind: 'prompt',    label: '翻译指令',      x: 260, y: 200, width: 160, config: { template: '将以下翻译为 {{lang}}:\n{{in}}' }, status: 'idle' },
    { id: 'l1',  kind: 'llm',       label: 'DeepL 风格',    x: 460, y: 200, width: 160, config: { model: 'sonnet' }, status: 'idle' },
    { id: 't1',  kind: 'tool',      label: '语法检查',      x: 660, y: 100, width: 160, config: { tool: 'grammar-check' }, status: 'idle' },
    { id: 'c1',  kind: 'condition', label: '质量达标?',     x: 860, y: 200, width: 160, config: { threshold: 0.7 }, status: 'idle' },
    { id: 'l2',  kind: 'llm',       label: '重译',          x: 1060, y: 100, width: 160, config: { model: 'opus' }, status: 'idle' },
    { id: 'out', kind: 'output',    label: '译文',          x: 1060, y: 300, width: 160, config: {}, status: 'idle' },
  ],
  edges: [
    { id: 'e1', from: 'in',  to: 'p1' },
    { id: 'e2', from: 'p1',  to: 'l1' },
    { id: 'e3', from: 'l1',  to: 't1' },
    { id: 'e4', from: 'l1',  to: 'c1' },
    { id: 'e5', from: 't1',  to: 'c1' },
    { id: 'e6', from: 'c1',  to: 'l2', branch: 'false', label: '否' },
    { id: 'e7', from: 'l2',  to: 'p1' },
    { id: 'e8', from: 'c1',  to: 'out', branch: 'true', label: '是' },
  ],
};

const ROUTE_PIPELINE: Pipeline = {
  id: 'route', name: 'AI 决策路由', icon: 'fork_right', description: '多 LLM 投票 → 仲裁 → 单一决策',
  nodes: [
    { id: 'in',  kind: 'input',     label: '请求',         x: 60,  y: 200, width: 160, config: {}, status: 'idle' },
    { id: 'p1',  kind: 'prompt',    label: '问题模板',     x: 260, y: 200, width: 160, config: {}, status: 'idle' },
    { id: 'l1',  kind: 'llm',       label: 'GPT-4o',       x: 460, y: 80,  width: 140, config: { model: 'gpt-4o' }, status: 'idle' },
    { id: 'l2',  kind: 'llm',       label: 'Claude Opus',  x: 460, y: 200, width: 140, config: { model: 'opus' }, status: 'idle' },
    { id: 'l3',  kind: 'llm',       label: 'DeepSeek',     x: 460, y: 320, width: 140, config: { model: 'deepseek' }, status: 'idle' },
    { id: 'm1',  kind: 'merge',     label: '投票合并',     x: 660, y: 200, width: 160, config: { strategy: 'majority' }, status: 'idle' },
    { id: 'c1',  kind: 'condition', label: '置信度 ≥ 0.7?', x: 860, y: 200, width: 160, config: { threshold: 0.7 }, status: 'idle' },
    { id: 'l4',  kind: 'llm',       label: '仲裁 LLM',     x: 1060, y: 100, width: 140, config: { model: 'opus' }, status: 'idle' },
    { id: 'out', kind: 'output',    label: '最终决策',     x: 1260, y: 200, width: 160, config: {}, status: 'idle' },
  ],
  edges: [
    { id: 'e1', from: 'in',  to: 'p1' },
    { id: 'e2', from: 'p1',  to: 'l1' },
    { id: 'e3', from: 'p1',  to: 'l2' },
    { id: 'e4', from: 'p1',  to: 'l3' },
    { id: 'e5', from: 'l1',  to: 'm1' },
    { id: 'e6', from: 'l2',  to: 'm1' },
    { id: 'e7', from: 'l3',  to: 'm1' },
    { id: 'e8', from: 'm1',  to: 'c1' },
    { id: 'e9', from: 'c1',  to: 'out', branch: 'true' },
    { id: 'e10', from: 'c1', to: 'l4', branch: 'false' },
    { id: 'e11', from: 'l4', to: 'out' },
  ],
};

const CLEAN_PIPELINE: Pipeline = {
  id: 'clean', name: '数据清洗', icon: 'cleaning_services', description: '解析 → 校验 → 转换 → 写入',
  nodes: [
    { id: 'in',   kind: 'input',     label: '原始数据',  x: 60,  y: 200, width: 160, config: { format: 'csv' }, status: 'idle' },
    { id: 't1',   kind: 'transform', label: '字段映射',  x: 260, y: 200, width: 160, config: { map: 'auto' }, status: 'idle' },
    { id: 'c1',   kind: 'condition', label: '必填齐全?', x: 460, y: 200, width: 160, config: {}, status: 'idle' },
    { id: 't2',   kind: 'transform', label: '脱敏',      x: 660, y: 100, width: 160, config: { mask: ['phone', 'email'] }, status: 'idle' },
    { id: 'out',  kind: 'output',    label: '数据库',    x: 860, y: 100, width: 160, config: { table: 'users' }, status: 'idle' },
    { id: 'skip', kind: 'output',    label: '错误日志',  x: 660, y: 300, width: 160, config: {}, status: 'idle' },
  ],
  edges: [
    { id: 'e1', from: 'in',  to: 't1' },
    { id: 'e2', from: 't1',  to: 'c1' },
    { id: 'e3', from: 'c1',  to: 't2',  branch: 'true' },
    { id: 'e4', from: 't2',  to: 'out' },
    { id: 'e5', from: 'c1',  to: 'skip', branch: 'false' },
  ],
};

const PIPELINES: Pipeline[] = [SUMMARIZE_PIPELINE, TRANSLATE_PIPELINE, ROUTE_PIPELINE, CLEAN_PIPELINE];

const STORAGE_KEY = 'soloforge.pipelines.v1';

// ── 模拟执行 ──
async function runPipelineSim(
  pipeline: Pipeline,
  input: string,
  onNodeUpdate: (id: string, update: Partial<PipelineNode>) => void,
  onEdgePass: (id: string) => void,
  speedMul: number = 1
): Promise<void> {
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms / speedMul));
  const executed = new Set<string>();
  const queue: string[] = ['in'];

  // 设置 input 内容
  onNodeUpdate('in', { output: input, status: 'done', durationMs: 0 });
  await delay(100);

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (executed.has(id)) continue;
    const node = pipeline.nodes.find(n => n.id === id);
    if (!node) continue;

    onNodeUpdate(id, { status: 'running' });
    await delay(300 + Math.random() * 400);

    // 模拟输出
    let output: any;
    let error: string | undefined;
    const dur = Math.floor(200 + Math.random() * 800);

    if (node.kind === 'input') {
      output = input;
    } else if (node.kind === 'prompt') {
      output = (node.config.template || '').replace(/\{\{in\}\}/g, String(input)).replace(/\{\{lang\}\}/g, '中文');
    } else if (node.kind === 'llm') {
      output = `[${node.config.model || 'AI'} 响应] 已生成 ${20 + Math.floor(Math.random() * 100)} 字符的内容`;
    } else if (node.kind === 'tool') {
      output = `[tool:${node.config.tool}] 验证通过`;
    } else if (node.kind === 'transform') {
      output = `[transform] 处理后数据 ${Math.floor(Math.random() * 100)} 条`;
    } else if (node.kind === 'merge') {
      output = `[merge:${node.config.format || 'json'}] 已合并多路结果`;
    } else if (node.kind === 'condition') {
      // 模拟: 大部分通过 true 分支
      const pass = Math.random() < 0.7;
      output = { branch: pass ? 'true' : 'false', value: Math.random() };
    } else if (node.kind === 'output') {
      output = `最终结果 (${dur}ms)`;
    }

    onNodeUpdate(id, { output, status: 'done', durationMs: dur, error });
    executed.add(id);

    // 沿边传递
    const nextEdges = pipeline.edges.filter(e => e.from === id);
    for (const e of nextEdges) {
      onEdgePass(e.id);
      await delay(50);
      // condition 节点: 根据 branch 选择下一节点
      if (node.kind === 'condition' && e.branch) {
        const branchValue = output?.branch || 'true';
        if (e.branch !== branchValue && e.branch !== 'data') continue;
      }
      if (!executed.has(e.to)) queue.push(e.to);
    }
  }
}

// ─── 主组件 ───
interface Props {
  open: boolean;
  onClose: () => void;
}

export function WorkflowPipeline({ open, onClose }: Props) {
  const [pipelines, setPipelines] = useState<Pipeline[]>(PIPELINES);
  const [currentId, setCurrentId] = useState<string>(PIPELINES[0].id);
  const [nodes, setNodes] = useState<Record<string, PipelineNode>>(() => objMap(PIPELINES[0].nodes, n => n));
  const [edges, setEdges] = useState<PipelineEdge[]>(PIPELINES[0].edges);
  const [executing, setExecuting] = useState(false);
  const [activeEdgeIds, setActiveEdgeIds] = useState<Set<string>>(new Set());
  const [input, setInput] = useState('SoloForge 是一个 AI 多智能体自治系统,集成了嵌入式数据库、Rust 调度器和 Python 强化学习引擎。本文详细介绍其架构设计与实现原理。');
  const [speed, setSpeed] = useState(1);
  const [showPalette, setShowPalette] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [execLog, setExecLog] = useState<Array<{ ts: number; nodeId: string; kind: NodeKind; status: string; text: string }>>([]);

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pipelines)); } catch { /* ignore */ } }, [pipelines]);

  // 切换 pipeline 时重置
  useEffect(() => {
    const p = pipelines.find(x => x.id === currentId);
    if (!p) return;
    setNodes(objMap(p.nodes, n => ({ ...n, status: 'idle' })));
    setEdges(p.edges);
    setActiveEdgeIds(new Set());
    setExecLog([]);
    setSelectedNodeId(null);
  }, [currentId, pipelines]);

  const onNodeUpdate = useCallback((id: string, update: Partial<PipelineNode>) => {
    setNodes(prev => ({ ...prev, [id]: { ...prev[id], ...update } }));
    if (update.status) {
      setExecLog(prev => [{ ts: Date.now(), nodeId: id, kind: prev.find(n => n.nodeId === id)?.kind || 'input', status: update.status!, text: update.output || update.error || '' }, ...prev].slice(0, 100));
    }
  }, []);

  const onEdgePass = useCallback((id: string) => {
    setActiveEdgeIds(prev => new Set([...prev, id]));
    setTimeout(() => {
      setActiveEdgeIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 600);
  }, []);

  const runPipeline = useCallback(async () => {
    if (executing) return;
    const p = pipelines.find(x => x.id === currentId);
    if (!p) return;
    setExecuting(true);
    setNodes(objMap(p.nodes, n => ({ ...n, status: 'idle' })));
    setActiveEdgeIds(new Set());
    setExecLog([]);
    try {
      await runPipelineSim(p, input, onNodeUpdate, onEdgePass, speed);
    } finally {
      setExecuting(false);
    }
  }, [executing, currentId, pipelines, input, speed, onNodeUpdate, onEdgePass]);

  const reset = useCallback(() => {
    const p = pipelines.find(x => x.id === currentId);
    if (!p) return;
    setNodes(objMap(p.nodes, n => ({ ...n, status: 'idle', output: undefined, error: undefined, durationMs: undefined })));
    setActiveEdgeIds(new Set());
    setExecLog([]);
  }, [currentId, pipelines]);

  const exportJson = useCallback(() => {
    const p = pipelines.find(x => x.id === currentId);
    if (!p) return;
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pipeline-' + p.id + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [pipelines, currentId]);

  const currentPipeline = pipelines.find(x => x.id === currentId);
  const selectedNode = selectedNodeId ? nodes[selectedNodeId] : null;
  const stats = useMemo(() => {
    const ns = Object.values(nodes);
    return {
      total: ns.length,
      done: ns.filter(n => n.status === 'done').length,
      running: ns.filter(n => n.status === 'running').length,
      errored: ns.filter(n => n.status === 'error').length,
      totalMs: ns.reduce((a, n) => a + (n.durationMs || 0), 0),
    };
  }, [nodes]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(98vw,1380px)] h-[min(94vh,860px)] bg-bg-elevated border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">account_tree</span>
            <h2 className="text-base font-semibold">AI 工作流 Pipeline</h2>
            <span className="text-xs text-text-secondary ml-2">
              {stats.done}/{stats.total} 完成 · 累计 {stats.totalMs}ms
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <select
              value={currentId}
              onChange={e => setCurrentId(e.target.value)}
              className="px-2 py-1 text-xs rounded border border-border bg-bg"
            >
              {pipelines.map(p => (
                <option key={p.id} value={p.id}>{p.icon} {p.name}</option>
              ))}
            </select>
            <select
              value={speed}
              onChange={e => setSpeed(parseFloat(e.target.value))}
              className="px-2 py-1 text-xs rounded border border-border bg-bg"
            >
              <option value="0.5">0.5×</option>
              <option value="1">1×</option>
              <option value="2">2×</option>
              <option value="4">4×</option>
            </select>
            <button
              onClick={runPipeline}
              disabled={executing}
              className="px-2.5 py-1 text-xs rounded bg-primary text-bg disabled:opacity-50 flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-sm">{executing ? 'progress_activity' : 'play_arrow'}</span>
              {executing ? '运行中' : '运行'}
            </button>
            <button onClick={reset} className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">refresh</span>
              重置
            </button>
            <button
              onClick={() => setShowJson(v => !v)}
              className={'px-2.5 py-1 text-xs rounded border ' + (showJson ? 'border-primary text-primary bg-primary/10' : 'border-border hover:bg-bg-dim')}
            >
              <span className="material-symbols-outlined text-sm align-middle mr-0.5">data_object</span>
              JSON
            </button>
            <button onClick={exportJson} className="px-2.5 py-1 text-xs rounded border border-border hover:bg-bg-dim" title="导出 JSON">
              <span className="material-symbols-outlined text-sm">download</span>
            </button>
            <button onClick={onClose} className="px-2 py-1 rounded hover:bg-bg-dim text-text-secondary ml-1">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* 节点调色板 */}
          {showPalette && (
            <div className="w-44 border-r border-border p-2 shrink-0 overflow-auto">
              <div className="text-xs text-text-secondary uppercase mb-1.5">节点类型</div>
              {Object.entries(NODE_META).map(([k, m]) => (
                <div
                  key={k}
                  className="px-2 py-1.5 rounded border border-border mb-1 flex items-center gap-1.5 cursor-grab"
                  style={{ backgroundColor: m.bg, borderColor: m.color + '40' }}
                >
                  <span className="material-symbols-outlined text-sm" style={{ color: m.color }}>{m.icon}</span>
                  <span className="text-xs font-medium">{m.label}</span>
                </div>
              ))}
              <div className="text-[10px] text-text-secondary mt-2 leading-relaxed">
                拖入画布添加节点<br />
                拖动节点调整位置<br />
                点击节点查看配置
              </div>
            </div>
          )}

          {/* 画布 */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* 输入条 */}
            <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
              <span className="text-xs text-text-secondary whitespace-nowrap">输入:</span>
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="用户输入..."
                className="flex-1 px-2 py-1 rounded border border-border bg-bg text-sm"
              />
              <button
                onClick={() => setShowPalette(v => !v)}
                className="px-2 py-1 text-xs rounded border border-border hover:bg-bg-dim"
                title="切换调色板"
              >
                <span className="material-symbols-outlined text-sm">{showPalette ? 'chevron_left' : 'extension'}</span>
              </button>
            </div>

            {/* 画布 */}
            <div className="flex-1 overflow-auto relative bg-bg-dim/30">
              {currentPipeline && (
                <PipelineCanvas
                  nodes={Object.values(nodes)}
                  edges={edges}
                  activeEdgeIds={activeEdgeIds}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={setSelectedNodeId}
                />
              )}
            </div>

            {/* 执行日志 */}
            {execLog.length > 0 && (
              <div className="border-t border-border max-h-32 overflow-auto shrink-0">
                <div className="px-3 py-1 text-[10px] text-text-secondary uppercase tracking-wide bg-bg-dim/30 sticky top-0">执行日志</div>
                {execLog.slice(0, 30).map((l, i) => {
                  const meta = NODE_META[l.kind];
                  return (
                    <div key={i} className="px-3 py-1 text-xs font-mono border-b border-border/30 flex items-center gap-2">
                      <span className="text-text-secondary text-[10px]">{new Date(l.ts).toLocaleTimeString('zh-CN')}</span>
                      <span className="material-symbols-outlined text-sm" style={{ color: meta.color }}>{meta.icon}</span>
                      <span className="font-medium">{l.nodeId}</span>
                      <span className={
                        l.status === 'done' ? 'text-success' :
                        l.status === 'error' ? 'text-danger' :
                        l.status === 'running' ? 'text-warning' : 'text-text-secondary'
                      }>{l.status}</span>
                      <span className="text-text-secondary truncate flex-1">{l.text}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 右侧: 节点详情 */}
          {selectedNode && !showJson && (
            <div className="w-72 border-l border-border flex flex-col shrink-0">
              <div className="px-3 py-2 border-b border-border flex items-center gap-2">
                <span className="material-symbols-outlined text-sm" style={{ color: NODE_META[selectedNode.kind].color }}>{NODE_META[selectedNode.kind].icon}</span>
                <h3 className="text-sm font-semibold">{selectedNode.label}</h3>
                <span className="text-xs px-1.5 rounded ml-auto" style={{ backgroundColor: NODE_META[selectedNode.kind].bg, color: NODE_META[selectedNode.kind].color }}>{NODE_META[selectedNode.kind].label}</span>
              </div>
              <div className="flex-1 overflow-auto p-3 text-xs space-y-2">
                <div>
                  <div className="text-text-secondary mb-0.5">状态</div>
                  <div className={
                    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ' +
                    (selectedNode.status === 'done' ? 'bg-success/15 text-success' :
                     selectedNode.status === 'error' ? 'bg-danger/15 text-danger' :
                     selectedNode.status === 'running' ? 'bg-warning/15 text-warning' :
                     'bg-bg-dim text-text-secondary')
                  }>
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'currentColor' }} />
                    {selectedNode.status}
                    {selectedNode.durationMs !== undefined && <span className="text-text-secondary ml-1">· {selectedNode.durationMs}ms</span>}
                  </div>
                </div>
                <div>
                  <div className="text-text-secondary mb-0.5">配置</div>
                  <pre className="px-2 py-1.5 rounded bg-bg-dim font-mono text-[10px] whitespace-pre-wrap break-all">
                    {JSON.stringify(selectedNode.config, null, 2)}
                  </pre>
                </div>
                {selectedNode.output !== undefined && (
                  <div>
                    <div className="text-text-secondary mb-0.5">输出</div>
                    <pre className="px-2 py-1.5 rounded bg-primary/10 text-primary font-mono text-[10px] whitespace-pre-wrap break-all">
                      {typeof selectedNode.output === 'object' ? JSON.stringify(selectedNode.output, null, 2) : String(selectedNode.output)}
                    </pre>
                  </div>
                )}
                {selectedNode.error && (
                  <div>
                    <div className="text-danger mb-0.5">错误</div>
                    <div className="px-2 py-1.5 rounded bg-danger/10 text-danger text-[10px]">{selectedNode.error}</div>
                  </div>
                )}
                <div>
                  <div className="text-text-secondary mb-0.5">位置</div>
                  <div className="text-text-secondary/70 text-[10px]">x: {Math.round(selectedNode.x)}, y: {Math.round(selectedNode.y)}</div>
                </div>
              </div>
            </div>
          )}

          {/* JSON 视图 */}
          {showJson && (
            <div className="w-96 border-l border-border flex flex-col shrink-0">
              <div className="px-3 py-2 border-b border-border text-xs text-text-secondary">JSON Schema</div>
              <pre className="flex-1 overflow-auto p-3 text-[10px] font-mono whitespace-pre-wrap break-all text-text-secondary">
                {JSON.stringify(currentPipeline, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 画布组件 ──
function PipelineCanvas({ nodes, edges, activeEdgeIds, selectedNodeId, onSelectNode }: {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  activeEdgeIds: Set<string>;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  // 计算包围盒
  const bounds = useMemo(() => {
    const maxX = Math.max(...nodes.map(n => n.x + n.width), 1300);
    const maxY = Math.max(...nodes.map(n => n.y + 100), 400);
    return { width: maxX + 50, height: maxY + 50 };
  }, [nodes]);

  const getNode = (id: string) => nodes.find(n => n.id === id);

  return (
    <div className="relative" style={{ width: bounds.width, height: bounds.height, minWidth: '100%' }}>
      {/* 边 */}
      <svg className="absolute inset-0 pointer-events-none" width={bounds.width} height={bounds.height}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {edges.map(e => {
          const from = getNode(e.from);
          const to = getNode(e.to);
          if (!from || !to) return null;
          const x1 = from.x + from.width;
          const y1 = from.y + 30;
          const x2 = to.x;
          const y2 = to.y + 30;
          const cx = (x1 + x2) / 2;
          const path = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
          const isActive = activeEdgeIds.has(e.id);
          const isTrue = e.branch === 'true';
          const isFalse = e.branch === 'false';
          return (
            <g key={e.id} className={isActive ? 'text-primary' : 'text-text-secondary'}>
              <path
                d={path}
                fill="none"
                stroke="currentColor"
                strokeWidth={isActive ? 3 : 1.5}
                strokeDasharray={isActive ? '0' : '4 4'}
                opacity={isActive ? 1 : 0.4}
                markerEnd="url(#arrow)"
              />
              {e.label && (
                <text
                  x={cx}
                  y={(y1 + y2) / 2 - 4}
                  textAnchor="middle"
                  className="text-[10px]"
                  fill="currentColor"
                  style={{ fontSize: 10 }}
                >
                  {e.label}
                </text>
              )}
              {(isTrue || isFalse) && (
                <circle cx={cx} cy={(y1 + y2) / 2} r={3} fill={isTrue ? '#10b981' : '#ef4444'} />
              )}
            </g>
          );
        })}
      </svg>

      {/* 节点 */}
      {nodes.map(n => {
        const meta = NODE_META[n.kind];
        const isSelected = selectedNodeId === n.id;
        const isRunning = n.status === 'running';
        return (
          <div
            key={n.id}
            onClick={() => onSelectNode(n.id)}
            className={
              'absolute rounded-lg border-2 cursor-pointer transition-all ' +
              (isSelected ? 'ring-2 ring-primary ring-offset-2 ring-offset-bg' : '') +
              (isRunning ? 'animate-pulse' : '')
            }
            style={{
              left: n.x, top: n.y, width: n.width,
              backgroundColor: meta.bg,
              borderColor: isSelected ? meta.color : (isRunning ? meta.color : meta.color + '60'),
            }}
          >
            <div className="px-2 py-1.5 flex items-center gap-1.5 border-b" style={{ borderColor: meta.color + '30' }}>
              <span className="material-symbols-outlined text-sm" style={{ color: meta.color }}>{meta.icon}</span>
              <span className="text-xs font-medium truncate flex-1">{n.label}</span>
              <span className="text-[10px] text-text-secondary">{meta.label}</span>
            </div>
            <div className="px-2 py-1.5 text-[10px] font-mono text-text-secondary truncate">
              {n.kind === 'llm' && n.config.model}
              {n.kind === 'prompt' && n.config.template?.slice(0, 30) + '...'}
              {n.kind === 'tool' && n.config.tool}
              {n.kind === 'input' && n.config.placeholder}
              {n.kind === 'condition' && 'if value ≥ ' + n.config.threshold}
              {n.kind === 'transform' && Object.keys(n.config).join(', ')}
              {n.kind === 'merge' && n.config.format}
              {n.kind === 'output' && '→ sink'}
            </div>
            {n.status === 'done' && (
              <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-success text-white flex items-center justify-center text-[10px]">
                <span className="material-symbols-outlined text-[10px]">check</span>
              </div>
            )}
            {n.status === 'running' && (
              <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-warning text-bg flex items-center justify-center">
                <span className="material-symbols-outlined text-[10px] animate-spin">progress_activity</span>
              </div>
            )}
            {n.status === 'error' && (
              <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-danger text-white flex items-center justify-center text-[10px]">!</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function objMap<T extends { id: string }>(arr: T[], map: (x: T) => T): Record<string, T> {
  const o: Record<string, T> = {};
  arr.forEach(x => { o[x.id] = map(x); });
  return o;
}
