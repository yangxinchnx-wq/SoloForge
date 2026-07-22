import React, { memo, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, Bot, CheckCircle2, ChevronDown, ChevronRight, Clock, Shield, Sparkles, Zap } from '../utils/icons';
import type { UIPart } from '../types/messages';
import { deriveExecutionView, getDelegationForAgent, type AgentExecutionView, type ExecutionStatus } from '../services/executionViewModel';
import { useLastAssistantMessage, useUIMessages } from '../services/uiMessageStore';
import { useStreamingStore } from '../state/streamingStore';
import { useStreamSummary } from '../services/useStreamSummary';
import { useStreamAppearanceStore } from '../state/streamAppearanceStore';

interface ExecutionStreamProps {
  chatId: string;
  messageId?: string;
}

const STATUS_LABELS: Record<ExecutionStatus, string> = {
  pending: '等待中',
  running: '进行中',
  done: '已完成',
  error: '未完成',
  cancelled: '已取消',
};

const STATUS_CLASSES: Record<ExecutionStatus, string> = {
  pending: 'text-on-surface/40 bg-on-surface/5',
  running: 'text-primary bg-primary/10',
  done: 'text-emerald-400 bg-emerald-500/10',
  error: 'text-red-400 bg-red-500/10',
  cancelled: 'text-amber-400 bg-amber-500/10',
};

function StatusIcon({ status }: { status: ExecutionStatus }) {
  if (status === 'done') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
  if (status === 'error') return <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;
  if (status === 'running') return <Sparkles className="w-3.5 h-3.5 text-primary shrink-0 animate-pulse" />;
  return <Clock className="w-3.5 h-3.5 text-on-surface/30 shrink-0" />;
}

function AgentAvatar({ agent }: { agent: AgentExecutionView }) {
  if (agent.agentAvatar?.startsWith('http') || agent.agentAvatar?.startsWith('/') || agent.agentAvatar?.startsWith('data:')) {
    return <img src={agent.agentAvatar} alt="" className="w-6 h-6 rounded-full object-cover" />;
  }
  if (agent.agentAvatar) return <span className="text-base leading-none">{agent.agentAvatar}</span>;
  return <Bot className="w-5 h-5 text-primary/70" />;
}

