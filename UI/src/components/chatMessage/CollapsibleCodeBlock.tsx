/**
 * 可折叠代码块组件
 *
 * 2026-07-03 阶段3.1.B 从 ChatPanel.tsx 抽出。
 * 含复制按钮 + 高度过渡动画,自维护 isExpanded state。
 */

import React, { useState } from 'react';
import { FileCode, ChevronUp, ChevronDown, Copy } from '../../utils/icons';
import { MountTransition } from '../MountTransition';

export interface CollapsibleCodeBlockProps {
  fileName: string;
  text: string;
}

export const CollapsibleCodeBlock = React.memo(function CollapsibleCodeBlock({ fileName, text }: CollapsibleCodeBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const lineCount = text.split('\n').length;

  return (
    <div className="mt-2 border border-outline bg-surface rounded-lg overflow-hidden w-full max-w-full">
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center justify-between p-2.5 bg-surface-bright/50 hover:bg-surface transition-colors cursor-pointer select-none"
      >
        <div className="flex items-center gap-2 text-[11px] font-sans font-medium text-on-surface/90 min-w-0">
          <FileCode className="w-4 h-4 text-primary shrink-0" />
          <span className="truncate max-w-[240px] font-bold text-on-surface">{fileName}</span>
          <span className="text-[10px] text-on-surface/40 font-mono shrink-0">({lineCount} 行代码)</span>
        </div>
        <div className="flex items-center gap-1 text-on-surface/50 text-[10px] shrink-0">
          <span>{isExpanded ? '点击收起' : '点击展开代码'}</span>
          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </div>
      </div>

      <MountTransition show={isExpanded} variant="height" duration={200}>
          <div className="overflow-hidden border-t border-outline/30">
            <div className="relative">
              <pre className="max-h-72 overflow-auto p-3 font-mono text-[10.5px] text-on-surface/85 bg-bg/40 select-text scrollbar-thin scrollbar-thumb-outline/50 scrollbar-track-transparent leading-relaxed whitespace-pre font-bold">
                <code>{text}</code>
              </pre>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(text);
                  const customToastEv = new CustomEvent('soloforge-toast', {
                    detail: { message: '代码已复制至剪贴板', type: 'success' }
                  });
                  window.dispatchEvent(customToastEv);
                }}
                className="absolute top-2.5 right-2.5 p-1.5 rounded bg-surface-bright border border-outline/40 text-on-surface hover:text-primary transition-all cursor-pointer shadow"
                title="复制全部代码"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
      </MountTransition>
    </div>
  );
});
