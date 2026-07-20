/**
 * StreamPanel — AI 行为流送区
 * 嵌入 ChatPanel 消息流中，替代原占位图片
 * 样式与消息卡片一致，无缝融入对话流
 *
 * ★ 2026-07-20 v2 组件树完整接入 + 过程/结果互斥:
 *   - TaskExecutionCard 完整接入 TaskTree → SubTaskNode → StepRecordItem + ModelDelegationTag
 *   - 过程与结果互斥: streaming 时展开 TaskTree (过程), 结束后自动折叠成小图标
 *   - 用户可点击小图标重新展开过程
 *   - Token 统计在折叠状态下仍然显示
 *
 * ★ 2026-07-20 右键菜单修复:
 *   - onContextMenu 提升到 StreamPanel 外层 div, 覆盖整个流送区
 *   - 右键菜单 (StreamContextMenu) 渲染在 .stream-process-root 外部, 字体大小不受 CSS 变量影响
 *   - 即使 TaskExecutionCard 返回 null, 右键菜单仍可弹出 (只要有 hasTask 或 cards)
 */
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, ChevronDown, ChevronRight, CheckCircle2, AlertCircle, Settings } from '../utils/icons';
import type { PermissionMode } from '../types/streaming';
import type { UIUsagePart } from '../types/messages';
import { useStreamingStore } from '../state/streamingStore';
import { promptCardPool } from '../services/promptCardPool';
import { usePromptCards } from '../hooks/usePromptCards';
import { PromptCard } from './PromptCard';
import { useAutoPersist, clearChatAll } from '../services/actorIntegration';
import { useStreamSummary } from '../services/useStreamSummary';
import { useRootTaskFromParts } from '../services/usePartsDerived';
import { useLastAssistantMessage } from '../services/uiMessageStore';
import { useStreamAppearanceStore } from '../state/streamAppearanceStore';
import { StreamContextMenu } from './StreamContextMenu';
import { TaskTree } from './TaskTree';
import { UIMessagePartsRenderer } from './UIMessagePartsRenderer';

interface StreamPanelProps {
  chatId: string;
  mainModel: string;
  modelCount: number;
  permissionMode: PermissionMode;
}

