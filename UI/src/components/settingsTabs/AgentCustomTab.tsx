/**
 * AgentCustomTab — 07. Agent自定义
 *
 * Phase 4: Agent 池管理 UI
 *   - 从 Java Spring AI 服务 (经 Node.js 透传) 拉取 Agent 列表
 *   - 展示每个 Agent 的 id/name/role/domain/level/strategy/taskCount
 *   - 点击 Agent 查看详情 (systemPrompt 摘要 + modelBinding + capabilities + temperature + maxRounds)
 *   - 展示 Java 服务连通状态 (8770 端口)
 *
 * 数据源: GET /api/java-agent/api/agents (→ 8770/api/agents)
 *         GET /api/java-agent/api/agents/{id} (→ 8770/api/agents/{id})
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Bot, RefreshCw, Cpu, Activity, Zap, Workflow, ShieldCheck, X, Database, ThumbsUp, ThumbsDown, Send, Link2, Upload, FileCode, Code, Globe, ChevronDown } from '../../utils/icons';

interface AgentSummary {
  id: string;
  name: string;
  role: string;
  domain: string;
  /** level 是字符串 ("senior"/"master"/"expert") 而非数字 */
  level: string;
  strategy: string;
  taskCount: number;
}

interface AgentDetail extends AgentSummary {
  systemPrompt?: string;
  systemPromptVersion?: string;
  modelBinding?: string;
  capabilities?: string[];
  temperature?: number;
  maxRounds?: number;
  status?: string;
  enabled?: boolean;
}

