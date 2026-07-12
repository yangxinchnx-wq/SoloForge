/**
 * WebAstPreview.tsx — Web 端 UniversalNode / Flutter DSL 渲染器
 *
 * 将 UniversalNode 树或 Flutter DSL 树渲染为 HTML/CSS, 在浏览器中直接展示 AST 预览。
 * 用于开发环境 (无 Electron) 或作为 canvas 不可用时的降级方案。
 *
 * ★ 2026-07-12: 支持 Flutter DSL 格式 ({type, props, children})
 *   当 LLM 返回 json 代码块时, pushRawDsl 直接写入 Flutter DSL 到 previewStreamStore,
 *   WebAstPreview 需要同时处理 UniversalNode 和 Flutter DSL 两种格式。
 *
 * 支持 12 种节点类型: container/row/column/stack/text/button/input/image/divider/spacer/svg/canvas
 */

import React from 'react';
import type { UniversalNode, UniversalStyle } from '../services/canvas/UniversalAST';

// ── Flutter DSL → UniversalNode 格式转换 ──
// Flutter DSL: { type: 'text', props: { content: 'Hello', color: '#fff' }, children: [...] }
// UniversalNode: { type: 'text', content: 'Hello', style: { color: '#fff' }, children: [...] }

function flutterPropsToStyle(props: Record<string, any> | undefined): UniversalStyle {
  if (!props) return {};
  const style: any = {};
  if (props.backgroundColor != null) style.background = props.backgroundColor;
  if (props.color != null) style.color = props.color;
  if (props.padding != null) style.padding = props.padding;
  if (props.margin != null) style.margin = props.margin;
  if (props.borderRadius != null) style.radius = props.borderRadius;
  if (props.boxShadow != null) style.shadow = props.boxShadow;
  if (props.border != null) style.border = props.border;
  if (props.opacity != null) style.opacity = props.opacity;
  if (props.fontSize != null) style.fontSize = props.fontSize;
  if (props.fontWeight != null) style.fontWeight = props.fontWeight;
  if (props.textAlign != null) style.textAlign = props.textAlign;
  if (props.spacing != null) style.gap = props.spacing;
  if (props.width != null) style.width = props.width;
  if (props.height != null) style.height = props.height;
  if (props.flex != null) style.flex = props.flex;
  if (props.lineHeight != null) style.lineHeight = props.lineHeight;
  if (props.letterSpacing != null) style.letterSpacing = props.letterSpacing;
  return style;
}

/** 将任意节点 (Flutter DSL 或 UniversalNode) 归一化为 UniversalNode */
function normalizeNode(node: any): UniversalNode {
  if (!node || typeof node !== 'object') return { type: 'text', content: String(node || '') };

  // 已经是 UniversalNode 格式 (有 style 或没有 props)
  if (node.style || !node.props) {
    return node as UniversalNode;
  }

  // Flutter DSL 格式: 把 props 展平到 node 顶层 + style
  const props = node.props || {};
  const style = flutterPropsToStyle(props);
  const result: any = { type: node.type, style };

  // 把 props 中的内容字段提到顶层
  if (props.content != null) result.content = props.content;
  if (props.label != null) result.label = props.label;
  if (props.variant != null) result.variant = props.variant;
  if (props.placeholder != null) result.placeholder = props.placeholder;
  if (props.value != null) result.value = props.value;
  if (props.kind != null) result.kind = props.kind;
  if (props.src != null) result.src = props.src;
  if (props.alt != null) result.alt = props.alt;

  // 保留所有 props 作为额外属性 (svg content 等)
  result.props = props;

  // 递归处理 children
  if (node.children && Array.isArray(node.children)) {
    result.children = node.children.map((child: any) => normalizeNode(child));
  }

  return result as UniversalNode;
}

// ── Style 映射: UniversalStyle → React.CSSProperties ──

function mapStyle(style?: UniversalStyle): React.CSSProperties {
  if (!style) return {};
  const css: React.CSSProperties = {};

  if (style.width != null) css.width = typeof style.width === 'number' ? `${style.width}px` : style.width;
  if (style.height != null) css.height = typeof style.height === 'number' ? `${style.height}px` : style.height;
  if (style.flex != null) css.flex = style.flex;
  if (style.background) css.background = style.background;
  if (style.color) css.color = style.color;
  if (style.radius != null) css.borderRadius = `${style.radius}px`;
  if (style.shadow) css.boxShadow = style.shadow;
  if (style.border) css.border = style.border;
  if (style.opacity != null) css.opacity = style.opacity;
  if (style.fontSize) css.fontSize = `${style.fontSize}px`;
  if (style.fontWeight) css.fontWeight = style.fontWeight;
  if (style.textAlign) css.textAlign = style.textAlign;
  if (style.gap != null) css.gap = `${style.gap}px`;
  if (style.lineHeight) css.lineHeight = style.lineHeight;
  if (style.letterSpacing != null) css.letterSpacing = `${style.letterSpacing}px`;

  // padding
  if (style.padding != null) {
    css.padding = Array.isArray(style.padding)
      ? style.padding.length === 2
        ? `${style.padding[0]}px ${style.padding[1]}px`
        : style.padding.map((v: number) => `${v}px`).join(' ')
      : `${style.padding}px`;
  }
  // margin
  if (style.margin != null) {
    css.margin = Array.isArray(style.margin)
      ? style.margin.length === 2
        ? `${style.margin[0]}px ${style.margin[1]}px`
        : style.margin.map((v: number) => `${v}px`).join(' ')
      : `${style.margin}px`;
  }

  return css;
}