export default function StreamPanel({ chatId, mainModel, modelCount, permissionMode }: StreamPanelProps) {
  const summary = useStreamSummary(chatId);
  const hasTask = summary.hasData;

  useAutoPersist(chatId);

  const cards = usePromptCards(chatId);
  const blockingCards = cards.filter(c => c.spec.priority === 'blocking');
  const nonBlockingCards = cards.filter(c => c.spec.priority === 'non_blocking');

  // ★ 2026-07-20 终极修复: document 级 capture 阶段监听 + boundingRect 坐标检测
  //   + React onContextMenu 双保险 + 左键齿轮按钮 fallback
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const fontColor = useStreamAppearanceStore(s => s.fontColor);
  const fontSize = useStreamAppearanceStore(s => s.fontSize);
  const rootRef = useRef<HTMLDivElement>(null);

  // 方案 A: document 级 capture 阶段监听 + boundingRect 坐标检测
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
        console.log('[StreamPanel] contextmenu capture: in bounds', { x: e.clientX, y: e.clientY, rect });
        e.preventDefault();
        e.stopImmediatePropagation();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }
    };
    document.addEventListener('contextmenu', handler, true);
    return () => document.removeEventListener('contextmenu', handler, true);
  }, []);

  // 方案 B: React onContextMenu 作为备份 (双保险)
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    console.log('[StreamPanel] contextmenu React event fired', { x: e.clientX, y: e.clientY });
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // 方案 C: 左键齿轮按钮 — 最可靠的 fallback
  const handleGearClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCtxMenu({ x: rect.left, y: rect.bottom + 4 });
  }, []);

  const handleCloseContextMenu = useCallback(() => setCtxMenu(null), []);

  // Ctrl+L 清空
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        clearChatAll(chatId);
        promptCardPool.clearChat(chatId);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [chatId]);

  if (!hasTask && blockingCards.length === 0 && nonBlockingCards.length === 0) return null;

  return (
    <>
      {/* ★ rootRef 用于 boundingRect 坐标检测, onContextMenu 作为备份
          齿轮按钮提供左键点击 fallback */}
      <div
        ref={rootRef}
        className="stream-process-root w-full flex flex-col gap-2 -mt-1.5 text-left pl-[5px] pr-[5px]"
        onContextMenu={handleContextMenu}
        style={{
          '--stream-font-size': `${fontSize}px`,
          '--stream-font-color': fontColor || undefined,
        } as React.CSSProperties}
        data-stream-color={fontColor ? '1' : undefined}
      >
        {/* ★ 左键齿轮按钮 — 点击打开外观设置面板 (右键也可打开) */}
        <div className="flex items-center justify-end -mb-1">
          <button
            type="button"
            title="流送区外观设置"
            onClick={handleGearClick}
            className="p-1 rounded-md text-on-surface/30 hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <Settings className="w-3 h-3" />
          </button>
        </div>

        {blockingCards.map(card => (
          <PromptCard
            key={card.spec.id}
            instance={card}
            onResolve={action => promptCardPool.resolve(card.spec.id, action)}
            onTimeout={() => promptCardPool.expire(card.spec.id)}
          />
        ))}

        {hasTask && (
          <TaskExecutionCard
            chatId={chatId}
            mainModel={mainModel}
            modelCount={modelCount}
            permissionMode={permissionMode}
          />
        )}

        {nonBlockingCards.map(card => (
          <PromptCard
            key={card.spec.id}
            instance={card}
            onResolve={action => promptCardPool.resolve(card.spec.id, action)}
            onTimeout={() => promptCardPool.expire(card.spec.id)}
          />
        ))}
      </div>

      {/* ★ 右键菜单 — 通过 Portal 渲染到 document.body,
          逃离婚 .sf-anim 父级的层叠上下文, 确保 position:fixed 相对于视口,
          z-index 不被限制, 菜单始终在最顶层 */}
      {ctxMenu && createPortal(
        <StreamContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={handleCloseContextMenu}
        />,
        document.body
      )}
    </>
  );
}

// ==================== TaskExecutionCard — 隔离的任务执行区 ====================

interface TaskExecutionCardProps {
  chatId: string;
  mainModel: string;
  modelCount: number;
  permissionMode: PermissionMode;
}

