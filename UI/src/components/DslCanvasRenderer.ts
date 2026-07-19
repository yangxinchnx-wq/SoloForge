/**
 * DslCanvasRenderer.ts — UniversalNode DSL → Canvas 2D 渲染器
 *
 * ★ 2026-07-20: 用于 3D 模式屏幕贴图
 *
 * 工作原理:
 *   1. 用 Canvas 2D API 把 UniversalNode 树渲染到 <canvas> 元素
 *   2. 用 THREE.CanvasTexture(canvas) 创建 WebGL 纹理
 *   3. 贴到 3D 模型屏幕 mesh 的 material.map 上
 *
 * 优势 (相比 Html transform):
 *   - 完美贴合: 纹理和模型在同一个 WebGL 渲染管线中, z-buffer 正确处理遮挡
 *   - 旋转到侧面/背面时纹理会被模型几何体自然遮挡 (不会穿透)
 *
 * 优势 (相比旧 DslToR3f):
 *   - 文字清晰: Canvas 2D 原生文字渲染 (vs troika SDF 字体)
 *   - 代码简洁: Canvas 2D API ~300 行 (vs R3F mesh ~600 行)
 *   - 性能好: Canvas 2D 比 R3F mesh 渲染快
 */

import * as THREE from 'three';
import type { UniversalNode, UniversalStyle } from '../services/canvas/UniversalAST';
import { isContainerLike } from '../services/canvas/UniversalAST';

// ───────────────────────────── 常量 ─────────────────────────────

const DEFAULT_BG = '#ffffff';
const DEFAULT_FG = '#000000';

// ───────────────────────────── 屏幕形状 ─────────────────────────────

/**
 * ★ 屏幕形状参数 (用于 3D 模式贴图裁剪)
 *
 * 让 Canvas 纹理只覆盖屏幕区域:
 *   - 圆角矩形裁剪 (匹配 iPhone 屏幕圆角)
 *   - 灵动岛/刘海挖孔 (让该区域透明, 显示模型本身的黑色挖孔)
 */
export interface ScreenShape {
  /** 屏幕圆角半径 (像素, 纹理坐标系) */
  cornerRadius: number;
  /** 灵动岛/刘海挖孔区域 (纹理坐标系) */
  notch?: {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
  };
}

/**
 * iPhone 15 Pro Max 屏幕形状 (纹理坐标系 393×852)
 *
 * 基于 iPhone 15 Pro Max 原生尺寸 430×932 换算:
 *   - 屏幕圆角半径: 55px → 55 * 393/430 ≈ 50
 *   - 灵动岛: 125×37px, 距顶部 11px → 换算到 393×852
 */
export const IPHONE_15_PROMAX_SHAPE: ScreenShape = {
  cornerRadius: 50,
  notch: {
    x: 139,      // (430-125)/2 * 393/430 ≈ 139
    y: 10,       // 11 * 852/932 ≈ 10
    width: 114,  // 125 * 393/430 ≈ 114
    height: 34,  // 37 * 852/932 ≈ 34
    radius: 17,  // height/2
  },
};

// ───────────────────────────── 样式工具 ─────────────────────────────

/** 解析颜色: 支持 #RRGGBB / #RGB / 命名色; 失败返回 fallback */
function parseColor(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  const s = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  return s; // 命名色 / rgb() 等交给 Canvas 解析
}

/** 从 style.width/height 取数值 (px), 否则返回 fallback */
function px(v: number | string | undefined, fallback: number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = v.match(/^([\d.]+)(px)?$/);
    if (m) return parseFloat(m[1]);
  }
  return fallback;
}

/** 解析 padding, 返回 [top, right, bottom, left] */
function paddingOf(style: UniversalStyle | undefined): [number, number, number, number] {
  const p = style?.padding;
  if (typeof p === 'number') return [p, p, p, p];
  if (Array.isArray(p)) {
    if (p.length === 2) return [p[0], p[1], p[0], p[1]];
    if (p.length === 4) return [p[0], p[1], p[2], p[3]];
  }
  return [0, 0, 0, 0];
}

