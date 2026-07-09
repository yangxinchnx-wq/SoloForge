/**
 * types.ts — 翻译器统一接口定义
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  Translator 接口 — 每种语言实现此接口即可被自动发现                ║
 * ║                                                                  ║
 * ║  实现 Translator 接口并放到 *Translator.ts 文件中,                ║
 * ║  index.ts 会通过 import.meta.glob 自动发现并注册。                ║
 * ║                                                                  ║
 * ║  接口要求:                                                       ║
 * ║    - language:     语言标识 (唯一 key, 如 'html' / 'rust')       ║
 * ║    - displayName:  展示名 (如 'HTML' / 'Rust egui')             ║
 * ║    - detect(code): 代码归属检测 (返回 0-1 置信度)                ║
 * ║    - translate(code): 翻译为 Universal AST                       ║
 * ║                                                                  ║
 * ║  纯本地解析, 不依赖网络, 不消耗 LLM token。                      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * @example 最小翻译器示例 (保存为 myLangTranslator.ts 即可自动注册)
 *   import type { Translator } from './types';
 *
 *   export const myLangTranslator: Translator = {
 *     language: 'mylang',
 *     displayName: 'My Language',
 *     detect: (code) => code.startsWith('#mylang') ? 0.9 : 0,
 *     translate: (code) => {
 *       // 解析 code, 返回 UniversalNode 树
 *       return { type: 'container', children: [...] };
 *     },
 *   };
 */

import type { UniversalNode } from '../services/canvas/UniversalAST';

/**
 * 翻译器接口 — 每种语言实现此接口
 *
 * 实现后放到 *Translator.ts 文件中, 会被 index.ts 的 import.meta.glob
 * 自动发现并注册 (零配置接入)。
 */
export interface Translator {
  /**
   * 语言标识 (唯一 key)
   *
   * 用作注册表的 key, 必须唯一。小写英文, 如 'html' / 'react' / 'rust'。
   * translateCode(code, 'html') 通过此标识查找翻译器。
   * 大小写不敏感 (内部统一转小写存储)。
   */
  language: string;

  /**
   * 显示名 (UI 展示用)
   *
   * 如 'HTML' / 'React JSX' / 'Vue SFC' / 'C (Win32 / GTK / LVGL)'。
   * 可包含框架说明, 如 'Python (Tkinter / PyQt / Kivy)'。
   */
  displayName: string;

  /**
   * 检测代码是否属于此语言
   *
   * 用于自动识别 (未指定 language 时, index.ts 遍历所有翻译器,
   * 取 detect() 返回值最高者)。
   *
   * 置信度约定:
   *   - 0.9  强特征匹配 (如 #include + 函数调用同时存在)
   *   - 0.7  中等特征 (仅有函数调用, 无 include)
   *   - 0.5  弱特征 (框架特征关键字)
   *   - 0.3  仅语法特征 (可能误判, 兜底置信度)
   *   - 0    不匹配
   *
   * 注意: 置信度 < 0.3 会被 index.ts 视为不匹配。
   *       多个翻译器可能同时返回 > 0.3, 取最高者。
   *
   * @param code 源代码字符串
   * @returns 置信度 0-1, 0 表示不匹配
   */
  detect(code: string): number;

  /**
   * 翻译源代码为 Universal AST
   *
   * 纯本地解析, 不依赖网络, 不消耗 LLM token。
   * 实现策略因语言而异:
   *   - HTML/XML 系: 用 cheerio 解析
   *   - JSX/TSX: 用 @babel/parser 解析
   *   - Vue SFC: 用 @vue/compiler-sfc 解析
   *   - Flutter/SwiftUI/Compose/QML/Python/C: 自定义 tokenizer + 递归下降 parser
   *
   * @param code 源代码字符串
   * @returns UniversalNode 根节点 (可送入画布渲染)
   * @throws TranslateError 当翻译失败时 (语法错误 / 不支持的构造等)
   */
  translate(code: string): UniversalNode;
}

/**
 * 翻译错误
 *
 * 所有翻译器在 translate() 中遇到不可恢复的错误时应抛出此异常。
 * index.ts 的 translateCodeDetailed() 会捕获并重新包装非 TranslateError 的异常。
 */
export class TranslateError extends Error {
  /** 出错的语言标识 */
  readonly language: string;
  /** 触发错误的原始代码 (用于调试) */
  readonly originalCode: string;

  constructor(language: string, message: string, originalCode?: string) {
    super(`[${language} translator] ${message}`);
    this.name = 'TranslateError';
    this.language = language;
    this.originalCode = originalCode || '';
  }
}

/**
 * 翻译结果 (translateCodeDetailed 的返回值)
 */
export interface TranslateResult {
  /** 翻译出的 AST 根节点 */
  node: UniversalNode;
  /** 使用的翻译器语言 (自动检测时用于确认实际命中的翻译器) */
  language: string;
  /** 翻译过程中的非致命警告 (不影响结果, 但告知用户有信息丢失) */
  warnings: string[];
  /** 翻译耗时 (毫秒, 用于性能监控) */
  durationMs: number;
}