function TaskExecutionCard({ chatId, mainModel, modelCount, permissionMode }: TaskExecutionCardProps) {
  const summary = useStreamSummary(chatId);
  const streamMeta = useStreamingStore(s => s.streamTaskMeta[chatId]);
  const userInput = streamMeta?.userInput;
  const rootTaskId = streamMeta?.rootTaskId;
  const task = useRootTaskFromParts(chatId, userInput, rootTaskId);

  const lastMsg = useLastAssistantMessage(chatId);
  const usageParts = useMemo(
    () => (lastMsg?.parts.filter(p => p.type === 'usage') as UIUsagePart[]) ?? [],
    [lastMsg],
  );

  // ★ 2026-07-21 FIX: 过程不再自动消失 — manualExpanded 默认 true
  //   旧代码: 默认 false → 流送结束后 processExpanded = false → 过程消失
  //   新代码: 默认 true → 流送结束后过程保持可见, 用户可手动折叠
  //   isStreaming 时永远展开 (不受 manualExpanded 影响)
  const [manualExpanded, setManualExpanded] = useState(true);
  const isStreaming = lastMsg?.status === 'streaming' || lastMsg?.status === 'pending';
  const processExpanded = isStreaming || manualExpanded;

  const handleToggleProcess = useCallback(() => {
    setManualExpanded(prev => !prev);
  }, []);

  // ★ 2026-07-20 FIX: 移除过早的 return null — 即使 task 为空, parts 仍然存在需要渲染
  //   旧代码: if (isStreaming && !isActive) return null; → 流送刚开始无 phase 时整个组件消失
  //   旧代码: if (!task && !showTokenStats) return null; → task 派生失败时 parts 也消失
  //   新代码: 只在完全无数据 (无 task + 无 parts) 时返回 null
  if (!task && !summary.hasData) return null;

  const isDone = summary.isDone;
  const isError = summary.isError;

  const showTokenStats = (isDone || isError) && usageParts.length > 0;

  const formatToken = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const totalPrompt = usageParts.reduce((s, p) => s + p.promptTokens, 0);
  const totalCompletion = usageParts.reduce((s, p) => s + p.completionTokens, 0);
  const totalTokens = usageParts.reduce((s, p) => s + p.totalTokens, 0);
  const totalCached = usageParts.reduce((s, p) => s + (p.cachedTokens ?? 0), 0);
  const cacheRate = totalPrompt > 0 ? Math.round((totalCached / totalPrompt) * 100) : 0;

  const statusIcon = isDone
    ? <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />
    : isError
    ? <AlertCircle className="w-3 h-3 text-red-400 shrink-0" />
    : null;

  return (
    <div className="w-full">
      {/* ★ 2026-07-20 FIX: 过程和结果严格互斥
          - processExpanded=true 时只显示过程 (streaming 中或用户手动展开)
          - processExpanded=false 时只显示折叠按钮 + token 统计
          - 总结气泡由 ChatPanel 的 isAssistantStreaming 控制, 与 isStreaming 同步 */}
      {processExpanded ? (
        <div>
          <button
            onClick={handleToggleProcess}
            className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-on-surface/50 hover:text-on-surface/80 transition-colors mb-1"
          >
            <ChevronDown className="w-3 h-3 text-primary shrink-0" />
            <span className="font-medium">过程</span>
            {summary.subtaskCount > 0 && (
              <span className="text-[10px] text-on-surface/30 font-mono">
                {summary.doneCount}/{summary.subtaskCount}
              </span>
            )}
          </button>

          {task && (
            <TaskTree
              task={task}
              mainModel={mainModel}
              modelCount={modelCount}
              mode={permissionMode}
              chatId={chatId}
            />
          )}

          {/* ★ 2026-07-20: 渲染 parts 内容 — 显示实际过程 (文本输出/步骤/工具调用等)
              flat 模式: 不带 CollapsibleProcess 折叠包装器, 避免双层折叠
              ★ 2026-07-20 FIX: 移到 task && 外部, 即使 task 为空也渲染 parts */}
          <UIMessagePartsRenderer chatId={chatId} flat />
        </div>
      ) : (
        <>
          <button
            onClick={handleToggleProcess}
            className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-on-surface/50 hover:text-on-surface/80 transition-colors"
          >
            <ChevronRight className="w-3 h-3 text-primary shrink-0" />
            {statusIcon}
            <span className="font-medium">过程</span>
            {summary.subtaskCount > 0 && (
              <span className="text-[10px] text-on-surface/30 font-mono">
                {summary.doneCount}/{summary.subtaskCount}
              </span>
            )}
          </button>

          {showTokenStats && (
            <div className="flex items-center gap-2 px-1 py-1 text-[10px] font-mono text-on-surface/40">
              <Gauge className="w-3 h-3 text-on-surface/40 shrink-0" />
              <span className="shrink-0">Token</span>
              <span className="text-on-surface/50">
                {formatToken(totalPrompt)} + {formatToken(totalCompletion)}
              </span>
              <span className="text-on-surface/30">=</span>
              <span className="text-on-surface/70 font-bold">{formatToken(totalTokens)}</span>
              {totalCached > 0 && (
                <span className="text-emerald-400/60">
                  (缓存命中 {formatToken(totalCached)} · {cacheRate}%)
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
