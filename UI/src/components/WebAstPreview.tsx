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
 * ★ 2026-07-16: 新增 icon/progress/chart/video 节点类型，支持 canvas draw 指令
 *
 * 支持 16 种节点类型: container/row/column/stack/text/button/input/image/divider/spacer
 *                    svg/canvas/icon/progress/chart/video
 */

import React from 'react';
import type { UniversalNode, UniversalStyle, CanvasDrawOp } from '../services/canvas/UniversalAST';
import { play2DLayoutTransition, playScrambleText } from '../services/canvas/canvasAnimations';

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
  // ★ FIX 2026-07-14: 根据 props.layout 确定节点类型
  //   normalizeDsl 把 column/row 转成了 container + props.layout
  //   WebAstPreview 需要转回来才能正确设置 flex 方向
  let nodeType = node.type;
  if (nodeType === 'container' && props.layout === 'row') {
    nodeType = 'row';
  } else if (nodeType === 'container' && props.layout === 'column') {
    nodeType = 'column';
  }
  const result: any = { type: nodeType, style };

  // 把 props 中的内容字段提到顶层
  if (props.content != null) result.content = props.content;
  if (props.label != null) result.label = props.label;
  if (props.variant != null) result.variant = props.variant;
  if (props.placeholder != null) result.placeholder = props.placeholder;
  if (props.value != null) result.value = props.value;
  if (props.kind != null) result.kind = props.kind;
  if (props.src != null) result.src = props.src;
  if (props.alt != null) result.alt = props.alt;
  if (props.icon != null) result.icon = props.icon;
  if (props.url != null) result.src = props.url; // image url → src

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

/**
 * ★ anime.js: 文本节点 scramble 解码效果
 *
 * 文本变化时用 anime.js scrambleText 做乱码→揭示过渡，
 * 让 LLM 流式生成的文字有科技感解码效果。
 * 首次渲染直接显示（无 scramble），后续变化才触发效果。
 */