const ROLE_LABELS: Record<string, { label: string; icon: React.ComponentType<any>; color: string }> = {
  EXECUTOR: { label: '执行者', icon: Cpu, color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  PLANNER: { label: '规划者', icon: Workflow, color: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
  REVIEWER: { label: '审查者', icon: ShieldCheck, color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
};

const STRATEGY_LABELS: Record<string, string> = {
  'code-dev': '代码开发',
  planning: '任务规划',
  debugging: '调试排查',
  documentation: '文档撰写',
  review: '代码审查',
  research: '调研分析',
};

function getRoleMeta(role: string) {
  return ROLE_LABELS[role] || { label: role, icon: Bot, color: 'text-surface-bright bg-on-surface/5 border-outline/30' };
}

const CAPABILITY_LABELS: Record<string, string> = {
  read: '读取文件',
  write: '写入文件',
  search: '搜索代码',
  execute: '执行命令',
  analyze: '分析推理',
  debug: '调试排查',
  review: '代码审查',
  document: '文档撰写',
  plan: '任务规划',
  test: '测试验证',
  refactor: '重构优化',
  deploy: '部署发布',
  monitor: '监控运维',
  communicate: '沟通协作',
};

function getStrategyLabel(strategy: string) {
  return STRATEGY_LABELS[strategy] || strategy;
}

function getCapabilityLabel(cap: string) {
  return CAPABILITY_LABELS[cap] || cap;
}

export default function AgentCustomTab() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceAlive, setServiceAlive] = useState<boolean | null>(null);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/java-agent/api/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAgents(Array.isArray(data) ? data : []);
      setServiceAlive(true);
    } catch (err: any) {
      setAgents([]);
      setServiceAlive(false);
      setError(err?.message || 'Java Agent 服务未启动');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/java-agent/api/agents/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDetail(data);
    } catch (err: any) {
      setDetail(null);
      setError(err?.message || '加载详情失败');
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    if (selectedId) fetchDetail(selectedId);
    else setDetail(null);
  }, [selectedId, fetchDetail]);

  return (
    <div className="space-y-4 animate-fadeIn">
      {/* Header */}
      <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-[var(--color-on-surface)]">Agent 池管理</h3>
          </div>
          <div className="flex items-center gap-2">
            <ServiceStatusBadge alive={serviceAlive} loading={loading} />
            <button
              onClick={fetchAgents}
              className="p-1.5 rounded-lg border border-[var(--color-outline)]/30 hover:bg-[var(--color-surface-bright)]/40 text-on-surface/70 hover:text-[var(--color-on-surface)] transition-colors"
              title="刷新 Agent 列表"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-400 text-xs">
          <div className="font-bold mb-1">⚠️ 无法连接 Java Agent 服务</div>
          <div className="font-mono opacity-80">{error}</div>
          <div className="mt-2 opacity-70">
            请确认: <code className="font-mono">node start-all.mjs</code> 已启动 8770 端口, 或单独运行{' '}
            <code className="font-mono">java -jar solo-forge-agent/target/solo-forge-agent-1.0.0.jar</code>
          </div>
        </div>
      )}

      <div className="grid grid-cols-12 gap-4">
        {/* Left: Agent List */}
        <div className="col-span-5 space-y-2">
          <div className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider font-mono">
            Agent 列表 ({agents.length})
          </div>
          {loading && agents.length === 0 ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map(i => (
                <div key={i} className="h-20 rounded-xl bg-[var(--color-surface-bright)]/30 animate-pulse" />
              ))}
            </div>
          ) : agents.length === 0 ? (
            <div className="p-6 rounded-xl border border-dashed border-[var(--color-outline)]/30 text-center text-on-surface/40 text-xs">
              {serviceAlive === false ? '服务未启动' : '暂无 Agent'}
            </div>
          ) : (
            <div className="space-y-1.5">
              {agents.map(agent => {
                const meta = getRoleMeta(agent.role);
                const isSelected = selectedId === agent.id;
                const RoleIcon = meta.icon;
                return (
                  <button
                    key={agent.id}
                    onClick={() => setSelectedId(agent.id)}
                    className={`w-full flex items-start gap-2.5 p-2.5 rounded-xl border text-left transition-all ${
                      isSelected
                        ? 'border-primary/40 bg-primary/10 shadow-sm'
                        : 'border-outline/25 bg-[var(--color-surface)] hover:bg-[var(--color-surface-bright)]/40'
                    }`}
                  >
                    <div className={`p-1.5 rounded-lg border shrink-0 ${meta.color}`}>
                      <RoleIcon className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-xs font-bold truncate ${isSelected ? 'text-primary' : 'text-on-surface'}`}>
                          {agent.name}
                        </span>
                        <span className="text-[9px] font-mono opacity-50 shrink-0 uppercase">{agent.level}</span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-on-surface/5 text-on-surface/60 shrink-0">
                          {agent.id}
                        </span>
                        <span className="text-[9px] opacity-50 truncate">{getStrategyLabel(agent.strategy)}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[9px] opacity-50">
                        <span className="flex items-center gap-0.5">
                          <Activity className="w-2.5 h-2.5" />
                          {agent.taskCount} 任务
                        </span>
                        <span>·</span>
                        <span>{meta.label}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Agent Detail + Feed Training */}
        <div className="col-span-7 space-y-3 overflow-y-auto max-h-[calc(85vh-220px)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider font-mono mb-2">
            Agent 详情
          </div>
          {!selectedId ? (
            <div className="p-8 rounded-xl border border-dashed border-[var(--color-outline)]/30 text-center text-on-surface/40 text-xs">
              ← 点击左侧 Agent 查看详情
            </div>
          ) : loadingDetail ? (
            <div className="h-64 rounded-xl bg-[var(--color-surface-bright)]/30 animate-pulse" />
          ) : detail ? (
            <>
              <AgentDetailPanel detail={detail} onClose={() => setSelectedId(null)} />
              <FeedTrainingPanel agentId={detail.id} agentName={detail.name} />
            </>
          ) : (
            <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-400 text-xs">
              加载详情失败
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ServiceStatusBadge({ alive, loading }: { alive: boolean | null; loading: boolean }) {
  if (loading && alive === null) {
    return (
      <span className="text-[9px] font-mono px-2 py-1 rounded-md border border-outline/30 text-on-surface/50">
        检测中...
      </span>
    );
  }
  if (alive) {
    return (
      <span className="text-[9px] font-mono px-2 py-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        8770 在线
      </span>
    );
  }
  return (
    <span className="text-[9px] font-mono px-2 py-1 rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-400 flex items-center gap-1">
      <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
      8770 离线
    </span>
  );
}

function AgentDetailPanel({ detail, onClose }: { detail: AgentDetail; onClose: () => void }) {
  const meta = getRoleMeta(detail.role);
  const RoleIcon = meta.icon;
  const promptPreview = (detail.systemPrompt || '').slice(0, 500);
  const promptTruncated = (detail.systemPrompt || '').length > 500;

  return (
    <div className="rounded-xl border border-[var(--color-outline)]/25 bg-[var(--color-surface)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 border-b border-[var(--color-outline)]/20 bg-[var(--color-bg)]">
        <div className={`p-2 rounded-lg border ${meta.color}`}>
          <RoleIcon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-[var(--color-on-surface)]">{detail.name}</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
              {detail.id}
            </span>
          </div>
          <div className="text-[10px] text-on-surface/50 mt-0.5">
            {meta.label} · {getStrategyLabel(detail.strategy)} · <span className="uppercase">{detail.level}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-[var(--color-surface-bright)]/40 rounded text-on-surface/40 hover:text-[var(--color-on-surface)]"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="p-3 space-y-3 text-xs">
        {/* Stats Grid */}
        <div className="grid grid-cols-4 gap-2">
          <StatBox icon={Activity} label="任务数" value={String(detail.taskCount ?? 0)} />
          <StatBox icon={Zap} label="温度" value={detail.temperature != null ? String(detail.temperature) : '—'} />
          <StatBox icon={RefreshCw} label="最大轮次" value={String(detail.maxRounds ?? '—')} />
          <StatBox
            icon={ShieldCheck}
            label="状态"
            value={detail.enabled === false ? '禁用' : (detail.status || '启用')}
            highlight={detail.enabled !== false}
          />
        </div>

        {/* Capabilities */}
        {detail.capabilities && detail.capabilities.length > 0 && (
          <div>
            <div className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider font-mono mb-1">
              能力 ({detail.capabilities.length})
            </div>
            <div className="flex flex-wrap gap-1">
              {detail.capabilities.map(cap => (
                <span
                  key={cap}
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20"
                >
                  {getCapabilityLabel(cap)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* System Prompt Preview */}
        {promptPreview && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider font-mono">
                System Prompt 预览
              </div>
              {detail.systemPromptVersion && (
                <span className="text-[9px] font-mono opacity-50">v{detail.systemPromptVersion}</span>
              )}
            </div>
            <div className="p-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-outline)]/20 font-mono text-[10px] text-on-surface/70 max-h-48 overflow-y-auto whitespace-pre-wrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {promptPreview}
              {promptTruncated && <span className="opacity-50">... ({(detail.systemPrompt || '').length - 500} 字符省略)</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatBox({
  icon: Icon,
  label,
  value,
  highlight,
}: {
  icon: React.ComponentType<any>;
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="p-2 rounded-lg border border-[var(--color-outline)]/20 bg-[var(--color-bg)]">
      <div className="flex items-center gap-1 text-[9px] text-on-surface/50 uppercase tracking-wider font-mono mb-0.5">
        <Icon className="w-2.5 h-2.5" />
        {label}
      </div>
      <div className={`text-xs font-bold ${highlight ? 'text-emerald-400' : 'text-on-surface'}`}>{value}</div>
    </div>
  );
}

// ─── 自定义下拉组件 (替代原生 <select>, 遵循主题色) ─────────
function CustomSelect({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selected = options.find(o => o.value === value);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] rounded-lg bg-[var(--color-bg)] border border-[var(--color-outline)]/20 text-on-surface hover:border-primary/30 transition-colors cursor-pointer"
        style={{ outline: 'none' }}>
        <span className="truncate">{selected?.label || value}</span>
        <ChevronDown className={`w-3 h-3 text-on-surface/40 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-lg border border-[var(--color-outline)]/20 bg-[var(--color-surface)] shadow-lg [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {options.map(opt => (
            <button key={opt.value} type="button"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors cursor-pointer ${
                opt.value === value
                  ? 'bg-primary/15 text-primary font-bold'
                  : 'text-on-surface hover:bg-[var(--color-surface-bright)]'
              }`}
              style={{ outline: 'none' }}>
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 投喂训练面板 (多模态 Tab) ─────────────────────────────────
type FeedTabId = 'text' | 'url' | 'file' | 'code';
const FEED_TABS: { id: FeedTabId; label: string; icon: React.ComponentType<any> }[] = [
  { id: 'text', label: '文本', icon: Database },
  { id: 'url', label: 'URL', icon: Link2 },
  { id: 'file', label: '文件', icon: Upload },
  { id: 'code', label: '代码', icon: Code },
];

const CODE_LANGUAGES = [
  { value: 'typescript', label: 'TypeScript' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'sql', label: 'SQL' },
  { value: 'shell', label: 'Shell' },
  { value: 'other', label: 'Other' },
];

function FeedTrainingPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [activeTab, setActiveTab] = useState<FeedTabId>('text');
  const [positive, setPositive] = useState(true);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // ── 文本 Tab 状态 ──
  const [textMsg, setTextMsg] = useState('');
  const [textResp, setTextResp] = useState('');

  // ── URL Tab 状态 ──
  const [urlInput, setUrlInput] = useState('');
  const [urlFetching, setUrlFetching] = useState(false);
  const [urlResults, setUrlResults] = useState<Array<{
    url: string; title: string; content: string; charCount: number; error?: string; selected: boolean;
  }>>([]);

  // ── 文件 Tab 状态 ──
  const [fileChunks, setFileChunks] = useState<Array<{
    fileName: string; content: string; index: number; selected: boolean;
  }>>([]);

  // ── 代码 Tab 状态 ──
  const [codeLang, setCodeLang] = useState('typescript');
  const [codeDesc, setCodeDesc] = useState('');
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // ── 模型选择 (用于训练优化) ──
  interface AvailableModel { id: string; name: string; baseUrl: string; apiKey: string; model: string; }
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [codeContent, setCodeContent] = useState('');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('cherry_providers_v2');
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return;
      const models: AvailableModel[] = [];
      for (const prov of parsed) {
        if (!prov.enabled || prov.status !== 'success' || !prov.apiKey) continue;
        const baseUrl = prov.baseUrl || '';
        const apiKey = prov.apiKey || '';
        if (Array.isArray(prov.models)) {
          for (const m of prov.models) {
            if (m.enabled) {
              models.push({ id: m.id, name: m.name || m.id, baseUrl, apiKey, model: m.id });
            }
          }
        }
        if (Array.isArray(prov.customModels)) {
          for (const cm of prov.customModels) {
            const cmId = typeof cm === 'string' ? cm : cm?.id;
            const cmName = typeof cm === 'string' ? cm : cm?.name || cm?.id;
            if (cmId && (typeof cm === 'string' || cm.enabled !== false)) {
              models.push({ id: cmId, name: cmName, baseUrl, apiKey, model: cmId });
            }
          }
        }
      }
      // 去重 (models 和 customModels 可能有相同 id)
      const seen = new Set<string>();
      const deduped = models.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      setAvailableModels(deduped);
      if (deduped.length > 0 && !selectedModelId) {
        setSelectedModelId(deduped[0].id);
      }
    } catch { /* ignore parse errors */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 计算当前 Tab 是否可提交 ──
  const canSubmit = (() => {
    switch (activeTab) {
      case 'text': return textMsg.trim().length > 0 && textResp.trim().length > 0;
      case 'url': return urlResults.some(r => r.selected && !r.error);
      case 'file': return fileChunks.some(c => c.selected);
      case 'code': return codeContent.trim().length > 0;
      default: return false;
    }
  })();

  // ── 提交到经验案例库 ──
  const submitFeedback = useCallback(async (triggerOptimize: boolean) => {
    if (!canSubmit) return;
    setSubmitting(true);
    setResult(null);

    try {
      const cases: Array<{ message: string; response: string }> = [];

      switch (activeTab) {
        case 'text':
          cases.push({ message: textMsg.trim(), response: textResp.trim() });
          break;
        case 'url':
          for (const r of urlResults) {
            if (r.selected && !r.error) {
              cases.push({
                message: `参考链接: ${r.url}${r.title ? ` (${r.title})` : ''}`,
                response: r.content,
              });
            }
          }
          break;
        case 'file':
          for (const c of fileChunks) {
            if (c.selected) {
              cases.push({
                message: `文件: ${c.fileName} (片段 ${c.index + 1})`,
                response: c.content,
              });
            }
          }
          break;
        case 'code':
          cases.push({
            message: `示例代码 (${codeLang})${codeDesc.trim() ? ': ' + codeDesc.trim() : ''}`,
            response: codeContent.trim(),
          });
          break;
      }

      let successCount = 0;
      let failCount = 0;
      let lastCaseId = '';

      for (const c of cases) {
        try {
          const fbRes = await fetch('/api/java-agent/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId, positive,
              message: c.message, response: c.response,
              comment: comment.trim() || undefined,
            }),
          });
          if (!fbRes.ok) { failCount++; continue; }
          const fbData = await fbRes.json();
          lastCaseId = fbData.caseId || '';
          successCount++;
        } catch { failCount++; }
      }

      let optimizeMsg = '';
      if (triggerOptimize && successCount > 0) {
        try {
          const selectedModel = availableModels.find(m => m.id === selectedModelId);
          const optBody: Record<string, any> = { agentId };
          if (selectedModel) {
            optBody.provider = { baseUrl: selectedModel.baseUrl, apiKey: selectedModel.apiKey, model: selectedModel.model };
          }
          const optRes = await fetch('/api/java-agent/api/training/optimize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(optBody),
          });
          if (optRes.ok) {
            const optData = await optRes.json();
            optimizeMsg = ` + Prompt 优化已提交 (${optData.jobId || 'N/A'})`;
          }
        } catch { /* ignore */ }
      }

      setResult({
        type: failCount === 0 ? 'success' : 'error',
        text: `${successCount} 条案例已入库${failCount > 0 ? ` (${failCount} 条失败)` : ''}${optimizeMsg}` +
              (successCount === 1 ? ` (caseId: ${lastCaseId})` : ''),
      });

      // 清空
      setTextMsg(''); setTextResp('');
      setUrlResults([]);
      setFileChunks([]);
      setCodeContent(''); setCodeDesc('');
    } catch (err: any) {
      setResult({ type: 'error', text: err?.message || '提交失败' });
    } finally {
      setSubmitting(false);
    }
  }, [agentId, positive, comment, canSubmit, activeTab,
      textMsg, textResp, urlResults, fileChunks, codeLang, codeDesc, codeContent,
      availableModels, selectedModelId]);

  // ── URL 抓取 ──
  const handleFetchUrls = useCallback(async () => {
    const urls = urlInput.split('\n').map(u => u.trim()).filter(Boolean);
    if (urls.length === 0) return;
    setUrlFetching(true);
    setResult(null);
    try {
      const res = await fetch('/api/training/fetch-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, maxLength: 6000 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setUrlResults((data.results || []).map((r: any) => ({ ...r, selected: !r.error })));
    } catch (err: any) {
      setResult({ type: 'error', text: `抓取失败: ${err?.message}` });
    } finally {
      setUrlFetching(false);
    }
  }, [urlInput]);

  // ── 文件上传处理 ──
  const processFiles = useCallback(async (files: FileList | File[]) => {
    setResult(null);
    const CHUNK_SIZE = 2000;
    const newChunks: typeof fileChunks = [];

    for (const file of Array.from(files)) {
      const ALLOWED = ['.txt', '.md', '.json', '.py', '.ts', '.tsx', '.js', '.jsx', '.java', '.go', '.rs', '.yaml', '.yml', '.toml', '.log', '.css', '.html', '.sql', '.sh', '.bat', '.env', '.cfg', '.conf', '.xml', '.csv'];
      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      if (!ALLOWED.includes(ext) && !file.type.startsWith('text/')) {
        continue;
      }
      try {
        const text = await file.text();
        if (text.length <= CHUNK_SIZE) {
          newChunks.push({ fileName: file.name, content: text, index: 0, selected: true });
        } else {
          let idx = 0;
          for (let i = 0; i < text.length; i += CHUNK_SIZE) {
            newChunks.push({ fileName: file.name, content: text.slice(i, i + CHUNK_SIZE), index: idx++, selected: true });
          }
        }
      } catch { /* skip binary */ }
    }

    setFileChunks(prev => [...prev, ...newChunks]);
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      e.target.value = '';
    }
  }, [processFiles]);

  // ── 渲染 Tab 内容区 ──
  const renderTabContent = () => {
    switch (activeTab) {
      case 'text':
        return (
          <div className="space-y-3">
            <div>
              <label className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider font-mono mb-1 block">
                用户输入 (训练场景)
              </label>
              <textarea value={textMsg} onChange={(e) => setTextMsg(e.target.value)}
                placeholder="例: 帮我写一个 React 自定义 Hook，实现防抖搜索功能"
                className="w-full h-20 px-3 py-2 text-[11px] rounded-lg bg-[var(--color-bg)] border border-[var(--color-outline)]/20 text-on-surface placeholder:text-on-surface/25 resize-none focus:outline-none focus:border-primary/40 transition-colors" />
            </div>
            <div>
              <label className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider font-mono mb-1 block">
                理想回复 (期望 Agent 这样回答)
              </label>
              <textarea value={textResp} onChange={(e) => setTextResp(e.target.value)}
                placeholder="粘贴期望的 Agent 回复内容..."
                className="w-full h-24 px-3 py-2 text-[11px] rounded-lg bg-[var(--color-bg)] border border-[var(--color-outline)]/20 text-on-surface placeholder:text-on-surface/25 resize-none focus:outline-none focus:border-primary/40 transition-colors" />
            </div>
          </div>
        );

      case 'url':
        return (
          <div className="space-y-3">
            <div>
              <label className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider font-mono mb-1 block">
                输入 URL (每行一个, 最多 5 个)
              </label>
              <textarea value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
                placeholder={"https://example.com/article\nhttps://github.com/user/repo/issues/123"}
                className="w-full h-20 px-3 py-2 text-[11px] rounded-lg bg-[var(--color-bg)] border border-[var(--color-outline)]/20 text-on-surface placeholder:text-on-surface/25 resize-none focus:outline-none focus:border-primary/40 transition-colors font-mono" />
            </div>
            <button type="button" onClick={handleFetchUrls} disabled={urlFetching || !urlInput.trim()}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-colors ${
                urlFetching || !urlInput.trim()
                  ? 'border-[var(--color-outline)]/15 text-on-surface/25 cursor-not-allowed'
                  : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer'
              }`}>
              <Globe className={`w-3 h-3 ${urlFetching ? 'animate-spin' : ''}`} />
              {urlFetching ? '抓取中...' : '抓取内容'}
            </button>
            {urlResults.length > 0 && (
              <div className="space-y-2 max-h-48 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {urlResults.map((r, i) => (
                  <div key={i} className={`rounded-lg border p-2.5 text-[10px] transition-colors ${
                    r.error ? 'border-rose-500/30 bg-rose-500/5' : r.selected ? 'border-primary/30 bg-primary/5' : 'border-[var(--color-outline)]/20 bg-[var(--color-bg)]'
                  }`}>
                    <div className="flex items-center gap-2 mb-1">
                      {!r.error && (
                        <input type="checkbox" checked={r.selected}
                          onChange={() => {
                            const next = [...urlResults];
                            next[i] = { ...next[i], selected: !next[i].selected };
                            setUrlResults(next);
                          }}
                          className="accent-primary w-3 h-3 cursor-pointer" />
                      )}
                      <span className="font-bold text-on-surface truncate flex-1">{r.title || r.url}</span>
                      {!r.error && <span className="text-on-surface/40 shrink-0">{r.charCount} 字符</span>}
                    </div>
                    {r.error ? (
                      <span className="text-rose-400">{r.error}</span>
                    ) : (
                      <div className="text-on-surface/50 line-clamp-3 leading-relaxed">{r.content.slice(0, 300)}...</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'file':
        return (
          <div className="space-y-3">
            <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }}
              onChange={handleFileSelect}
              accept=".txt,.md,.json,.py,.ts,.tsx,.js,.jsx,.java,.go,.rs,.yaml,.yml,.toml,.log,.css,.html,.sql,.sh,.bat,.env,.cfg,.conf,.xml,.csv" />
            <div className="flex flex-col items-center justify-center gap-2 p-6 rounded-lg border border-dashed border-[var(--color-outline)]/25 bg-[var(--color-bg)]"
              style={{ outline: 'none', WebkitTapHighlightColor: 'transparent' }}>
              <Upload className="w-6 h-6 text-on-surface/30" />
              <span className="text-[11px] text-on-surface/50">点击下方按钮选择文件</span>
              <button type="button" onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 rounded-lg text-[11px] font-bold border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer transition-colors">
                选择文件
              </button>
              <span className="text-[9px] text-on-surface/30">支持 txt/md/json/py/ts/js/java/go/rs/yaml 等文本文件</span>
            </div>
            {fileChunks.length > 0 && (
              <div className="space-y-1.5 max-h-48 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="flex items-center justify-between text-[10px] text-on-surface/50 font-mono">
                  <span>{fileChunks.length} 个片段</span>
                  <button type="button" onClick={() => setFileChunks([])}
                    className="text-rose-400 hover:text-rose-300 text-[9px] cursor-pointer">清空</button>
                </div>
                {fileChunks.map((c, i) => (
                  <div key={i} className={`flex items-start gap-2 p-2 rounded-lg border text-[10px] transition-colors ${
                    c.selected ? 'border-primary/30 bg-primary/5' : 'border-[var(--color-outline)]/15 opacity-50'
                  }`}>
                    <input type="checkbox" checked={c.selected}
                      onChange={() => {
                        const next = [...fileChunks];
                        next[i] = { ...next[i], selected: !next[i].selected };
                        setFileChunks(next);
                      }}
                      className="accent-primary w-3 h-3 mt-0.5 shrink-0 cursor-pointer" />
                    <div className="flex-1 min-w-0">
                      <span className="font-bold text-on-surface">{c.fileName}</span>
                      {fileChunks.filter(f => f.fileName === c.fileName).length > 1 && (
                        <span className="text-on-surface/40 ml-1">#{c.index + 1}</span>
                      )}
                      <div className="text-on-surface/40 mt-0.5 line-clamp-2 font-mono leading-relaxed">{c.content.slice(0, 200)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'code':
        return (
          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider font-mono mb-1 block">
                  语言
                </label>
                <CustomSelect
                  value={codeLang}
                  onChange={setCodeLang}
                  options={CODE_LANGUAGES}
                />
              </div>
              <div className="flex-[2]">
                <label className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider font-mono mb-1 block">
                  描述 (可选)
                </label>
                <input type="text" value={codeDesc} onChange={(e) => setCodeDesc(e.target.value)}
                  placeholder="这段代码实现了什么功能..."
                  className="w-full px-3 py-1.5 text-[11px] rounded-lg bg-[var(--color-bg)] border border-[var(--color-outline)]/20 text-on-surface placeholder:text-on-surface/25 focus:outline-none focus:border-primary/40 transition-colors" />
              </div>
            </div>
            <div>
              <label className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider font-mono mb-1 block">
                代码内容
              </label>
              <textarea value={codeContent} onChange={(e) => setCodeContent(e.target.value)}
                placeholder="粘贴代码片段..."
                className="w-full h-40 px-3 py-2 text-[11px] rounded-lg bg-[var(--color-bg)] border border-[var(--color-outline)]/20 text-on-surface placeholder:text-on-surface/25 resize-none focus:outline-none focus:border-primary/40 transition-colors font-mono leading-relaxed" />
            </div>
          </div>
        );
    }
  };

  return (
    <div className="rounded-xl border border-[var(--color-outline)]/25 bg-[var(--color-surface)] overflow-hidden">
      {/* Header + Tab Bar */}
      <div className="border-b border-[var(--color-outline)]/20 bg-[var(--color-bg)]">
        <div className="flex items-center justify-between p-3 pb-0">
          <div className="flex items-center gap-2">
            <Database className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-bold text-[var(--color-on-surface)]">投喂训练数据</span>
          </div>
        </div>
        <div className="flex gap-0.5 px-3 pt-2">
          {FEED_TABS.map(tab => {
            const TabIcon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-t-lg text-[10px] font-bold border border-b-0 transition-colors ${
                  isActive
                    ? 'border-[var(--color-outline)]/20 bg-[var(--color-surface)] text-primary'
                    : 'border-transparent text-on-surface/40 hover:text-on-surface/60 cursor-pointer'
                }`}>
                <TabIcon className="w-3 h-3" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-3 space-y-3">
        {/* Tab 内容区 */}
        {renderTabContent()}

        {/* 反馈类型 + 备注 (共享) */}
        <div className="flex gap-3 pt-1 border-t border-[var(--color-outline)]/10">
          <div className="flex-1">
            <label className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider font-mono mb-1.5 block">
              反馈标记
            </label>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => setPositive(true)}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-bold border transition-colors ${
                  positive ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
                    : 'border-[var(--color-outline)]/20 text-on-surface/40 hover:bg-[var(--color-surface-bright)]/40'
                }`}>
                <ThumbsUp className="w-3 h-3" /> 正向
              </button>
              <button type="button" onClick={() => setPositive(false)}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-bold border transition-colors ${
                  !positive ? 'border-rose-500/40 bg-rose-500/15 text-rose-400'
                    : 'border-[var(--color-outline)]/20 text-on-surface/40 hover:bg-[var(--color-surface-bright)]/40'
                }`}>
                <ThumbsDown className="w-3 h-3" /> 负向
              </button>
            </div>
          </div>
          <div className="flex-1">
            <label className="text-[10px] text-on-surface/50 font-bold uppercase tracking-wider font-mono mb-1.5 block">
              备注 (可选)
            </label>
            <input type="text" value={comment} onChange={(e) => setComment(e.target.value)}
              placeholder="补充说明..."
              className="w-full px-3 py-1.5 text-[11px] rounded-lg bg-[var(--color-bg)] border border-[var(--color-outline)]/20 text-on-surface placeholder:text-on-surface/25 focus:outline-none focus:border-primary/40 transition-colors" />
          </div>
        </div>

        {/* 结果提示 */}
        {result && (
          <div className={`p-2 rounded-lg text-[10px] font-mono ${
            result.type === 'success' ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              : 'border border-rose-500/30 bg-rose-500/10 text-rose-400'
          }`}>{result.text}</div>
        )}

        {/* 操作按钮 */}
        <div className="flex gap-2 pt-1">
          <button type="button" disabled={!canSubmit || submitting} onClick={() => submitFeedback(false)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-bold border transition-colors ${
              canSubmit && !submitting ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer'
                : 'border-[var(--color-outline)]/15 text-on-surface/25 cursor-not-allowed'
            }`}>
            <Database className="w-3 h-3" />
            {submitting ? '提交中...' : '仅入库'}
          </button>
          <button type="button" disabled={!canSubmit || submitting} onClick={() => submitFeedback(true)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-bold border transition-colors ${
              canSubmit && !submitting ? 'border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 cursor-pointer'
                : 'border-[var(--color-outline)]/15 text-on-surface/25 cursor-not-allowed'
            }`}>
            <Send className="w-3 h-3" />
            {submitting ? '提交中...' : '入库并触发优化'}
          </button>
        </div>

        {/* 模型选择器 (仅当有可用模型时显示) */}
        {availableModels.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-on-surface/50 font-mono shrink-0">优化用模型:</span>
            <div className="flex-1">
              <CustomSelect
                value={selectedModelId}
                onChange={setSelectedModelId}
                options={availableModels.map(m => ({ value: m.id, label: m.name }))}
              />
            </div>
          </div>
        )}

        <p className="text-[9px] text-on-surface/30 leading-relaxed">
          「仅入库」将案例写入经验库，Agent 下次执行时自动检索作为 few-shot 参考。
          「入库并触发优化」使用所选模型分析当前 prompt 弱点并尝试改进。
        </p>
      </div>
    </div>
  );
}
