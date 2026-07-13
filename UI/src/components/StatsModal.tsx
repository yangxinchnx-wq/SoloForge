import { useState, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import {
  X, BarChart3, TrendingUp, Clock,
  Database, MessageSquare, Flame, Cpu, Zap,
  Activity, Gauge, HardDrive, LineChart as LineChartIcon, Brain, Search, Download
} from '../utils/icons';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  PieChart as RePieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip as ReChartsTooltip,
  CartesianGrid,
  BarChart,
  Bar,
  LineChart,
  Line,
  Legend
} from 'recharts';
import { uiMessageStore } from '../services/uiMessageStore';
import { useChatsStore } from '../state/chatsStore';
import {
  onPerfSample, FPSCounter, sampleMemory,
  type FPSSample, type LatencySample, type MemorySample
} from '../services/perfMonitor';
import type { UIUsagePart } from '../types/messages';

interface StatsModalProps {
  onClose: () => void;
}

// ─── 颜色 & 样式常量 ───
const MODEL_COLORS = ['#3b82f6', '#4cf0b5', '#f59e0b', '#a855f7'];
const getModelColor = (idx: number) => MODEL_COLORS[idx % MODEL_COLORS.length];

const TOOLTIP_STYLE: CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-outline)',
  borderRadius: '8px',
  color: 'var(--color-on-surface)',
};

const TOOLTIP_LABEL_STYLE: CSSProperties = {
  color: 'var(--color-primary)',
  fontWeight: 'bold',
};

const TOOLTIP_ITEM_STYLE: CSSProperties = {
  color: 'var(--color-on-surface)',
};

// ─── 类型定义 ───
interface UsageEntry {
  chatId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model?: string;
  timestamp: number;
}

interface ChatAgg {
  chatId: string;
  title: string;
  createdAt: number;
  rounds: number;
  messageCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  models: string[];
}

interface ModelAgg {
  model: string;
  callCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  pct: number;
  avgTtft: number | null;
}

interface TimeBucket {
  label: string;
  prompt: number;
  completion: number;
  total: number;
}

// ─── 辅助函数 ───
const formatRelativeTime = (ts: number): string => {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
};

const formatClock = (ts: number): string => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

const formatNumber = (n: number): string => n.toLocaleString();

