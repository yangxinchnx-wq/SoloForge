/**
 * index.ts — 翻译器统一入口 + 自动发现注册表
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  自动发现机制 (方案 A · 零配置接入 · 推荐)                          ║
 * ║                                                                  ║
 * ║  Vite 构建时用 import.meta.glob 扫描本目录下所有 *Translator.ts   ║
 * ║  文件, 自动从模块导出中提取满足 Translator 接口的对象并注册。       ║
 * ║                                                                  ║
 * ║  ➤ 新增翻译器只需:                                               ║
 * ║      1. 在本目录新建 myLangTranslator.ts                         ║
 * ║      2. export const myLangTranslator: Translator = {            ║
 * ║           language, displayName, detect, translate               ║
 * ║         }                                                        ║
 * ║      3. 完成 — 自动被发现和注册, 无需修改 index.ts               ║
 * ║                                                                  ║
 * ║  ➤ 命名约定: 文件名必须以 "Translator.ts" 结尾                    ║
 * ║      (htmlTranslator.ts ✓ / myHelpers.ts ✗)                     ║
 * ║      这样能自动排除: index.ts / types.ts / cssExtractor.ts /     ║
 * ║      translatorWorker.ts 等非翻译器文件                          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ────────────────────────────────────────────────────────────────────
 *  补充能力 (不依赖文件命名约定)
 * ────────────────────────────────────────────────────────────────────
 *
 *  运行时动态注册 — 适合插件系统、远程加载、测试 mock 等场景:
 *
 *    import { registerTranslator } from '@/translate';
 *    registerTranslator({
 *      language: 'rust',
 *      displayName: 'Rust egui',
 *      detect: (code) => code.includes('egui::') ? 0.9 : 0,
 *      translate: (code) => parseRustEgui(code),
 *    });
 *
 * ────────────────────────────────────────────────────────────────────
 *  使用方式
 * ────────────────────────────────────────────────────────────────────
 *
 *    import { translateCode } from '@/translate';
 *
 *    // 指定语言 (性能最佳, 跳过 detect 遍历)
 *    const ast = translateCode(htmlString, 'html');
 *
 *    // 自动检测 (遍历所有翻译器的 detect(), 取置信度最高者)
 *    const ast2 = translateCode(codeString);
 *
 *    // 获取详细信息 (含警告/耗时)
 *    const result = translateCodeDetailed(codeString, 'vue');
 *    // result = { node, language, warnings, durationMs }
 *
 * ────────────────────────────────────────────────────────────────────
 *  环境兼容性
 * ────────────────────────────────────────────────────────────────────
 *
 *  - Vite (浏览器/Electron 渲染进程):
 *      import.meta.glob 可用 → 自动发现主路径
 *  - Node.js / tsx (压力测试脚本等):
 *      import.meta.glob 不可用 → 回退到下方显式 import 列表
 *      (显式 import 与 glob 共享模块缓存, Vite 下不会重复加载)
 */

import type { UniversalNode } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator, type TranslateResult } from './types';

// ────────────────────────────────────────────────────────────────────────────
// 显式 import — 仅用于 Node/tsx 环境的 fallback + 向后兼容 re-export
// ────────────────────────────────────────────────────────────────────────────
// Vite 环境下这些 import 与 import.meta.glob 共享模块缓存, 不会重复加载。
// 新增翻译器时: 如果你希望 tsx 脚本(如 stressTest)也能用, 把它加到下方
//              fallbackTranslators 数组即可; Vite 浏览器端会自动发现, 无需改这里。
import { htmlTranslator } from './htmlTranslator';
import { reactTranslator } from './reactTranslator';
import { vueTranslator } from './vueTranslator';
import { flutterTranslator } from './flutterTranslator';
import { swiftuiTranslator } from './swiftuiTranslator';
import { composeTranslator } from './composeTranslator';
import { androidXmlTranslator } from './androidXmlTranslator';
import { xamlTranslator } from './xamlTranslator';
import { qmlTranslator } from './qmlTranslator';
import { pythonTranslator } from './pythonTranslator';
import { cTranslator } from './cTranslator';

// ════════════════════════════════════════════════════════════════════════════
//  翻译器自动发现 (方案 A 核心)
// ════════════════════════════════════════════════════════════════════════════