/** 解析 margin, 返回 [top, right, bottom, left] */
function marginOf(style: UniversalStyle | undefined): [number, number, number, number] {
  const m = style?.margin;
  if (typeof m === 'number') return [m, m, m, m];
  if (Array.isArray(m)) {
    if (m.length === 2) return [m[0], m[1], m[0], m[1]];
    if (m.length === 4) return [m[0], m[1], m[2], m[3]];
  }
  return [0, 0, 0, 0];
}

// ───────────────────────────── 布局 ─────────────────────────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * ★ Flex 布局算法
 *
 * 支持的属性:
 *   - flex: 按比例分配空间
 *   - gap: 子节点间距
 *   - padding: 内边距
 *   - margin: 外边距
 *   - width/height: 固定尺寸 (覆盖 flex 分配)
 *
 * 不支持 (降级为等分):
 *   - align-items (子节点交叉轴对齐)
 *   - justify-content (主轴分布) — 除了 center 的等效效果
 */
function layoutChildren(
  children: UniversalNode[],
  box: Box,
  dir: 'row' | 'column',
  style: UniversalStyle | undefined,
): Box[] {
  const [pt, pr, pb, pl] = paddingOf(style);
  const [mt, mr, mb, ml] = [0, 0, 0, 0]; // margin 在父级处理
  const gap = style?.gap ?? 0;

  const innerX = box.x + pl + ml;
  const innerY = box.y + pt + mt;
  const innerW = box.w - pl - pr - ml - mr;
  const innerH = box.h - pt - pb - mt - mb;

  const n = children.length;
  if (n === 0) return [];

  const boxes: Box[] = [];
  const isRow = dir === 'row';

  // 收集固定尺寸和 flex 值
  const fixedSizes: (number | null)[] = [];
  const flexValues: number[] = [];
  let totalFlex = 0;
  let totalFixed = 0;

  for (const child of children) {
    const cs = child.style;
    if (isRow) {
      const w = cs?.width != null ? px(cs.width, 0) : null;
      fixedSizes.push(w);
      if (w != null) totalFixed += w;
      const f = cs?.flex ?? 0;
      flexValues.push(f);
      totalFlex += f;
    } else {
      const h = cs?.height != null ? px(cs.height, 0) : null;
      fixedSizes.push(h);
      if (h != null) totalFixed += h;
      const f = cs?.flex ?? 0;
      flexValues.push(f);
      totalFlex += f;
    }
  }

  // 可用空间 (减去固定尺寸 + gap)
  const totalGap = gap * Math.max(0, n - 1);
  const available = (isRow ? innerW : innerH) - totalFixed - totalGap;

  // 计算每个子节点的尺寸
  let offset = isRow ? innerX : innerY;
  for (let i = 0; i < n; i++) {
    const child = children[i];
    const cs = child.style;
    const [cmt, , , cml] = marginOf(cs);

    let childMain: number;
    if (fixedSizes[i] != null) {
      childMain = fixedSizes[i]!;
    } else if (totalFlex > 0 && flexValues[i] > 0) {
      childMain = (available * flexValues[i]) / totalFlex;
    } else if (totalFlex === 0) {
      // 没有 flex 值, 等分剩余空间
      childMain = available / n;
    } else {
      childMain = 0;
    }

    // 子节点尺寸
    const childW = isRow ? childMain : innerW;
    const childH = isRow ? innerH : childMain;

    // margin 偏移
    const childX = isRow ? offset + cml : innerX + cml;
    const childY = isRow ? innerY + cmt : offset + cmt;

    // 减去子节点 margin 的交叉轴
    const [, cmr, cmb, ] = marginOf(cs);
    const actualW = childW - cml - cmr;
    const actualH = childH - cmt - cmb;

    boxes.push({ x: childX, y: childY, w: actualW, h: actualH });

    offset += childMain + gap;
  }

  return boxes;
}

// ───────────────────────────── 渲染 ─────────────────────────────

