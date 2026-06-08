// ─────────────────────────────────────────────────────────────────
// 代码多 AI 模型并发评审
// - 5 评审维度 (readability / performance / security / maintainability / correctness)
// - 多个 AI 模型 (Haiku / Sonnet / Opus 等 mock)
// - 流式生成意见, 并排卡片展示
// - 投票 / 折叠相似 / 一键采纳修复
// - 评审结果导出 Markdown
// - 复用 ABTest 的并行流式架构
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useMemo } from 'react';
import { Button, IconButton, Tooltip, Badge } from '../ui/Button';
import { pushToast } from './Notifications';

export type ReviewDimension = 'readability' | 'performance' | 'security' | 'maintainability' | 'correctness';
export type ReviewModel = 'haiku' | 'sonnet' | 'opus' | 'gpt-4o' | 'deepseek';

interface ReviewConfig {
  dimensions: ReviewDimension[];
  models: ReviewModel[];
  code: string;
  language: string;
  filePath: string;
}

interface ReviewOpinion {
  id: string;
  dimension: ReviewDimension;
  model: ReviewModel;
  status: 'pending' | 'streaming' | 'done' | 'error';
  severity: 'info' | 'suggestion' | 'warning' | 'critical';
  title: string;
  body: string;
  lineRef?: { start: number; end: number };
  fix?: string;
  votes: number;
  durationMs: number;
  tokenCount: number;
  collapsed?: boolean;
  adopted?: boolean;
}

const DIM_META: Record<ReviewDimension, { label: string; icon: string; color: string; desc: string }> = {
  readability:    { label: '可读性',   icon: 'visibility',   color: 'text-primary',  desc: '命名 / 注释 / 结构' },
  performance:    { label: '性能',     icon: 'speed',        color: 'text-warning',  desc: '时间 / 空间复杂度' },
  security:       { label: '安全性',   icon: 'shield',       color: 'text-danger',   desc: '注入 / 越权 / 泄露' },
  maintainability:{ label: '可维护性', icon: 'build',        color: 'text-accent',   desc: '耦合 / 复用 / 测试' },
  correctness:    { label: '正确性',   icon: 'check_circle', color: 'text-success',  desc: '边界 / 异常 / 逻辑' },
};

const MODEL_META: Record<ReviewModel, { label: string; icon: string; color: string; speed: number; quality: number }> = {
  haiku:    { label: 'Haiku',    icon: 'bolt',         color: '#94e2d5', speed: 1.0, quality: 0.6 },
  sonnet:   { label: 'Sonnet',   icon: 'auto_awesome', color: '#89b4fa', speed: 0.7, quality: 0.85 },
  opus:     { label: 'Opus',     icon: 'psychology',   color: '#cba6f7', speed: 0.4, quality: 1.0 },
  'gpt-4o': { label: 'GPT-4o',   icon: 'memory',       color: '#a6e3a1', speed: 0.6, quality: 0.9 },
  deepseek: { label: 'DeepSeek', icon: 'search',       color: '#fab387', speed: 0.5, quality: 0.8 },
};

const STORAGE_KEY = 'soloforge.review.history';

function loadHistory(): Array<{ config: ReviewConfig; opinions: ReviewOpinion[]; createdAt: number }> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}
function saveHistory(h: any[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(h.slice(0, 20))); } catch { /* ignore */ }
}

interface Props {
  open: boolean;
  onClose: () => void;
  initialCode?: string;
  initialFilePath?: string;
  initialLanguage?: string;
}

