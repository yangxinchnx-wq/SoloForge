/**
 * CanvasStudioPanel.tsx — Gemini Studio 风格的画布预览 + AI 指令面板
 *
 * 设计理念:
 *   - 纯预览，不暴露代码
 *   - 用户用自然语言告诉 AI 怎么修改画布
 *   - 底部输入框: "把鸭子改成奶牛" → 发送给 LLM
 *   - 快捷操作按钮: 放大/缩小/换颜色/重新生成
 *   - 实时预览渲染结果
 *
 * 2026-07-12: 初版
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Send, RefreshCw, Maximize2, Minimize2,
  Sparkles, History,
} from '../utils/icons';
import WebAstPreview from './WebAstPreview';

interface CanvasStudioPanelProps {
  /** DSL 数据 (直接渲染) */
  dsl: any;
  /** 背景色 */
  bgColor?: string;
  /** 关闭回调 */
  onClose?: () => void;
  /** 发送修改指令给 LLM */
  onSendToLLM?: (instruction: string) => void;
  /** 是否正在等待 LLM 响应 */
  isGenerating?: boolean;
}

// 快捷指令预设
const QUICK_PROMPTS = [
  { label: '换颜色', icon: '🎨', prompt: '把当前画布的主色调换成更好看的颜色' },
  { label: '放大', icon: '🔍', prompt: '把画布上的内容放大一些' },
  { label: '缩小', icon: '🔬', prompt: '把画布上的内容缩小一些' },
  { label: '加细节', icon: '✨', prompt: '给当前画布内容增加更多细节和装饰' },
  { label: '简化', icon: ' minimal', prompt: '简化当前画布内容，去掉多余的元素' },
  { label: '换风格', icon: '🎭', prompt: '换一种完全不同的视觉风格重新画' },
];

// 历史指令记录 (内存级, 组件销毁即丢)
const instructionHistory: string[] = [];