/**
 * 鸭子类型检查: 一个值是否满足 Translator 接口
 *
 * 用途: 从 glob 扫描到的模块中, 自动找出实现了 Translator 接口的导出。
 * 这样翻译器文件可以导出任意多个辅助函数/类型, 只要有一个导出满足
 * { language, displayName, detect(), translate() } 就会被识别。
 *
 * @param val 模块的某个导出值
 * @returns 是否是合法的 Translator
 */
function isTranslator(val: unknown): val is Translator {
  if (!val || typeof val !== 'object') return false;
  const t = val as Record<string, unknown>;
  return (
    typeof t.language === 'string' &&
    typeof t.displayName === 'string' &&
    typeof t.detect === 'function' &&
    typeof t.translate === 'function'
  );
}

/**
 * 从模块的所有导出中提取 Translator 实例
 *
 * 一个翻译器文件可能导出多个对象 (如 Translator + 辅助函数 + 类型),
 * 此函数遍历所有导出, 收集满足 Translator 接口的对象。
 * 单个文件导出多个 Translator 也会全部被收集。
 *
 * @param mod 模块对象 (import * as mod 的结果)
 * @returns 模块中所有 Translator 实例
 */
function extractTranslators(mod: Record<string, unknown>): Translator[] {
  const found: Translator[] = [];
  for (const val of Object.values(mod)) {
    if (isTranslator(val)) found.push(val);
  }
  return found;
}

/**
 * Vite 自动发现结果
 *
 * import.meta.glob 是 Vite 特有的构建时 API, 在构建阶段静态分析,
 * 把匹配的文件全部 import 进来 (eager: true 表示同步加载)。
 *
 * ⚠️ 注意: import.meta.glob 必须直接调用 (不能赋值给变量再调用),
 *          否则 Vite 无法静态识别, 会在构建时报错或运行时为 undefined。
 *
 * tsx / 纯 Node 环境下 import.meta.glob 不存在, 调用会抛 TypeError,
 * 被 catch 后回退到 fallbackTranslators。
 */
let autoDiscovered: Translator[] = [];
try {
  // 扫描当前目录 (translate/) 下所有 *Translator.ts 文件
  // eager: true → 同步加载, 模块对象直接可用 (非 () => Promise)
  const modules = import.meta.glob('./*Translator.ts', { eager: true }) as
    Record<string, Record<string, unknown>>;
  for (const mod of Object.values(modules)) {
    autoDiscovered.push(...extractTranslators(mod));
  }
} catch {
  // 非 Vite 环境 (tsx/Node) → 使用 fallbackTranslators
}

/**
 * Fallback 翻译器列表 (Node/tsx 环境用)
 *
 * 当 import.meta.glob 不可用时 (如 npx tsx 运行 stressTest),
 * 用这组显式 import 的翻译器作为后备。
 *
 * Vite 环境下此数组不会使用 (autoDiscovered.length > 0 时优先)。
 * 新增翻译器后, 若希望 tsx 脚本也能用, 在此数组追加即可。
 */
const fallbackTranslators: Translator[] = [
  htmlTranslator,
  reactTranslator,
  vueTranslator,
  flutterTranslator,
  swiftuiTranslator,
  composeTranslator,
  androidXmlTranslator,
  xamlTranslator,
  qmlTranslator,
  pythonTranslator,
  cTranslator,
];

// ════════════════════════════════════════════════════════════════════════════
//  注册表
// ════════════════════════════════════════════════════════════════════════════

/**
 * 翻译器注册表 — 按 language 标识 (小写) 去重
 *
 * 注册顺序:
 *   1. 启动时: 自动发现的翻译器 (Vite glob) 或 fallback 显式 import (tsx)
 *   2. 运行时: 通过 registerTranslator() 注册的 (可覆盖同 language 的已有翻译器)
 *
 * 用 Map 而非数组, 保证:
 *   - O(1) 按语言查找
 *   - 同 language 后注册覆盖先注册 (支持热替换/插件升级)
 */
const translatorRegistry = new Map<string, Translator>();

/**
 * 初始化注册表: 把自动发现 / fallback 的翻译器注册进去
 *
 * 优先使用 autoDiscovered (Vite 环境), 为空时用 fallbackTranslators (tsx 环境)。
 * language 标识统一转小写, 保证大小写不敏感查找。
 */
