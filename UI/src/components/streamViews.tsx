/**
 * AI 社会 6 个流式子组件
 *
 * 2026-07-03 阶段3.1.B 从 ChatPanel.tsx 抽出。
 * 全部只依赖 streamState 切片，无副作用，无内部 state。
 * 设计文档: UI/连接.md §4.3
 *
 * 1. WorkerOutputsView  - 并行副模型输出卡片
 * 2. ScoresView         - Scorer 打分表
 * 3. JudgeView          - Judge 选定结果
 * 4. AuditView          - Auditor 审计发现
 * 5. FinalReplyView     - 最终回答（流式）
 * 6. SuggestEnableView  - 阶段 0 启发式建议启用副模型
 */

import React from 'react';
import { Workflow, Gauge, BadgeCheck, ShieldCheck, Rocket, Zap } from '../utils/icons';

// ─────────────────────────────────────────────────────────────
// 共享类型（也可考虑外移到 types/stream.ts,目前只此模块使用故就近定义）
// ─────────────────────────────────────────────────────────────

export interface WorkerOutput {
  workerIdx: number;
  modelName: string;
  content: string;
  status: string;
}

export interface ScoreEntry {
  workerIdx: number;
  score: number;
  reason: string;
  modelName?: string;
}

export interface AuditFinding {
  severity: string;
  target: string;
  suggestion: string;
}

export interface SuggestEnableItem {
  candidateName: string;
  expectedGain: number;
  reason: string;
}

// ─────────────────────────────────────────────────────────────
// 1. WorkerOutputsView
// ─────────────────────────────────────────────────────────────