const AgentNode = memo(function AgentNode({ agent, delegation }: { agent: AgentExecutionView; delegation?: ReturnType<typeof getDelegationForAgent> }) {
  const [open, setOpen] = useState(agent.status === 'running');
  const label = agent.agentName || agent.model || '执行 Agent';
  return (
    <div className="rounded-lg border border-outline/15 bg-bg/35 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="flex items-center gap-2 w-full min-h-[40px] px-3 py-2 text-left hover:bg-on-surface/[0.03] transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-on-surface/35 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-on-surface/35 shrink-0" />}
        <span className="w-6 h-6 rounded-full bg-primary/8 flex items-center justify-center shrink-0"><AgentAvatar agent={agent} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-semibold text-on-surface truncate">{label}</span>
          <span className="block text-[10px] text-on-surface/48 truncate">{agent.task}</span>
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_CLASSES[agent.status]}`}>{STATUS_LABELS[agent.status]}</span>
      </button>

      {delegation && (
        <div className="px-3 pb-1 text-[10px] text-on-surface/45">
          <span>{delegation.caller || '主模型'}</span><span className="mx-1.5 text-on-surface/25">→</span><span className="text-primary/80">{label}</span>
        </div>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="px-3 pb-2 pt-1 border-t border-outline/10">
              {agent.steps.length > 0 ? (
                <div className="space-y-1">
                  {agent.steps.map(step => (
                    <div key={step.id} className="flex items-center gap-2 text-[10px]">
                      <StatusIcon status={step.status === 'done' ? 'done' : step.status === 'error' ? 'error' : step.status === 'running' ? 'running' : 'pending'} />
                      <span className={step.status === 'done' ? 'text-on-surface/50' : 'text-on-surface/75'}>{step.label}</span>
                      {step.progress !== undefined && step.status === 'running' && <span className="ml-auto font-mono tabular-nums text-primary/70">{step.progress}%</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-on-surface/35">正在准备工作</div>
              )}
              {agent.latestActivity && <div className="mt-2 text-[10px] text-on-surface/45 truncate">{agent.latestActivity}</div>}
              {agent.output && agent.status !== 'running' && <div className="mt-2 max-h-24 overflow-y-auto text-[10px] leading-relaxed text-on-surface/55 whitespace-pre-wrap">{agent.output}</div>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

export const ExecutionStream = memo(function ExecutionStream({ chatId, messageId }: ExecutionStreamProps) {
  const allMessages = useUIMessages(chatId);
  const message = messageId ? allMessages.find(item => item.id === messageId) : useLastAssistantMessage(chatId);
  const summary = useStreamSummary(chatId);
  const agents = useStreamingStore(s => s.agentsMap[chatId] ?? []);
  const fontColor = useStreamAppearanceStore(s => s.fontColor);
  const fontSize = useStreamAppearanceStore(s => s.fontSize);
  const agentNames = useMemo(() => Object.fromEntries(agents.map(agent => [agent.id, { name: agent.name, avatar: agent.avatar }])), [agents]);
  const view = useMemo(() => deriveExecutionView(message?.parts as UIPart[] | undefined, agentNames), [message, agentNames]);

  if (!message && !summary.hasData) return null;
  const completed = view.agents.filter(agent => agent.status === 'done').length;
  const running = view.agents.filter(agent => agent.status === 'running').length;

  return (
    <div className="w-full flex flex-col gap-2 text-left" style={{ '--stream-font-size': `${fontSize}px`, '--stream-font-color': fontColor || undefined } as React.CSSProperties} data-stream-color={fontColor ? '1' : undefined}>
      <div className="flex items-center gap-2 px-1">
        <StatusIcon status={view.error ? 'error' : view.phase === 'DONE' ? 'done' : 'running'} />
        <span className="text-[11px] font-medium text-on-surface/75">{view.headline}</span>
        {view.agents.length > 0 && <span className="text-[10px] text-on-surface/35 font-mono tabular-nums">{completed}/{view.agents.length} 已完成</span>}
      </div>

      {view.delegations.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 text-[10px] text-on-surface/50 border-l-2 border-primary/30 bg-primary/[0.03]">
          <Bot className="w-3.5 h-3.5 text-primary/70 shrink-0" />
          <span>{view.delegations.length === 1 ? '主模型已委派一个工作项' : `主模型已分配 ${view.delegations.length} 个工作项`}</span>
          {running > 0 && <span className="text-primary/70">{running} 个进行中</span>}
        </div>
      )}

      {view.agents.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {view.agents.map(agent => <AgentNode key={agent.id} agent={agent} delegation={getDelegationForAgent(view, agent)} />)}
        </div>
      )}

      {view.rootActions.length > 0 && (
        <div className="flex flex-col gap-1 px-3 py-2 border-l-2 border-on-surface/15 bg-on-surface/[0.02]">
          <div className="flex items-center gap-2 text-[10px] text-on-surface/55"><Zap className="w-3.5 h-3.5 text-primary/70 shrink-0" /><span>主模型工作记录</span></div>
          {view.rootActions.map(item => <div key={item.id} className="pl-5 text-[10px] text-on-surface/55 truncate">{item.detail || item.action}</div>)}
        </div>
      )}

      {view.review.started && (
        <div className="flex items-center gap-2 px-3 py-2 text-[10px] border-l-2 border-violet-400/40 bg-violet-500/[0.03]">
          <Shield className="w-3.5 h-3.5 text-violet-400 shrink-0" />
          <span className="text-on-surface/65">结果检查</span>
          <span className="text-on-surface/40">{view.review.completed ? '已完成' : '进行中'}</span>
          {view.review.findings.length > 0 && <span className="text-amber-400/75">{view.review.findings.length} 条建议</span>}
        </div>
      )}

      {view.error && <div className="text-[10px] text-red-400/80 px-1">{view.error}</div>}
      {view.delivery && <div className="text-[10px] text-emerald-400/80 px-1">结果已整理完成</div>}
    </div>
  );
});