/**
 * 渲染 UniversalNode 树到 Canvas 2D 上下文
 *
 * @param ctx         Canvas 2D 上下文
 * @param node        DSL 根节点
 * @param box         渲染区域 {x, y, w, h}
 * @param bgColor     背景色
 * @param screenShape 屏幕形状 (可选, 用于 3D 模式裁剪圆角 + 灵动岛挖孔)
 */
export function renderDslToCanvas(
  ctx: CanvasRenderingContext2D,
  node: UniversalNode,
  box: Box,
  bgColor: string = DEFAULT_BG,
  screenShape?: ScreenShape,
): void {
  // 清空画布 (透明)
  ctx.clearRect(0, 0, box.w + box.x, box.h + box.y);

  // ★ 如果有屏幕形状, 用 clip 限制绘制区域为圆角矩形
  if (screenShape) {
    ctx.save();
    drawRoundRect(ctx, box.x, box.y, box.w, box.h, screenShape.cornerRadius);
    ctx.clip();
  }

  // 画背景色 (只在裁剪区域内)
  ctx.fillStyle = bgColor;
  ctx.fillRect(box.x, box.y, box.w, box.h);

  // 递归渲染 DSL 内容
  renderNode(ctx, node, box);

  // ★ 灵动岛挖孔: 清除该区域 (让纹理透明, 显示模型本身的黑色挖孔)
  if (screenShape?.notch) {
    const n = screenShape.notch;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    drawRoundRect(ctx, n.x, n.y, n.width, n.height, n.radius);
    ctx.fill();
    ctx.restore();
  }

  if (screenShape) {
    ctx.restore();
  }
}

