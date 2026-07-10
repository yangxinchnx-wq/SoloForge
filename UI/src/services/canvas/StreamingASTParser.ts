/**
 * StreamingASTParser.ts — 容错的渐进式 JSON 解析器
 *
 * 目标：
 *   - 接受 LLM 流式字符片段（chunk-by-chunk）
 *   - 返回 Partial<PreviewPayload>（半成品也能提取 root）
 *   - bracket 自动修复（容错截断的 JSON）
 *   - 不抛错（错误进 errors[]，调用方决定是否 fallback）
 *
 * 设计原则：
 *   - 无外部依赖（不引入 stream-json 等重型库）
 *   - O(n) 单遍扫描
 *   - 每次 feed 都是纯函数（state 不变则返回同 result）
 *
 * 与旧 ASTParser 的关系：
 *   - 旧 ASTParser 解析 Flutter widget 代码（一次性）
 *   - 这个解析 LLM 输出的 JSON 契约（流式）
 *   - 互不替代，按场景选择
 */

import type { PreviewPayload, StreamState, UniversalNode } from './UniversalAST';

const REPAIRABLE_ERRORS = ['parse-failed', 'repaired-truncation'] as const;
export type StreamError = (typeof REPAIRABLE_ERRORS)[number] | 'empty-input';

function tryParse(raw: string): PreviewPayload | null {
  // ★ 2026-07-11: LLM 经常把 JSON 包在 markdown code fence 里 (```json ... ```)
  //   或在前后加解释文字。需要先提取 JSON 主体再 parse。
  let jsonStr = raw;

  // 1. 尝试提取 ```json ... ``` 或 ``` ... ``` 代码块
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else {
    // 2. 没有代码块, 尝试提取第一个 { 到最后一个 } (JSON 主体)
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
  }

  try {
    const v = JSON.parse(jsonStr);
    if (v && typeof v === 'object' && 'preview' in v && (v as any).preview) {
      return v as PreviewPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 暴力修复：补全截断的字符串、未闭合的花括号 / 中括号
 * 适用于 LLM 在 chunk 边界处切断的常见情况
 */
function repair(raw: string): string {
  let s = raw;
  // 截断的字符串：在最后一个未闭合引号处补 "
  const quoteCount = (s.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    s = s + '"';
  }
  // 补全括号
  const openBraces = (s.match(/{/g) || []).length;
  const closeBraces = (s.match(/}/g) || []).length;
  const openBrackets = (s.match(/\[/g) || []).length;
  const closeBrackets = (s.match(/\]/g) || []).length;
  s = s + ']'.repeat(Math.max(0, openBrackets - closeBrackets));
  s = s + '}'.repeat(Math.max(0, openBraces - closeBraces));
  return s;
}

/** 从 Partial<PreviewPayload> 中尽量提取 root（半成品也行） */
export function bestEffortRoot(payload: Partial<PreviewPayload> | null | undefined): UniversalNode | undefined {
  if (!payload) return undefined;
  const p: any = payload.preview;
  if (!p || typeof p !== 'object') return undefined;
  if (p.root && typeof p.root === 'object' && 'type' in p.root) return p.root as UniversalNode;
  return undefined;
}

/** 创建初始流状态 */
export function createStreamState(): StreamState {
  return { raw: '', payload: null, errors: [], done: false };
}

/**
 * 喂入一个 chunk，返回新 state
 * 注意：调用方应 setState(next)，本函数不持有引用
 */
export function feedChunk(state: StreamState, chunk: string): StreamState {
  if (state.done) return state;
  const raw = state.raw + chunk;
  let payload: Partial<PreviewPayload> | null = null;
  const errors: string[] = [];

  if (raw.length === 0) {
    errors.push('empty-input');
    return { raw, payload: null, errors, done: false };
  }

  const direct = tryParse(raw);
  if (direct) {
    payload = direct;
  } else {
    const repaired = repair(raw);
    const r = tryParse(repaired);
    if (r) {
      payload = r;
      errors.push('repaired-truncation');
    } else {
      errors.push('parse-failed');
    }
  }

  return { raw, payload, errors, done: false };
}

/** 标记流结束（用于 UI 显示 complete 态） */
export function markDone(state: StreamState): StreamState {
  return { ...state, done: true };
}

/** 重置流（用于重试） */
export function resetStream(): StreamState {
  return createStreamState();
}

/**
 * 单次解析（非流式场景）
 * 用途：LLM 返回完整字符串时一步解析
 */
export function parseOnce(raw: string): { payload: PreviewPayload | null; errors: string[] } {
  const state = feedChunk(createStreamState(), raw);
  return { payload: (state.payload as PreviewPayload | null) ?? null, errors: state.errors };
}
