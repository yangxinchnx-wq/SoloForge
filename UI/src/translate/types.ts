/**
 * types.ts — 翻译器统一接口定义
 *
 * 设计原则:
 *   - 每种语言/框架一个 Translator 实现
 *   - detect() 检测代码归属 (用于自动识别)
 *   - translate() 翻译成 Universal AST (画布可渲染)
 *   - 支持 streaming (未来扩展, 当前只支持完整代码翻译)
 *
 * 翻译器不依赖网络, 纯本地解析, 不消耗 LLM token。
 *
 * 使用方式:
 *   import { translateCode } from './index';
 *   const ast = translateCode(htmlString, 'html');
 *   // 或自动检测:
 *   const ast2 = translateCode(codeString);  // 自动调用 detect
 */

import type { UniversalNode } from '../services/canvas/UniversalAST';

/**
 * 翻译器接口 — 每种语言实现此接口
 */
export interface Translator {
  /** 语言标识 (如 'html', 'react', 'vue') */
  language: string;

  /** 显示名 (如 'HTML', 'React JSX', 'Vue SFC') */
  displayName: string;

  /**
   * 检测代码是否属于此语言
   * 用于自动识别 (未指定 language 时遍历所有翻译器)
   * @param code 源代码字符串
   * @returns 置信度 0-1, 0 表示不匹配
   */
  detect(code: string): number;

  /**
   * 翻译源代码为 Universal AST
   * @param code 源代码字符串
   * @throws TranslateError 当翻译失败时
   * @returns UniversalNode 根节点
   */
  translate(code: string): UniversalNode;
}

/**
 * 翻译错误
 */
export class TranslateError extends Error {
  readonly language: string;
  readonly originalCode: string;

  constructor(language: string, message: string, originalCode?: string) {
    super(`[${language} translator] ${message}`);
    this.name = 'TranslateError';
    this.language = language;
    this.originalCode = originalCode || '';
  }
}

/**
 * 翻译结果
 */
export interface TranslateResult {
  /** 翻译出的 AST 根节点 */
  node: UniversalNode;
  /** 使用的翻译器语言 */
  language: string;
  /** 翻译过程中的警告 (不影响结果, 但告知用户有丢失) */
  warnings: string[];
  /** 翻译耗时 (ms) */
  durationMs: number;
}