function initRegistry(): void {
  const initial = autoDiscovered.length > 0 ? autoDiscovered : fallbackTranslators;
  for (const t of initial) {
    translatorRegistry.set(t.language.toLowerCase(), t);
  }
}
initRegistry();

/**
 * 运行时注册翻译器 (可覆盖同 language 的已有翻译器)
 *
 * 适用场景:
 *   - 插件系统: 用户从远程加载翻译器并注册
 *   - 动态加载: 按需 import 翻译器, 减少首屏体积
 *   - 测试 mock: 单元测试中替换真实翻译器
 *   - 热更新: 修复 bug 后重注册新版本
 *
 * @example
 *   import { registerTranslator } from '@/translate';
 *
 *   registerTranslator({
 *     language: 'rust',
 *     displayName: 'Rust egui',
 *     detect: (code) => code.includes('egui::') ? 0.9 : 0,
 *     translate: (code) => parseRustEgui(code),
 *   });
 *
 *   // 立即可用
 *   const ast = translateCode(rustCode, 'rust');
 *
 * @param translator 满足 Translator 接口的对象
 * @throws TranslateError 当 translator 不满足接口时
 */
export function registerTranslator(translator: Translator): void {
  if (!isTranslator(translator)) {
    throw new TranslateError(translator?.language || 'unknown', '翻译器不满足 Translator 接口');
  }
  translatorRegistry.set(translator.language.toLowerCase(), translator);
}

/**
 * 注销翻译器
 *
 * @param language 语言标识 (大小写不敏感)
 * @returns 是否成功移除 (false 表示该语言未注册)
 */
export function unregisterTranslator(language: string): boolean {
  return translatorRegistry.delete(language.toLowerCase());
}

/**
 * 获取已注册的翻译器列表 (副本)
 *
 * 按 language 字母排序, 保证遍历顺序的确定性
 * (对自动检测 detectLanguage 的调试输出友好)。
 */