function ScrambleText({ text, style }: { text: string; style: React.CSSProperties }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const prevText = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!ref.current) return;
    if (prevText.current === null) {
      // 首次渲染，直接显示
      ref.current.textContent = text;
    } else if (prevText.current !== text) {
      // 文本变化 — anime.js scramble 解码效果
      playScrambleText(ref.current, text, 500);
    }
    prevText.current = text;
  }, [text]);

  return <div ref={ref} style={style} />;
}

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
      return <ScrambleText key={key} style={style} text={n.content} />;

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
      // ★ 2026-07-16: canvas 节点 — 支持 draw 指令数组（优先）+ 兼容旧 SVG content
      const drawOps: CanvasDrawOp[] | undefined = n.draw || n.props?.draw;
      const innerContent = n.props?.content || n.content || '';

      // 优先：draw 指令数组 → HTML5 Canvas 2D API
      if (drawOps && Array.isArray(drawOps) && drawOps.length > 0) {
        const cw = n.width || n.props?.width || 300;
        const ch = n.height || n.props?.height || 200;
        return (
          <canvas
            key={key}
            ref={(canvas: HTMLCanvasElement | null) => {
              if (!canvas) return;
              const ctx = canvas.getContext('2d');
              if (!ctx) return;
              ctx.clearRect(0, 0, cw, ch);
              for (const op of drawOps) {
                if (op.fill) ctx.fillStyle = op.fill;
                if (op.stroke) ctx.strokeStyle = op.stroke;
                if (op.width != null) ctx.lineWidth = op.width;
                switch (op.op) {
                  case 'rect':
                    ctx.fillRect(op.x || 0, op.y || 0, op.w || 0, op.h || 0);
                    if (op.stroke) ctx.strokeRect(op.x || 0, op.y || 0, op.w || 0, op.h || 0);
                    break;
                  case 'circle':
                    ctx.beginPath();
                    ctx.arc(op.cx || 0, op.cy || 0, op.r || 0, 0, Math.PI * 2);
                    if (op.fill) ctx.fill();
                    if (op.stroke) ctx.stroke();
                    break;
                  case 'line':
                    ctx.beginPath();
                    ctx.moveTo((op.from || [0,0])[0], (op.from || [0,0])[1]);
                    ctx.lineTo((op.to || [0,0])[0], (op.to || [0,0])[1]);
                    ctx.stroke();
                    break;
                  case 'text':
                    if (op.fontSize) ctx.font = `${op.fontSize}px sans-serif`;
                    if (op.fill) ctx.fillText(op.content || '', op.x || 0, op.y || 0);
                    if (op.stroke) ctx.strokeText(op.content || '', op.x || 0, op.y || 0);
                    break;
                  case 'path':
                    try {
                      const path = new Path2D(op.d || '');
                      if (op.fill) ctx.fill(path);
                      if (op.stroke) ctx.stroke(path);
                    } catch { /* ignore invalid path */ }
                    break;
                }
              }
            }}
            width={cw}
            height={ch}
            style={{ ...style, width: cw, height: ch, display: 'block' }}
          />
        );
      }

      // 兼容旧格式：SVG content 字符串
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
            border: n.variant === 'outlined' ? '1px solid currentColor' : 'none',
            background: n.variant === 'filled' ? style.background || '#3b82f6' : 'transparent',
            color: style.color || (n.variant === 'filled' ? '#fff' : '#3b82f6'),
            padding: '8px 16px',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: 500,
          }}
        >
          {n.label}
        </button>
      );

    case 'input':
      return (
        <input
          key={key}
          placeholder={n.placeholder}
          defaultValue={n.value}
          type={n.kind || 'text'}
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
      if (!n.src) return null;
      return (
        <div key={key} style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '8px' }}>
          <img src={n.src} alt={n.alt || ''} style={{ maxWidth: '100%', maxHeight: '100%' }} />
        </div>
      );

    case 'divider':
      return <hr key={key} style={{ ...style, border: 'none', borderTop: '1px solid #e5e7eb', margin: '8px 0' }} />;

    case 'spacer':
      return <div key={key} style={{ ...style, flex: style.flex ?? 1 }} />;

    case 'icon': {
      // ★ 2026-07-16: icon 节点 — 用 emoji 或 Heroicons name 渲染
      const iconSize = n.size || 24;
      const iconColor = n.color || style.color || 'currentColor';
      const emojiMap: Record<string, string> = {
        'home': '🏠', 'search': '🔍', 'settings': '⚙️', 'user': '👤',
        'heart': '❤️', 'star': '⭐', 'check': '✓', 'close': '✕',
        'plus': '+', 'minus': '−', 'menu': '☰', 'back': '←',
        'forward': '→', 'edit': '✎', 'delete': '🗑', 'save': '💾',
        'download': '⬇', 'upload': '⬆', 'share': '↗', 'info': 'ℹ',
        'warning': '⚠', 'error': '✕', 'success': '✓', 'loading': '◐',
      };
      const emoji = emojiMap[n.name?.toLowerCase()] || '◇';
      return (
        <span key={key} style={{
          ...style, fontSize: `${iconSize}px`, color: iconColor,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: `${iconSize}px`, height: `${iconSize}px`,
        }}>
          {emoji}
        </span>
      );
    }

    case 'progress': {
      // ★ 2026-07-16: progress 节点 — linear/circular
      const value = Math.max(0, Math.min(100, n.value || 0));
      const color = n.color || '#3b82f6';
      const trackColor = n.trackColor || '#e5e7eb';
      if (n.variant === 'circular') {
        const size = 48;
        const stroke = 4;
        const radius = (size - stroke) / 2;
        const circ = 2 * Math.PI * radius;
        const offset = circ - (value / 100) * circ;
        return (
          <div key={key} style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width={size} height={size}>
              <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke={trackColor} strokeWidth={stroke} />
              <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke={color} strokeWidth={stroke}
                strokeDasharray={circ} strokeDashoffset={offset}
                transform={`rotate(-90 ${size/2} ${size/2})`} strokeLinecap="round" />
            </svg>
          </div>
        );
      }
      return (
        <div key={key} style={{
          ...style, width: style.width || '100%', height: style.height || 8,
          background: trackColor, borderRadius: 4, overflow: 'hidden',
        }}>
          <div style={{
            width: `${value}%`, height: '100%', background: color,
            borderRadius: 4, transition: 'width 0.3s ease',
          }} />
        </div>
      );
    }

    case 'chart': {
      // ★ 2026-07-16: chart 节点 — 用 recharts 渲染 bar/line/pie
      // recharts 已是项目依赖，直接动态 import 拆 chunk
      const ChartRenderer = React.lazy(async () => {
        const R = await import('recharts');
        const Comp = n.chartType === 'bar' ? R.BarChart
          : n.chartType === 'line' ? R.LineChart
          : R.PieChart;
        return {
          default: ({ data, series, width, height }: any) => {
            if (n.chartType === 'pie') {
              return (
                <Comp width={width} height={height}>
                  <R.Pie data={data} dataKey={series[0].name} nameKey="name" cx="50%" cy="50%" outerRadius={Math.min(width, height) / 3} />
                  <R.Tooltip />
                </Comp>
              );
            }
            const SeriesComp = n.chartType === 'bar' ? R.Bar : R.Line;
            return (
              <Comp data={data} width={width} height={height}>
                <R.XAxis dataKey="name" />
                <R.YAxis />
                <R.Tooltip />
                <R.Legend />
                {series.map((s: any, idx: number) => (
                  <SeriesComp key={idx} type="monotone" dataKey={s.name} stroke={s.color} fill={s.color} />
                ))}
              </Comp>
            );
          },
        };
      });
      const chartWidth = n.width || 300;
      const chartHeight = n.height || 200;
      const hasData = n.series && n.series.length > 0 && n.series[0].data && n.series[0].data.length > 0;
      if (!hasData) return <div key={key} style={style}>图表无数据</div>;

      // 转换为 recharts 数据格式
      const data = (n.labels || n.series[0].data.map((_: number, i: number) => `项 ${i+1}`)).map((label: string, i: number) => {
        const row: Record<string, any> = { name: label };
        n.series.forEach((s: any) => { row[s.name] = s.data[i] ?? 0; });
        return row;
      });

      return (
        <div key={key} style={{ ...style, width: chartWidth, height: chartHeight }}>
          <React.Suspense fallback={<div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100%'}}>加载图表...</div>}>
            <ChartRenderer data={data} series={n.series} width={chartWidth} height={chartHeight} />
          </React.Suspense>
        </div>
      );
    }

    case 'video': {
      // ★ 2026-07-16: video 节点 — 直接用 <video> 标签
      if (!n.src) return null;
      return (
        <video
          key={key}
          src={n.src}
          poster={n.poster}
          autoPlay={n.autoPlay ?? false}
          loop={n.loop ?? false}
          controls={n.controls ?? true}
          style={{
            ...style,
            width: style.width || '100%',
            height: style.height || '100%',
            objectFit: 'contain',
          }}
        />
      );
    }

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
  const containerRef = React.useRef<HTMLDivElement>(null);
  const prevRootRef = React.useRef<UniversalNode>(root);

  // ★ anime.js: DSL 更新时 FLIP 布局过渡
  // 当 root 变化时，先用 createLayout 记录旧布局，DOM 更新后 reposition 平滑过渡
  React.useEffect(() => {
    if (containerRef.current && prevRootRef.current !== root) {
      prevRootRef.current = root;
      play2DLayoutTransition(containerRef.current);
    }
  }, [root]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden flex flex-col items-center"
      style={{ background: bgColor }}
    >
      <div style={{
        width: '100%',
        height: '100%',
        margin: '0 auto',
      }}>
        {renderNode(normalizedRoot, 'root')}
      </div>
    </div>
  );
}
