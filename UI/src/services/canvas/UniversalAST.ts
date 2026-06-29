/**
 * UniversalAST.ts — 语言无关的 Preview AST
 *
 * 设计目标：
 *   1. LLM 输出此结构（替代"直接生成 Flutter 源码"的旧路径）
 *   2. 渲染器（Flutter canvas_preview.exe）消费此结构
 *   3. 支持 Python / C / Java / Go / Rust / TypeScript 等任意语言生成的 UI
 *   4. 流式可解析（半成品 AST 也能提取 root）
 *
 * 与现有 ASTParser 的关系：
 *   - 旧 ASTParser 解析 Flutter widget 代码（Container/Row/Text...）
 *   - 新的 UniversalAST 是 LLM 输出的统一格式
 *   - 两者并存，按调用方选择：旧路径继续工作，新路径走这个
 */

// ───────────────────────────── 视觉属性 ─────────────────────────────

export type FlexDir = 'row' | 'column';
export type Align = 'start' | 'center' | 'end' | 'stretch' | 'space-between' | 'space-around';
export type Justify = 'start' | 'center' | 'end';
export type FontWeight = 300 | 400 | 500 | 600 | 700;
export type ButtonVariant = 'filled' | 'outlined' | 'text';
export type InputKind = 'text' | 'password' | 'email' | 'number';

/**
 * 视觉属性子集：覆盖 80% 常见 UI（渐变、阴影、圆角、间距、边框）
 * 字段命名兼容 Flutter / CSS 习惯，便于后端映射
 */
export interface UniversalStyle {
  width?: number | string;
  height?: number | string;
  flex?: number;
  padding?: number | [number, number] | [number, number, number, number];
  margin?: number | [number, number] | [number, number, number, number];
  background?: string;            // CSS color 或 linear-gradient(...)
  color?: string;
  radius?: number;
  shadow?: string;
  border?: string;
  opacity?: number;
  align?: Align;
  justify?: Justify;
  fontSize?: number;
  fontWeight?: FontWeight;
  textAlign?: 'left' | 'center' | 'right';
  gap?: number;
  lineHeight?: number;
  letterSpacing?: number;
}

// ───────────────────────────── AST 节点（联合类型） ─────────────────────────────

export type UniversalNode =
  | { type: 'container'; style?: UniversalStyle; children?: UniversalNode[] }
  | { type: 'row'; style?: UniversalStyle; children?: UniversalNode[] }
  | { type: 'column'; style?: UniversalStyle; children?: UniversalNode[] }
  | { type: 'stack'; style?: UniversalStyle; children?: UniversalNode[] }
  | { type: 'text'; content: string; style?: UniversalStyle }
  | { type: 'button'; label: string; variant?: ButtonVariant; style?: UniversalStyle }
  | {
      type: 'input';
      placeholder?: string;
      value?: string;
      kind?: InputKind;
      style?: UniversalStyle;
    }
  | { type: 'image'; src?: string; alt?: string; style?: UniversalStyle }
  | { type: 'divider'; style?: UniversalStyle }
  | { type: 'spacer'; style?: UniversalStyle };

// ───────────────────────────── LLM 输出契约 ─────────────────────────────

/**
 * PreviewPayload — LLM 必须输出的最小契约
 *   language    : 用于选择 system prompt 和 source code 高亮
 *   framework   : 描述框架名（Flask / GTK3 / Swing ...）
 *   source_code : 真实源码（Code 面板展示用）
 *   preview     : AST 描述树 + 可选 design notes
 */
export interface PreviewPayload {
  language: string;
  framework: string;
  source_code: string;
  preview: {
    root: UniversalNode;
    notes?: string;
  };
}

/** 流式解析中间态 */
export interface StreamState {
  raw: string;
  payload: Partial<PreviewPayload> | null;
  errors: string[];
  done: boolean;
}

// ───────────────────────────── 类型守卫（utils） ─────────────────────────────

export function isContainerLike(
  node: UniversalNode,
): node is Extract<UniversalNode, { children?: UniversalNode[] }> {
  return node.type === 'container' || node.type === 'row' || node.type === 'column' || node.type === 'stack';
}

export function getChildren(node: UniversalNode): UniversalNode[] | undefined {
  return isContainerLike(node) ? node.children : undefined;
}
