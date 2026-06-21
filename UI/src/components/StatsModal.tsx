import React, { useState, useEffect } from 'react';
import { 
  X, BarChart3, PieChart, TrendingUp, Clock, ArrowUpRight, ArrowDownRight, 
  Database, MessageSquare, Calendar, Flame, Cpu, Zap, Award, Download,
  Activity, Gauge, HardDrive, LineChart as LineChartIcon, Brain
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
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

interface StatsModalProps {
  onClose: () => void;
}

const PERFORMANCE_DATA_DAY = {
  renderHistory: [
    { label: '02:00', editor: 8, chat: 18, sandbox: 35, avg: 20 },
    { label: '06:00', editor: 9, chat: 20, sandbox: 38, avg: 22 },
    { label: '10:00', editor: 12, chat: 32, sandbox: 54, avg: 32 },
    { label: '14:00', editor: 14, chat: 38, sandbox: 62, avg: 38 },
    { label: '18:00', editor: 11, chat: 30, sandbox: 48, avg: 29 },
    { label: '22:00', editor: 9, chat: 22, sandbox: 39, avg: 23 },
  ],
  memoryBreakdown: [
    { name: '代码编辑器', value: 16.4, color: '#3b82f6' },
    { name: 'AI 聊天消息实体队列', value: 12.8, color: '#ffde82' },
    { name: 'Virtual DOM & Layout 树基模', value: 8.5, color: '#4cf0b5' },
    { name: '沙箱内运行时 JS Stack 堆栈', value: 24.3, color: '#a855f7' }
  ],
  apiPerformance: [
    { model: 'GPT-4o', ttft: 280, speed: 85, successRate: 99.8 },
    { model: 'Claude 3.5', ttft: 310, speed: 72, successRate: 99.5 },
    { model: 'DeepSeek-R1', ttft: 460, speed: 48, successRate: 98.4 },
    { model: 'Qwen-2.5-Local', ttft: 75, speed: 38, successRate: 100.0 }
  ],
  overall: {
    avgRender: '23.4 ms',
    activeMem: '62.0 MB',
    avgTtft: '281 ms',
    gcCount: '4 次',
    loadSpeed: '0.85s',
    concurrency: '4 c/s'
  }
};

const PERFORMANCE_DATA_WEEK = {
  renderHistory: [
    { label: '周一', editor: 10, chat: 25, sandbox: 44, avg: 26 },
    { label: '周二', editor: 11, chat: 28, sandbox: 48, avg: 29 },
    { label: '周三', editor: 13, chat: 34, sandbox: 58, avg: 35 },
    { label: '周四', editor: 14, chat: 37, sandbox: 60, avg: 37 },
    { label: '周五', editor: 12, chat: 31, sandbox: 51, avg: 31 },
    { label: '周六', editor: 9, chat: 21, sandbox: 38, avg: 22 },
    { label: '周日', editor: 8, chat: 18, sandbox: 35, avg: 20 },
  ],
  memoryBreakdown: [
    { name: '代码编辑器', value: 24.1, color: '#3b82f6' },
    { name: 'AI 聊天消息实体队列', value: 18.5, color: '#ffde82' },
    { name: 'Virtual DOM & Layout 树基模', value: 11.2, color: '#4cf0b5' },
    { name: '沙箱内运行时 JS Stack 堆栈', value: 34.2, color: '#a855f7' }
  ],
  apiPerformance: [
    { model: 'GPT-4o', ttft: 290, speed: 83, successRate: 99.7 },
    { model: 'Claude 3.5', ttft: 320, speed: 70, successRate: 99.4 },
    { model: 'DeepSeek-R1', ttft: 480, speed: 45, successRate: 98.1 },
    { model: 'Qwen-2.5-Local', ttft: 78, speed: 35, successRate: 100.0 }
  ],
  overall: {
    avgRender: '28.5 ms',
    activeMem: '88.0 MB',
    avgTtft: '292 ms',
    gcCount: '28 次',
    loadSpeed: '0.92s',
    concurrency: '6 c/s'
  }
};

const PERFORMANCE_DATA_MONTH = {
  renderHistory: [
    { label: '第 1 周', editor: 11, chat: 28, sandbox: 50, avg: 29 },
    { label: '第 2 周', editor: 13, chat: 34, sandbox: 56, avg: 34 },
    { label: '第 3 周', editor: 14, chat: 38, sandbox: 62, avg: 38 },
    { label: '第 4 周', editor: 12, chat: 30, sandbox: 48, avg: 30 }
  ],
  memoryBreakdown: [
    { name: '代码编辑器', value: 32.8, color: '#3b82f6' },
    { name: 'AI 聊天消息实体队列', value: 26.4, color: '#ffde82' },
    { name: 'Virtual DOM & Layout 树基模', value: 15.6, color: '#4cf0b5' },
    { name: '沙箱内运行时 JS Stack 堆栈', value: 48.2, color: '#a855f7' }
  ],
  apiPerformance: [
    { model: 'GPT-4o', ttft: 305, speed: 81, successRate: 99.6 },
    { model: 'Claude 3.5', ttft: 335, speed: 68, successRate: 99.2 },
    { model: 'DeepSeek-R1', ttft: 512, speed: 42, successRate: 97.8 },
    { model: 'Qwen-2.5-Local', ttft: 82, speed: 33, successRate: 100.0 }
  ],
  overall: {
    avgRender: '32.7 ms',
    activeMem: '123.0 MB',
    avgTtft: '310 ms',
    gcCount: '135 次',
    loadSpeed: '1.04s',
    concurrency: '8 c/s'
  }
};

// Simulated data for day, week, month
const TOKEN_DATA_DAY = {
  total: 68420,
  prompt: 24500,
  completion: 43920,
  cost: '¥4.86',
  trend: '+12.4%',
  chartData: [
    { label: '02:00', total: 1200, prompt: 300, completion: 900 },
    { label: '06:00', total: 4500, prompt: 1500, completion: 3000 },
    { label: '10:00', total: 18400, prompt: 6200, completion: 12200 },
    { label: '14:00', total: 24200, prompt: 8200, completion: 16000 },
    { label: '18:00', total: 15600, prompt: 6100, completion: 9500 },
    { label: '22:00', total: 4520, prompt: 2200, completion: 2320 }
  ],
  conversations: [
    { id: 'c1', title: '博客系统后端开发 - Vue3 + Node.js', model: 'GPT-4o', tokens: 42100, messages: 18, cost: '¥3.20' },
    { id: 'c2', title: '算法研究 - 快速排序原地置换优化', model: 'DeepSeek-R1', tokens: 18320, messages: 6, cost: '¥1.15' },
    { id: 'c3', title: 'SettingsModal 极客UI美化', model: 'Sonnet 3.5', tokens: 8000, messages: 4, cost: '¥0.51' }
  ],
  models: [
    { name: 'GPT-4o', tokens: 42100, pct: 61 },
    { name: 'DeepSeek-R1', tokens: 18320, pct: 27 },
    { name: 'Claude 3.5 Sonnet', tokens: 8000, pct: 12 }
  ]
};

const TOKEN_DATA_WEEK = {
  total: 486200,
  prompt: 172100,
  completion: 314100,
  cost: '¥35.20',
  trend: '+8.7%',
  chartData: [
    { label: '周一', total: 45000, prompt: 12000, completion: 33000 },
    { label: '周二', total: 72000, prompt: 25000, completion: 47000 },
    { label: '周三', total: 98000, prompt: 35000, completion: 63000 },
    { label: '周四', total: 124000, prompt: 44000, completion: 80000 },
    { label: '周五', total: 85000, prompt: 31000, completion: 54000 },
    { label: '周六', total: 38200, prompt: 14100, completion: 24100 },
    { label: '周日', total: 24000, prompt: 11000, completion: 13000 }
  ],
  conversations: [
    { id: 'c1', title: '博客系统后端开发 - Vue3 + Node.js', model: 'GPT-4o', tokens: 245000, messages: 92, cost: '¥18.60' },
    { id: 'c2', title: '算法研究 - 快速排序原地置换优化', model: 'DeepSeek-R1', tokens: 131200, messages: 42, cost: '¥9.20' },
    { id: 'c3', title: 'SettingsModal 极客UI美化', model: 'Sonnet 3.5', tokens: 68000, messages: 24, cost: '¥4.80' },
    { id: 'c4', title: '微信自动化网关与QBot消息通道拦截', model: 'Qwen-2.5-7B', tokens: 42000, messages: 15, cost: '¥2.60' }
  ],
  models: [
    { name: 'GPT-4o', tokens: 245000, pct: 50 },
    { name: 'DeepSeek-R1', tokens: 131200, pct: 27 },
    { name: 'Claude 3.5 Sonnet', tokens: 68000, pct: 14 },
    { name: 'Qwen-2.5-7B 本地', tokens: 42000, pct: 9 }
  ]
};

const TOKEN_DATA_MONTH = {
  total: 2145890,
  prompt: 845400,
  completion: 1300490,
  cost: '¥156.40',
  trend: '+24.5%',
  chartData: [
    { label: '第 1 周', total: 420100, prompt: 180100, completion: 240000 },
    { label: '第 2 周', total: 580400, prompt: 220100, completion: 360300 },
    { label: '第 3 周', total: 645190, prompt: 245100, completion: 400090 },
    { label: '第 4 周', total: 500200, prompt: 200100, completion: 300100 }
  ],
  conversations: [
    { id: 'c1', title: '博客系统后端开发 - Vue3 + Node.js', model: 'GPT-4o', tokens: 985000, messages: 342, cost: '¥72.50' },
    { id: 'c2', title: '算法研究 - 快速排序原地置换优化', model: 'DeepSeek-R1', tokens: 541000, messages: 184, cost: '¥38.20' },
    { id: 'c3', title: 'SettingsModal 极客UI美化', model: 'Sonnet 3.5', tokens: 365200, messages: 120, cost: '¥24.80' },
    { id: 'c4', title: '微信自动化网关与QBot消息通道拦截', model: 'Qwen-2.5-7B', tokens: 184690, messages: 68, cost: '¥12.50' },
    { id: 'c5', title: '数据库迁移 - PostgreSQL到MongoDB高可靠脚本', model: 'GPT-3.5', tokens: 70000, messages: 32, cost: '¥8.40' }
  ],
  models: [
    { name: 'GPT-4o', tokens: 985000, pct: 46 },
    { name: 'DeepSeek-R1', tokens: 541000, pct: 25 },
    { name: 'Claude 3.5 Sonnet', tokens: 365200, pct: 17 },
    { name: 'Qwen-2.5-7B 本地', tokens: 184690, pct: 9 },
    { name: 'GPT-3.5 Turbo', tokens: 70000, pct: 3 }
  ]
};

const getTodayString = () => {
  return new Date().toISOString().split('T')[0];
};

const getDaysAgoString = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
};

