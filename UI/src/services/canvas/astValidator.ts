/**
 * astValidator.ts — UniversalAST 的运行时校验器（无外部依赖）
 *
 * 设计动机：
 *   - LLM 输出经此函数验证（确保 root.children 等结构合法）
 *   - StreamingASTParser 在解析时调用
 *   - 给后端 / 前端双重防御
 *
 * 与 zod 的对比：
 *   - zod 更强大但有 ~50KB 依赖
 *   - 这个版本手写、零依赖、覆盖我们用到的子集
 *   - 如未来需要严格 schema，迁移到 zod 只需替换实现
 *
 * 导出：
 *   - validatePreviewPayload(payload) → { ok, errors }
 *   - validateRoot(node) → { ok, errors }
 *   - isValidNode(node) → boolean（快路径）
 *   - NodeType 枚举
 */

import type { UniversalNode } from './UniversalAST';

export const NODE_TYPES = [
  'container', 'row', 'column', 'stack',
  'text', 'button', 'input', 'image',
  'divider', 'spacer',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];
export type ValidationErrors = string[];
export interface ValidationResult {
  ok: boolean;
  errors: ValidationErrors;
}

const CONTAINER_TYPES: ReadonlySet<NodeType> = new Set(['container', 'row', 'column', 'stack']);

/** 快速判断一个值是否可能是合法节点 */
export function isValidNode(value: unknown): value is UniversalNode {
  if (!value || typeof value !== 'object') return false;
  const t = (value as any).type;
  return typeof t === 'string' && (NODE_TYPES as readonly string[]).includes(t);
}

/**
 * 递归校验 root 节点（含 children）
 * - 不抛错，错误累积在 errors[]
 * - 性能：单遍深度优先，O(n)
 */
export function validateRoot(root: unknown, maxDepth = 64): ValidationResult {
  const errors: ValidationErrors = [];

  function walk(node: unknown, path: string, depth: number): void {
    if (depth > maxDepth) {
      errors.push(`${path}: max depth ${maxDepth} exceeded`);
      return;
    }
    if (!node || typeof node !== 'object') {
      errors.push(`${path}: expected object, got ${typeof node}`);
      return;
    }

    const n = node as any;
    const t = n.type;
    if (typeof t !== 'string' || !(NODE_TYPES as readonly string[]).includes(t)) {
      errors.push(`${path}: invalid type "${String(t)}"`);
      return;
    }

    // 必填字段
    if (t === 'text' && typeof n.content !== 'string') {
      errors.push(`${path}.content: must be string`);
    }
    if (t === 'button' && typeof n.label !== 'string') {
      errors.push(`${path}.label: must be string`);
    }

    // container-like 应有 children 数组
    if (CONTAINER_TYPES.has(t as NodeType)) {
      if (n.children !== undefined) {
        if (!Array.isArray(n.children)) {
          errors.push(`${path}.children: must be array`);
        } else {
          n.children.forEach((c: unknown, i: number) => walk(c, `${path}.children[${i}]`, depth + 1));
        }
      }
    }

    // style 是可选对象
    if (n.style !== undefined && (typeof n.style !== 'object' || n.style === null || Array.isArray(n.style))) {
      errors.push(`${path}.style: must be plain object`);
    }
  }

  walk(root, 'root', 0);
  return { ok: errors.length === 0, errors };
}

/**
 * 校验 PreviewPayload
 */
export function validatePreviewPayload(payload: unknown): ValidationResult {
  const errors: ValidationErrors = [];

  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: ['payload: must be object'] };
  }

  const p = payload as any;

  if (typeof p.language !== 'string') errors.push('language: must be string');
  if (typeof p.framework !== 'string') errors.push('framework: must be string');
  if (typeof p.source_code !== 'string') errors.push('source_code: must be string');

  if (!p.preview || typeof p.preview !== 'object') {
    errors.push('preview: must be object');
    return { ok: false, errors };
  }

  const rootResult = validateRoot(p.preview.root);
  if (!rootResult.ok) {
    errors.push(...rootResult.errors);
  }

  if (p.preview.notes !== undefined && typeof p.preview.notes !== 'string') {
    errors.push('preview.notes: must be string');
  }

  return { ok: errors.length === 0, errors };
}

/** 仅校验节点类型（流式解析时快路径） */
export function nodeType(value: unknown): NodeType | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const t = (value as any).type;
  return typeof t === 'string' && (NODE_TYPES as readonly string[]).includes(t) ? (t as NodeType) : undefined;
}