function getTranslators(): Translator[] {
  return Array.from(translatorRegistry.values()).sort((a, b) =>
    a.language.localeCompare(b.language),
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  公共 API
// ════════════════════════════════════════════════════════════════════════════

/**
 * 翻译源代码为 Universal AST (简单版, 只返回节点)
 *
 * @param code 源代码字符串
 * @param language 语言标识 ('html' | 'react' | 'vue' | ...), 省略则自动检测
 * @returns UniversalNode 根节点 (可送入画布渲染)
 * @throws TranslateError 当语言不支持或翻译失败时
 *
 * @example
 *   // 指定语言 (推荐, 跳过 detect 遍历, 性能最佳)
 *   const ast = translateCode('<div>hi</div>', 'html');
 *
 *   // 自动检测 (遍历所有翻译器的 detect(), 取置信度最高者)
 *   const ast2 = translateCode(someCode);
 */
export function translateCode(code: string, language?: string): UniversalNode {
  const translator = resolveTranslator(code, language);
  return translator.translate(code);
}

/**
 * 翻译源代码为 Universal AST (详细版, 含警告/耗时)
 *
 * 与 translateCode 的区别: 返回 TranslateResult 对象, 额外包含:
 *   - language: 实际使用的翻译器语言 (自动检测时有用)
 *   - warnings: 翻译过程中的非致命警告 (如丢失的属性)
 *   - durationMs: 翻译耗时 (毫秒, 用于性能监控)
 *
 * @param code 源代码字符串
 * @param language 语言标识, 省略则自动检测
 * @returns TranslateResult 含 node + language + warnings + durationMs
 */
export function translateCodeDetailed(code: string, language?: string): TranslateResult {
  const translator = resolveTranslator(code, language);
  const warnings: string[] = [];

  const start = Date.now();
  let node: UniversalNode;
  try {
    node = translator.translate(code);
  } catch (err: any) {
    // 已是 TranslateError → 直接抛; 其他错误 → 包装成 TranslateError
    if (err instanceof TranslateError) throw err;
    throw new TranslateError(translator.language, err.message, code);
  }
  const durationMs = Date.now() - start;

  return { node, language: translator.language, warnings, durationMs };
}

/**
 * 获取已注册的所有翻译器语言标识列表
 *
 * @returns 语言标识数组, 如 ['android', 'c', 'compose', 'html', ...]
 */
export function getSupportedLanguages(): string[] {
  return getTranslators().map(t => t.language);
}

/**
 * 获取已注册的所有翻译器信息 (language + displayName)
 *
 * 用于 UI 展示翻译器列表 (如设置页面的语言下拉框)。
 *
 * @returns 翻译器信息数组, 按 language 字母排序
 */
export function getTranslatorInfo(): Array<{ language: string; displayName: string }> {
  return getTranslators().map(t => ({ language: t.language, displayName: t.displayName }));
}

/**
 * 检查某语言是否已注册
 *
 * @param language 语言标识 (大小写不敏感, 'HTML' 和 'html' 等价)
 * @returns 是否已注册
 */
export function isLanguageSupported(language: string): boolean {
  return translatorRegistry.has(language.toLowerCase());
}

/**
 * 自动检测代码语言
 *
 * 遍历所有已注册翻译器的 detect(), 返回置信度最高的那个。
 * 置信度低于 0.3 时不认为匹配, 返回 null。
 *
 * 各翻译器 detect() 的置信度约定:
 *   - 0.9  强特征匹配 (如 #include + 函数调用同时存在)
 *   - 0.7  中等特征 (仅有函数调用, 无 include)
 *   - 0.3  弱特征 (仅语法特征, 可能误判)
 *   - 0    不匹配
 *
 * @param code 源代码字符串
 * @returns 匹配的翻译器, 或 null (无匹配)
 */
export function detectLanguage(code: string): Translator | null {
  let best: Translator | null = null;
  let bestScore = 0;

  for (const t of getTranslators()) {
    const score = t.detect(code);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }

  // 置信度低于 0.3 不认为匹配 (避免弱特征误判)
  return bestScore >= 0.3 ? best : null;
}

// ════════════════════════════════════════════════════════════════════════════
//  内部工具
// ════════════════════════════════════════════════════════════════════════════

/**
 * 解析翻译器: 指定语言 → 查 registry; 未指定 → 自动检测
 *
 * 这是 translateCode / translateCodeDetailed 的共用前置步骤,
 * 把"选哪个翻译器"的逻辑集中在一处。
 *
 * @param code 源代码 (自动检测时传给 detect())
 * @param language 语言标识, 省略则自动检测
 * @throws TranslateError 当语言不支持或无法自动识别时
 */
function resolveTranslator(code: string, language?: string): Translator {
  if (language) {
    const t = translatorRegistry.get(language.toLowerCase());
    if (!t) {
      throw new TranslateError(
        language,
        `不支持的语言: ${language}. 已注册: ${getSupportedLanguages().join(', ')}`,
      );
    }
    return t;
  }

  // 自动检测
  const detected = detectLanguage(code);
  if (!detected) {
    throw new TranslateError(
      'auto',
      `无法识别代码语言. 已注册: ${getSupportedLanguages().join(', ')}`,
    );
  }
  return detected;
}

// ════════════════════════════════════════════════════════════════════════════
//  显式 re-export (向后兼容)
// ════════════════════════════════════════════════════════════════════════════
//
// 以下 re-export 保持向后兼容 — 外部代码如果直接 import 具体翻译器
// (如 `import { htmlTranslator } from '@/translate'`) 仍可工作。
//
// 自动发现机制不依赖这些 re-export, 删除它们不影响翻译功能。
// 保留它们是为了让历史代码平滑迁移到新的 registerTranslator() API。

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
export { pythonTranslator } from './pythonTranslator';
export { cTranslator } from './cTranslator';
export { parseCss, extractStyleBlocks, applyCssRules, enrichWithCss } from './cssExtractor';
export type { CssRule } from './cssExtractor';

// CPU 加速 worker 池 — 批量翻译 + 长代码翻译自动并行
export {
  translateCodeAsync,
  translateBatch,
  translateBatchParallel,
  getTranslatorPoolStatus,
  setTranslatorMode,
} from './translatorWorker';
export type { TranslateTask, TranslateTaskResult, TranslatorPoolStatus } from './translatorWorker';