const hashStringToNumber = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
};

const generateDataForDate = (dateStr: string) => {
  const seed = hashStringToNumber(dateStr);
  const isWeekend = new Date(dateStr).getDay() % 6 === 0;
  const basePrompt = isWeekend ? 6000 : 18000;
  const prompt = basePrompt + (seed % 15000);
  const completionFactor = 1.3 + ((seed % 10) / 10);
  const completion = Math.round(prompt * completionFactor);
  const total = prompt + completion;
  return {
    label: dateStr.substring(5), // e.g. "06-01"
    fullDate: dateStr,
    prompt,
    completion,
    total
  };
};

const generateRangeData = (startStr: string, endStr: string) => {
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    return {
      total: 0,
      prompt: 0,
      completion: 0,
      cost: '¥0.00',
      trend: '0.0%',
      chartData: [] as Array<{ label: string; fullDate: string; prompt: number; completion: number; total: number }>,
      conversations: [] as Array<{ id: string; title: string; model: string; tokens: number; messages: number; cost: string }>,
      models: [] as Array<{ name: string; tokens: number; pct: number }>
    };
  }
  const chartData = [];
  let curr = new Date(start);
  let count = 0;
  while (curr <= end && count < 90) {
    const yyyy = curr.getFullYear();
    const mm = String(curr.getMonth() + 1).padStart(2, '0');
    const dd = String(curr.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    chartData.push(generateDataForDate(dateStr));
    curr.setDate(curr.getDate() + 1);
    count++;
  }
  const total = chartData.reduce((sum, d) => sum + d.total, 0);
  const prompt = chartData.reduce((sum, d) => sum + d.prompt, 0);
  const completion = chartData.reduce((sum, d) => sum + d.completion, 0);
  const costVal = (prompt * 0.000008) + (completion * 0.000015);
  const cost = `¥${costVal.toFixed(2)}`;
  const trendPercent = ((hashStringToNumber(startStr) % 150) / 10) - 5;
  const trend = `${trendPercent >= 0 ? '+' : ''}${trendPercent.toFixed(1)}%`;
  const rawConvs = [
    { title: '博客系统后端开发 - Vue3 + Node.js', model: 'GPT-4o', weight: 0.5 },
    { title: '算法研究 - 快速排序原地置换优化', model: 'DeepSeek-R1', weight: 0.25 },
    { title: 'SettingsModal 极客UI美化', model: 'Sonnet 3.5', weight: 0.15 },
    { title: '微信自动化网关与QBot消息通道拦截', model: 'Qwen-2.5-7B', weight: 0.08 },
    { title: '数据库迁移 - PostgreSQL到MongoDB高可靠脚本', model: 'GPT-3.5', weight: 0.02 }
  ];
  const conversations = rawConvs.map((rc, idx) => {
    const convTokens = Math.round(total * rc.weight);
    const convPrompt = Math.round(prompt * rc.weight);
    const convCompletion = convTokens - convPrompt;
    const convMessages = Math.round(convTokens / 2500) + 2;
    const convCost = `¥${((convPrompt * 0.000008) + (convCompletion * 0.000015)).toFixed(2)}`;
    return {
      id: `rc-${idx}`,
      title: rc.title,
      model: rc.model,
      tokens: convTokens,
      messages: convMessages,
      cost: convCost
    };
  });
  const models = [
    { name: 'GPT-4o', tokens: Math.round(total * 0.5), pct: 50 },
    { name: 'DeepSeek-V3', tokens: Math.round(total * 0.25), pct: 25 },
    { name: 'Claude 3.5 Sonnet', tokens: Math.round(total * 0.15), pct: 15 },
    { name: 'Qwen-2.5-7B 本地', tokens: Math.round(total * 0.08), pct: 8 },
    { name: 'GPT-3.5 Turbo', tokens: Math.round(total * 0.02), pct: 2 }
  ];
  return {
    total,
    prompt,
    completion,
    cost,
    trend,
    chartData,
    conversations,
    models
  };
};