export default function CanvasStudioPanel({
  dsl,
  bgColor = '#1a1a2e',
  onClose,
  onSendToLLM,
  isGenerating = false,
}: CanvasStudioPanelProps) {
  const [instruction, setInstruction] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 自动聚焦输入框
  useEffect(() => {
    if (!isGenerating) inputRef.current?.focus();
  }, [isGenerating]);

  const handleSend = () => {
    const text = instruction.trim();
    if (!text || !onSendToLLM || isGenerating) return;
    instructionHistory.unshift(text);
    if (instructionHistory.length > 20) instructionHistory.pop();
    onSendToLLM(text);
    setInstruction('');
  };

  const handleQuickPrompt = (prompt: string) => {
    if (isGenerating) return;
    instructionHistory.unshift(prompt);
    if (instructionHistory.length > 20) instructionHistory.pop();
    onSendToLLM?.(prompt);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      className={`absolute inset-0 z-50 flex flex-col bg-bg/98 backdrop-blur-md ${
        isFullscreen ? 'fixed z-[9999]' : ''
      }`}
    >
      {/* ── 顶部栏 ── */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-outline/40 bg-surface/80 backdrop-blur shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          <span className="font-display font-semibold text-[11px] text-on-surface tracking-wide">
            Canvas Studio
          </span>
          {dsl?.type && (
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary/70">
              {dsl.type}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* 历史 */}
          {instructionHistory.length > 0 && (
            <button
              onClick={() => setShowHistory(v => !v)}
              className={`flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded transition-colors ${
                showHistory
                  ? 'bg-primary/15 text-primary'
                  : 'text-on-surface/50 hover:text-on-surface hover:bg-surface-bright/50'
              }`}
              title="历史指令"
            >
              <History className="w-3 h-3" />
            </button>
          )}

          {/* 全屏 */}
          <button
            onClick={() => setIsFullscreen(v => !v)}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded text-on-surface/50 hover:text-on-surface hover:bg-surface-bright/50 transition-colors"
            title={isFullscreen ? '退出全屏' : '全屏'}
          >
            {isFullscreen ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
          </button>

          {/* 关闭 */}
          {onClose && (
            <button
              onClick={onClose}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded text-on-surface/50 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="关闭 Studio"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* ── 历史指令浮层 ── */}
      {showHistory && instructionHistory.length > 0 && (
        <div className="absolute top-10 right-3 z-10 w-56 bg-surface-bright border border-outline/30 rounded-lg shadow-xl p-1.5 max-h-48 overflow-y-auto">
          <div className="text-[9px] font-bold text-on-surface/40 uppercase tracking-wider px-1.5 py-1 border-b border-outline/20 mb-1">
            历史指令
          </div>
          {instructionHistory.map((h, i) => (
            <button
              key={i}
              onClick={() => {
                setInstruction(h);
                setShowHistory(false);
                inputRef.current?.focus();
              }}
              className="w-full text-left px-2 py-1.5 rounded text-[10px] text-on-surface/70 hover:bg-primary/10 hover:text-primary transition-colors truncate"
            >
              {h}
            </button>
          ))}
        </div>
      )}

      {/* ── 预览区 (占满中间) ── */}
      <div className="flex-1 relative overflow-hidden">
        {dsl ? (
          <WebAstPreview root={dsl} bgColor={bgColor} />
        ) : (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 select-none"
            style={{ background: bgColor }}
          >
            <div
              className="w-14 h-14 rounded-2xl border-2 border-dashed flex items-center justify-center mb-3"
              style={{ borderColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.3)' }}
            >
              <Sparkles className="w-7 h-7" />
            </div>
            <div className="text-[11px] font-mono text-on-surface/40">
              等待画布数据...
            </div>
          </div>
        )}

        {/* 生成中遮罩 */}
        {isGenerating && (
          <div className="absolute inset-0 bg-bg/40 backdrop-blur-[2px] flex items-center justify-center">
            <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-bright/90 border border-outline/30 shadow-xl">
              <RefreshCw className="w-3.5 h-3.5 text-primary animate-spin" />
              <span className="text-[11px] font-mono text-on-surface/70">AI 正在修改...</span>
            </div>
          </div>
        )}
      </div>

      {/* ── 快捷操作按钮 ── */}
      <div className="shrink-0 px-3 py-1.5 border-t border-outline/40 bg-surface/60 backdrop-blur">
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
          {QUICK_PROMPTS.map((qp) => (
            <button
              key={qp.label}
              onClick={() => handleQuickPrompt(qp.prompt)}
              disabled={isGenerating}
              className="shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded-full bg-surface-bright/60 hover:bg-primary/15 hover:text-primary border border-outline/30 hover:border-primary/30 text-on-surface/60 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              title={qp.prompt}
            >
              <span className="text-[10px]">{qp.icon}</span>
              <span>{qp.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── 底部指令输入 ── */}
      <div className="shrink-0 px-3 py-2 border-t border-outline/40 bg-surface/80 backdrop-blur">
        <div className="flex items-center gap-1.5">
          <div className="flex-1 relative">
            <input
              ref={inputRef}
              type="text"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isGenerating}
              placeholder="描述你想要的修改... (如: 把鸭子改成奶牛)"
              className="w-full px-3 py-2 pr-9 text-[11px] bg-bg border border-outline/40 rounded-lg text-on-surface placeholder:text-on-surface/30 outline-none focus:border-primary/50 disabled:opacity-50 transition-colors"
            />
            {instruction && !isGenerating && (
              <button
                onClick={() => setInstruction('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface/30 hover:text-on-surface text-[12px]"
              >
                ✕
              </button>
            )}
          </div>
          <button
            onClick={handleSend}
            disabled={!instruction.trim() || isGenerating}
            className="flex items-center gap-1 px-3 py-2 text-[11px] font-bold bg-primary hover:bg-primary-hover text-bg rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
