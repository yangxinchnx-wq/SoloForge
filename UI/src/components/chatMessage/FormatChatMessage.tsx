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
import { ImageBlock } from './ImageBlock';

export interface FormatChatMessageProps {
  content: string;
}

export const FormatChatMessage = React.memo(function FormatChatMessage({ content }: FormatChatMessageProps) {
  if (!content || !content.trim()) return null;

  // 状态机分割: 逐行扫描,正确匹配 ``` 开闭,支持嵌套 ``` 内容
  const parts: Array<{ type: 'text' | 'code'; content: string; lang?: string }> = [];
  const lines = content.split('\n');
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let textLines: string[] = [];

  for (const line of lines) {
    if (!inCodeBlock && line.trimStart().startsWith('```')) {
      // 开始代码块: flush 文本
      if (textLines.length > 0) {
        parts.push({ type: 'text', content: textLines.join('\n') });
        textLines = [];
      }
      inCodeBlock = true;
      codeLang = line.trimStart().slice(3).trim();
      codeLines = [];
    } else if (inCodeBlock && line.trimStart().startsWith('```')) {
      // 结束代码块
      parts.push({ type: 'code', content: codeLines.join('\n'), lang: codeLang });
      inCodeBlock = false;
      codeLang = '';
      codeLines = [];
    } else if (inCodeBlock) {
      codeLines.push(line);
    } else {
      textLines.push(line);
    }
  }
  // 未闭合的代码块仍然输出 (流式场景可能未闭合)
  if (inCodeBlock && codeLines.length > 0) {
    parts.push({ type: 'code', content: codeLines.join('\n'), lang: codeLang });
  }
  if (textLines.length > 0) {
    parts.push({ type: 'text', content: textLines.join('\n') });
  }

  return (
    <div className="space-y-3.5 select-text w-full max-w-full overflow-hidden">
      {parts.map((part, index) => {
        if (part.type === 'code') {
          return (
            <div key={index}>
              <CollapsibleCodeBlock
                fileName={part.lang ? `智脑生成文件 (.${part.lang})` : '智脑配置代码段'}
                text={part.content.trim()}
              />
            </div>
          );
        } else {
          // Standard text! Let's format paragraphs and inline elements
          const paragraphs = part.content.split('\n\n');
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

                  // ★ 2026-07-19: 支持 markdown 图片语法 ![alt](url)
                  //   先按图片语法 split, 图片部分渲染为 <img>, 其余部分继续处理 bold/inline code
                  //   仅允许 http/https/data:image 协议, 防止恶意协议
                  const imageParts = renderedLine.split(/(!\[[^\]]*\]\([^)]+\))/g);
                  const processedInline = imageParts.map((ip, iIdx) => {
                    const imgMatch = ip.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
                    if (imgMatch) {
                      const url = imgMatch[2];
                      // 安全: 仅允许 http/https/data:image
                      if (/^https?:\/\//.test(url) || /^data:image\//.test(url)) {
                        return (
                          <ImageBlock
                            key={`img-${iIdx}`}
                            src={url}
                            alt={imgMatch[1]}
                          />
                        );
                      }
                      return <span key={`img-${iIdx}`}>{ip}</span>;
                    }

                    // Process bold **text** -> strong
                    const boldParts = ip.split(/(\*\*.*?\*\*)/g);
                    return boldParts.map((bp, bIdx) => {
                      if (bp.startsWith('**') && bp.endsWith('**')) {
                        return <strong key={`b-${iIdx}-${bIdx}`} className="font-bold text-on-surface">{bp.slice(2, -2)}</strong>;
                      }

                      // Process inline code `code`
                      const codeParts = bp.split(/(`.*?`)/g);
                      return codeParts.map((cp, cIdx) => {
                        if (cp.startsWith('`') && cp.endsWith('`')) {
                          return (
                            <code key={`c-${iIdx}-${bIdx}-${cIdx}`} className="px-1 py-0.5 font-mono text-[11px] text-on-surface font-bold mx-0.5">
                              {cp.slice(1, -1)}
                            </code>
                          );
                        }
                        return cp;
                      });
                    });
                  });

                  if (isBullet) {
                    return (
                      <div key={lIdx} className="flex gap-2 pl-2 text-on-surface/90 text-[12px] leading-relaxed select-text mt-1">
                        <span className="text-on-surface font-bold shrink-0 select-none">•</span>
                        <span>{processedInline}</span>
                      </div>
                    );
                  }

                  if (isNumbered) {
                    const numString = line.trim().match(/^(\d+)/)?.[1] || '';
                    return (
                      <div key={lIdx} className="flex gap-2 pl-2 text-on-surface/90 text-[12px] leading-relaxed select-text mt-1">
                        <span className="text-on-surface font-bold shrink-0 font-mono text-[11px] select-none">{numString}.</span>
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
});