export function WorkerOutputsView({ outputs }: { outputs: WorkerOutput[] }) {
  if (outputs.length === 0) return null;
  return (
    <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/30">
      <div className="px-2.5 py-1.5 bg-surface border-b border-outline/20 flex items-center gap-2 text-[10.5px] text-on-surface/80 font-bold">
        <Workflow className="w-3 h-3" /> 副模型并行输出（{outputs.length}）
      </div>
      <div className="grid grid-cols-1 gap-1.5 p-2">
        {outputs.map(w => (
          <div key={w.workerIdx} className="bg-surface/40 border border-outline/20 rounded-md p-2 text-[11px]">
            <div className="flex items-center justify-between mb-1">
              <span className="font-bold text-on-surface/90">#{w.workerIdx} {w.modelName}</span>
              <span className={
                w.status === 'done' ? 'text-emerald-400' :
                w.status === 'error' ? 'text-rose-400' :
                w.status === 'streaming' ? 'text-amber-400 animate-pulse' :
                'text-on-surface/40'
              }>
                {w.status === 'done' ? '✓ 完成' :
                 w.status === 'error' ? '✗ 失败' :
                 w.status === 'streaming' ? '... 生成中' :
                 '○ 等待'}
              </span>
            </div>
            {w.content && (
              <div className="text-on-surface/70 max-h-24 overflow-y-auto whitespace-pre-wrap text-[10.5px] leading-snug">
                {w.content.length > 300 ? w.content.slice(0, 300) + '...' : w.content}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 2. ScoresView
// ─────────────────────────────────────────────────────────────

export function ScoresView({ scores }: { scores: ScoreEntry[] }) {
  if (scores.length === 0) return null;
  return (
    <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/30">
      <div className="px-2.5 py-1.5 bg-surface border-b border-outline/20 flex items-center gap-2 text-[10.5px] text-on-surface/80 font-bold">
        <Gauge className="w-3 h-3" /> Scorer 打分
      </div>
      <div className="p-2 space-y-1 text-[11px]">
        {scores.map(s => (
          <div key={s.workerIdx} className="flex items-start gap-2">
            <span className="font-mono text-on-surface/60 shrink-0">#{s.workerIdx}</span>
            <span className={
              s.score >= 80 ? 'text-emerald-400 font-bold' :
              s.score >= 60 ? 'text-amber-400 font-bold' :
              'text-rose-400 font-bold'
            }>{s.score}分</span>
            <span className="text-on-surface/70 flex-1">{s.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 3. JudgeView
// ─────────────────────────────────────────────────────────────

export function JudgeView({ chosen, reasoning }: { chosen: number[]; reasoning: string }) {
  if (chosen.length === 0) return null;
  return (
    <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/30">
      <div className="px-2.5 py-1.5 bg-surface border-b border-outline/20 flex items-center gap-2 text-[10.5px] text-on-surface/80 font-bold">
        <BadgeCheck className="w-3 h-3" /> Judge 选定
      </div>
      <div className="p-2 text-[11px] text-on-surface/80">
        <div className="mb-1">选中：<span className="font-mono text-emerald-400">[{chosen.join(', ')}]</span></div>
        {reasoning && <div className="text-on-surface/60 italic">理由：{reasoning}</div>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 4. AuditView
// ─────────────────────────────────────────────────────────────

const sevColor = (s: string) =>
  s === 'critical' ? 'text-rose-400 border-rose-400/30' :
  s === 'high' ? 'text-orange-400 border-orange-400/30' :
  s === 'medium' ? 'text-amber-400 border-amber-400/30' :
  'text-blue-400 border-blue-400/30';

export function AuditView({ findings }: { findings: AuditFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/30">
      <div className="px-2.5 py-1.5 bg-surface border-b border-outline/20 flex items-center gap-2 text-[10.5px] text-on-surface/80 font-bold">
        <ShieldCheck className="w-3 h-3" /> Auditor 审计（{findings.length} 项）
      </div>
      <div className="p-2 space-y-1.5 text-[11px]">
        {findings.map((f, i) => (
          <div key={i} className={`border-l-2 pl-2 ${sevColor(f.severity)}`}>
            <div className="flex items-center gap-1.5 font-bold">
              <span className="font-mono">[{f.severity.toUpperCase()}]</span>
              <span>{f.target}</span>
            </div>
            <div className="text-on-surface/70">建议：{f.suggestion}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 5. FinalReplyView
// ─────────────────────────────────────────────────────────────

export function FinalReplyView({ content, label }: { content: string; label: string }) {
  if (!content) return null;
  return (
    <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/30">
      <div className="px-2.5 py-1.5 bg-surface border-b border-outline/20 flex items-center gap-2 text-[10.5px] text-on-surface/80 font-bold">
        <Rocket className="w-3 h-3" /> {label}
      </div>
      <div className="p-2.5 text-[11.5px] text-on-surface/90 leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto scrollbar-thin">
        {content}
        <span className="inline-block w-1.5 h-3 bg-primary ml-0.5 animate-pulse" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 6. SuggestEnableView
// ─────────────────────────────────────────────────────────────

export function SuggestEnableView({ items, onAccept }: { items: SuggestEnableItem[]; onAccept?: (name: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="border border-amber-400/30 rounded-lg overflow-hidden bg-amber-400/5">
      <div className="px-2.5 py-1.5 bg-amber-400/10 border-b border-amber-400/20 flex items-center gap-2 text-[10.5px] text-amber-300 font-bold">
        <Zap className="w-3 h-3" /> 💡 建议启用副模型
      </div>
      <div className="p-2 space-y-1.5 text-[11px]">
        {items.map((s, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="flex-1">
              <div className="text-on-surface/90 font-bold">{s.candidateName}（预期增益 {(s.expectedGain * 100).toFixed(0)}%）</div>
              <div className="text-on-surface/60">{s.reason}</div>
            </div>
            {onAccept && (
              <button
                onClick={() => onAccept(s.candidateName)}
                className="px-2 py-0.5 text-[10px] bg-amber-400/20 hover:bg-amber-400/30 text-amber-300 rounded border border-amber-400/30"
              >
                启用并重发
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
