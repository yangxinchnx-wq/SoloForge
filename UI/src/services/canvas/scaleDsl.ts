/**
 * scaleDsl.ts — DSL 等比例缩放器
 *
 * 拖拽画布面板时, 根据设计尺寸与当前画布尺寸的比例,
 * 遍历 DSL 树, 缩放所有数值型样式字段。
 *
 * 缩放字段:
 *   width, height        → × scaleX / × scaleY
 *   padding, margin      → × avg (四边均匀)
 *   fontSize             → × avg
 *   borderRadius, radius → × avg
 *   gap, spacing         → × avg
 *   letterSpacing        → × avg
 *   lineHeight           → × scaleY (行高与高度相关)
 *
 * 不缩放:
 *   flex, opacity, color, content, label, variant, placeholder, value,
 *   src, alt, kind, textAlign, fontWeight, align, justify
 *
 * 支持 UniversalNode 格式 (有 style) 和 Flutter DSL 格式 (有 props)
 */

/** 需要按 avg 缩放的 props/style 字段名 */
const AVG_FIELDS = new Set([
  'padding', 'margin', 'fontSize', 'borderRadius', 'radius',
  'gap', 'spacing', 'letterSpacing', 'lineHeight',
]);

/** 需要按 scaleX 缩放的字段 */
const X_FIELDS = new Set(['width']);

/** 需要按 scaleY 缩放的字段 */
const Y_FIELDS = new Set(['height']);

function scaleValue(val: any, scale: number): any {
  if (typeof val === 'number') return Math.round(val * scale * 100) / 100;
  if (Array.isArray(val)) return val.map((v) => scaleValue(v, scale));
  return val; // 字符串 (如 "100%") 不缩放
}

function scaleUniversalStyle(
  style: Record<string, any> | undefined,
  scaleX: number,
  scaleY: number,
): Record<string, any> | undefined {
  if (!style) return style;
  const avg = (scaleX + scaleY) / 2;
  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(style)) {
    if (X_FIELDS.has(key)) result[key] = scaleValue(val, scaleX);
    else if (Y_FIELDS.has(key)) result[key] = scaleValue(val, scaleY);
    else if (AVG_FIELDS.has(key)) result[key] = scaleValue(val, avg);
    else result[key] = val; // 不缩放
  }
  return result;
}

function scaleFlutterProps(
  props: Record<string, any> | undefined,
  scaleX: number,
  scaleY: number,
): Record<string, any> | undefined {
  if (!props) return props;
  const avg = (scaleX + scaleY) / 2;
  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(props)) {
    if (X_FIELDS.has(key)) result[key] = scaleValue(val, scaleX);
    else if (Y_FIELDS.has(key)) result[key] = scaleValue(val, scaleY);
    else if (AVG_FIELDS.has(key)) result[key] = scaleValue(val, avg);
    else result[key] = val; // 不缩放
  }
  return result;
}

/**
 * 递归缩放 DSL 节点 (同时支持 UniversalNode 和 Flutter DSL)
 *
 * @param node DSL 节点
 * @param scaleX X 轴缩放比例 (currentWidth / designWidth)
 * @param scaleY Y 轴缩放比例 (currentHeight / designHeight)
 * @returns 缩放后的新节点 (不改原节点)
 */
export function scaleDsl(node: any, scaleX: number, scaleY: number): any {
  if (!node || typeof node !== 'object') return node;

  // 防止 scale 为 0 或 NaN
  const sx = scaleX > 0 && isFinite(scaleX) ? scaleX : 1;
  const sy = scaleY > 0 && isFinite(scaleY) ? scaleY : 1;

  // 如果 scale 都是 1, 直接返回原节点 (无需克隆)
  if (sx === 1 && sy === 1) return node;

  const result: any = { type: node.type };

  // UniversalNode 格式: 有 style 字段
  if (node.style) {
    result.style = scaleUniversalStyle(node.style, sx, sy);
  }

  // Flutter DSL 格式: 有 props 字段
  if (node.props) {
    result.props = scaleFlutterProps(node.props, sx, sy);
  }

  // 复制非尺寸内容字段
  if (node.content != null) result.content = node.content;
  if (node.label != null) result.label = node.label;
  if (node.variant != null) result.variant = node.variant;
  if (node.placeholder != null) result.placeholder = node.placeholder;
  if (node.value != null) result.value = node.value;
  if (node.kind != null) result.kind = node.kind;
  if (node.src != null) result.src = node.src;
  if (node.alt != null) result.alt = node.alt;

  // 递归 children
  if (node.children && Array.isArray(node.children)) {
    result.children = node.children.map((child: any) => scaleDsl(child, sx, sy));
  }

  return result;
}