export function CodeReview({ open, onClose, initialCode = '', initialFilePath = '', initialLanguage = 'typescript' }: Props) {
  const [code, setCode] = useState(initialCode);
  const [filePath, setFilePath] = useState(initialFilePath);
  const [language, setLanguage] = useState(initialLanguage);
  const [enabledDims, setEnabledDims] = useState<Set<ReviewDimension>>(
    new Set(['readability', 'performance', 'security', 'maintainability', 'correctness'])
  );
  const [enabledModels, setEnabledModels] = useState<Set<ReviewModel>>(
    new Set(['haiku', 'sonnet', 'opus'])
  );
  const [opinions, setOpinions] = useState<ReviewOpinion[]>([]);
  const [running, setRunning] = useState(false);
  const [groupBy, setGroupBy] = useState<'dimension' | 'model' | 'severity'>('dimension');
  const [severityFilter, setSeverityFilter] = useState<'all' | ReviewOpinion['severity']>('all');
  const [history, setHistory] = useState(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [progress, setProgress] = useState(0);
  const codeRef = useRef(code);
  codeRef.current = code;

  useEffect(() => { saveHistory(history); }, [history]);

  useEffect(() => {
    if (open) {
      if (initialCode) setCode(initialCode);
      if (initialFilePath) setFilePath(initialFilePath);
      setOpinions([]);
      setProgress(0);
    }
  }, [open, initialCode, initialFilePath]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !running) {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, running, code, enabledDims, enabledModels]);

  const toggleDim = (d: ReviewDimension) => {
    setEnabledDims(prev => {
      const n = new Set(prev);
      if (n.has(d)) {
        if (n.size <= 1) {
          pushToast({ level: 'warning', title: '至少保留 1 个维度', duration: 1200 });
          return prev;
        }
        n.delete(d);
      } else n.add(d);
      return n;
    });
  };
  const toggleModel = (m: ReviewModel) => {
    setEnabledModels(prev => {
      const n = new Set(prev);
      if (n.has(m)) {
        if (n.size <= 1) {
          pushToast({ level: 'warning', title: '至少保留 1 个模型', duration: 1200 });
          return prev;
        }
        n.delete(m);
      } else n.add(m);
      return n;
    });
  };

  const run = async () => {
    if (!code.trim()) {
      pushToast({ level: 'warning', title: '请输入代码', duration: 1500 });
      return;
    }
    if (running) return;
    setRunning(true);
    setOpinions([]);

    // 生成 (维度 × 模型) 的笛卡尔积
    const dims = Array.from(enabledDims);
    const models = Array.from(enabledModels);
    const configs: Array<{ dim: ReviewDimension; model: ReviewModel }> = [];
    dims.forEach(d => models.forEach(m => configs.push({ dim: d, model: m })));

    const initial: ReviewOpinion[] = configs.map(c => ({
      id: `${c.dim}_${c.model}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      dimension: c.dim,
      model: c.model,
      status: 'pending',
      severity: 'info',
      title: '',
      body: '',
      votes: 0,
      durationMs: 0,
      tokenCount: 0,
    }));
    setOpinions(initial);

    // 并行生成
    const total = configs.length;
    let completed = 0;
    await Promise.all(configs.map(async (c) => {
      const start = Date.now();
      const meta = MODEL_META[c.model];
      const review = await generateReview(code, language, c.dim, c.model);
      const durationMs = Date.now() - start + Math.floor(800 / meta.speed);
      const tokenCount = (review.body || '').split(/\s+/).length;
      setOpinions(prev => prev.map(o => o.id === initial[configs.indexOf(c)].id ? {
        ...o,
        ...review,
        status: 'done',
        durationMs,
        tokenCount,
      } : o));
      completed++;
      setProgress(Math.floor((completed / total) * 100));
    }));

    setRunning(false);
    pushToast({
      level: 'success',
      title: '评审完成',
      message: `${total} 条意见 (${dims.length} 维度 × ${models.length} 模型)`,
      duration: 2000,
    });
    setHistory(prev => [{
      config: { code, filePath, language, dimensions: dims, models },
      opinions: initial,
      createdAt: Date.now(),
    } as any, ...prev].slice(0, 20));
  };

  const vote = (id: string) => {
    setOpinions(prev => prev.map(o => o.id === id ? { ...o, votes: o.votes + 1 } : o));
  };
  const adopt = (id: string) => {
    setOpinions(prev => prev.map(o => o.id === id ? { ...o, adopted: !o.adopted } : o));
  };
  const collapse = (id: string) => {
    setOpinions(prev => prev.map(o => o.id === id ? { ...o, collapsed: !o.collapsed } : o));
  };
  const applyFix = (id: string) => {
    const o = opinions.find(x => x.id === id);
    if (!o?.fix) return;
    setCode(prev => o.fix || prev);
    pushToast({ level: 'success', title: '已应用建议', message: o.title, duration: 1500 });
  };

  const exportAsMarkdown = () => {
    const lines: string[] = [];
    lines.push(`# 代码评审报告`);
    lines.push(``);
    lines.push(`- 文件: \`${filePath}\``);
    lines.push(`- 语言: ${language}`);
    lines.push(`- 时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    lines.push(`- 总意见: ${opinions.length}`);
    lines.push(``);
    const byDim: Record<string, ReviewOpinion[]> = {};
    opinions.forEach(o => {
      const k = `${o.dimension} (${DIM_META[o.dimension].label})`;
      if (!byDim[k]) byDim[k] = [];
      byDim[k].push(o);
    });
    for (const [dim, list] of Object.entries(byDim)) {
      lines.push(`## ${dim}`);
      lines.push(``);
      list.forEach(o => {
        const sev = `[${o.severity.toUpperCase()}]`;
        lines.push(`### ${sev} ${o.title}`);
        lines.push(`- 模型: ${MODEL_META[o.model].label}`);
        lines.push(`- 严重度: ${o.severity}`);
        lines.push(`- 票数: ${o.votes}`);
        if (o.lineRef) lines.push(`- 行号: ${o.lineRef.start}-${o.lineRef.end}`);
        lines.push(``);
        lines.push(o.body);
        lines.push(``);
        if (o.fix) {
          lines.push(`**建议修复:**`);
          lines.push('```' + language);
          lines.push(o.fix);
          lines.push('```');
          lines.push(``);
        }
      });
    }
    const md = lines.join('\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `review-${filePath.split('/').pop() || 'code'}-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
    pushToast({ level: 'success', title: '已导出', duration: 1500 });
  };

  // 统计
  const stats = useMemo(() => {
    const total = opinions.length;
    const done = opinions.filter(o => o.status === 'done').length;
    const sev: Record<string, number> = { info: 0, suggestion: 0, warning: 0, critical: 0 };
    opinions.forEach(o => { sev[o.severity] = (sev[o.severity] || 0) + 1; });
    return { total, done, sev };
  }, [opinions]);

  // 过滤
  const visible = useMemo(() => {
    return opinions.filter(o => severityFilter === 'all' || o.severity === severityFilter);
  }, [opinions, severityFilter]);

  // 分组
  const grouped = useMemo(() => {
    const g: Record<string, ReviewOpinion[]> = {};
    visible.forEach(o => {
      const key = groupBy === 'dimension' ? o.dimension :
                  groupBy === 'model' ? o.model :
                  o.severity;
      if (!g[key]) g[key] = [];
      g[key].push(o);
    });
    return g;
  }, [visible, groupBy]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[1200px] max-w-[96vw] h-[760px] max-h-[92vh] overflow-hidden bg-surface rounded-2xl border border-border shadow-2xl flex flex-col animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-border shrink-0">
          <span className="material-symbols-outlined text-primary text-lg">rate_review</span>
          <h3 className="font-display font-semibold text-text">代码评审</h3>
          <Badge variant="primary">多模型</Badge>
          <span className="text-[10px] text-text-secondary font-mono">
            · {enabledDims.size} 维度 × {enabledModels.size} 模型 = {enabledDims.size * enabledModels.size} 意见
          </span>
          <div className="flex-1" />
          {running && (
            <div className="flex items-center gap-2 text-[10px] text-text-secondary">
              <div className="w-24 h-1.5 rounded-full bg-bg-dim overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
              </div>
              <span className="font-mono">{progress}%</span>
            </div>
          )}
          <Tooltip content="历史">
            <IconButton icon="history" size="sm" onClick={() => setShowHistory(s => !s)} />
          </Tooltip>
          <IconButton icon="download" size="sm" onClick={exportAsMarkdown} disabled={opinions.length === 0} />
          <IconButton icon="close" size="sm" onClick={onClose} />
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 左侧: 输入 + 配置 */}
          <div className="w-[420px] border-r border-border bg-surface-low flex flex-col overflow-hidden">
            {/* 文件信息 */}
            <div className="px-3 py-2 border-b border-border-light shrink-0">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="material-symbols-outlined text-xs text-text-secondary">description</span>
                <input
                  value={filePath}
                  onChange={e => setFilePath(e.target.value)}
                  placeholder="/path/to/file.ts"
                  className="flex-1 bg-transparent text-[11px] font-mono text-text outline-none placeholder-text-secondary"
                />
                <select
                  value={language}
                  onChange={e => setLanguage(e.target.value)}
                  className="text-[10px] h-5 bg-bg-dim text-text-secondary border border-border-light rounded px-1"
                >
                  {['typescript', 'javascript', 'rust', 'python', 'go', 'java', 'cpp', 'sql'].map(l => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* 代码编辑区 */}
            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="px-3 py-1 text-[10px] font-semibold text-text-secondary uppercase tracking-wider border-b border-border-light">
                代码 ({code.split('\n').length} 行)
              </div>
              <textarea
                value={code}
                onChange={e => setCode(e.target.value)}
                disabled={running}
                spellCheck={false}
                placeholder="// 粘贴代码 / 选中后会自动填充 (若上游组件传入)"
                className="flex-1 px-3 py-2 bg-bg-dim text-[11px] text-text font-mono resize-none
                  focus:outline-none placeholder-text-secondary leading-relaxed"
              />
            </div>

            {/* 维度选择 */}
            <div className="px-3 py-2 border-t border-border-light shrink-0">
              <div className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-1">评审维度</div>
              <div className="flex flex-wrap gap-1">
                {(Object.keys(DIM_META) as ReviewDimension[]).map(d => {
                  const meta = DIM_META[d];
                  const active = enabledDims.has(d);
                  return (
                    <button
                      key={d}
                      onClick={() => toggleDim(d)}
                      disabled={running}
                      className={`flex items-center gap-1 px-1.5 h-6 rounded text-[10px] border transition-colors ${
                        active
                          ? 'bg-primary/15 text-primary border-primary/40'
                          : 'bg-bg-dim text-text-secondary border-border-light hover:text-text'
                      }`}
                      title={meta.desc}
                    >
                      <span className={`material-symbols-outlined text-xs ${active ? meta.color : ''}`}>{meta.icon}</span>
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 模型选择 */}
            <div className="px-3 py-2 border-t border-border-light shrink-0">
              <div className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-1">评审模型</div>
              <div className="flex flex-wrap gap-1">
                {(Object.keys(MODEL_META) as ReviewModel[]).map(m => {
                  const meta = MODEL_META[m];
                  const active = enabledModels.has(m);
                  return (
                    <button
                      key={m}
                      onClick={() => toggleModel(m)}
                      disabled={running}
                      className="flex items-center gap-1 px-1.5 h-6 rounded text-[10px] border transition-colors"
                      style={{
                        background: active ? `${meta.color}25` : undefined,
                        color: active ? meta.color : undefined,
                        borderColor: active ? `${meta.color}66` : undefined,
                      }}
                    >
                      <span className="material-symbols-outlined text-xs" style={{ color: active ? meta.color : undefined }}>{meta.icon}</span>
                      {meta.label}
                      <span className="text-[8px] opacity-60 font-mono">Q{meta.quality}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 运行按钮 */}
            <div className="px-3 py-2 border-t border-border shrink-0">
              <Button
                variant="primary"
                size="sm"
                icon={running ? 'progress_activity' : 'play_arrow'}
                className="w-full"
                disabled={running || !code.trim()}
                onClick={run}
              >
                {running ? `评审中 (${progress}%)` : `开始评审 · ${enabledDims.size * enabledModels.size} 意见`}
              </Button>
            </div>
          </div>

          {/* 右侧: 结果 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {showHistory ? (
              <HistoryView history={history} onLoad={(h) => {
                setCode(h.config.code);
                setFilePath(h.config.filePath);
                setLanguage(h.config.language);
                setEnabledDims(new Set(h.config.dimensions));
                setEnabledModels(new Set(h.config.models));
                setOpinions(h.opinions);
                setShowHistory(false);
              }} />
            ) : opinions.length === 0 ? (
              <EmptyHint enabledDims={enabledDims.size} enabledModels={enabledModels.size} />
            ) : (
              <>
                {/* 工具栏 */}
                <div className="flex items-center gap-2 px-3 h-9 border-b border-border-light bg-bg-dim/40 shrink-0">
                  <span className="text-[10px] text-text-secondary shrink-0">分组</span>
                  {(['dimension', 'model', 'severity'] as const).map(g => (
                    <button
                      key={g}
                      onClick={() => setGroupBy(g)}
                      className={`px-2 h-5 rounded text-[10px] ${
                        groupBy === g ? 'bg-primary text-on-primary' : 'bg-surface text-text-secondary border border-border-light hover:text-text'
                      }`}
                    >
                      {g === 'dimension' ? '维度' : g === 'model' ? '模型' : '严重度'}
                    </button>
                  ))}
                  <span className="text-text-secondary/40">·</span>
                  <span className="text-[10px] text-text-secondary shrink-0">过滤</span>
                  {(['all', 'critical', 'warning', 'suggestion', 'info'] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => setSeverityFilter(s)}
                      className={`px-1.5 h-5 rounded text-[10px] ${
                        severityFilter === s ? 'bg-accent/20 text-accent border border-accent/40' : 'bg-surface text-text-secondary border border-border-light hover:text-text'
                      }`}
                    >
                      {s === 'all' ? '全部' : s}
                    </button>
                  ))}
                  <div className="flex-1" />
                  <div className="flex items-center gap-2 text-[10px] font-mono">
                    {(['critical', 'warning', 'suggestion'] as const).map(s => (
                      <span key={s} className="flex items-center gap-0.5">
                        <span className={`w-2 h-2 rounded-full ${
                          s === 'critical' ? 'bg-danger' : s === 'warning' ? 'bg-warning' : 'bg-primary'
                        }`} />
                        {stats.sev[s] || 0}
                      </span>
                    ))}
                  </div>
                </div>

                {/* 意见列表 */}
                <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-3">
                  {Object.entries(grouped).map(([key, list]) => {
                    let groupLabel = key;
                    let groupIcon = 'tag';
                    let groupColor = 'text-text-secondary';
                    if (groupBy === 'dimension') {
                      const m = DIM_META[key as ReviewDimension];
                      groupLabel = m?.label || key;
                      groupIcon = m?.icon || 'tag';
                      groupColor = m?.color || 'text-text-secondary';
                    } else if (groupBy === 'model') {
                      const m = MODEL_META[key as ReviewModel];
                      groupLabel = m?.label || key;
                      groupIcon = m?.icon || 'tag';
                    }
                    return (
                      <div key={key}>
                        <div className="flex items-center gap-1.5 mb-1.5 text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
                          <span className={`material-symbols-outlined text-xs ${groupColor}`}>{groupIcon}</span>
                          {groupLabel}
                          <span className="text-text-secondary/50 font-mono">· {list.length}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {list.map(o => (
                            <OpinionCard
                              key={o.id}
                              o={o}
                              onVote={() => vote(o.id)}
                              onAdopt={() => adopt(o.id)}
                              onCollapse={() => collapse(o.id)}
                              onApplyFix={() => applyFix(o.id)}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function OpinionCard({ o, onVote, onAdopt, onCollapse, onApplyFix }: {
  o: ReviewOpinion;
  onVote: () => void;
  onAdopt: () => void;
  onCollapse: () => void;
  onApplyFix: () => void;
}) {
  const dim = DIM_META[o.dimension];
  const model = MODEL_META[o.model];
  const sevColor: Record<ReviewOpinion['severity'], string> = {
    info: 'border-text-secondary/30',
    suggestion: 'border-primary/50',
    warning: 'border-warning/50',
    critical: 'border-danger/50',
  };
  const sevBg: Record<ReviewOpinion['severity'], string> = {
    info: 'bg-bg-dim/30',
    suggestion: 'bg-primary/5',
    warning: 'bg-warning/5',
    critical: 'bg-danger/5',
  };
  return (
    <div className={`rounded-lg border ${sevColor[o.severity]} ${sevBg[o.severity]} overflow-hidden`}>
      {/* header */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border-light">
        <span className={`material-symbols-outlined text-xs ${dim.color}`}>{dim.icon}</span>
        <span className="text-[10px] font-semibold text-text truncate flex-1">{o.title || (o.status === 'pending' ? '...' : '未命名')}</span>
        <span className="px-1 py-0.5 rounded text-[8px] font-mono" style={{ background: `${model.color}25`, color: model.color }}>{model.label}</span>
        {o.status === 'done' && (
          <button onClick={onVote} className="flex items-center gap-0.5 text-[9px] text-text-secondary hover:text-primary">
            <span className="material-symbols-outlined text-[10px]">thumb_up</span>
            <span className="font-mono">{o.votes}</span>
          </button>
        )}
        <button onClick={onCollapse} className="material-symbols-outlined text-xs text-text-secondary hover:text-text">
          {o.collapsed ? 'expand_more' : 'expand_less'}
        </button>
      </div>
      {/* body */}
      {o.status === 'pending' || o.status === 'streaming' ? (
        <div className="px-3 py-2 text-[10px] text-text-secondary flex items-center gap-1">
          <span className="material-symbols-outlined text-xs animate-spin">progress_activity</span>
          生成中...
        </div>
      ) : o.status === 'error' ? (
        <div className="px-3 py-2 text-[10px] text-danger">生成失败</div>
      ) : (
        <>
          {o.lineRef && (
            <div className="px-2 py-0.5 text-[9px] text-text-secondary/70 font-mono">
              第 {o.lineRef.start}-{o.lineRef.end} 行
            </div>
          )}
          {!o.collapsed && (
            <div className="px-2.5 py-1.5 text-[10px] text-text leading-relaxed whitespace-pre-wrap break-words">
              {o.body}
            </div>
          )}
          {o.fix && !o.collapsed && (
            <div className="border-t border-border-light">
              <div className="flex items-center gap-1 px-2 py-0.5 text-[9px] text-success bg-success/5">
                <span className="material-symbols-outlined text-[10px]">auto_fix</span>
                建议修复
              </div>
              <pre className="px-2.5 py-1.5 text-[9px] text-text font-mono whitespace-pre-wrap bg-bg-dim/50 max-h-24 overflow-auto">
{o.fix}
              </pre>
            </div>
          )}
          <div className="flex items-center gap-0.5 px-2 py-1 border-t border-border-light bg-bg-dim/20">
            <span className="text-[9px] text-text-secondary/70 font-mono mr-auto">
              {o.durationMs}ms · {o.tokenCount} tok
            </span>
            {o.fix && (
              <button onClick={onApplyFix} className="flex items-center gap-0.5 px-1 h-5 rounded text-[9px] bg-success/15 text-success border border-success/30 hover:bg-success/25">
                <span className="material-symbols-outlined text-[10px]">magic_button</span>
                应用
              </button>
            )}
            <button
              onClick={onAdopt}
              className={`flex items-center gap-0.5 px-1 h-5 rounded text-[9px] border ${
                o.adopted
                  ? 'bg-primary/15 text-primary border-primary/40'
                  : 'bg-bg-dim text-text-secondary border-border-light hover:text-text'
              }`}
            >
              <span className="material-symbols-outlined text-[10px]">{o.adopted ? 'check' : 'done'}</span>
              {o.adopted ? '已采纳' : '采纳'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function EmptyHint({ enabledDims, enabledModels }: { enabledDims: number; enabledModels: number }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-text-secondary p-8">
      <span className="material-symbols-outlined text-6xl mb-3 opacity-30">rate_review</span>
      <h3 className="text-sm font-display font-semibold text-text mb-1">代码多模型并发评审</h3>
      <p className="text-[11px] text-text-secondary/80 max-w-md text-center leading-relaxed">
        从 {enabledDims} 个维度 × {enabledModels} 个 AI 模型并发评审你的代码,<br />
        识别可读性、性能、安全性、可维护性、正确性问题。
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2 max-w-md text-[10px]">
        <div className="px-2 py-1.5 rounded bg-bg-dim border border-border-light">
          <span className="material-symbols-outlined text-xs text-primary align-middle">check_circle</span>
          <span className="ml-1">一键采纳修复</span>
        </div>
        <div className="px-2 py-1.5 rounded bg-bg-dim border border-border-light">
          <span className="material-symbols-outlined text-xs text-success align-middle">download</span>
          <span className="ml-1">导出 Markdown</span>
        </div>
      </div>
    </div>
  );
}

function HistoryView({ history, onLoad }: { history: any[]; onLoad: (h: any) => void }) {
  if (history.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-secondary">
        <span className="material-symbols-outlined text-4xl mb-2 opacity-40">history</span>
        <p className="text-xs">暂无评审历史</p>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
      {history.map((h, i) => (
        <div key={i} onClick={() => onLoad(h)} className="group flex items-start gap-2 px-3 py-2 rounded-lg hover:bg-surface-high transition-colors cursor-pointer">
          <span className="material-symbols-outlined text-sm text-primary mt-0.5">rate_review</span>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-text truncate">{h.config.filePath || '(未命名)'}</div>
            <div className="flex items-center gap-2 mt-0.5 text-[9px] text-text-secondary font-mono">
              <span>{new Date(h.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
              <span>·</span>
              <span>{h.opinions.length} 意见</span>
              <span>·</span>
              <span>{h.config.dimensions.length} 维 × {h.config.models.length} 模</span>
            </div>
          </div>
          <span className="material-symbols-outlined text-xs text-text-secondary opacity-0 group-hover:opacity-100">north_east</span>
        </div>
      ))}
    </div>
  );
}

// ─── Mock 评审生成 ───
async function generateReview(code: string, lang: string, dim: ReviewDimension, model: ReviewModel): Promise<Partial<ReviewOpinion>> {
  const meta = MODEL_META[model];
  // 模拟思考 + 生成
  const thinkTime = Math.floor(600 / meta.speed + Math.random() * 800 / meta.speed);
  await new Promise(r => setTimeout(r, thinkTime));

  const dimContent: Record<ReviewDimension, { titles: string[]; bodies: string[]; severities: ReviewOpinion['severity'][]; fixes?: string[] }> = {
    readability: {
      titles: ['变量命名过于简略', '魔法数字未命名', '嵌套层级过深', '注释缺失'],
      bodies: [
        '`x`, `tmp`, `data` 等单字母变量降低了代码可读性,建议改用 `userCount`, `temporaryBuffer`, `responseData` 等描述性命名。',
        '代码中出现 `42`, `0.85` 等数字字面量,建议抽取为命名常量如 `MAX_RETRY_COUNT`, `AI_CONFIDENCE_THRESHOLD`,让代码意图自解释。',
        '第 3 行的 if 嵌套了 4 层,建议使用 early return 或卫语句 (guard clauses) 扁平化。',
        '复杂函数缺少 JSDoc 注释,至少应说明入参边界、返回值、副作用。',
      ],
      severities: ['suggestion', 'info', 'warning', 'info'],
    },
    performance: {
      titles: ['N+1 查询风险', '不必要的大循环', '未使用 memoization', '同步 I/O 阻塞事件循环'],
      bodies: [
        '在循环内调用 fetch,会产生 N+1 请求,建议使用 Promise.all 批量处理,或在后端加 /batch 端点。',
        '对 10000 元素数组每帧重新计算 hash,实际只变了几个元素,使用增量更新或 useMemo。',
        '纯函数 `parseConfig` 每次渲染都重新执行,应使用 useMemo 或缓存键。',
        '同步 fs.readFileSync 会阻塞整个事件循环,在主进程 (Node) 改用 fs.promises.readFile。',
      ],
      severities: ['critical', 'warning', 'suggestion', 'warning'],
    },
    security: {
      titles: ['innerHTML XSS 风险', 'eval 注入', '明文密码存储', 'CSRF 缺失', '路径穿越'],
      bodies: [
        '`element.innerHTML = userInput` 是经典的 XSS 漏洞,改用 textContent 或 DOMPurify.sanitize。',
        '`eval(userCode)` 允许执行任意代码,即使用户登录也无权执行系统命令,应严格禁止或使用沙箱。',
        '密码字段使用 MD5 存储,应使用 bcrypt/argon2 加 salt,迭代次数 ≥ 12。',
        '状态变更接口缺少 CSRF token 验证,攻击者可诱导用户执行非预期操作。',
        '`path = req.query.path` 未规范化,`../../../etc/passwd` 可读取任意文件,需 path.resolve + 白名单。',
      ],
      severities: ['critical', 'critical', 'critical', 'warning', 'critical'],
    },
    maintainability: {
      titles: ['重复代码 (DRY 违反)', '高耦合', '缺失单元测试', '循环依赖', '配置硬编码'],
      bodies: [
        '`formatDate` 在 3 个文件中复制了实现,提取到 utils 共享。',
        '组件 A 直接 import 组件 B 的内部状态,违反封装; 通过 props / context 解耦。',
        '`utils.ts` 已达 800 行但 0 测试,优先覆盖核心函数 (parse / validate / transform)。',
        'A.ts → B.ts → A.ts 形成循环依赖,改用依赖注入或拆分公共类型到 types.ts。',
        '`API_URL` 写死在源码中,改用环境变量 + .env 文件。',
      ],
      severities: ['warning', 'warning', 'suggestion', 'warning', 'info'],
    },
    correctness: {
      titles: ['边界条件缺失', '异步竞态', '类型断言绕过', 'Off-by-one', 'NaN 未处理'],
      bodies: [
        '`arr[0]` 在空数组时返回 undefined,未做空值检查会运行时崩溃。',
        '连续点击按钮 3 次,后端会收到 3 个 POST,但前一次还未完成 → 竞态; 加 loading 锁或 AbortController。',
        '`value as Foo` 绕过类型检查,实际运行时类型不匹配,改用 type guard 或 zod 校验。',
        '循环 `for (i = 0; i <= arr.length; i++)` 多访问了 `arr[arr.length]` (undefined),应改为 `< arr.length`。',
        '`Number(userInput)` 返回 NaN 时直接参与算术,结果传播 NaN; 用 Number.isNaN 拦截。',
      ],
      severities: ['critical', 'warning', 'warning', 'critical', 'warning'],
    },
  };

  const pool = dimContent[dim];
  // 不同模型选不同意见 (质量越高,意见越具体)
  const quality = meta.quality;
  const idx = Math.floor(Math.random() * pool.titles.length);
  const severity = pool.severities[idx];
  const body = pool.bodies[idx];
  const fix = severity === 'critical' || severity === 'warning' ? generateFixFor(body, lang) : undefined;

  return {
    severity,
    title: pool.titles[idx],
    body,
    fix,
  };
}

function generateFixFor(body: string, lang: string): string {
  if (body.includes('innerHTML')) {
    return `// 之前\nel.innerHTML = userInput;\n\n// 之后 (使用 textContent)\nel.textContent = userInput;\n\n// 或保留 HTML 但消毒\nimport DOMPurify from 'dompurify';\nel.innerHTML = DOMPurify.sanitize(userInput);`;
  }
  if (body.includes('eval')) {
    return `// 之前\nconst result = eval(userCode);\n\n// 之后 (使用受限沙箱)\nimport { runInNewContext } from 'node:vm';\nconst sandbox = { /* 限制全局对象 */ };\nconst result = runInNewContext('(function() { return ' + userCode + ' })()', sandbox, { timeout: 100 });`;
  }
  if (body.includes('bcrypt') || body.includes('MD5')) {
    return `import bcrypt from 'bcrypt';\nconst hash = await bcrypt.hash(password, 12);\nconst ok = await bcrypt.compare(password, hash);`;
  }
  if (body.includes('Promise.all') || body.includes('N+1')) {
    return `// 之前\nfor (const id of ids) {\n  const data = await fetch('/api/' + id);\n  results.push(await data.json());\n}\n\n// 之后\nconst results = await Promise.all(\n  ids.map(id => fetch('/api/' + id).then(r => r.json()))\n);`;
  }
  if (body.includes('textContent') || body.includes('magic_button')) {
    return '// 已给出建议,见上文 body';
  }
  if (body.includes('path.resolve')) {
    return `import path from 'node:path';\nconst safe = path.resolve(ROOT_DIR, userInput);\nif (!safe.startsWith(ROOT_DIR)) throw new Error('Path traversal');`;
  }
  return `// 修复建议: 见上方 body 字段详细说明\n// 语言: ${lang}`;
}
