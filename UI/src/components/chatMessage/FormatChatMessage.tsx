/**
 * Markdown 极简渲染器
 *
 * 2026-07-03 阶段3.1.B 从 ChatPanel.tsx 抽出。
 * 支持: ``` 代码块 / **bold** / `inline code` / - bullet list / 1. numbered list
 *
 * 不依赖 react-markdown 等重型库,只覆盖 ChatPanel 实际使用的语法子集。
 * 代码块走 CollapsibleCodeBlock 折叠展示。
 */

import React from 'react';
import { CollapsibleCodeBlock } from './CollapsibleCodeBlock';

export interface FormatChatMessageProps {
  content: string;
}

export function FormatChatMessage({ content }: FormatChatMessageProps) {
  if (!content) return null;

  // Split by ``` to extract code blocks
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-3.5 select-text w-full max-w-full overflow-hidden">
      {parts.map((part, index) => {
        if (part.startsWith('```')) {
          // It is a code block! Get language and code
          const match = part.match(/```([a-zA-Z0-9+#-]*)\n([\s\S]*?)```/);
          const lang = match ? match[1] : '';
          const code = match ? match[2] : part.slice(3, -3);

          return (
            <div key={index}>
              <CollapsibleCodeBlock
                fileName={lang ? `智脑生成文件 (.${lang})` : '智脑配置代码段'}
                text={code.trim()}
              />
            </div>
          );
        } else {
          // Standard text! Let's format paragraphs and inline elements
          const paragraphs = part.split('\n\n');
          return paragraphs.map((para, pIdx) => {
            if (!para.trim()) return null;

            // Render bold / inline code / bullet lists
            const lines = para.split('\n');
            return (
              <div key={`${index}-${pIdx}`} className="space-y-1 py-0.5">
                {lines.map((line, lIdx) => {
                  let renderedLine = line.trim();
                  if (!renderedLine) return <div key={lIdx} className="h-1.5" />;

                  // If it's a list item
                  const isBullet = renderedLine.startsWith('- ') || renderedLine.startsWith('* ');
                  const isNumbered = /^\d+\.\s/.test(renderedLine);

                  if (isBullet) {
                    renderedLine = renderedLine.substring(2);
                  } else if (isNumbered) {
                    const matchNum = renderedLine.match(/^(\d+\.\s)(.*)/);
                    if (matchNum) {
                      renderedLine = matchNum[2];
                    }
                  }

                  // Process bold **text** -> strong
                  const boldParts = renderedLine.split(/(\*\*.*?\*\*)/g);
                  const processedInline = boldParts.map((bp, bIdx) => {
                    if (bp.startsWith('**') && bp.endsWith('**')) {
                      return <strong key={bIdx} className="text-primary font-black">{bp.slice(2, -2)}</strong>;
                    }

                    // Process inline code `code`
                    const codeParts = bp.split(/(`.*?`)/g);
                    return codeParts.map((cp, cIdx) => {
                      if (cp.startsWith('`') && cp.endsWith('`')) {
                        return (
                          <code key={cIdx} className="px-1 py-0.5 font-mono text-[11px] text-emerald-500 font-bold mx-0.5">
                            {cp.slice(1, -1)}
                          </code>
                        );
                      }
                      return cp;
                    });
                  });

                  if (isBullet) {
                    return (
                      <div key={lIdx} className="flex gap-2 pl-2 text-on-surface/90 text-[12px] leading-relaxed select-text mt-1">
                        <span className="text-primary font-bold shrink-0 select-none">•</span>
                        <span>{processedInline}</span>
                      </div>
                    );
                  }

                  if (isNumbered) {
                    const numString = line.trim().match(/^(\d+)/)?.[1] || '';
                    return (
                      <div key={lIdx} className="flex gap-2 pl-2 text-on-surface/90 text-[12px] leading-relaxed select-text mt-1">
                        <span className="text-primary font-bold shrink-0 font-mono text-[11px] select-none">{numString}.</span>
                        <span>{processedInline}</span>
                      </div>
                    );
                  }

                  return (
                    <p key={lIdx} className="text-on-surface/90 text-[12px] leading-relaxed select-text">
                      {processedInline}
                    </p>
                  );
                })}
              </div>
            );
          });
        }
      })}
    </div>
  );
}