const formatBytes = (bytes?: number): string => {
  if (bytes === undefined || bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// ─── 空态组件 ───
function EmptyState({ message = '暂无数据，开始对话后这里会显示统计' }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[160px] text-center text-on-surface/40 py-12">
      <Database className="w-8 h-8 mb-2 opacity-50" />
      <p className="text-xs">{message}</p>
    </div>
  );
}

// ─── 主组件 ───
export default function StatsModal({ onClose }: StatsModalProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'conversations' | 'models' | 'performance'>('overview');
  const [version, setVersion] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'tokens' | 'time'>('tokens');

  const [liveTelemetry, setLiveTelemetry] = useState<{
    cpu: number;
    memoryUsed: number;
    memoryTotal: number;
    memoryPercent: number;
  } | null>(null);

  const [fps, setFps] = useState<number | null>(null);
  const [fpsSamples, setFpsSamples] = useState<FPSSample[]>([]);
  const [latencySamples, setLatencySamples] = useState<LatencySample[]>([]);
  const [llmLatencySamples, setLlmLatencySamples] = useState<LatencySample[]>([]);
  const [memorySample, setMemorySample] = useState<MemorySample | null>(null);

  const fpsCounterRef = useRef<FPSCounter | null>(null);
  const memIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 订阅 uiMessageStore 变化
  useEffect(() => {
    const unsub = uiMessageStore.subscribe(() => setVersion(v => v + 1));
    return unsub;
  }, []);

  // 订阅 liveTelemetry
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) setLiveTelemetry(detail);
    };
    window.addEventListener('soloforge-live-telemetry', handler);
    return () => window.removeEventListener('soloforge-live-telemetry', handler);
  }, []);

  // 订阅 perfMonitor + 启动 FPS & 内存采样
  useEffect(() => {
    const counter = new FPSCounter((newFps) => {
      setFps(newFps);
    });
    counter.start();
    fpsCounterRef.current = counter;

    const memInterval = setInterval(() => {
      const s = sampleMemory();
      if (s) setMemorySample(s);
    }, 2000);
    memIntervalRef.current = memInterval;

    const unsub = onPerfSample((sample) => {
      if ('fps' in sample) {
        setFpsSamples(prev => {
          const next = [...prev, sample as FPSSample];
          return next.length > 60 ? next.slice(-60) : next;
        });
      } else if ('ttfb' in sample) {
        const ls = sample as LatencySample;
        setLatencySamples(prev => {
          const next = [...prev, ls];
          return next.length > 30 ? next.slice(-30) : next;
        });
        const opLower = ls.op.toLowerCase();
        if (opLower.includes('llm-stream') || opLower.includes('llm-proxy')) {
          setLlmLatencySamples(prev => {
            const next = [...prev, ls];
            return next.length > 10 ? next.slice(-10) : next;
          });
        }
      } else if ('usedJSHeapMB' in sample) {
        setMemorySample(sample as MemorySample);
      }
    });

    return () => {
      counter.stop();
      if (memIntervalRef.current) clearInterval(memIntervalRef.current);
      unsub();
    };
  }, []);

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [onClose]);

  // 响应式获取 chats
  const chats = useChatsStore((s) => s.chats);

  // ─── 数据聚合 ───
  const aggregated = useMemo(() => {
    const all = uiMessageStore.getAllMessages();
    const usageEntries: UsageEntry[] = [];
    const chatAggs: ChatAgg[] = [];
    let totalMessages = 0;

    for (const [chatId, messages] of all) {
      totalMessages += messages.length;
      let chatTotalTokens = 0;
      let chatPromptTokens = 0;
      let chatCompletionTokens = 0;
      let rounds = 0;
      const modelSet = new Set<string>();

      for (const msg of messages) {
        if (msg.role === 'user') rounds++;
        for (const part of msg.parts) {
          if (part.type === 'usage') {
            const u = part as UIUsagePart;
            usageEntries.push({
              chatId,
              promptTokens: u.promptTokens,
              completionTokens: u.completionTokens,
              totalTokens: u.totalTokens,
              model: u.model,
              timestamp: u.timestamp,
            });
            chatTotalTokens += u.totalTokens;
            chatPromptTokens += u.promptTokens;
            chatCompletionTokens += u.completionTokens;
            if (u.model) modelSet.add(u.model);
          }
        }
      }

      const chat = chats.find(c => c.id === chatId);
      chatAggs.push({
        chatId,
        title: chat?.title || `会话 ${chatId.slice(-6)}`,
        createdAt: chat?.createdAt ?? (messages[0]?.createdAt ?? Date.now()),
        rounds,
        messageCount: messages.length,
        totalTokens: chatTotalTokens,
        promptTokens: chatPromptTokens,
        completionTokens: chatCompletionTokens,
        models: Array.from(modelSet),
      });
    }

    chatAggs.sort((a, b) => b.totalTokens - a.totalTokens);
    return { usageEntries, chatAggs, totalMessages };
  }, [version, chats]);

  const { usageEntries, chatAggs, totalMessages } = aggregated;

  const totalTokens = useMemo(() => usageEntries.reduce((s, u) => s + u.totalTokens, 0), [usageEntries]);
  const totalPrompt = useMemo(() => usageEntries.reduce((s, u) => s + u.promptTokens, 0), [usageEntries]);
  const totalCompletion = useMemo(() => usageEntries.reduce((s, u) => s + u.completionTokens, 0), [usageEntries]);
  const chatsWithTokens = useMemo(() => chatAggs.filter(c => c.totalTokens > 0).length, [chatAggs]);
  const avgTokensPerChat = chatsWithTokens > 0 ? totalTokens / chatsWithTokens : 0;
  const hasTokenData = usageEntries.length > 0;

  const modelAggs = useMemo<ModelAgg[]>(() => {
    const byModel = new Map<string, { count: number; total: number; prompt: number; completion: number }>();
    for (const u of usageEntries) {
      const key = u.model || '未知';
      const existing = byModel.get(key) ?? { count: 0, total: 0, prompt: 0, completion: 0 };
      existing.count++;
      existing.total += u.totalTokens;
      existing.prompt += u.promptTokens;
      existing.completion += u.completionTokens;
      byModel.set(key, existing);
    }
    const grandTotal = Array.from(byModel.values()).reduce((s, m) => s + m.total, 0);

    // 按模型名匹配 LatencySample 的 TTFT
    const ttftByModel = new Map<string, number[]>();
    for (const s of latencySamples) {
      const opLower = s.op.toLowerCase();
      for (const [modelName] of byModel) {
        if (modelName !== '未知' && opLower.includes(modelName.toLowerCase())) {
          const arr = ttftByModel.get(modelName) ?? [];
          arr.push(s.ttfb);
          ttftByModel.set(modelName, arr);
        }
      }
    }

    return Array.from(byModel.entries())
      .map(([model, agg]) => {
        const ttfts = ttftByModel.get(model);
        const avgTtft = ttfts && ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null;
        return {
          model,
          callCount: agg.count,
          totalTokens: agg.total,
          promptTokens: agg.prompt,
          completionTokens: agg.completion,
          pct: grandTotal > 0 ? (agg.total / grandTotal) * 100 : 0,
          avgTtft,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }, [usageEntries, latencySamples]);

  const timeBuckets = useMemo<TimeBucket[]>(() => {
    if (usageEntries.length === 0) return [];
    const buckets = new Map<string, TimeBucket & { ts: number }>();
    const minTs = Math.min(...usageEntries.map(u => u.timestamp));
    const maxTs = Math.max(...usageEntries.map(u => u.timestamp));
    const spansDays = new Date(minTs).toDateString() !== new Date(maxTs).toDateString();

    for (const u of usageEntries) {
      const d = new Date(u.timestamp);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
      const label = spansDays
        ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`
        : `${String(d.getHours()).padStart(2, '0')}:00`;
      const existing = buckets.get(key) ?? { label, prompt: 0, completion: 0, total: 0, ts: u.timestamp };
      existing.prompt += u.promptTokens;
      existing.completion += u.completionTokens;
      existing.total += u.totalTokens;
      buckets.set(key, existing);
    }
    return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
  }, [usageEntries]);

  const modelPieData = useMemo(() =>
    modelAggs.map((m, idx) => ({
      name: m.model,
      value: m.totalTokens,
      color: getModelColor(idx),
    })),
    [modelAggs]
  );

  const modelBarData = useMemo(() =>
    modelAggs.map(m => ({
      name: m.model.length > 15 ? m.model.slice(0, 13) + '…' : m.model,
      prompt: m.promptTokens,
      completion: m.completionTokens,
    })),
    [modelAggs]
  );

  const top5Chats = useMemo(() => chatAggs.filter(c => c.totalTokens > 0).slice(0, 5), [chatAggs]);

  const filteredChats = useMemo(() => {
    if (!searchQuery.trim()) return chatAggs;
    const q = searchQuery.toLowerCase();
    return chatAggs.filter(c => c.title.toLowerCase().includes(q));
  }, [chatAggs, searchQuery]);

  const sortedChats = useMemo(() => {
    const arr = [...filteredChats];
    if (sortBy === 'tokens') {
      arr.sort((a, b) => b.totalTokens - a.totalTokens);
    } else {
      arr.sort((a, b) => b.createdAt - a.createdAt);
    }
    return arr;
  }, [filteredChats, sortBy]);

  const fpsChartData = useMemo(() =>
    fpsSamples.map(s => ({
      time: formatClock(s.timestamp),
      fps: s.fps,
    })),
    [fpsSamples]
  );

  const latencyChartData = useMemo(() =>
    latencySamples.map(s => ({
      time: formatClock(s.timestamp),
      ttfb: s.ttfb,
      total: s.total,
    })),
    [latencySamples]
  );

  const frameTime = fps && fps > 0 ? (1000 / fps).toFixed(1) : null;

  // ─── CSV 导出 ───
  const handleExportCSV = () => {
    const lines: string[] = [];
    lines.push('\uFEFF');
    lines.push(`"AI与Token审计报告 - 当前会话统计"`);
    lines.push(`"导出时间","${new Date().toLocaleString()}"`);
    lines.push(`"总会话数","${chats.length}"`);
    lines.push(`"总消息数","${totalMessages}"`);
    lines.push(`"总消耗 Tokens","${totalTokens}"`);
    lines.push(`"输入 (Prompt) Tokens","${totalPrompt}"`);
    lines.push(`"生成 (Completion) Tokens","${totalCompletion}"`);
    lines.push('');
    lines.push(`"时间序列流量数据"`);
    lines.push(`"时间点","Prompt Tokens","Completion Tokens","总计 Tokens"`);
    timeBuckets.forEach(item => {
      lines.push(`"${item.label}","${item.prompt}","${item.completion}","${item.total}"`);
    });
    lines.push('');
    lines.push(`"会话消耗细目审计"`);
    lines.push(`"会话标题","轮次","消息数","Prompt Tokens","Completion Tokens","总计 Tokens","模型"`);
    chatAggs.forEach(c => {
      lines.push(`"${c.title.replace(/"/g, '""')}","${c.rounds}","${c.messageCount}","${c.promptTokens}","${c.completionTokens}","${c.totalTokens}","${c.models.join(' / ')}"`);
    });
    lines.push('');
    lines.push(`"模型使用占比"`);
    lines.push(`"模型名称","调用次数","消耗 Tokens","Prompt Tokens","Completion Tokens","占比(%)"`);
    modelAggs.forEach(m => {
      lines.push(`"${m.model}","${m.callCount}","${m.totalTokens}","${m.promptTokens}","${m.completionTokens}","${m.pct.toFixed(2)}%"`);
    });

    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Token_Audit_Report_${new Date().toISOString().slice(0, 10)}.csv`;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ─── 渲染 ───
  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-[1000] p-4 font-sans overflow-hidden animate-fadeIn cursor-pointer"
      style={{
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
      }}
      onClick={onClose}
    >
      <div
        className="sf-anim sf-anim-fade-scale w-full max-w-5xl bg-bg border border-outline rounded-2xl shadow-2xl flex flex-col h-[82vh] md:h-[78vh] overflow-hidden select-none text-on-surface relative z-[1001] cursor-default"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-bg border-b border-outline px-6 py-4.5 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-xl border border-primary/20">
              <BarChart3 className="text-primary w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h2 className="text-base font-bold text-on-surface tracking-wide">AI 与 Token 审计统计中心</h2>
              <p className="text-xs text-on-surface/50 mt-0.5 font-mono">
                当前会话统计 · 监控大模型 Token 吞吐结构与其响应速度、以及会话流量占比
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleExportCSV}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/30 hover:border-primary/60 bg-primary/5 hover:bg-primary/10 text-primary hover:text-primary text-xs font-semibold transition-all cursor-pointer active:scale-95"
              title="导出当前会话的 Token 消耗数据"
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出 CSV</span>
            </button>

            <button
              onClick={onClose}
              className="text-on-surface/60 hover:text-on-surface hover:bg-on-surface/5 p-2 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar */}
          <div className="w-[180px] md:w-[220px] bg-bg border-r border-outline flex flex-col p-4 shrink-0 justify-between">
            <div className="space-y-1">
              <span className="text-[10px] text-primary/65 px-2.5 py-1 font-mono font-bold tracking-wider uppercase block mb-2">
                审计导航栏
              </span>

              <button
                onClick={() => setActiveTab('overview')}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold text-left transition-all cursor-pointer relative overflow-hidden group"
              >
                {activeTab === 'overview' && (
                  <div className="absolute inset-0 bg-primary/10 border border-primary/20 rounded-lg" />
                )}
                <span className={`relative z-10 flex items-center gap-2.5 ${activeTab === 'overview' ? 'text-primary' : 'text-on-surface/60'}`}>
                  <TrendingUp className="w-4 h-4 shrink-0" />
                  <span>概要趋势分析</span>
                </span>
              </button>

              <button
                onClick={() => setActiveTab('conversations')}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold text-left transition-all cursor-pointer relative overflow-hidden group"
              >
                {activeTab === 'conversations' && (
                  <div className="absolute inset-0 bg-primary/10 border border-primary/20 rounded-lg" />
                )}
                <span className={`relative z-10 flex items-center gap-2.5 ${activeTab === 'conversations' ? 'text-primary' : 'text-on-surface/60'}`}>
                  <MessageSquare className="w-4 h-4 shrink-0" />
                  <span>各会话消耗审计</span>
                </span>
              </button>

              <button
                onClick={() => setActiveTab('models')}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold text-left transition-all cursor-pointer relative overflow-hidden group"
              >
                {activeTab === 'models' && (
                  <div className="absolute inset-0 bg-primary/10 border border-primary/20 rounded-lg" />
                )}
                <span className={`relative z-10 flex items-center gap-2.5 ${activeTab === 'models' ? 'text-primary' : 'text-on-surface/60'}`}>
                  <Cpu className="w-4 h-4 shrink-0" />
                  <span>各 AI 模型详情</span>
                </span>
              </button>

              <button
                onClick={() => setActiveTab('performance')}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold text-left transition-all cursor-pointer relative overflow-hidden group"
              >
                {activeTab === 'performance' && (
                  <div className="absolute inset-0 bg-primary/10 border border-primary/20 rounded-lg" />
                )}
                <span className={`relative z-10 flex items-center gap-2.5 ${activeTab === 'performance' ? 'text-primary' : 'text-on-surface/60'}`}>
                  <Activity className="w-4 h-4 shrink-0" />
                  <span>容器与性能审计</span>
                </span>
              </button>
            </div>

            {/* 实时数据摘要 */}
            <div className="bg-surface border border-outline rounded-xl p-3 space-y-1.5">
              <span className="text-[9px] text-primary/70 font-mono tracking-wide uppercase font-bold block">
                核载概要
              </span>
              <div className="flex items-center justify-between text-[11px] text-on-surface/70">
                <span>总 Token:</span>
                <span className="text-on-surface font-mono font-bold">{formatNumber(totalTokens)}</span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-on-surface/70">
                <span>会话数:</span>
                <span className="text-on-surface font-mono font-bold">{chats.length}</span>
              </div>
              {modelAggs[0] && (
                <div className="flex items-center justify-between text-[11px] text-on-surface/70">
                  <span>主力模型:</span>
                  <span className="text-on-surface font-mono font-bold truncate max-w-[100px]">{modelAggs[0].model}</span>
                </div>
              )}
              <div className="h-1 bg-on-surface/10 rounded-full overflow-hidden mt-1">
                <div
                  className="bg-primary h-full transition-all"
                  style={{ width: `${hasTokenData ? Math.min(100, (totalTokens / Math.max(1, totalTokens)) * 100) : 0}%` }}
                />
              </div>
            </div>
          </div>

          {/* Main Panel */}
          <div className="flex-1 bg-bg p-6 overflow-y-auto scrollbar-thin">
            <div key={activeTab} className="sf-anim sf-anim-slide-right space-y-6 min-h-full">

              {/* ════ Tab 1: 概要趋势分析 ════ */}
              {activeTab === 'overview' && (
                <div className="space-y-6">
                  {/* KPI 卡片 */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-surface border border-outline rounded-xl p-4 space-y-1 relative overflow-hidden group">
                      <div className="absolute top-3 right-3 p-1.5 bg-primary/10 rounded-lg group-hover:scale-115 transition-transform">
                        <Flame className="w-4 h-4 text-primary" />
                      </div>
                      <span className="text-xs text-on-surface/50 font-medium">总 Token 消耗</span>
                      <h3 className="text-lg md:text-xl font-mono font-bold text-primary mt-1">
                        {hasTokenData ? formatNumber(totalTokens) : '—'}
                      </h3>
                      <div className="text-[10px] text-on-surface/40 font-mono pt-1">
                        Prompt {formatNumber(totalPrompt)} · Completion {formatNumber(totalCompletion)}
                      </div>
                    </div>

                    <div className="bg-surface border border-outline rounded-xl p-4 space-y-1 relative overflow-hidden group">
                      <div className="absolute top-3 right-3 p-1.5 bg-blue-500/10 rounded-lg group-hover:scale-115 transition-transform">
                        <Database className="w-4 h-4 text-blue-400" />
                      </div>
                      <span className="text-xs text-on-surface/50 font-medium">总会话数</span>
                      <h3 className="text-lg md:text-xl font-mono font-bold text-blue-400 mt-1">
                        {chats.length}
                      </h3>
                      <div className="text-[10px] text-on-surface/40 font-mono pt-1">
                        含 token 会话 {chatsWithTokens} 个
                      </div>
                    </div>

                    <div className="bg-surface border border-outline rounded-xl p-4 space-y-1 relative overflow-hidden group">
                      <div className="absolute top-3 right-3 p-1.5 bg-[#4cf0b5]/10 rounded-lg group-hover:scale-115 transition-transform">
                        <MessageSquare className="w-4 h-4 text-[#4cf0b5]" />
                      </div>
                      <span className="text-xs text-on-surface/50 font-medium">总消息数</span>
                      <h3 className="text-lg md:text-xl font-mono font-bold text-[#4cf0b5] mt-1">
                        {formatNumber(totalMessages)}
                      </h3>
                      <div className="text-[10px] text-on-surface/40 font-mono pt-1">
                        跨 {chats.length} 个会话
                      </div>
                    </div>

                    <div className="bg-surface border border-outline rounded-xl p-4 space-y-1 relative overflow-hidden group">
                      <div className="absolute top-3 right-3 p-1.5 bg-orange-500/10 rounded-lg group-hover:scale-115 transition-transform">
                        <TrendingUp className="w-4 h-4 text-orange-400" />
                      </div>
                      <span className="text-xs text-on-surface/50 font-medium">平均每会话 Token</span>
                      <h3 className="text-lg md:text-xl font-mono font-bold text-orange-400 mt-1">
                        {chatsWithTokens > 0 ? formatNumber(Math.round(avgTokensPerChat)) : '—'}
                      </h3>
                      <div className="text-[10px] text-on-surface/40 font-mono pt-1">
                        基于 {chatsWithTokens} 个有 token 会话
                      </div>
                    </div>
                  </div>

                  {/* Token 趋势图 */}
                  <div className="bg-surface border border-outline rounded-xl p-5 space-y-4">
                    <div className="flex items-center justify-between border-b border-on-surface/5 pb-3">
                      <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-primary" />
                        <span className="text-xs font-bold text-on-surface uppercase tracking-wider">
                          Token 趋势分析 (按小时分桶)
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-[10.5px] font-mono text-on-surface/60">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-[#3b82f6]" />
                          <span>Prompt 输入</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--color-primary)' }} />
                          <span>Completion 生成</span>
                        </div>
                      </div>
                    </div>

                    <div className="h-[240px] w-full text-xs font-mono">
                      {timeBuckets.length > 0 ? (
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={timeBuckets} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-outline)" strokeOpacity={0.3} vertical={false} />
                            <XAxis
                              dataKey="label"
                              stroke="var(--color-on-surface)"
                              strokeOpacity={0.4}
                              tickLine={false}
                              axisLine={false}
                              dy={10}
                              style={{ fontSize: 10 }}
                            />
                            <YAxis
                              stroke="var(--color-on-surface)"
                              strokeOpacity={0.4}
                              tickLine={false}
                              axisLine={false}
                              style={{ fontSize: 10 }}
                              tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                            />
                            <ReChartsTooltip
                              contentStyle={TOOLTIP_STYLE}
                              labelStyle={TOOLTIP_LABEL_STYLE}
                              itemStyle={TOOLTIP_ITEM_STYLE}
                            />
                            <Area
                              type="monotone"
                              dataKey="prompt"
                              name="Prompt"
                              stroke="#3b82f6"
                              fill="#3b82f6"
                              fillOpacity={0.3}
                              strokeWidth={2}
                              animationDuration={800}
                            />
                            <Area
                              type="monotone"
                              dataKey="completion"
                              name="Completion"
                              stroke="var(--color-primary)"
                              fill="var(--color-primary)"
                              fillOpacity={0.3}
                              strokeWidth={2}
                              animationDuration={1000}
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      ) : (
                        <EmptyState />
                      )}
                    </div>
                  </div>

                  {/* 模型占比 + 高消耗会话 Top 5 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* 模型占比饼图 */}
                    <div className="bg-surface border border-outline rounded-xl p-5 space-y-3">
                      <span className="text-xs font-bold text-on-surface uppercase tracking-wider block border-b border-on-surface/5 pb-2">
                        模型 Token 占比
                      </span>
                      {modelPieData.length > 0 ? (
                        <div className="h-[220px] w-full">
                          <ResponsiveContainer width="100%" height="100%">
                            <RePieChart>
                              <Pie
                                data={modelPieData}
                                dataKey="value"
                                nameKey="name"
                                cx="50%"
                                cy="50%"
                                outerRadius={75}
                                innerRadius={40}
                                label={({ percent }) => `${(percent * 100).toFixed(0)}%`}
                                labelLine={false}
                                style={{ fontSize: 10 }}
                              >
                                {modelPieData.map((entry, idx) => (
                                  <Cell key={idx} fill={entry.color} />
                                ))}
                              </Pie>
                              <ReChartsTooltip
                                contentStyle={TOOLTIP_STYLE}
                                labelStyle={TOOLTIP_LABEL_STYLE}
                                itemStyle={TOOLTIP_ITEM_STYLE}
                              />
                              <Legend wrapperStyle={{ fontSize: 10 }} />
                            </RePieChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <EmptyState />
                      )}
                    </div>

                    {/* 高消耗会话 Top 5 */}
                    <div className="bg-surface border border-outline rounded-xl p-5 space-y-3">
                      <span className="text-xs font-bold text-on-surface uppercase tracking-wider block border-b border-on-surface/5 pb-2">
                        高消耗会话 Top 5
                      </span>
                      {top5Chats.length > 0 ? (
                        <div className="space-y-2.5 text-xs">
                          {top5Chats.map((c, idx) => (
                            <div key={c.chatId} className="flex justify-between items-center p-2 bg-bg border border-on-surface/5 rounded-lg hover:border-primary/20 transition-colors">
                              <div className="truncate max-w-[60%]">
                                <span className="font-semibold text-on-surface block truncate">
                                  <span className="text-primary/60 font-mono">#{idx + 1}</span> {c.title}
                                </span>
                                <span className="text-[10px] text-on-surface/45 font-mono">{c.rounds} 轮 · {c.models.join(' / ') || '未知模型'}</span>
                              </div>
                              <div className="text-right shrink-0">
                                <span className="font-mono text-primary font-bold block">
                                  {formatNumber(c.totalTokens)}
                                </span>
                                <span className="text-[10px] text-on-surface/40 font-mono">Tokens</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <EmptyState />
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ════ Tab 2: 各会话消耗审计 ════ */}
              {activeTab === 'conversations' && (
                <div className="space-y-5">
                  <div className="border-b border-outline pb-3 mb-2">
                    <h3 className="text-base font-bold text-on-surface">会话全谱消耗细目审计</h3>
                    <p className="text-xs text-on-surface/50 mt-1">按会话主题、运行模型、轮次进行 Token 精准审计</p>
                  </div>

                  {/* 搜索 + 排序 */}
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 bg-surface border border-outline rounded-lg px-3 py-1.5 w-full sm:w-64">
                      <Search className="w-3.5 h-3.5 text-on-surface/40 shrink-0" />
                      <input
                        type="text"
                        placeholder="搜索会话标题..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="bg-transparent text-xs text-on-surface placeholder:text-on-surface/30 focus:outline-none w-full"
                      />
                    </div>
                    <div className="flex bg-surface-bright/40 border border-outline rounded-lg p-0.5 text-xs font-semibold">
                      <button
                        onClick={() => setSortBy('tokens')}
                        className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${sortBy === 'tokens' ? 'bg-primary text-black font-extrabold' : 'text-on-surface/60 hover:text-on-surface'}`}
                      >
                        按 Token
                      </button>
                      <button
                        onClick={() => setSortBy('time')}
                        className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${sortBy === 'time' ? 'bg-primary text-black font-extrabold' : 'text-on-surface/60 hover:text-on-surface'}`}
                      >
                        按时间
                      </button>
                    </div>
                  </div>

                  {/* 会话表格 */}
                  {sortedChats.length > 0 ? (
                    <div className="bg-surface border border-outline rounded-xl overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead>
                            <tr className="border-b border-outline text-on-surface/50 bg-surface-bright/40">
                              <th className="px-4 py-3 font-semibold">会话标题</th>
                              <th className="px-4 py-3 font-semibold cursor-pointer hover:text-on-surface transition-colors" onClick={() => setSortBy('time')}>
                                创建时间 {sortBy === 'time' && '↓'}
                              </th>
                              <th className="px-4 py-3 font-semibold text-right">轮次</th>
                              <th className="px-4 py-3 font-semibold text-right cursor-pointer hover:text-on-surface transition-colors" onClick={() => setSortBy('tokens')}>
                                Token 总量 {sortBy === 'tokens' && '↓'}
                              </th>
                              <th className="px-4 py-3 font-semibold text-right">Prompt / Completion</th>
                              <th className="px-4 py-3 font-semibold">模型</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-on-surface/5">
                            {sortedChats.map((c) => (
                              <tr key={c.chatId} className="hover:bg-surface-bright/40 transition-colors">
                                <td className="px-4 py-3">
                                  <span className="font-semibold text-on-surface block truncate max-w-[200px]">{c.title}</span>
                                  <span className="text-[10px] text-on-surface/40 font-mono">{c.messageCount} 条消息</span>
                                </td>
                                <td className="px-4 py-3 text-on-surface/70 font-mono text-[11px]">
                                  {formatRelativeTime(c.createdAt)}
                                </td>
                                <td className="px-4 py-3 text-right font-mono text-on-surface/80">{c.rounds}</td>
                                <td className="px-4 py-3 text-right">
                                  <span className="font-mono font-bold text-primary">{formatNumber(c.totalTokens)}</span>
                                </td>
                                <td className="px-4 py-3 text-right font-mono text-[11px] text-on-surface/60">
                                  <span className="text-[#3b82f6]">{formatNumber(c.promptTokens)}</span>
                                  <span className="text-on-surface/30"> / </span>
                                  <span className="text-[#4cf0b5]">{formatNumber(c.completionTokens)}</span>
                                </td>
                                <td className="px-4 py-3">
                                  <div className="flex flex-wrap gap-1">
                                    {c.models.length > 0 ? c.models.map((m, i) => (
                                      <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 font-mono">
                                        {m}
                                      </span>
                                    )) : (
                                      <span className="text-[10px] text-on-surface/30">—</span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-surface border border-outline rounded-xl">
                      <EmptyState message={searchQuery ? '没有匹配的会话' : '暂无会话数据'} />
                    </div>
                  )}
                </div>
              )}

              {/* ════ Tab 3: 各 AI 模型详情 ════ */}
              {activeTab === 'models' && (
                <div className="space-y-6">
                  <div className="border-b border-outline pb-3 mb-2">
                    <h3 className="text-base font-bold text-on-surface">模型使用配比与吞吐评估</h3>
                    <p className="text-xs text-on-surface/50 mt-1">评估各个云端及本地大语言模型的字词交互与吞吐性能情况</p>
                  </div>

                  {/* 模型概要表格 */}
                  {modelAggs.length > 0 ? (
                    <div className="bg-surface border border-outline rounded-xl overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead>
                            <tr className="border-b border-outline text-on-surface/50 bg-surface-bright/40">
                              <th className="px-4 py-3 font-semibold">模型名</th>
                              <th className="px-4 py-3 font-semibold text-right">调用次数</th>
                              <th className="px-4 py-3 font-semibold text-right">总 Token</th>
                              <th className="px-4 py-3 font-semibold text-right">Prompt</th>
                              <th className="px-4 py-3 font-semibold text-right">Completion</th>
                              <th className="px-4 py-3 font-semibold text-right">占比</th>
                              <th className="px-4 py-3 font-semibold text-right">平均 TTFT</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-on-surface/5">
                            {modelAggs.map((m, idx) => (
                              <tr key={m.model} className="hover:bg-surface-bright/40 transition-colors">
                                <td className="px-4 py-3">
                                  <div className="flex items-center gap-2">
                                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: getModelColor(idx) }} />
                                    <span className="font-semibold text-on-surface">{m.model}</span>
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-right font-mono text-on-surface/80">{m.callCount}</td>
                                <td className="px-4 py-3 text-right font-mono font-bold text-primary">{formatNumber(m.totalTokens)}</td>
                                <td className="px-4 py-3 text-right font-mono text-[#3b82f6]">{formatNumber(m.promptTokens)}</td>
                                <td className="px-4 py-3 text-right font-mono text-[#4cf0b5]">{formatNumber(m.completionTokens)}</td>
                                <td className="px-4 py-3 text-right font-mono text-on-surface/80">{m.pct.toFixed(1)}%</td>
                                <td className="px-4 py-3 text-right font-mono text-on-surface/80">
                                  {m.avgTtft !== null ? `${Math.round(m.avgTtft)} ms` : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-surface border border-outline rounded-xl">
                      <EmptyState />
                    </div>
                  )}

                  {/* 模型 Token 对比柱状图 */}
                  {modelBarData.length > 0 && (
                    <div className="bg-surface border border-outline rounded-xl p-5 space-y-3">
                      <div className="flex items-center justify-between border-b border-on-surface/5 pb-2">
                        <span className="text-xs font-bold text-on-surface flex items-center gap-1.5">
                          <BarChart3 className="w-4 h-4 text-primary" />
                          <span>模型 Token 对比</span>
                        </span>
                        <div className="flex items-center gap-4 text-[10.5px] font-mono text-on-surface/60">
                          <div className="flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-[#3b82f6]" />
                            <span>Prompt</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--color-primary)' }} />
                            <span>Completion</span>
                          </div>
                        </div>
                      </div>
                      <div className="h-[240px] w-full text-xs font-mono">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={modelBarData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-outline)" strokeOpacity={0.3} vertical={false} />
                            <XAxis
                              dataKey="name"
                              stroke="var(--color-on-surface)"
                              strokeOpacity={0.4}
                              tickLine={false}
                              axisLine={false}
                              style={{ fontSize: 10 }}
                            />
                            <YAxis
                              stroke="var(--color-on-surface)"
                              strokeOpacity={0.4}
                              tickLine={false}
                              axisLine={false}
                              style={{ fontSize: 10 }}
                              tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                            />
                            <ReChartsTooltip
                              contentStyle={TOOLTIP_STYLE}
                              labelStyle={TOOLTIP_LABEL_STYLE}
                              itemStyle={TOOLTIP_ITEM_STYLE}
                            />
                            <Bar dataKey="prompt" name="Prompt" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                            <Bar dataKey="completion" name="Completion" fill="var(--color-primary)" radius={[3, 3, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ════ Tab 4: 容器与性能审计 ════ */}
              {activeTab === 'performance' && (
                <div className="space-y-6">
                  <div className="border-b border-outline pb-3 mb-2">
                    <h3 className="text-base font-bold text-on-surface">运行时性能与大模型吞吐审计</h3>
                    <p className="text-xs text-on-surface/50 mt-1">
                      涵盖 CPU/内存/FPS/JS Heap 实时指标，以及 LLM 流式延迟 (TTFT) 与吞吐速率
                    </p>
                  </div>

                  {/* 4 个实时 KPI 卡片 */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {/* CPU */}
                    <div className="bg-surface border border-outline rounded-xl p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-on-surface/50 font-medium">CPU 使用率</span>
                        <Activity className="w-4 h-4 text-emerald-400" />
                      </div>
                      <span className={`text-2xl font-mono font-bold ${
                        (liveTelemetry?.cpu ?? 0) > 60 ? 'text-rose-400' : (liveTelemetry?.cpu ?? 0) > 30 ? 'text-amber-400' : 'text-emerald-400'
                      }`}>
                        {liveTelemetry ? `${liveTelemetry.cpu}%` : '—'}
                      </span>
                      <div className="w-full bg-on-surface/10 h-1.5 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            (liveTelemetry?.cpu ?? 0) > 60 ? 'bg-gradient-to-r from-rose-500 to-red-400'
                              : (liveTelemetry?.cpu ?? 0) > 30 ? 'bg-gradient-to-r from-amber-500 to-yellow-400'
                              : 'bg-gradient-to-r from-emerald-500 to-teal-400'
                          }`}
                          style={{ width: `${liveTelemetry?.cpu ?? 0}%` }}
                        />
                      </div>
                    </div>

                    {/* Memory */}
                    <div className="bg-surface border border-outline rounded-xl p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-on-surface/50 font-medium">系统内存</span>
                        <Brain className="w-4 h-4 text-blue-400" />
                      </div>
                      <span className="text-2xl font-mono font-bold text-blue-400">
                        {liveTelemetry ? `${liveTelemetry.memoryPercent}%` : '—'}
                      </span>
                      <div className="w-full bg-on-surface/10 h-1.5 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 to-indigo-400 rounded-full transition-all duration-300"
                          style={{ width: `${liveTelemetry?.memoryPercent ?? 0}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-on-surface/40 font-mono">
                        {liveTelemetry ? `${liveTelemetry.memoryUsed.toFixed(2)} / ${liveTelemetry.memoryTotal.toFixed(1)} GB` : '等待数据...'}
                      </span>
                    </div>

                    {/* FPS */}
                    <div className="bg-surface border border-outline rounded-xl p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-on-surface/50 font-medium">渲染帧率 (FPS)</span>
                        <Gauge className="w-4 h-4 text-primary" />
                      </div>
                      <span className="text-2xl font-mono font-bold text-primary">
                        {fps !== null ? fps : '—'}
                      </span>
                      <div className="text-[10px] text-on-surface/40 font-mono">
                        帧耗时: {frameTime !== null ? `${frameTime} ms` : '—'}
                      </div>
                    </div>

                    {/* JS Heap */}
                    <div className="bg-surface border border-outline rounded-xl p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-on-surface/50 font-medium">JS Heap</span>
                        <HardDrive className="w-4 h-4 text-orange-400" />
                      </div>
                      <span className="text-2xl font-mono font-bold text-orange-400">
                        {memorySample ? `${memorySample.usedJSHeapMB} MB` : '—'}
                      </span>
                      <div className="text-[10px] text-on-surface/40 font-mono">
                        {memorySample?.totalJSHeapMB ? `上限 ${memorySample.totalJSHeapMB} MB` : 'Chromium API 不可用'}
                      </div>
                    </div>
                  </div>

                  {/* FPS 历史 + API 延迟历史 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* FPS 历史 */}
                    <div className="bg-surface border border-outline rounded-xl p-4.5 space-y-3">
                      <div className="flex items-center justify-between border-b border-on-surface/5 pb-2">
                        <span className="text-xs font-bold text-on-surface flex items-center gap-1.5">
                          <Activity className="w-4 h-4 text-primary" />
                          <span>FPS 历史 (最近 60 样本)</span>
                        </span>
                      </div>
                      <div className="h-[200px] w-full text-[10px] font-mono">
                        {fpsChartData.length > 0 ? (
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={fpsChartData} margin={{ top: 10, right: 10, left: -22, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-outline)" strokeOpacity={0.3} vertical={false} />
                              <XAxis dataKey="time" stroke="var(--color-on-surface)" strokeOpacity={0.4} tickLine={false} axisLine={false} style={{ fontSize: 9 }} />
                              <YAxis stroke="var(--color-on-surface)" strokeOpacity={0.4} tickLine={false} axisLine={false} style={{ fontSize: 9 }} />
                              <ReChartsTooltip
                                contentStyle={TOOLTIP_STYLE}
                                labelStyle={TOOLTIP_LABEL_STYLE}
                                itemStyle={TOOLTIP_ITEM_STYLE}
                              />
                              <Line type="monotone" dataKey="fps" name="FPS" stroke="var(--color-primary)" strokeWidth={2} dot={false} animationDuration={300} />
                            </LineChart>
                          </ResponsiveContainer>
                        ) : (
                          <EmptyState message="等待 FPS 采样..." />
                        )}
                      </div>
                    </div>

                    {/* API 延迟历史 */}
                    <div className="bg-surface border border-outline rounded-xl p-4.5 space-y-3">
                      <div className="flex items-center justify-between border-b border-on-surface/5 pb-2">
                        <span className="text-xs font-bold text-on-surface flex items-center gap-1.5">
                          <LineChartIcon className="w-4 h-4 text-[#3b82f6]" />
                          <span>API 延迟历史 (最近 30 样本)</span>
                        </span>
                        <div className="flex items-center gap-3 text-[10px] font-mono text-on-surface/60">
                          <div className="flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-[#3b82f6]" />
                            <span>TTFT</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-[#f59e0b]" />
                            <span>Total</span>
                          </div>
                        </div>
                      </div>
                      <div className="h-[200px] w-full text-[10px] font-mono">
                        {latencyChartData.length > 0 ? (
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={latencyChartData} margin={{ top: 10, right: 10, left: -22, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-outline)" strokeOpacity={0.3} vertical={false} />
                              <XAxis dataKey="time" stroke="var(--color-on-surface)" strokeOpacity={0.4} tickLine={false} axisLine={false} style={{ fontSize: 9 }} />
                              <YAxis stroke="var(--color-on-surface)" strokeOpacity={0.4} tickLine={false} axisLine={false} style={{ fontSize: 9 }} />
                              <ReChartsTooltip
                                contentStyle={TOOLTIP_STYLE}
                                labelStyle={TOOLTIP_LABEL_STYLE}
                                itemStyle={TOOLTIP_ITEM_STYLE}
                              />
                              <Line type="monotone" dataKey="ttfb" name="TTFT (ms)" stroke="#3b82f6" strokeWidth={2} dot={false} animationDuration={300} />
                              <Line type="monotone" dataKey="total" name="Total (ms)" stroke="#f59e0b" strokeWidth={2} dot={false} animationDuration={300} />
                            </LineChart>
                          </ResponsiveContainer>
                        ) : (
                          <EmptyState message="等待 API 调用..." />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* LLM 流式延迟详情 */}
                  <div className="bg-surface border border-outline rounded-xl p-5 space-y-3">
                    <div className="flex items-center justify-between border-b border-on-surface/5 pb-2">
                      <span className="text-xs font-bold text-on-surface uppercase tracking-wider flex items-center gap-1.5">
                        <Zap className="w-4 h-4 text-primary" />
                        <span>LLM 流式延迟详情 (最近 10 次)</span>
                      </span>
                    </div>
                    {llmLatencySamples.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead>
                            <tr className="border-b border-on-surface/10 text-on-surface/50">
                              <th className="px-3 py-2 font-semibold">操作名</th>
                              <th className="px-3 py-2 font-semibold text-right">TTFT (ms)</th>
                              <th className="px-3 py-2 font-semibold text-right">总耗时 (ms)</th>
                              <th className="px-3 py-2 font-semibold text-right">字节数</th>
                              <th className="px-3 py-2 font-semibold text-right">吞吐速率</th>
                              <th className="px-3 py-2 font-semibold text-right">时间</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-on-surface/5">
                            {llmLatencySamples.map((ls, idx) => {
                              const throughput = (ls.bytes !== undefined && ls.total > 0) ? (ls.bytes / ls.total) * 1000 : null;
                              return (
                                <tr key={idx} className="hover:bg-surface-bright/40 transition-colors">
                                  <td className="px-3 py-2.5">
                                    <span className="font-mono text-on-surface/90 text-[11px]">{ls.op}</span>
                                  </td>
                                  <td className="px-3 py-2.5 text-right font-mono text-[#3b82f6] font-bold">
                                    {Math.round(ls.ttfb)}
                                  </td>
                                  <td className="px-3 py-2.5 text-right font-mono text-[#f59e0b] font-bold">
                                    {Math.round(ls.total)}
                                  </td>
                                  <td className="px-3 py-2.5 text-right font-mono text-on-surface/70">
                                    {formatBytes(ls.bytes)}
                                  </td>
                                  <td className="px-3 py-2.5 text-right font-mono text-[#4cf0b5] font-bold">
                                    {throughput !== null ? `${Math.round(throughput)} B/s` : '—'}
                                  </td>
                                  <td className="px-3 py-2.5 text-right font-mono text-on-surface/40 text-[11px]">
                                    {formatClock(ls.timestamp)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <EmptyState message="暂无 LLM 流式调用记录，开始对话后这里会显示延迟数据" />
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