export default function StatsModal({ onClose }: StatsModalProps) {
  const [timeRange, setTimeRange] = useState<'day' | 'week' | 'month'>('week');
  const [activeTab, setActiveTab] = useState<'overview' | 'conversations' | 'models' | 'performance'>('overview');
  const [hoveredBarIndex, setHoveredBarIndex] = useState<number | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<{
    label: string;
    total: number;
    prompt: number;
    completion: number;
  } | null>(null);

  const [dateFilterType, setDateFilterType] = useState<'7d' | '30d' | 'custom'>('7d');
  const [chartStartDate, setChartStartDate] = useState<string>(() => getDaysAgoString(6));
  const [chartEndDate, setChartEndDate] = useState<string>(() => getTodayString());

  const [liveTelemetry, setLiveTelemetry] = useState<{
    cpu: number;
    memoryUsed: number;
    memoryTotal: number;
    memoryPercent: number;
  } | null>(null);

  useEffect(() => {
    const handleTelemetry = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        setLiveTelemetry(detail);
      }
    };
    window.addEventListener('soloforge-live-telemetry', handleTelemetry);
    return () => {
      window.removeEventListener('soloforge-live-telemetry', handleTelemetry);
    };
  }, []);

  useEffect(() => {
    setHoveredPoint(null);
  }, [timeRange, activeTab, dateFilterType, chartStartDate, chartEndDate]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [onClose]);

  const handleSelectPresetsInChart = (preset: '7d' | '30d') => {
    setDateFilterType(preset);
    setTimeRange(preset === '7d' ? 'week' : 'month');
    const days = preset === '7d' ? 6 : 29;
    setChartStartDate(getDaysAgoString(days));
    setChartEndDate(getTodayString());
  };

  const handleCustomDateChange = (start: string, end: string) => {
    setChartStartDate(start);
    setChartEndDate(end);
    setDateFilterType(preset => {
      if (preset !== 'custom') return 'custom';
      return preset;
    });
    if (timeRange === 'day') {
      setTimeRange('week');
    }
  };

  // Pick dataset
  const activeData = timeRange === 'day' 
    ? TOKEN_DATA_DAY 
    : generateRangeData(chartStartDate, chartEndDate);

  // Pick performance dataset
  const activePerfData = timeRange === 'day' 
    ? PERFORMANCE_DATA_DAY 
    : timeRange === 'week' 
      ? PERFORMANCE_DATA_WEEK 
      : PERFORMANCE_DATA_MONTH;

  // Max value in chart for scale calculation
  const maxChartValue = Math.max(...activeData.chartData.map(d => d.total)) * 1.15;

  const handleExportCSV = () => {
    const lines: string[] = [];
    
    // Add BOM for Microsoft Excel UTF-8 display compatibility
    lines.push('\uFEFF');

    // 1. Meta / Summary Info
    lines.push(`"AI与Token审计报告 - 耗能概要"`);
    lines.push(`"时间跨度","${timeRange === 'day' ? '一天' : timeRange === 'week' ? '一周' : '一月'}"`);
    lines.push(`"导出时间","${new Date().toLocaleString()}"`);
    lines.push(`"总消耗 Tokens","${activeData.total}"`);
    lines.push(`"输入 (Prompt) Tokens","${activeData.prompt}"`);
    lines.push(`"生成 (Completion) Tokens","${activeData.completion}"`);
    lines.push('');

    // 2. Trend Data Section
    lines.push(`"时间序列流量数据"`);
    lines.push(`"时间点/日期","Prompt Tokens","Completion Tokens","总计 Tokens"`);
    activeData.chartData.forEach(item => {
      lines.push(`"${item.label}","${item.prompt}","${item.completion}","${item.total}"`);
    });
    lines.push('');

    // 3. Conversation Audit Section
    lines.push(`"会话消耗细目审计"`);
    lines.push(`"会话主题","主要模型","会话轮次","消耗 Tokens"`);
    activeData.conversations.forEach(c => {
      lines.push(`"${c.title.replace(/"/g, '""')}","${c.model}","${c.messages}","${c.tokens}"`);
    });
    lines.push('');

    // 4. Model usage percent breakdown Section
    lines.push(`"首选大模型占比排行"`);
    lines.push(`"模型名称","消耗 Tokens","占比"`);
    activeData.models.forEach(m => {
      lines.push(`"${m.name}","${m.tokens}","${m.pct}%"`);
    });

    const csvContent = lines.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    
    const exportSuffix = timeRange === 'day' 
      ? 'Day' 
      : dateFilterType === 'custom' 
        ? `${chartStartDate}_to_${chartEndDate}` 
        : dateFilterType;
    link.setAttribute('download', `Token_Audit_Report_${exportSuffix}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="fixed inset-0 bg-[#000000]/85 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="w-full max-w-5xl bg-[#0c0d10] border border-[#22242b] rounded-2xl shadow-2xl flex flex-col h-[82vh] md:h-[78vh] overflow-hidden select-none text-on-surface"
      >
        {/* Header container */}
        <div className="bg-[#0e0f12] border-b border-[#22242b] px-6 py-4.5 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-xl border border-primary/20">
              <BarChart3 className="text-primary w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-wide">AI 与 Token 审计统计中心</h2>
              <p className="text-xs text-on-surface/50 mt-0.5 font-mono">
                监控大模型 Token 吞吐结构与其响应速度、以及会话流量占比
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Time Filter Tabs */}
            <div className="flex bg-[#14161a] border border-[#22242b] rounded-lg p-0.5 text-xs font-semibold">
              <button 
                onClick={() => { 
                  setTimeRange('day'); 
                  setHoveredBarIndex(null); 
                }}
                className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${timeRange === 'day' ? 'bg-[#ffde82] text-black font-extrabold' : 'text-on-surface/60 hover:text-white'}`}
              >
                一天
              </button>
              <button 
                onClick={() => { 
                  setTimeRange('week'); 
                  setDateFilterType('7d');
                  setChartStartDate(getDaysAgoString(6));
                  setChartEndDate(getTodayString());
                  setHoveredBarIndex(null); 
                }}
                className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${timeRange === 'week' ? 'bg-[#ffde82] text-black font-extrabold' : 'text-on-surface/60 hover:text-white'}`}
              >
                一周
              </button>
              <button 
                onClick={() => { 
                  setTimeRange('month'); 
                  setDateFilterType('30d');
                  setChartStartDate(getDaysAgoString(29));
                  setChartEndDate(getTodayString());
                  setHoveredBarIndex(null); 
                }}
                className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${timeRange === 'month' ? 'bg-[#ffde82] text-black font-extrabold' : 'text-on-surface/60 hover:text-white'}`}
              >
                一月
              </button>
            </div>

            {/* Export CSV button */}
            <button 
              onClick={handleExportCSV}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#ffde82]/25 hover:border-[#ffde82]/60 bg-[#ffde82]/5 hover:bg-[#ffde82]/10 text-primary hover:text-[#ffde82] text-xs font-semibold transition-all cursor-pointer active:scale-95"
              title="导出当前选定时间段的 Token 消耗数据"
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出 CSV</span>
            </button>

            <button 
              onClick={onClose}
              className="text-[#9ea4b0] hover:text-white hover:bg-white/5 p-2 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content body with sidebar navigation */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left Sidebar function index */}
          <div className="w-[180px] md:w-[220px] bg-[#07080a] border-r border-[#22242b] flex flex-col p-4 shrink-0 justify-between">
            <div className="space-y-1">
              <span className="text-[10px] text-[#ffde82]/65 px-2.5 py-1 font-mono font-bold tracking-wider uppercase block mb-2">
                审计导航栏
              </span>

              <button 
                onClick={() => setActiveTab('overview')}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold text-left transition-all cursor-pointer relative overflow-hidden group"
              >
                {activeTab === 'overview' && (
                  <motion.div 
                    layoutId="statsTabIndicator"
                    className="absolute inset-0 bg-[#ffde82]/10 border border-[#ffde82]/20 rounded-lg"
                    style={{ originY: "0px" }}
                    transition={{ type: "spring", stiffness: 95, damping: 22 }}
                  />
                )}
                <span className={`relative z-10 flex items-center gap-2.5 ${activeTab === 'overview' ? 'text-[#ffde82]' : 'text-on-surface/60'}`}>
                  <TrendingUp className="w-4 h-4 shrink-0" />
                  <span>概要趋势分析</span>
                </span>
              </button>

              <button 
                onClick={() => setActiveTab('conversations')}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold text-left transition-all cursor-pointer relative overflow-hidden group"
              >
                {activeTab === 'conversations' && (
                  <motion.div 
                    layoutId="statsTabIndicator"
                    className="absolute inset-0 bg-[#ffde82]/10 border border-[#ffde82]/20 rounded-lg"
                    style={{ originY: "0px" }}
                    transition={{ type: "spring", stiffness: 95, damping: 22 }}
                  />
                )}
                <span className={`relative z-10 flex items-center gap-2.5 ${activeTab === 'conversations' ? 'text-[#ffde82]' : 'text-on-surface/60'}`}>
                  <MessageSquare className="w-4 h-4 shrink-0" />
                  <span>各会话消耗审计</span>
                </span>
              </button>

              <button 
                onClick={() => setActiveTab('models')}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold text-left transition-all cursor-pointer relative overflow-hidden group"
              >
                {activeTab === 'models' && (
                  <motion.div 
                    layoutId="statsTabIndicator"
                    className="absolute inset-0 bg-[#ffde82]/10 border border-[#ffde82]/20 rounded-lg"
                    style={{ originY: "0px" }}
                    transition={{ type: "spring", stiffness: 95, damping: 22 }}
                  />
                )}
                <span className={`relative z-10 flex items-center gap-2.5 ${activeTab === 'models' ? 'text-[#ffde82]' : 'text-on-surface/60'}`}>
                  <Cpu className="w-4 h-4 shrink-0" />
                  <span>各 AI 模型详情</span>
                </span>
              </button>

              <button 
                onClick={() => setActiveTab('performance')}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold text-left transition-all cursor-pointer relative overflow-hidden group"
              >
                {activeTab === 'performance' && (
                  <motion.div 
                    layoutId="statsTabIndicator"
                    className="absolute inset-0 bg-[#ffde82]/10 border border-[#ffde82]/20 rounded-lg"
                    style={{ originY: "0px" }}
                    transition={{ type: "spring", stiffness: 95, damping: 22 }}
                  />
                )}
                <span className={`relative z-10 flex items-center gap-2.5 ${activeTab === 'performance' ? 'text-[#ffde82]' : 'text-on-surface/60'}`}>
                  <Activity className="w-4 h-4 shrink-0" />
                  <span>容器与性能审计</span>
                </span>
              </button>
            </div>

            {/* Model Processing Latency & Token Efficiency Comparison Table */}
            <div className="bg-[#101217]/70 border border-[#22242b] rounded-xl p-3 space-y-2.5">
              <span className="text-[10px] text-[#ffde82]/85 font-mono tracking-wider uppercase font-extrabold flex items-center gap-1.5">
                < Award className="w-3.5 h-3.5 text-[#ffde82]" />
                模型能效硬核审计
              </span>
              <div className="overflow-hidden">
                <table className="w-full text-left text-[10.5px] font-mono leading-tight">
                  <thead>
                    <tr className="border-b border-[#22242b] text-on-surface/45 pb-1">
                      <th className="pb-1.5 font-semibold text-[9.5px]">内核模型</th>
                      <th className="pb-1.5 font-semibold text-[9.5px] text-right">均时</th>
                      <th className="pb-1.5 font-semibold text-[9.5px] text-right">效率</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.03]">
                    <tr className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-1.5 text-white/90 font-medium">Gemini 2.5</td>
                      <td className="py-1.5 text-right font-semibold text-emerald-400">0.78s</td>
                      <td className="py-1.5 text-right font-semibold text-white">99.1%</td>
                    </tr>
                    <tr className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-1.5 text-white/90 font-medium">DeepSeek-V3</td>
                      <td className="py-1.5 text-right font-semibold text-[#4cf0b5]">1.32s</td>
                      <td className="py-1.5 text-right font-semibold text-white">97.4%</td>
                    </tr>
                    <tr className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-1.5 text-white/90 font-medium">GPT-4o</td>
                      <td className="py-1.5 text-right font-semibold text-blue-400">1.10s</td>
                      <td className="py-1.5 text-right font-semibold text-white">95.6%</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-[9px] text-on-surface/45 leading-normal">
                测量依据: 单次对话多轮上下文首字响应与 Token 转化损耗占比
              </p>
            </div>

            {/* Quick Summary at bottom of sidebar */}
            <div className="bg-[#101217] border border-[#22242b] rounded-xl p-3 space-y-1.5">
              <span className="text-[9px] text-[#ffde82]/70 font-mono tracking-wide uppercase font-bold block">
                核载概要
              </span>
              <div className="flex items-center justify-between text-[11px] text-on-surface/70">
                <span>最高占比:</span>
                <span className="text-white font-mono font-bold">GPT-4o</span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-on-surface/70">
                <span>平均字宽:</span>
                <span className="text-white font-mono font-bold">3.24 K/s</span>
              </div>
              <div className="h-1 bg-[#1a1c22] rounded-full overflow-hidden mt-1">
                <div className="bg-primary h-full w-[82%]" />
              </div>
            </div>
          </div>

          {/* Right Main Panel */}
          <div className="flex-1 bg-[#090a0d] p-6 overflow-y-auto scrollbar-thin">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }} // ultra soothing custom bezier curve
                className="space-y-6 min-h-full"
              >
                {/* Tab 1: Overview */}
                {activeTab === 'overview' && (
                  <div className="space-y-6">
                {/* Visual Stats Summary Cards */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-[#12141a] border border-[#22242b] rounded-xl p-4.5 space-y-1 relative overflow-hidden group">
                    <div className="absolute top-3 right-3 p-1.5 bg-primary/10 rounded-lg group-hover:scale-115 transition-transform">
                      <Flame className="w-4 h-4 text-primary" />
                    </div>
                    <span className="text-xs text-on-surface/50 font-medium">
                      {hoveredPoint ? `总消耗 (时段: ${hoveredPoint.label})` : "总消耗"}
                    </span>
                    <h3 className="text-lg md:text-xl font-mono font-bold text-[#ffde82] mt-1 transition-colors duration-200">
                      {(hoveredPoint ? hoveredPoint.total : activeData.total).toLocaleString()}
                    </h3>
                    <div className="flex items-center gap-1 text-[10px] text-emerald-400 font-mono pt-1">
                      {hoveredPoint ? (
                        <span className="text-primary/70 animate-pulse">交互浮动数据</span>
                      ) : (
                        <>
                          <ArrowUpRight className="w-3 h-3" />
                          <span>{activeData.trend} 环比</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="bg-[#12141a] border border-[#22242b] rounded-xl p-4.5 space-y-1 relative overflow-hidden group">
                    <div className="absolute top-3 right-3 p-1.5 bg-blue-500/10 rounded-lg group-hover:scale-115 transition-transform">
                      <ArrowUpRight className="w-4 h-4 text-blue-400" />
                    </div>
                    <span className="text-xs text-on-surface/50 font-medium">
                      {hoveredPoint ? `输入 (时段: ${hoveredPoint.label})` : "输入"}
                    </span>
                    <h3 className="text-lg md:text-xl font-mono font-bold text-blue-400 mt-1 transition-colors duration-200">
                      {(hoveredPoint ? hoveredPoint.prompt : activeData.prompt).toLocaleString()}
                    </h3>
                    <div className="text-[10px] text-on-surface/40 font-mono pt-1">
                      占比 {Math.round(((hoveredPoint ? hoveredPoint.prompt : activeData.prompt) / (hoveredPoint ? hoveredPoint.total : activeData.total)) * 100)}%
                    </div>
                  </div>

                  <div className="bg-[#12141a] border border-[#22242b] rounded-xl p-4.5 space-y-1 relative overflow-hidden group">
                    <div className="absolute top-3 right-3 p-1.5 bg-[#4cf0b5]/10 rounded-lg group-hover:scale-115 transition-transform">
                      <ArrowDownRight className="w-4 h-4 text-[#4cf0b5]" />
                    </div>
                    <span className="text-xs text-on-surface/50 font-medium">
                      {hoveredPoint ? `生成 (时段: ${hoveredPoint.label})` : "生成"}
                    </span>
                    <h3 className="text-lg md:text-xl font-mono font-bold text-[#4cf0b5] mt-1 transition-colors duration-200">
                      {(hoveredPoint ? hoveredPoint.completion : activeData.completion).toLocaleString()}
                    </h3>
                    <div className="text-[10px] text-on-surface/40 font-mono pt-1">
                      占比 {Math.round(((hoveredPoint ? hoveredPoint.completion : activeData.completion) / (hoveredPoint ? hoveredPoint.total : activeData.total)) * 100)}%
                    </div>
                  </div>
                </div>

                {/* Main Interactive Recharts Line Chart */}
                <div className="bg-[#111216] border border-[#22242b] rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-white/5 pb-3">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-primary" />
                      <span className="text-xs font-bold text-white uppercase tracking-wider">
                        时间序列流量审计趋势图 (Recharts 引擎 - 动态折线)
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-[10.5px] font-mono text-on-surface/60">
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full col-span-1 bg-[#ffde82]" />
                        <span>总 Token 吞吐</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full col-span-1 bg-[#3b82f6]" />
                        <span>Prompt 输入</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full col-span-1 bg-[#4cf0b5]" />
                        <span>Completion 生成</span>
                      </div>
                    </div>
                  </div>

                  {/* Date Range Selector Bar */}
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-[#16181e] p-3 rounded-lg border border-[#22242b] text-xs">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-3.5 h-3.5 text-[#ffde82]" />
                      <span className="font-semibold text-white/95">审计时间跨度筛选:</span>
                      {timeRange === 'day' && (
                        <span className="text-[10px] bg-[#ffde82]/10 text-[#ffde82] border border-[#ffde82]/20 px-1.5 py-0.5 rounded font-mono">
                          24小时细分已启用
                        </span>
                      )}
                    </div>
                    
                    <div className="flex flex-wrap items-center gap-2.5">
                      {/* Presets */}
                      <div className="flex bg-[#0f1115] border border-[#22242b] rounded-md p-0.5 font-medium font-sans">
                        <button
                          type="button"
                          onClick={() => handleSelectPresetsInChart('7d')}
                          className={`px-2.5 py-1 rounded transition-all cursor-pointer ${timeRange !== 'day' && dateFilterType === '7d' ? 'bg-[#ffde82] text-black font-bold' : 'text-on-surface/60 hover:text-white'}`}
                        >
                          最近 7 天
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSelectPresetsInChart('30d')}
                          className={`px-2.5 py-1 rounded transition-all cursor-pointer ${timeRange !== 'day' && dateFilterType === '30d' ? 'bg-[#ffde82] text-black font-bold' : 'text-on-surface/60 hover:text-white'}`}
                        >
                          最近 30 天
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDateFilterType('custom');
                            if (timeRange === 'day') {
                              setTimeRange('week'); // transition to dates display
                            }
                          }}
                          className={`px-2.5 py-1 rounded transition-all cursor-pointer ${timeRange !== 'day' && dateFilterType === 'custom' ? 'bg-[#ffde82] text-black font-bold' : 'text-on-surface/60 hover:text-white'}`}
                        >
                          自定义
                        </button>
                      </div>

                      {/* Custom inputs shown if custom is selected */}
                      {timeRange !== 'day' && dateFilterType === 'custom' && (
                        <div className="flex items-center gap-1.5 animate-fadeIn font-sans">
                          <input
                            type="date"
                            value={chartStartDate}
                            onChange={(e) => handleCustomDateChange(e.target.value, chartEndDate)}
                            max={chartEndDate}
                            className="bg-[#0f1115] border border-[#22242b] rounded px-2 py-1 text-white font-mono focus:outline-none focus:border-[#ffde82] text-[11px] cursor-pointer"
                          />
                          <span className="text-on-surface/40 font-mono">至</span>
                          <input
                            type="date"
                            value={chartEndDate}
                            onChange={(e) => handleCustomDateChange(chartStartDate, e.target.value)}
                            min={chartStartDate}
                            max={getTodayString()}
                            className="bg-[#0f1115] border border-[#22242b] rounded px-2 py-1 text-white font-mono focus:outline-none focus:border-[#ffde82] text-[11px] cursor-pointer"
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Recharts Line Chart Drawing */}
                  <div className="h-[240px] w-full text-xs font-mono">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={activeData.chartData}
                        margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                        onMouseMove={(state: any) => {
                          if (state && state.activePayload && state.activePayload.length) {
                            const p = state.activePayload[0].payload;
                            setHoveredPoint({
                              label: p.label,
                              total: p.total,
                              prompt: p.prompt,
                              completion: p.completion
                            });
                          }
                        }}
                        onMouseLeave={() => {
                          setHoveredPoint(null);
                        }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#22242b" vertical={false} />
                        <XAxis 
                          dataKey="label" 
                          stroke="#606670" 
                          tickLine={false} 
                          axisLine={false}
                          dy={10}
                          style={{ fontSize: 10 }}
                        />
                        <YAxis 
                          stroke="#606670" 
                          tickLine={false} 
                          axisLine={false}
                          style={{ fontSize: 10 }}
                          tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                        />
                        <ReChartsTooltip
                          cursor={{ stroke: '#3a3f4d', strokeWidth: 1.5, strokeDasharray: '4 4' }}
                          content={({ active, payload, label }) => {
                            if (active && payload && payload.length) {
                              const totalVal = payload.find(p => p.name === 'total')?.value as number || 0;
                              const promptVal = payload.find(p => p.name === 'prompt')?.value as number || 0;
                              const completionVal = payload.find(p => p.name === 'completion')?.value as number || 0;

                              return (
                                <div className="bg-[#0e1014]/95 border border-[#ffde82]/30 text-white p-3.5 rounded-xl shadow-2xl space-y-2 text-xs font-sans backdrop-blur-md min-w-[200px] animate-fadeIn">
                                  <div className="flex items-center gap-1.5 border-b border-white/10 pb-1.5 mb-1 text-primary">
                                    <Clock className="w-3.5 h-3.5 text-[#ffde82]" />
                                    <span className="font-bold font-mono text-[#ffde82]">{label} 消耗细目</span>
                                  </div>
                                  <div className="space-y-1.5">
                                    <div className="flex justify-between items-center gap-4">
                                      <div className="flex items-center gap-1.5">
                                        <span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6]" />
                                        <span className="text-on-surface/70 font-medium">输入:</span>
                                      </div>
                                      <span className="font-mono font-bold text-[#3b82f6]">
                                        {promptVal.toLocaleString()}
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center gap-4">
                                      <div className="flex items-center gap-1.5">
                                        <span className="w-1.5 h-1.5 rounded-full bg-[#4cf0b5]" />
                                        <span className="text-on-surface/70 font-medium">生成:</span>
                                      </div>
                                      <span className="font-mono font-bold text-[#4cf0b5]">
                                        {completionVal.toLocaleString()}
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center gap-4 pt-1.5 border-t border-white/10 font-semibold mt-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="w-1.5 h-1.5 rounded-full bg-[#ffde82]" />
                                        <span className="text-on-surface/90">合计:</span>
                                      </div>
                                      <span className="font-mono font-extrabold text-[#ffde82]">
                                        {totalVal.toLocaleString()}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              );
                            }
                            return null;
                          }}
                        />
                        <Line 
                          type="monotone" 
                          dataKey="total" 
                          name="total"
                          stroke="#ffde82" 
                          strokeWidth={3}
                          dot={{ r: 3, stroke: '#ffde82', strokeWidth: 1, fill: '#111216' }}
                          activeDot={{ r: 6, stroke: '#111216', strokeWidth: 2, fill: '#ffde82' }}
                          animationDuration={800}
                        />
                        <Line 
                          type="monotone" 
                          dataKey="prompt" 
                          name="prompt"
                          stroke="#3b82f6" 
                          strokeWidth={2}
                          dot={{ r: 2, stroke: '#3b82f6', strokeWidth: 1, fill: '#111216' }}
                          activeDot={{ r: 5, stroke: '#111216', strokeWidth: 2, fill: '#3b82f6' }}
                          animationDuration={1000}
                        />
                        <Line 
                          type="monotone" 
                          dataKey="completion" 
                          name="completion"
                          stroke="#4cf0b5" 
                          strokeWidth={2}
                          dot={{ r: 2, stroke: '#4cf0b5', strokeWidth: 1, fill: '#111216' }}
                          activeDot={{ r: 5, stroke: '#111216', strokeWidth: 2, fill: '#4cf0b5' }}
                          animationDuration={1200}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="text-[10px] text-on-surface/30 font-mono text-center">
                    提示: 鼠标悬浮在折线上方可精确查看对应时间粒度（日/周/月）的输入、输出、生成与总词吞吐开销
                  </div>
                </div>

                {/* Sub row showing Quick stats breakdown lists */}
                <div className="grid grid-cols-2 gap-4">
                  {/* Model ranking */}
                  <div className="bg-[#12141a] border border-[#22242b] p-4.5 rounded-xl space-y-3">
                    <span className="text-xs text-white font-bold block border-b border-white/5 pb-2">
                       首选大模型占比排行
                    </span>
                    <div className="space-y-3">
                      {activeData.models.map((m, idx) => (
                        <div key={idx} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="font-semibold text-on-surface/80">{m.name}</span>
                            <span className="font-mono text-white">{m.tokens.toLocaleString()} ({m.pct}%)</span>
                          </div>
                          <div className="w-full bg-[#1c1e24] h-1.5 rounded-full overflow-hidden">
                            <div 
                              className={`h-full rounded-full ${idx === 0 ? 'bg-primary' : idx === 1 ? 'bg-blue-500' : 'bg-orange-400'}`}
                              style={{ width: `${m.pct}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Active Conversation highlights */}
                  <div className="bg-[#12141a] border border-[#22242b] p-4.5 rounded-xl space-y-3">
                    <span className="text-xs text-white font-bold block border-b border-white/5 pb-2">
                      当前时间跨度内首选高消耗会话
                    </span>
                    <div className="space-y-3 text-xs">
                      {activeData.conversations.slice(0, 3).map((c, idx) => (
                        <div key={idx} className="flex justify-between items-center p-2 bg-[#0c0d10] border border-white/3 rounded-lg">
                          <div className="truncate max-w-[65%]">
                            <span className="font-semibold text-white block truncate">{c.title}</span>
                            <span className="text-[10px] text-on-surface/45 font-mono">{c.model} • {c.messages} 轮会话</span>
                          </div>
                          <div className="text-right">
                            <span className="font-mono text-[#ffde82] tracking-normal font-bold block">
                              {c.tokens.toLocaleString()}
                            </span>
                            <span className="text-[10px] text-on-surface/40 font-mono">Tokens</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Tab 2: Conversations Analytics */}
            {activeTab === 'conversations' && (
              <div className="space-y-5">
                <div className="border-b border-[#222426] pb-3 mb-2">
                  <h3 className="text-base font-bold text-white">会话全谱消耗细目审计</h3>
                  <p className="text-xs text-on-surface/50 mt-1">按会话主题、运行模型、轮次进行 Token 及费用精准审计</p>
                </div>

                <div className="space-y-3">
                  {activeData.conversations.map((c, idx) => (
                    <div 
                      key={c.id} 
                      className="p-4 bg-[#121419] border border-[#22242b] rounded-xl flex items-center justify-between hover:border-primary/20 transition-all shadow-sm relative overflow-hidden"
                    >
                      <div className="absolute top-0 bottom-0 left-0 w-1 bg-gradient-to-b from-primary to-blue-500" />
                      
                      <div className="space-y-1 pl-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-[#ffde82]/60 font-bold">#0{idx + 1}</span>
                          <span className="text-sm font-bold text-white">{c.title}</span>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-on-surface/50">
                          <span className="flex items-center gap-1">
                            <Cpu className="w-3.5 h-3.5 text-primary/70" />
                            <span className="font-mono">{c.model}</span>
                          </span>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            <MessageSquare className="w-3.5 h-3.5 text-blue-400" />
                            <span>{c.messages} 轮交互会话</span>
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-6 shrink-0 font-mono">
                        <div className="text-right">
                          <span className="text-xs text-on-surface/50 block">字词吞吐</span>
                          <span className="text-sm font-bold text-white tracking-wide">{c.tokens.toLocaleString()} Tokens</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="p-4 bg-[#0e1014] border border-dashed border-[#22242b] rounded-xl flex items-center gap-3">
                  <div className="p-2 bg-yellow-500/10 rounded-lg text-yellow-400">
                    <Award className="w-4 h-4" />
                  </div>
                  <span className="text-xs text-on-surface/55 leading-relaxed">
                    本工作空间所有本地会话消耗均进行离线日志备份，导出系统会自动加密数据防止开发过程中的敏感源码、Prompt 结构外泄至非受信端。
                  </span>
                </div>
              </div>
            )}

            {/* Tab 3: Models Detail */}
            {activeTab === 'models' && (
              <div className="space-y-6">
                <div className="border-b border-[#222426] pb-3 mb-2">
                  <h3 className="text-base font-bold text-white">模型使用配比与吞吐评估</h3>
                  <p className="text-xs text-on-surface/50 mt-1">评估各个云端及本地微内核大语言模型的字词交互与吞吐性能情况</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {activeData.models.map((m, idx) => (
                    <div 
                      key={idx} 
                      className="p-5 bg-[#121419] border border-[#22242b] rounded-xl relative overflow-hidden group hover:bg-[#15171e] transition-colors"
                    >
                      <div className="flex justify-between items-start">
                        <div className="space-y-1">
                          <h4 className="text-sm font-bold text-white flex items-center gap-2">
                            <Cpu className="w-4 h-4 text-primary" />
                            <span>{m.name}</span>
                          </h4>
                          <span className="text-xs text-on-surface/40 font-mono uppercase block">ACTIVE DEPLOYMENT</span>
                        </div>

                        <span className="text-2xl font-mono font-extrabold text-[#ffde82]/10 group-hover:text-[#ffde82]/20 transition-colors">
                          {m.pct}%
                        </span>
                      </div>

                      <div className="mt-5 space-y-3.5">
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-on-surface/60">消耗 Token 数:</span>
                          <span className="font-mono font-bold text-white">{m.tokens.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-on-surface/60">调用并发频次:</span>
                          <span className="font-mono text-on-surface/80">
                            {Math.round(m.tokens / 850)} 次
                          </span>
                        </div>
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-on-surface/60">响应流平均延迟:</span>
                          <span className="font-mono text-emerald-400 font-bold">120ms</span>
                        </div>
                      </div>

                      <div className="w-full bg-[#1b1c22] h-1.5 rounded-full overflow-hidden mt-4">
                        <div 
                          className="h-full bg-gradient-to-r from-primary to-blue-500 rounded-full" 
                          style={{ width: `${m.pct}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bg-[#101217] border border-[#22242b] rounded-xl p-5 flex items-center justify-between">
                  <div>
                    <span className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Zap className="w-4 h-4 text-[#ffde82]" />
                      <span>开启智能路由降低 Token 开销</span>
                    </span>
                    <p className="text-xs text-on-surface/50 mt-1">自动识别需求：基础编辑使用本地 Ollama/Qwen 节点，深度推理路由至 GPT-5 / Claude 节点</p>
                  </div>

                  <button className="bg-primary hover:opacity-95 text-black font-extrabold text-xs px-4 py-2 rounded-lg cursor-pointer transition-all">
                    配置智能路由
                  </button>
                </div>
              </div>
            )}

            {/* Tab 4: Performance Analysis Panel */}
            {activeTab === 'performance' && (
              <div className="space-y-6">
                <div className="border-b border-[#222426] pb-3 mb-2 flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-bold text-white">运行时性能与大模型吞吐审计</h3>
                    <p className="text-xs text-on-surface/50 mt-1">
                      涵盖了 UI 组件渲染帧频、垃圾回收（GC）频率、内存指标结构，以及各智能体接口 TTFT 与输出速率
                    </p>
                  </div>
                </div>

                {/* Real-time Hardware System Monitors (0.5s updates) */}
                <div id="live-hardware-monitor" className="bg-[#101216] border border-[#ffde82]/25 rounded-xl p-4.5 space-y-3.5 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-48 h-24 bg-gradient-to-bl from-[#ffde82]/5 to-transparent pointer-events-none" />
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Cpu className="w-5 h-5 text-[#ffde82] animate-pulse" />
                      <div>
                        <h4 className="text-sm font-bold text-white flex items-center gap-2">
                          <span>实时物理系统硬件监控</span>
                        </h4>
                        <p className="text-[10px] text-on-surface/40 mt-0.5 font-sans">
                          实时检测当前物理本机的多线程 CPU 系统核心负荷分配，以及物理内存分页状态状况。
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Live Memory Progress item */}
                    <div className="bg-[#0b0c0f] border border-[#1e2025] rounded-xl p-3.5 space-y-2.5">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-on-surface/60 font-medium flex items-center gap-1.5">
                          <Brain className="w-3.5 h-3.5 text-blue-400 font-bold" />
                          <span>实效内存 (Physical Memory Ticks)</span>
                        </span>
                        <span className="font-mono text-white">
                          <strong className="text-blue-400 font-bold">{liveTelemetry ? `${liveTelemetry.memoryUsed.toFixed(2)} GB` : '2.10 GB'}</strong>
                          <span className="text-on-surface/30"> / </span>
                          {liveTelemetry ? `${liveTelemetry.memoryTotal.toFixed(1)} GB` : '8.0 GB'}
                        </span>
                      </div>
                      <div className="w-full bg-[#181a1f] h-2 rounded-full overflow-hidden border border-[#22242b] relative">
                        <div 
                          className="h-full bg-gradient-to-r from-blue-500 to-indigo-400 rounded-full transition-all duration-300"
                          style={{ width: `${liveTelemetry ? liveTelemetry.memoryPercent : 26}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] text-on-surface/35 font-mono">
                        <span>主干内核总占比</span>
                        <span className="text-blue-400 font-bold">{liveTelemetry ? liveTelemetry.memoryPercent : 26}%</span>
                      </div>
                    </div>

                    {/* Live CPU Progress item */}
                    <div className="bg-[#0b0c0f] border border-[#1e2025] rounded-xl p-3.5 space-y-2.5">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-on-surface/60 font-medium flex items-center gap-1.5">
                          <Activity className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
                          <span>CPU 物理核心运行比</span>
                        </span>
                        <span className="font-mono text-white">
                          <strong className={`font-bold ${
                            (liveTelemetry?.cpu || 15) > 60 ? 'text-rose-400 animate-bounce' : (liveTelemetry?.cpu || 15) > 30 ? 'text-amber-400' : 'text-emerald-400'
                          }`}>{liveTelemetry ? liveTelemetry.cpu : 15}%</strong>
                        </span>
                      </div>
                      <div className="w-full bg-[#181a1f] h-2 rounded-full overflow-hidden border border-[#22242b] relative">
                        <div 
                          className={`h-full rounded-full transition-all duration-300 ${
                            (liveTelemetry?.cpu || 15) > 60 ? 'bg-gradient-to-r from-rose-500 to-red-400' : (liveTelemetry?.cpu || 15) > 30 ? 'bg-gradient-to-r from-amber-500 to-yellow-400' : 'bg-gradient-to-r from-emerald-500 to-teal-400'
                          }`}
                          style={{ width: `${liveTelemetry ? liveTelemetry.cpu : 15}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] text-on-surface/35 font-mono">
                        <span>周期核心执行比率</span>
                        <span className={(liveTelemetry?.cpu || 15) > 60 ? 'text-rose-400 font-bold' : (liveTelemetry?.cpu || 15) > 30 ? 'text-amber-400 font-bold' : 'text-emerald-400 font-bold'}>
                          {liveTelemetry ? liveTelemetry.cpu : 15}%
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Performance Bento Grid */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-[#12141a] border border-[#22242b] p-4 rounded-xl space-y-1 relative group">
                    <div className="absolute top-3 right-3 p-1 rounded bg-[#3b82f6]/10 text-[#3b82f6]">
                      <Gauge className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-[11px] text-on-surface/50 font-medium block">UI 渲染均值</span>
                    <span className="text-base font-bold font-mono text-white block">{activePerfData.overall.avgRender}</span>
                    <span className="text-[10px] text-emerald-400 font-mono block">低于 60Hz 帧临界点 (Healthy)</span>
                  </div>

                  <div className="bg-[#12141a] border border-[#22242b] p-4 rounded-xl space-y-1 relative group">
                    <div className="absolute top-3 right-3 p-1 rounded bg-[#ffde82]/10 text-primary">
                      <Zap className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-[11px] text-on-surface/50 font-medium block">API 首字响应 (TTFT)</span>
                    <span className="text-base font-bold font-mono text-white block">{activePerfData.overall.avgTtft}</span>
                    <span className="text-[10px] text-blue-400 font-mono block">多模型加权均时</span>
                  </div>

                  <div className="bg-[#12141a] border border-[#22242b] p-4 rounded-xl space-y-1 relative group">
                    <div className="absolute top-3 right-3 p-1 rounded bg-orange-500/10 text-orange-400">
                      <Activity className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-[11px] text-on-surface/50 font-medium block font-bold">垃圾回收(GC)频率</span>
                    <span className="text-base font-bold font-mono text-white block">{activePerfData.overall.gcCount}</span>
                    <span className="text-[10px] text-on-surface/40 font-mono block">系统主动内存释放次数</span>
                  </div>
                </div>

                {/* Charts Area */}
                <div className="grid grid-cols-2 gap-4">
                  {/* Left Column Chart: UI Rendering Latency LineChart */}
                  <div className="bg-[#111216] border border-[#22242b] rounded-xl p-4.5 space-y-3">
                    <div className="flex items-center justify-between border-b border-white/5 pb-2">
                      <span className="text-xs font-bold text-white flex items-center gap-1.5">
                        <Activity className="w-4 h-4 text-primary" />
                        <span>多交互模块 UI 绘帧延迟 (ms)</span>
                      </span>
                    </div>

                    <div className="h-[200px] w-full text-[10px] font-mono">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={activePerfData.renderHistory} margin={{ top: 10, right: 10, left: -22, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#22242b" vertical={false} />
                          <XAxis dataKey="label" stroke="#606670" tickLine={false} axisLine={false} style={{ fontSize: 9 }} />
                          <YAxis stroke="#606670" tickLine={false} axisLine={false} style={{ fontSize: 9 }} />
                          <ReChartsTooltip
                            contentStyle={{ backgroundColor: '#0f1115', borderColor: '#22242b', borderRadius: '8px' }}
                            labelStyle={{ fontWeight: 'bold', color: '#ffde82', fontSize: 11 }}
                          />
                          <Legend wrapperStyle={{ fontSize: 9 }} />
                          <Line type="monotone" dataKey="editor" name="代码编辑器" stroke="#3b82f6" strokeWidth={2} dot={false} />
                          <Line type="monotone" dataKey="chat" name="AI聊天面板" stroke="#ffde82" strokeWidth={2} dot={false} />
                          <Line type="monotone" dataKey="sandbox" name="沙箱Webview" stroke="#4cf0b5" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Right Column Chart: Model TTFT & Word Generation Rate BarChart */}
                  <div className="bg-[#111216] border border-[#22242b] rounded-xl p-4.5 space-y-3">
                    <div className="flex items-center justify-between border-b border-white/5 pb-2">
                      <span className="text-xs font-bold text-white flex items-center gap-1.5">
                        <LineChartIcon className="w-4 h-4 text-[#3b82f6]" />
                        <span>大模型时延（TTFT, ms）与吞吐速率（T/s）</span>
                      </span>
                    </div>

                    <div className="h-[200px] w-full text-[10px] font-mono font-bold">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={activePerfData.apiPerformance} margin={{ top: 10, right: 10, left: -22, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#22242b" vertical={false} />
                          <XAxis dataKey="model" stroke="#606670" tickLine={false} axisLine={false} style={{ fontSize: 9 }} />
                          <YAxis stroke="#606670" tickLine={false} axisLine={false} style={{ fontSize: 9 }} />
                          <ReChartsTooltip
                            contentStyle={{ backgroundColor: '#0f1115', borderColor: '#22242b', borderRadius: '8px' }}
                            labelStyle={{ fontWeight: 'bold', color: '#ffde82', fontSize: 11 }}
                          />
                          <Legend wrapperStyle={{ fontSize: 9 }} />
                          <Bar dataKey="ttft" name="首字延迟 (ms)" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                          <Bar dataKey="speed" name="生成速率 (T/s)" fill="#ffde82" radius={[3, 3, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>

                {/* Sandbox memory allocation list details */}
                <div className="bg-[#12141a] border border-[#22242b] rounded-xl p-4.5 space-y-3">
                  <div className="flex items-center justify-between border-b border-white/5 pb-2">
                    <span className="text-xs font-bold text-white uppercase tracking-wider block">
                      沙箱执行态内存配属（Sandbox Active JS Heap Allocation）
                    </span>
                    <span className="text-xs text-on-surface/50 font-mono">核算占比</span>
                  </div>

                  <div className="grid grid-cols-2 gap-x-6 gap-y-3.5 text-xs">
                    {activePerfData.memoryBreakdown.map((item, idx) => (
                      <div key={idx} className="space-y-1.5">
                        <div className="flex justify-between items-center">
                          <span className="font-semibold text-on-surface/80 flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                            <span>{item.name}</span>
                          </span>
                          <span className="font-mono text-white font-bold">{item.value} MB</span>
                        </div>
                        <div className="w-full bg-[#1c1e24] h-1.5 rounded-full overflow-hidden">
                          <div 
                            className="h-full rounded-full"
                            style={{ 
                              width: `${(item.value / 65) * 100}%`,
                              backgroundColor: item.color 
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