function layoutStyle(type: string): React.CSSProperties {
  switch (type) {
    case 'row': return { display: 'flex', flexDirection: 'row' };
    case 'column': return { display: 'flex', flexDirection: 'column' };
    case 'stack': return { display: 'flex', position: 'relative' };
    case 'container': return { display: 'flex', flexDirection: 'column' };
    default: return {};
  }
}

function alignToJustify(align?: string): React.CSSProperties {
  if (!align) return {};
  const map: Record<string, React.CSSProperties> = {
    'start': { alignItems: 'flex-start' },
    'center': { alignItems: 'center' },
    'end': { alignItems: 'flex-end' },
    'stretch': { alignItems: 'stretch' },
    'space-between': { justifyContent: 'space-between' },
    'space-around': { justifyContent: 'space-around' },
  };
  return map[align] || {};
}

function justifyToCSS(justify?: string): React.CSSProperties {
  if (!justify) return {};
  const map: Record<string, React.CSSProperties> = {
    'start': { justifyContent: 'flex-start' },
    'center': { justifyContent: 'center' },
    'end': { justifyContent: 'flex-end' },
  };
  return map[justify] || {};
}

// ── 节点渲染 ──

function renderNode(node: UniversalNode, key: string): React.ReactNode {
  // ★ 归一化: 同时支持 UniversalNode 和 Flutter DSL 格式
  const n = normalizeNode(node) as any;
  const style = { ...layoutStyle(n.type), ...mapStyle(n.style), ...alignToJustify(n.style?.align), ...justifyToCSS(n.style?.justify) };

  switch (n.type) {
    case 'container':
    case 'row':
    case 'column':
    case 'stack':
      return (
        <div key={key} style={style}>
          {n.children?.map((child: any, i: number) => renderNode(child, `${key}-${i}`))}
        </div>
      );

    case 'text':
      return <div key={key} style={style}>{n.content}</div>;

    case 'svg': {
      // ★ 2026-07-12: 支持 SVG 类型 — LLM 经常用 SVG 画图
      const svgContent = n.props?.content || n.content || '';
      const svgWidth = n.props?.width || n.style?.width || '100%';
      const svgHeight = n.props?.height || n.style?.height || '100%';
      return (
        <div
          key={key}
          style={{
            ...style,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            minHeight: '60px',
          }}
          dangerouslySetInnerHTML={{
            __html: `<div style="width:${typeof svgWidth === 'number' ? svgWidth + 'px' : svgWidth};height:${typeof svgHeight === 'number' ? svgHeight + 'px' : svgHeight};">${svgContent}</div>`,
          }}
        />
      );
    }

    case 'canvas': {
      // ★ 2026-07-12: 支持 canvas 类型 — 可能包含 SVG 或自定义绘制
      const innerContent = n.props?.content || n.content || '';
      if (innerContent) {
        return (
          <div
            key={key}
            style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            dangerouslySetInnerHTML={{ __html: innerContent }}
          />
        );
      }
      return <div key={key} style={style}>{n.children?.map((child: any, i: number) => renderNode(child, `${key}-${i}`))}</div>;
    }

    case 'button':
      return (
        <button
          key={key}
          style={{
            ...style,
            cursor: 'pointer',
            border: node.variant === 'outlined' ? '1px solid currentColor' : 'none',
            background: node.variant === 'filled' ? style.background || '#3b82f6' : 'transparent',
            color: style.color || (node.variant === 'filled' ? '#fff' : '#3b82f6'),
            padding: '8px 16px',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: 500,
          }}
        >
          {node.label}
        </button>
      );

    case 'input':
      return (
        <input
          key={key}
          placeholder={node.placeholder}
          defaultValue={node.value}
          type={node.kind || 'text'}
          style={{
            ...style,
            padding: '8px 12px',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            fontSize: '13px',
            outline: 'none',
          }}
        />
      );

    case 'image':
      return (
        <div key={key} style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6', borderRadius: '8px', minHeight: '60px' }}>
          {n.src ? (
            <img src={n.src} alt={n.alt || ''} style={{ maxWidth: '100%', maxHeight: '100%' }} />
          ) : (
            <span style={{ color: '#9ca3af', fontSize: '11px' }}>{n.alt || 'image'}</span>
          )}
        </div>
      );

    case 'divider':
      return <hr key={key} style={{ ...style, border: 'none', borderTop: '1px solid #e5e7eb', margin: '8px 0' }} />;

    case 'spacer':
      return <div key={key} style={{ ...style, flex: style.flex ?? 1 }} />;

    default: {
      // ★ 2026-07-12: 未知类型尝试从 props.content 渲染
      const fallbackContent = n.props?.content || n.content;
      if (fallbackContent && typeof fallbackContent === 'string' && fallbackContent.includes('<svg')) {
        return (
          <div
            key={key}
            style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            dangerouslySetInnerHTML={{ __html: fallbackContent }}
          />
        );
      }
      if (n.children && n.children.length > 0) {
        return (
          <div key={key} style={style}>
            {n.children.map((child: any, i: number) => renderNode(child, `${key}-${i}`))}
          </div>
        );
      }
      return null;
    }
  }
}

// ── 主组件 ──

export interface WebAstPreviewProps {
  root: UniversalNode;
  bgColor?: string;
}

export default function WebAstPreview({ root, bgColor = '#ffffff' }: WebAstPreviewProps) {
  // ★ 归一化 root: 同时支持 UniversalNode 和 Flutter DSL
  const normalizedRoot = normalizeNode(root);
  return (
    <div
      className="absolute inset-0 overflow-auto"
      style={{ background: bgColor }}
    >
      <div style={{ padding: '12px', minHeight: '100%' }}>
        {renderNode(normalizedRoot, 'root')}
      </div>
    </div>
  );
}
