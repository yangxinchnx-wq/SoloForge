// ─────────────────────────────────────────────────────────────────
// 轻量级 Markdown 渲染器
// 支持: # 标题、**bold**、`inline code`、```code block```、- 列表、> 引用、链接、自动换行
// 不引入额外依赖
// ─────────────────────────────────────────────────────────────────

import { useState } from 'react';

interface Props {
  source: string;
  className?: string;
  streaming?: boolean;
}

// 转义 HTML
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 提取 code blocks 之后再做行内替换
export function Markdown({ source, className, streaming }: Props) {
  const codeBlocks: Array<{ id: string; lang: string; content: string }> = [];
  let working = source;

  // ```lang\n...\n```
  working = working.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = `cb_${codeBlocks.length}_${Math.random().toString(36).slice(2, 6)}`;
    codeBlocks.push({ id, lang: lang || 'text', content: code });
    return `\n\n__CODE_BLOCK_${id}__\n\n`;
  });

  // 行内代码
  working = working.replace(/`([^`\n]+)`/g, (_, code) => `__INLINE_CODE_${btoa(unescape(encodeURIComponent(code)))}__`);

  // 转义剩余 HTML
  working = escapeHtml(working);

  // 链接 [text](url)
  working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-primary hover:underline">$1</a>');

  // 加粗
  working = working.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // 斜体
  working = working.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // 行内代码还原
  working = working.replace(/__INLINE_CODE_([A-Za-z0-9+/=]+)__/g, (_, b64) => {
    try {
      const code = decodeURIComponent(escape(atob(b64)));
      return `<code class="px-1 py-0.5 mx-0.5 rounded bg-bg-dim border border-border-light text-accent font-mono text-[0.9em]">${code}</code>`;
    } catch {
      return _;
    }
  });

  // 标题
  working = working.replace(/^######\s+(.+)$/gm, '<h6 class="text-xs font-semibold mt-2 mb-1 text-text">$1</h6>');
  working = working.replace(/^#####\s+(.+)$/gm, '<h5 class="text-xs font-semibold mt-2 mb-1 text-text">$1</h5>');
  working = working.replace(/^####\s+(.+)$/gm, '<h4 class="text-sm font-semibold mt-2 mb-1 text-text">$1</h4>');
  working = working.replace(/^###\s+(.+)$/gm, '<h3 class="text-sm font-semibold mt-2 mb-1 text-text">$1</h3>');
  working = working.replace(/^##\s+(.+)$/gm, '<h2 class="text-base font-semibold mt-2 mb-1 text-text">$1</h2>');
  working = working.replace(/^#\s+(.+)$/gm, '<h1 class="text-base font-bold mt-2 mb-1 text-text">$1</h1>');

  // 引用
  working = working.replace(/^>\s+(.+)$/gm, '<blockquote class="border-l-2 border-primary pl-2 my-1 text-text-secondary">$1</blockquote>');

  // 列表
  working = working.replace(/^[-*]\s+(.+)$/gm, '<li class="ml-3 list-disc">$1</li>');
  working = working.replace(/^(\d+)\.\s+(.+)$/gm, '<li class="ml-3 list-decimal">$2</li>');

  // 水平线
  working = working.replace(/^---$/gm, '<hr class="border-border-light my-2" />');

  // 换行
  working = working.replace(/\n/g, '<br />');

  // 拆分并组装 (code block 占位符替换)
  const parts = working.split(/__CODE_BLOCK_([a-zA-Z0-9_]+)__/);
  return (
    <div className={`markdown text-xs leading-relaxed break-words ${className || ''}`}>
      {parts.map((seg, i) => {
        if (i % 2 === 1) {
          const block = codeBlocks.find(b => b.id === seg);
          if (block) {
            return <CodeBlock key={i} lang={block.lang} content={block.content} />;
          }
          return null;
        }
        return (
          <span
            key={i}
            dangerouslySetInnerHTML={{ __html: seg }}
          />
        );
      })}
      {streaming && <span className="inline-block w-1.5 h-3 bg-primary ml-0.5 animate-blink align-middle" />}
    </div>
  );
}

function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="my-2 rounded-md border border-border-light bg-bg-dim overflow-hidden">
      <div className="flex items-center justify-between px-2 h-6 bg-surface border-b border-border-light">
        <span className="text-[10px] font-mono text-text-secondary">{lang}</span>
        <button
          onClick={copy}
          className="text-[10px] text-text-secondary hover:text-text flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-xs">
            {copied ? 'check' : 'content_copy'}
          </span>
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="p-2 overflow-x-auto text-[11px] font-mono text-text scrollbar-thin">
        <code>{content}</code>
      </pre>
    </div>
  );
}
