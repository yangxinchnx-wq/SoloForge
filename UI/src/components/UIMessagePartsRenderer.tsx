/**
 * UIMessagePartsRenderer — Data Parts 模式的 UI 渲染层
 *
 * 设计参考: Vercel AI SDK 5 UIMessage parts 渲染模式
 *
 * 核心理念:
 *   旧模式: StreamPanel 直接消费 streamingStore.flatState → 手动映射渲染
 *   新模式: UIMessagePartsRenderer 消费 uiMessageStore.parts[] → 按 part 类型自动渲染
 *
 * 优势:
 *   1. 每个 part 是独立的渲染单元, 可 memo 化, 高频 part 更新不重渲染整棵树
 *   2. 新增 part 类型只需加一个渲染函数, 不需要改现有组件
 *   3. 消息是完整故事线: 用户看到的是 "AI 做了什么" 的时间轴, 而非零散状态
 *
 * 2026-07-10: P3 集成层
 * 2026-07-10: 视觉打磨 — 交错入场动画、审计折叠、phase 过渡、步骤条动画
 * 2026-07-11: 补充 model-action Part 渲染器 (修复 LLM/Agent 思考过程不显示的 bug)
 */

import React, { memo, useDeferredValue, useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
  Zap,
  Shield,
  Box,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  Globe,
} from '../utils/icons';
import { useLastAssistantMessage, useUIMessages } from '../services/uiMessageStore';
import { useAgentName, useAgentAvatar } from '../state/streamingStore';
import type {
  UIPart,
  UITextPart,
  UIPhaseChangePart,
  UISubTaskCreatedPart,
  UISubTaskProgressPart,
  UISubTaskStepPart,
  UISubTaskDonePart,
  UIModelDelegationPart,
  UIModelActionPart,
  UIAuditStartPart,
  UIAuditFindingPart,
  UIAuditDonePart,
  UIDeliveryPart,
  UIClarifyPart,
  UIErrorPart,
  UIBrowserStepPart,
  UIBrowserScreenshotPart,
} from '../types/messages';
import { ModelIcon } from './ModelIcon';

// ==================== 动画常量 ====================

/** 统一 spring 配置: bounce 必须为 0 (无弹跳) */
const SPRING = { type: 'spring' as const, duration: 0.3, bounce: 0 };
/** CSS 等效缓动曲线 */
const EASE = [0.2, 0, 0, 1] as const;

// ==================== 主组件 ====================

interface UIMessagePartsRendererProps {
  chatId: string;
  /** 指定要渲染的 UIMessage id。
   *  ★ 2026-07-13: 支持多轮对话独立气泡 — 每轮 assistant 消息渲染自己的 parts。
   *  不传则回退到最后一条 assistant 消息 (兼容旧调用方)。 */
  messageId?: string;
}

export const UIMessagePartsRenderer = memo(function UIMessagePartsRenderer({
  chatId,
  messageId,
}: UIMessagePartsRendererProps) {
  const allMessages = useUIMessages(chatId);
  const lastAssistant = useLastAssistantMessage(chatId);
  const message = messageId
    ? allMessages.find(m => m.id === messageId)
    : lastAssistant;

  const deferredParts = useDeferredValue(message?.parts ?? EMPTY_PARTS);
  const isStreaming = message?.status === 'streaming';

  // ★ FIX 2026-07-14: 过滤掉 text / delivery / subtask-step
  //   text: LLM 文本已在主对话气泡显示
  //   delivery: 累积文本重复
  //   subtask-step: "EXECUTE" 与 phase-change 重复
  //   保留 model-action / model-delegation / usage (用户要求可见)
  const processParts = deferredParts.filter(
    p => p.type !== 'text' && p.type !== 'delivery' && p.type !== 'subtask-step'
  );

  if (!message) return null;

  if (processParts.length === 0) {
    return isStreaming ? (
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-on-surface/50 font-mono">
        <Loader2 className="w-3 h-3 text-primary animate-spin shrink-0" />
        <span>正在准备…</span>
      </div>
    ) : null;
  }

  return (
    <CollapsibleProcess parts={processParts} isStreaming={isStreaming} chatId={chatId} />
  );
});

// ==================== CollapsibleProcess — 可折叠过程块 ====================
// ★ 2026-07-14: 用户要求 — 简化、可折叠、不消失
//   - streaming 时自动展开
//   - 完成后 1.5s 自动折叠 (但不消失)
//   - 用户可手动点击展开/折叠

interface CollapsibleProcessProps {
  parts: UIPart[];
  isStreaming: boolean;
  chatId: string;
}