function renderNode(ctx: CanvasRenderingContext2D, node: UniversalNode, box: Box): void {
  const style = node.style;
  const [mt, mr, mb, ml] = marginOf(style);
  const [pt, pr, pb, pl] = paddingOf(style);

  // 应用 margin → 实际渲染区域
  const renderBox: Box = {
    x: box.x + ml,
    y: box.y + mt,
    w: box.w - ml - mr,
    h: box.h - mt - mb,
  };

  // 如果尺寸太小, 跳过
  if (renderBox.w <= 0 || renderBox.h <= 0) return;

  // 绘制背景 + 边框 + 圆角
  const bg = parseColor(style?.background, 'transparent');
  const opacity = style?.opacity ?? 1;
  const radius = style?.radius ?? 0;

  ctx.save();
  ctx.globalAlpha = opacity;

  // 背景
  if (bg !== 'transparent') {
    ctx.fillStyle = bg;
    if (radius > 0) {
      drawRoundRect(ctx, renderBox.x, renderBox.y, renderBox.w, renderBox.h, radius);
      ctx.fill();
    } else {
      ctx.fillRect(renderBox.x, renderBox.y, renderBox.w, renderBox.h);
    }
  }

  // 边框
  if (style?.border) {
    ctx.strokeStyle = style.border;
    ctx.lineWidth = 1;
    if (radius > 0) {
      drawRoundRect(ctx, renderBox.x, renderBox.y, renderBox.w, renderBox.h, radius);
      ctx.stroke();
    } else {
      ctx.strokeRect(renderBox.x, renderBox.y, renderBox.w, renderBox.h);
    }
  }

  // 按类型渲染
  switch (node.type) {
    case 'container':
    case 'column': {
      const innerBox: Box = {
        x: renderBox.x + pl,
        y: renderBox.y + pt,
        w: renderBox.w - pl - pr,
        h: renderBox.h - pt - pb,
      };
      const children = (node as any).children as UniversalNode[] | undefined;
      if (children && children.length > 0) {
        const childBoxes = layoutChildren(children, innerBox, 'column', style);
        children.forEach((child, i) => {
          if (childBoxes[i]) renderNode(ctx, child, childBoxes[i]);
        });
      }
      break;
    }

    case 'row': {
      const innerBox: Box = {
        x: renderBox.x + pl,
        y: renderBox.y + pt,
        w: renderBox.w - pl - pr,
        h: renderBox.h - pt - pb,
      };
      const children = (node as any).children as UniversalNode[] | undefined;
      if (children && children.length > 0) {
        const childBoxes = layoutChildren(children, innerBox, 'row', style);
        children.forEach((child, i) => {
          if (childBoxes[i]) renderNode(ctx, child, childBoxes[i]);
        });
      }
      break;
    }

    case 'stack': {
      const innerBox: Box = {
        x: renderBox.x + pl,
        y: renderBox.y + pt,
        w: renderBox.w - pl - pr,
        h: renderBox.h - pt - pb,
      };
      const children = (node as any).children as UniversalNode[] | undefined;
      if (children) {
        // stack: 所有子节点占满父容器
        children.forEach((child) => renderNode(ctx, child, innerBox));
      }
      break;
    }

    case 'text': {
      const content = (node as any).content as string;
      const color = parseColor(style?.color, DEFAULT_FG);
      const fontSize = style?.fontSize ?? 14;
      const fontWeight = style?.fontWeight ?? 400;
      const textAlign = style?.textAlign ?? 'left';
      const lineHeight = style?.lineHeight ?? fontSize * 1.4;
      const letterSpacing = style?.letterSpacing ?? 0;

      ctx.fillStyle = color;
      ctx.font = `${fontWeight} ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = textAlign as CanvasTextAlign;

      const textX = renderBox.x + pl;
      const textY = renderBox.y + pt;
      const maxWidth = renderBox.w - pl - pr;

      // 支持多行文本 + letterSpacing
      const lines = content.split('\n');
      if (letterSpacing > 0) {
        // Canvas 2D 不原生支持 letterSpacing, 手动逐字符绘制
        lines.forEach((line, lineIdx) => {
          const y = textY + lineIdx * lineHeight;
          let x = textX;
          if (textAlign === 'center') x = textX + maxWidth / 2;
          else if (textAlign === 'right') x = textX + maxWidth;
          for (const ch of line) {
            ctx.fillText(ch, x, y);
            const metrics = ctx.measureText(ch);
            x += metrics.width + letterSpacing;
          }
        });
      } else {
        lines.forEach((line, lineIdx) => {
          ctx.fillText(line, textX, textY + lineIdx * lineHeight, maxWidth);
        });
      }
      break;
    }

    case 'button': {
      const label = (node as any).label as string;
      const variant = (node as any).variant ?? 'filled';
      const color = parseColor(style?.color, '#ffffff');
      const bg2 = parseColor(style?.background, variant === 'filled' ? '#6366f1' : 'transparent');
      const fontSize = style?.fontSize ?? 14;

      // 按钮背景已绘制 (上面的 bg 逻辑)
      if (variant === 'outlined') {
        ctx.strokeStyle = parseColor(style?.background, '#6366f1');
        ctx.lineWidth = 1.5;
        drawRoundRect(ctx, renderBox.x, renderBox.y, renderBox.w, renderBox.h, radius || 8);
        ctx.stroke();
      } else if (variant === 'filled' && bg === 'transparent') {
        // filled 按钮默认紫色背景
        ctx.fillStyle = bg2;
        drawRoundRect(ctx, renderBox.x, renderBox.y, renderBox.w, renderBox.h, radius || 8);
        ctx.fill();
      }

      // 按钮文字 (居中)
      ctx.fillStyle = variant === 'filled' ? color : parseColor(style?.background, '#6366f1');
      ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, renderBox.x + renderBox.w / 2, renderBox.y + renderBox.h / 2);
      break;
    }

    case 'input': {
      const placeholder = (node as any).placeholder as string;
      const fontSize = style?.fontSize ?? 14;
      const bg2 = parseColor(style?.background, '#f5f5f5');

      // 输入框背景
      ctx.fillStyle = bg2;
      drawRoundRect(ctx, renderBox.x, renderBox.y, renderBox.w, renderBox.h, radius || 8);
      ctx.fill();

      // 边框
      ctx.strokeStyle = '#e0e0e0';
      ctx.lineWidth = 1;
      drawRoundRect(ctx, renderBox.x, renderBox.y, renderBox.w, renderBox.h, radius || 8);
      ctx.stroke();

      // placeholder 文字
      if (placeholder) {
        ctx.fillStyle = '#999999';
        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(placeholder, renderBox.x + 12, renderBox.y + renderBox.h / 2);
      }
      break;
    }

    case 'image': {
      const src = (node as any).src as string;
      if (src) {
        // 图片用占位色块 (Canvas 2D 异步加载图片太复杂, 3D 贴图中用色块代替)
        ctx.fillStyle = parseColor(style?.background, '#f0f0f0');
        drawRoundRect(ctx, renderBox.x, renderBox.y, renderBox.w, renderBox.h, radius);
        ctx.fill();

        // 占位图标 (简单的山形 SVG 路径)
        ctx.fillStyle = '#cccccc';
        const cx = renderBox.x + renderBox.w / 2;
        const cy = renderBox.y + renderBox.h / 2;
        const iconSize = Math.min(renderBox.w, renderBox.h) * 0.2;
        ctx.beginPath();
        ctx.moveTo(cx - iconSize, cy + iconSize * 0.5);
        ctx.lineTo(cx - iconSize * 0.3, cy - iconSize * 0.3);
        ctx.lineTo(cx, cy + iconSize * 0.2);
        ctx.lineTo(cx + iconSize * 0.3, cy - iconSize * 0.5);
        ctx.lineTo(cx + iconSize, cy + iconSize * 0.5);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(renderBox.x, renderBox.y, renderBox.w, renderBox.h);
      }
      break;
    }

    case 'divider': {
      ctx.fillStyle = parseColor(style?.background, '#e0e0e0');
      ctx.fillRect(renderBox.x, renderBox.y, renderBox.w, renderBox.h);
      break;
    }

    case 'spacer': {
      // spacer 只占空间, 不绘制
      break;
    }

    default: {
      // 未知节点类型 — 画透明矩形 (不干扰其他节点)
      break;
    }
  }

  ctx.restore();
}

/** 绘制圆角矩形路径 (不 fill/stroke, 调用方负责) */
function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// ───────────────────────────── THREE.js 集成 ─────────────────────────────

/**
 * 把 DSL 渲染到 CanvasTexture
 *
 * @param dsl      DSL 根节点
 * @param width    纹理宽度 (像素)
 * @param height   纹理高度 (像素)
 * @param bgColor  背景色
 * @returns THREE.CanvasTexture (已配置 colorSpace + needsUpdate)
 */
export function createDslTexture(
  dsl: UniversalNode,
  width: number,
  height: number,
  bgColor: string = DEFAULT_BG,
  screenShape?: ScreenShape,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // 高 DPI 渲染 (2x 超采样, 提升文字清晰度)
  const dpr = 2;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  renderDslToCanvas(ctx, dsl, { x: 0, y: 0, w: width, h: height }, bgColor, screenShape);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * ★ 更新已有 texture (避免重复创建 CanvasTexture, 减少 GPU 内存分配)
 *
 * @param texture  已有的 CanvasTexture
 * @param dsl      新的 DSL 根节点
 * @param width    纹理宽度
 * @param height   纹理高度
 * @param bgColor  背景色
 */
export function updateDslTexture(
  texture: THREE.CanvasTexture,
  dsl: UniversalNode,
  width: number,
  height: number,
  bgColor: string = DEFAULT_BG,
  screenShape?: ScreenShape,
): void {
  const canvas = texture.image as HTMLCanvasElement;
  if (!canvas) return;

  const ctx = canvas.getContext('2d')!;
  const dpr = 2;
  // 确保画布尺寸正确
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0); // 重置变换
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  renderDslToCanvas(ctx, dsl, { x: 0, y: 0, w: width, h: height }, bgColor, screenShape);

  texture.needsUpdate = true;
}
