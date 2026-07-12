/**
 * AuditSection — 混合裁决区
 * 显示子Agent评分 → 主模型仲裁 → AI社会制度校验 三层裁决链
 */
import React, { useState } from 'react';
import { ChevronDown, Shield, Gavel, Scale, CheckCircle2, AlertTriangle, XCircle, RefreshCw } from '../utils/icons';
import { MountTransition } from './MountTransition';
import type { AuditTask, AuditFinding, ArbitrationResult } from '../types/streaming';
import type { PermissionMode } from '../types/streaming';

interface AuditSectionProps {
  auditTask: AuditTask;
  result?: ArbitrationResult;
  mode: PermissionMode;
  modelCount: number;
}

export function AuditSection({ auditTask, result, mode, modelCount }: AuditSectionProps) {
  const [open, setOpen] = useState(true);

  const isDone = auditTask.status === 'done';
  const isReviewing = auditTask.status === 'reviewing';

  return (
    <div className="border border-outline/15 rounded-lg overflow-hidden bg-bg/30">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-on-surface/[0.02]"
        onClick={() => setOpen(!open)}
      >
        <ChevronDown className={`w-3.5 h-3.5 text-on-surface/40 transition-transform ${open ? 'rotate-0' : '-rotate-90'}`} />
        <Scale className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-[11px] font-bold text-amber-400">审查区</span>
        <span className="text-[10px] text-on-surface/40">
          {auditTask.auditorType === 'sub_agent' ? '子Agent 审查' : '主模型 审查'}
        </span>
        {isReviewing && (
          <span className="text-[10px] text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded animate-pulse ml-auto">
            审查中...
          </span>
        )}
        {result && (
          <span className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded ${
            result.verdict === 'accept' ? 'text-green-400 bg-green-500/10'
              : result.verdict === 'revise' ? 'text-amber-400 bg-amber-500/10'
              : 'text-red-400 bg-red-500/10'
          }`}>
            {result.verdict === 'accept' ? '通过' : result.verdict === 'revise' ? '修改' : '驳回'} · {result.finalScore}
          </span>
        )}
      </div>

      <MountTransition show={open} variant="height" duration={200}>
        <div>
            <div className="px-3 pb-2 border-t border-outline/5 space-y-2 pt-2">
              {/* 审查发现 */}
              {auditTask.findings.length > 0 && (
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-on-surface/50 uppercase">审查发现</span>
                  {auditTask.findings.map((f, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-[10px]">
                      {f.severity === 'error' ? <XCircle className="w-3 h-3 text-red-400 shrink-0 mt-0.5" />
                        : f.severity === 'warning' ? <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                        : <CheckCircle2 className="w-3 h-3 text-on-surface/30 shrink-0 mt-0.5" />}
                      <div>
                        <span className="text-on-surface/50">{f.target}</span>
                        <span className="text-on-surface/30"> — {f.suggestion}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 裁决结果 */}
              {result && (
                <div className="space-y-1.5 pt-1 border-t border-outline/5">
                  <span className="text-[10px] font-bold text-on-surface/50 uppercase">裁决结果</span>
                  <div className="grid grid-cols-3 gap-2 text-[10px]">
                    <div className="bg-on-surface/5 rounded p-1.5 text-center">
                      <div className="text-on-surface/40">子助理</div>
                      <div className="font-mono font-bold text-on-surface">{result.layerScores.subAgent}</div>
                    </div>
                    <div className="bg-on-surface/5 rounded p-1.5 text-center">
                      <div className="text-on-surface/40">主模型</div>
                      <div className="font-mono font-bold text-on-surface">{result.layerScores.mainModel}</div>
                    </div>
                    {mode !== 'ultimate' && (
                      <div className="bg-on-surface/5 rounded p-1.5 text-center">
                        <div className="text-on-surface/40">AI社会</div>
                        <div className="font-mono font-bold text-on-surface">{result.layerScores.society}</div>
                      </div>
                    )}
                    {mode === 'ultimate' && (
                      <div className="bg-green-500/5 rounded p-1.5 text-center">
                        <div className="text-green-400/60">全自动</div>
                        <div className="font-mono font-bold text-green-400">跳过</div>
                      </div>
                    )}
                  </div>
                  {result.reasoning && (
                    <p className="text-[10px] text-on-surface/50 leading-relaxed italic">{result.reasoning}</p>
                  )}
                </div>
              )}
            </div>
        </div>
      </MountTransition>
    </div>
  );
}