const CollapsibleProcess = memo(function CollapsibleProcess({ parts, isStreaming, chatId }: CollapsibleProcessProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [userToggled, setUserToggled] = useState(false);

  // streaming 时自动展开; 完成后 1.5s 自动折叠 (仅在用户未手动操作过时)
  useEffect(() => {
    if (isStreaming) {
      if (!isOpen) setIsOpen(true);
      return;
    }
    // streaming 结束后延迟折叠
    if (!userToggled) {
      const timer = setTimeout(() => setIsOpen(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = useCallback(() => {
    setUserToggled(true);
    setIsOpen(prev => !prev);
  }, []);

  return (
    <div className="rounded-lg border border-outline/20 bg-bg/30 overflow-hidden">
      {/* 折叠头 */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-on-surface/60 hover:bg-surface/40 transition-colors"
      >
        {isStreaming ? (
          <Loader2 className="w-3 h-3 text-primary animate-spin shrink-0" />
        ) : isOpen ? (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0" />
        )}
        <span className="font-medium">过程</span>
        <span className="text-[10px] text-on-surface/30 font-mono ml-0.5">{parts.length}</span>
      </button>

      {/* 展开内容 */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-1.5 px-3 pb-2.5 pt-0.5">
              {parts.map((part, index) => {
                const isLast = index === parts.length - 1;
                return (
                  <motion.div
                    key={`${part.type}-${index}`}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...SPRING, delay: Math.min(index * 0.03, 0.2) }}
                  >
                    <PartRenderer
                      part={part}
                      isStreaming={isStreaming && isLast}
                      isLast={isLast}
                      chatId={chatId}
                    />
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

// ==================== 单 Part 渲染器 ====================

interface PartRendererProps {
  part: UIPart;
  isStreaming: boolean;
  isLast: boolean;
  chatId: string;
}

const PartRenderer = memo(function PartRenderer({ part, isStreaming, isLast, chatId }: PartRendererProps) {
  switch (part.type) {
    case 'text':
      return <TextPartView part={part} isStreaming={isStreaming && isLast} />;
    case 'phase-change':
      return <PhaseChangePartView part={part} />;
    case 'subtask-created':
      return <SubTaskCreatedPartView part={part} />;
    case 'subtask-progress':
      return <SubTaskProgressPartView part={part} />;
    case 'subtask-step':
      return <SubTaskStepPartView part={part} />;
    case 'subtask-done':
      return <SubTaskDonePartView part={part} />;
    case 'model-delegation':
      return <ModelDelegationPartView part={part} chatId={chatId} />;
    case 'model-action':
      return <ModelActionPartView part={part} />;
    case 'audit-start':
      return <AuditStartPartView part={part} />;
    case 'audit-finding':
      return <AuditFindingPartView part={part} />;
    case 'audit-done':
      return <AuditDonePartView part={part} />;
    case 'delivery':
      return <DeliveryPartView part={part} />;
    case 'clarify':
      return <ClarifyPartView part={part} />;
    case 'error':
      return <ErrorPartView part={part} />;
    case 'browser-step':
      return <BrowserStepPartView part={part} />;
    case 'browser-screenshot':
      return <BrowserScreenshotPartView part={part} />;
    default:
      return null;
  }
});

// ==================== Part 视图组件 ====================

const TextPartView = memo(function TextPartView({ part, isStreaming }: { part: UITextPart; isStreaming: boolean }) {
  return (
    <div className="text-[12px] leading-relaxed text-on-surface/90 whitespace-pre-wrap break-words [text-wrap:pretty]">
      {part.text}
      <AnimatePresence>
        {isStreaming && part.streaming && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="inline-block w-1.5 h-3.5 bg-primary ml-0.5 align-middle rounded-sm"
            style={{ animation: 'pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite' }}
          />
        )}
      </AnimatePresence>
    </div>
  );
});

// ── Phase Change: 弹簧过渡 + 颜色淡入 ──

const PhaseChangePartView = memo(function PhaseChangePartView({ part }: { part: UIPhaseChangePart }) {
  const phaseColors: Record<string, string> = {
    DECOMPOSING: 'text-blue-400 bg-blue-500/10',
    DISPATCHING: 'text-cyan-400 bg-cyan-500/10',
    EXECUTING: 'text-indigo-400 bg-indigo-500/10',
    REVIEWING: 'text-amber-400 bg-amber-500/10',
    AUDITING: 'text-purple-400 bg-purple-500/10',
    DELIVERING: 'text-teal-400 bg-teal-500/10',
    DONE: 'text-green-400 bg-green-500/10',
    ERROR: 'text-red-400 bg-red-500/10',
    SINGLE_MODEL: 'text-blue-400 bg-blue-500/10',
    CLARIFY: 'text-orange-400 bg-orange-500/10',
    PLANNING: 'text-violet-400 bg-violet-500/10',
  };
  const colorClass = phaseColors[part.to] ?? 'text-on-surface/60 bg-on-surface/5';

  return (
    <div className="flex items-center gap-1.5 text-[10px] font-mono">
      {part.from !== 'CLARIFY' && (
        <>
          <span className="text-on-surface/30">{part.from}</span>
          <ArrowRight className="w-3 h-3 text-on-surface/30" />
        </>
      )}
      <motion.span
        key={part.to}
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={SPRING}
        className={`px-1.5 py-0.5 rounded font-bold ${colorClass}`}
        style={{ transformOrigin: 'left center' }}
      >
        {part.to}
      </motion.span>
      {part.detail && (
        <span className="text-on-surface/40 break-words [text-wrap:pretty]">{part.detail}</span>
      )}
    </div>
  );
});

// ── SubTask Created: concentric radius ──

const SubTaskCreatedPartView = memo(function SubTaskCreatedPartView({ part }: { part: UISubTaskCreatedPart }) {
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-surface"
      style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px rgba(255,255,255,0.06)' }}
    >
      <div className="w-6 h-6 rounded-lg bg-on-surface/5 flex items-center justify-center shrink-0">
        <ModelIcon modelName={part.assigneeModel} size={18} className="shrink-0" />
      </div>
      <div className="flex flex-col min-w-0">
        <span className="text-[10px] font-bold text-primary truncate">{part.assigneeModel}</span>
        <span className="text-[10px] text-on-surface/50 truncate">{part.description}</span>
      </div>
    </div>
  );
});

// ── SubTask Progress: spring-animated width + glow ──

const SubTaskProgressPartView = memo(function SubTaskProgressPartView({ part }: { part: UISubTaskProgressPart }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1">
      <div className="flex-1 h-1 rounded-full bg-on-surface/10 overflow-hidden">
        <motion.div
          className="h-full rounded-full bg-blue-500"
          initial={{ width: 0 }}
          animate={{ width: `${part.progress}%` }}
          transition={SPRING}
          style={{
            boxShadow: part.progress > 0 ? '0 0 4px rgba(59, 130, 246, 0.4)' : undefined,
          }}
        />
      </div>
      <span className="text-[10px] font-mono font-bold text-on-surface/50 tabular-nums w-8 text-right">
        {part.progress}%
      </span>
    </div>
  );
});

// ── SubTask Step: icon cross-fade on status change ──

const SubTaskStepPartView = memo(function SubTaskStepPartView({ part }: { part: UISubTaskStepPart }) {
  return (
    <div className="flex items-center gap-1.5 pl-2">
      <ChevronRight className="w-2.5 h-2.5 text-on-surface/20" />
      <div className="relative w-3 h-3 shrink-0">
        <AnimatePresence initial={false} mode="popLayout">
          {part.status === 'done' && (
            <motion.div
              key="done"
              initial={{ scale: 0.25, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.25, opacity: 0 }}
              transition={SPRING}
              className="absolute inset-0"
            >
              <CheckCircle2 className="w-3 h-3 text-green-400" />
            </motion.div>
          )}
          {part.status === 'error' && (
            <motion.div
              key="error"
              initial={{ scale: 0.25, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.25, opacity: 0 }}
              transition={SPRING}
              className="absolute inset-0"
            >
              <AlertCircle className="w-3 h-3 text-red-400" />
            </motion.div>
          )}
          {part.status !== 'done' && part.status !== 'error' && (
            <motion.div
              key="running"
              initial={{ scale: 0.25, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.25, opacity: 0 }}
              transition={SPRING}
              className="absolute inset-0"
            >
              <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <span className="text-[10px] font-mono text-on-surface/60 shrink-0">{part.step}</span>
      {part.detail && (
        <span className="text-[10px] text-on-surface/40 break-words [text-wrap:pretty]">{part.detail}</span>
      )}
    </div>
  );
});

// ── SubTask Done: icon spring-in ──

const SubTaskDonePartView = memo(function SubTaskDonePartView({ part }: { part: UISubTaskDonePart }) {
  const isSuccess = part.status === 'done';
  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-surface"
      style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px rgba(255,255,255,0.06)' }}
    >
      <motion.div
        initial={{ scale: 0.25, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={SPRING}
      >
        {isSuccess
          ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
          : <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
      </motion.div>
      <span className={`text-[10px] font-medium shrink-0 ${isSuccess ? 'text-green-400' : 'text-red-400'}`}>
        {isSuccess ? '已完成' : '失败'}
      </span>
      {part.result && (
        <span className="text-[10px] text-on-surface/50 break-words [text-wrap:pretty] flex-1">{part.result}</span>
      )}
    </div>
  );
});

const ModelDelegationPartView = memo(function ModelDelegationPartView({ part, chatId }: { part: UIModelDelegationPart; chatId: string }) {
  // 实时查询 agent 名字和头像 — agent 改名/改头像后自动响应式更新, 不缓存旧值
  const agentName = useAgentName(chatId, part.agentId);
  const agentAvatar = useAgentAvatar(chatId, part.agentId);
  // 新格式: "副模型 → agent → 任务"
  // part.fromModel = 副模型名, part.detail = 任务描述
  return (
    <div className="flex items-start gap-1.5 text-[10px] font-mono text-on-surface/50">
      <span className="text-on-surface/40 shrink-0">{part.fromModel}</span>
      <ArrowRight className="w-3 h-3 text-on-surface/30 shrink-0 mt-0.5" />
      {agentAvatar && (
        agentAvatar.startsWith('http') || agentAvatar.startsWith('/') || agentAvatar.startsWith('data:')
          ? <img src={agentAvatar} alt="" className="w-3.5 h-3.5 rounded-full object-cover shrink-0" />
          : <span className="text-xs leading-none shrink-0">{agentAvatar}</span>
      )}
      {agentName && (
        <span className="text-primary font-bold shrink-0">{agentName}</span>
      )}
      <ArrowRight className="w-3 h-3 text-on-surface/30 shrink-0 mt-0.5" />
      {part.detail && <span className="text-on-surface/70 font-medium break-words [text-wrap:pretty]">{part.detail}</span>}
    </div>
  );
});

// ── Model Action: LLM/Agent 思考与调用过程 (v3.2 新增, v3.2.1 去除图标) ──

const ModelActionPartView = memo(function ModelActionPartView({ part }: { part: UIModelActionPart }) {
  return (
    <div className="flex items-start gap-1.5 pl-2 py-0.5 text-[10px] text-on-surface/50 font-mono">
      <span className="text-on-surface/30 shrink-0">[动作]</span>
      <span className="shrink-0">{part.action}</span>
      {part.detail && (
        <span className="text-on-surface/40 break-words [text-wrap:pretty]">{part.detail}</span>
      )}
    </div>
  );
});

// ── Audit Start: shield pulse ──

const AuditStartPartView = memo(function AuditStartPartView({ part }: { part: UIAuditStartPart }) {
  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-purple-500/5"
      style={{ boxShadow: '0 0 0 1px rgba(168, 85, 247, 0.12)' }}
    >
      <motion.div
        initial={{ scale: 0.25, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={SPRING}
      >
        <Shield className="w-3.5 h-3.5 text-purple-400 shrink-0" />
      </motion.div>
      <span className="text-[10px] font-bold text-purple-400">审计启动</span>
      <span className="text-[10px] text-on-surface/30">
        {part.auditorType === 'main_model' ? '主模型审查' : '子 Agent 审查'}
      </span>
    </div>
  );
});

// ── Audit Finding: collapsible detail ──

const AuditFindingPartView = memo(function AuditFindingPartView({ part }: { part: UIAuditFindingPart }) {
  const [expanded, setExpanded] = useState(false);
  const handleToggle = useCallback(() => setExpanded(prev => !prev), []);

  const severityColors: Record<string, string> = {
    error: 'text-red-400 bg-red-500/10',
    warning: 'text-amber-400 bg-amber-500/10',
    info: 'text-blue-400 bg-blue-500/10',
  };
  const sevClass = severityColors[part.finding.severity] ?? severityColors.info;
  const sevLabel = part.finding.severity === 'error' ? '严重' : part.finding.severity === 'warning' ? '警告' : '建议';
  const hasSuggestion = Boolean(part.finding.suggestion);

  return (
    <div
      className="rounded-xl bg-surface"
      style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px rgba(255,255,255,0.04)' }}
    >
      <button
        onClick={handleToggle}
        className="flex items-start gap-1.5 px-2.5 py-1.5 w-full text-left min-h-[40px]"
        style={{ touchAction: 'manipulation' }}
      >
        <AlertTriangle className={`w-3 h-3 mt-0.5 shrink-0 ${sevClass.split(' ')[0]}`} />
        <div className="flex flex-col min-w-0 gap-0.5 flex-1">
          <div className="flex items-center gap-1">
            <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${sevClass}`}>{sevLabel}</span>
            <span className="text-[10px] text-on-surface/50 truncate">{part.finding.target}</span>
          </div>
        </div>
        {hasSuggestion && (
          <motion.div
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={SPRING}
            className="shrink-0 mt-0.5"
          >
            <ChevronDown className="w-3 h-3 text-on-surface/30" />
          </motion.div>
        )}
      </button>
      <AnimatePresence initial={false}>
        {expanded && hasSuggestion && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="px-2.5 pb-1.5 pl-7">
              <span className="text-[10px] text-on-surface/40 leading-relaxed">
                {part.finding.suggestion}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

const AuditDonePartView = memo(function AuditDonePartView({ part }: { part: UIAuditDonePart }) {
  void part;
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-0.5">
      <motion.div
        initial={{ scale: 0.25, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={SPRING}
      >
        <CheckCircle2 className="w-3 h-3 text-purple-400 shrink-0" />
      </motion.div>
      <span className="text-[10px] text-on-surface/40">审计完成</span>
    </div>
  );
});

// ── Delivery: concentric radius ──

const DeliveryPartView = memo(function DeliveryPartView({ part }: { part: UIDeliveryPart }) {
  return (
    <div
      className="px-3 py-2.5 rounded-2xl bg-green-500/5"
      style={{ boxShadow: '0 0 0 1px rgba(34, 197, 94, 0.12)' }}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <Box className="w-3.5 h-3.5 text-green-400 shrink-0" />
        <span className="text-[10px] font-bold text-green-400">交付结果</span>
      </div>
      <div className="text-[12px] leading-relaxed text-on-surface/80 whitespace-pre-wrap break-words [text-wrap:pretty]">
        {part.result}
      </div>
    </div>
  );
});

const ClarifyPartView = memo(function ClarifyPartView({ part }: { part: UIClarifyPart }) {
  return (
    <div
      className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-xl bg-orange-500/5"
      style={{ boxShadow: '0 0 0 1px rgba(249, 115, 22, 0.12)' }}
    >
      <Zap className="w-3 h-3 mt-0.5 text-orange-400 shrink-0" />
      <div className="flex flex-col min-w-0 gap-0.5">
        <span className="text-[10px] font-bold text-orange-400">追问</span>
        <span className="text-[11px] text-on-surface/70 [text-wrap:pretty]">{part.question}</span>
        {part.response && (
          <span className="text-[10px] text-on-surface/40">→ {part.response}</span>
        )}
      </div>
    </div>
  );
});

const ErrorPartView = memo(function ErrorPartView({ part }: { part: UIErrorPart }) {
  return (
    <div
      className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-xl bg-red-500/5"
      style={{ boxShadow: '0 0 0 1px rgba(239, 68, 68, 0.12)' }}
    >
      <AlertCircle className="w-3.5 h-3.5 mt-0.5 text-red-400 shrink-0" />
      <div className="flex flex-col min-w-0 gap-0.5">
        <span className="text-[10px] font-bold text-red-400">错误</span>
        <span className="text-[11px] text-on-surface/70 [text-wrap:pretty]">{part.message}</span>
        {part.detail && (
          <span className="text-[10px] text-on-surface/40">{part.detail}</span>
        )}
      </div>
    </div>
  );
});

const BrowserStepPartView = memo(function BrowserStepPartView({ part }: { part: UIBrowserStepPart }) {
  return (
    <div className="flex items-start gap-1.5 px-2.5 py-1">
      <Globe className="w-3 h-3 text-indigo-400 shrink-0 mt-0.5" />
      <span className="text-[10px] font-mono text-on-surface/40 tabular-nums shrink-0">#{part.stepIndex}</span>
      <span className="text-[10px] text-on-surface/60 break-words [text-wrap:pretty] flex-1">{part.detail}</span>
      {part.progress !== undefined && (
        <span className="text-[10px] font-mono text-on-surface/30 tabular-nums ml-auto">{part.progress}%</span>
      )}
    </div>
  );
});

const BrowserScreenshotPartView = memo(function BrowserScreenshotPartView({ part }: { part: UIBrowserScreenshotPart }) {
  return (
    <div className="rounded-xl overflow-hidden max-w-[280px]" style={{ boxShadow: '0 0 0 1px rgba(255,255,255,0.06)' }}>
      <img
        src={`data:image/png;base64,${part.screenshotB64}`}
        alt="浏览器截图"
        className="w-full h-auto block"
        style={{ outline: '1px solid rgba(255,255,255,0.06)' }}
      />
    </div>
  );
});

// ==================== 常量 ====================

const EMPTY_PARTS: UIPart[] = [];
