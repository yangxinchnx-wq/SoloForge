/**
 * index.ts — 翻译器统一入口 + 注册表
 *
 * 所有语言的翻译器在此注册, 外部只导入 translateCode() 即可。
 * 新增语言时只需:
 *   1. 实现 Translator 接口 (如 reactTranslator.ts)
 *   2. 在 translators 数组中注册
 *
 * 使用方式:
 *   import { translateCode } from '@/translate';
 *
 *   // 指定语言
 *   const ast = translateCode(htmlString, 'html');
 *
 *   // 自动检测 (遍历所有翻译器的 detect())
 *   const ast2 = translateCode(codeString);
 *
 *   // 获取详细信息 (含警告/耗时)
 *   const result = translateCodeDetailed(codeString, 'html');
 */

import type { UniversalNode } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator, type TranslateResult } from './types';
import { htmlTranslator } from './htmlTranslator';
import { reactTranslator } from './reactTranslator';
import { vueTranslator } from './vueTranslator';
import { flutterTranslator } from './flutterTranslator';
import { swiftuiTranslator } from './swiftuiTranslator';
import { composeTranslator } from './composeTranslator';
import { androidXmlTranslator } from './androidXmlTranslator';
import { xamlTranslator } from './xamlTranslator';
import { qmlTranslator } from './qmlTranslator';

// ──────────────────────────── 翻译器注册表 ────────────────────────────
// 主流 10 款翻译器, 按 detect 置信度从高到低排序。
// 翻译器的 detect() 返回值越高, 自动检测时优先级越高。
//
// 注意事项:
//   - 纯 HTML (<div>...</div>) 可能与 React/Vue 重叠, 但 htmlTranslator(0.7) 排在前面优先命中
//   - Vue SFC 有 <template> 标记, 置信度最高 (0.95)
//   - 原生系 (Flutter/SwiftUI/Compose) 需 import 才能到 0.9, 否则 0.6-0.8
//   - XML 系 (Android/XAML) 靠命名空间属性区分, 互不冲突

const translators: Translator[] = [
  htmlTranslator,        // 1. HTML (0.9/0.7)
  vueTranslator,         // 2. Vue SFC (0.95/0.85/0.7)
  reactTranslator,       // 3. React JSX/TSX (0.9/0.8/0.6)
  flutterTranslator,     // 4. Flutter/Dart (0.9/0.8/0.6)
  swiftuiTranslator,     // 5. SwiftUI (0.9/0.8/0.6)
  composeTranslator,     // 6. Jetpack Compose (0.9/0.7/0.6)
  androidXmlTranslator,  // 7. Android XML (0.95/0.85/0.5)
  xamlTranslator,        // 8. XAML WPF/MAUI (0.9/0.8/0.5)
  qmlTranslator,         // 9. Qt QML (0.9/0.8/0.5)
  // CSS 提取器是辅助工具, 不在此注册 (用 enrichWithCss() 手动调用)
];

const translatorMap = new Map<string, Translator>(
  translators.map(t => [t.language.toLowerCase(), t])
);

// ──────────────────────────── 公共 API ────────────────────────────

/**
 * 翻译源代码为 Universal AST (简单版, 只返回节点)
 *
 * @param code 源代码字符串
 * @param language 语言标识 ('html' | 'react' | 'vue' | ...), 省略则自动检测
 * @returns UniversalNode 根节点
 * @throws TranslateError 当翻译失败时
 */
export function translateCode(code: string, language?: string): UniversalNode {
  const translator = resolveTranslator(code, language);
  return translator.translate(code);
}

/**
 * 翻译源代码为 Universal AST (详细版, 含警告/耗时)
 *
 * @param code 源代码字符串
 * @param language 语言标识, 省略则自动检测
 * @returns TranslateResult 含 node + warnings + durationMs
 */
export function translateCodeDetailed(code: string, language?: string): TranslateResult {
  const translator = resolveTranslator(code, language);
  const warnings: string[] = [];

  const start = Date.now();
  let node: UniversalNode;
  try {
    node = translator.translate(code);
  } catch (err: any) {
    if (err instanceof TranslateError) throw err;
    throw new TranslateError(translator.language, err.message, code);
  }
  const durationMs = Date.now() - start;

  return { node, language: translator.language, warnings, durationMs };
}

/**
 * 获取已注册的所有翻译器语言列表
 */
export function getSupportedLanguages(): string[] {
  return translators.map(t => t.language);
}

/**
 * 检查某语言是否已注册
 */
export function isLanguageSupported(language: string): boolean {
  return translatorMap.has(language.toLowerCase());
}

/**
 * 自动检测代码语言 (遍历所有翻译器, 返回置信度最高的)
 *
 * @param code 源代码字符串
 * @returns 匹配的翻译器, 或 null (无匹配)
 */
export function detectLanguage(code: string): Translator | null {
  let best: Translator | null = null;
  let bestScore = 0;

  for (const t of translators) {
    const score = t.detect(code);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }

  // 置信度低于 0.3 不认为匹配
  return bestScore >= 0.3 ? best : null;
}

// ──────────────────────────── 内部工具 ────────────────────────────

/**
 * 解析翻译器: 指定语言 → 查 map; 未指定 → 自动检测
 */
function resolveTranslator(code: string, language?: string): Translator {
  if (language) {
    const t = translatorMap.get(language.toLowerCase());
    if (!t) {
      throw new TranslateError(language, `不支持的语言: ${language}. 已注册: ${getSupportedLanguages().join(', ')}`);
    }
    return t;
  }

  // 自动检测
  const detected = detectLanguage(code);
  if (!detected) {
    throw new TranslateError('auto', `无法识别代码语言. 已注册: ${getSupportedLanguages().join(', ')}`);
  }
  return detected;
}

// ──────────────────────────── 导出 ────────────────────────────

export type { Translator, TranslateResult } from './types';
export { TranslateError } from './types';
export { htmlTranslator } from './htmlTranslator';
export { reactTranslator } from './reactTranslator';
export { vueTranslator } from './vueTranslator';
export { flutterTranslator } from './flutterTranslator';
export { swiftuiTranslator } from './swiftuiTranslator';
export { composeTranslator } from './composeTranslator';
export { androidXmlTranslator } from './androidXmlTranslator';
export { xamlTranslator } from './xamlTranslator';
export { qmlTranslator } from './qmlTranslator';
export { parseCss, extractStyleBlocks, applyCssRules, enrichWithCss } from './cssExtractor';
export type { CssRule } from './cssExtractor';
