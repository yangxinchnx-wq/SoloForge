/**
 * WebAstPreview.tsx — Web 端 UniversalNode 渲染器 (非 Electron 回退)
 *
 * 将 UniversalNode 树渲染为 HTML/CSS, 在浏览器中直接展示 AST 预览。
 * 用于开发环境 (无 Electron) 或作为 canvas 不可用时的降级方案。
 *
 * 支持 10 种节点类型: container/row/column/stack/text/button/input/image/divider/spacer
 */

import React from 'react';
import type { UniversalNode, UniversalStyle } from '../services/canvas/UniversalAST';

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
  const style = { ...layoutStyle(node.type), ...mapStyle(node.style), ...alignToJustify(node.style?.align), ...justifyToCSS(node.style?.justify) };

  switch (node.type) {
    case 'container':
    case 'row':
    case 'column':
    case 'stack':
      return (
        <div key={key} style={style}>
          {node.children?.map((child, i) => renderNode(child, `${key}-${i}`))}
        </div>
      );

    case 'text':
      return <div key={key} style={style}>{node.content}</div>;

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
          {node.src ? (
            <img src={node.src} alt={node.alt || ''} style={{ maxWidth: '100%', maxHeight: '100%' }} />
          ) : (
            <span style={{ color: '#9ca3af', fontSize: '11px' }}>{node.alt || 'image'}</span>
          )}
        </div>
      );

    case 'divider':
      return <hr key={key} style={{ ...style, border: 'none', borderTop: '1px solid #e5e7eb', margin: '8px 0' }} />;

    case 'spacer':
      return <div key={key} style={{ ...style, flex: style.flex ?? 1 }} />;

    default:
      return null;
  }
}

// ── 主组件 ──

export interface WebAstPreviewProps {
  root: UniversalNode;
  bgColor?: string;
}

export default function WebAstPreview({ root, bgColor = '#ffffff' }: WebAstPreviewProps) {
  return (
    <div
      className="absolute inset-0 overflow-auto"
      style={{ background: bgColor }}
    >
      <div style={{ padding: '12px', minHeight: '100%' }}>
        {renderNode(root, 'root')}
      </div>
    </div>
  );
}
