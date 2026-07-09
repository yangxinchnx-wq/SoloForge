/**
 * translatorWorker.ts — 翻译器 worker_threads 池 (CPU 加速)
 *
 * 目标:
 *   - 翻译本身是纯 CPU 任务 (tokenize + 递归下降 parse)
 *   - 单文件翻译在主线程跑就行 (< 5ms)
 *   - 但批量翻译多个代码块 / 大文件 (10K+ 行) 时, 主线程会卡顿
 *   - 用 worker_threads 把翻译丢到独立线程, 充分利用多核 CPU
 *
 * 设计:
 *   - 自动判断环境: 浏览器 → Web Worker; Node → worker_threads; SSR/test → in-thread
 *   - worker 池大小 = min(CPU 核心数, 4) (避免线程切换开销)
 *   - 单任务直接 in-thread (起 worker 的成本 > 翻译本身)
 *   - 批量任务 (>3 个代码块) 才分发到 worker 池
 *   - worker 失败自动降级到 in-thread
 *
 * API:
 *   import { translateCode, translateBatch, translateBatchParallel } from './index';
 *
 *   // 单个翻译 (自动选 in-thread 或 worker, 取决于代码长度)
 *   const ast = await translateCodeAsync(code, 'python');
 *
 *   // 批量并行翻译 (worker 池)
 *   const results = await translateBatchParallel([
 *     { code: code1, language: 'python' },
 *     { code: code2, language: 'c' },
 *     { code: code3 },  // 自动检测
 *   ]);
 *
 * 性能预期 (8 核 CPU):
 *   - 单文件 100 行 Python: in-thread ~1ms, worker ~3ms (起线程开销) → 用 in-thread
 *   - 10 个文件各 1000 行: in-thread ~80ms, 4-worker 池 ~25ms → 用 worker
 *   - 单文件 50K 行: in-thread ~400ms (卡主线程), worker ~400ms (不卡) → 用 worker
 */

import type { UniversalNode } from '../services/canvas/UniversalAST';
import { TranslateError, type Translator } from './types';
import { translateCode, detectLanguage, getSupportedLanguages } from './index';

// ──────────────────────────── 环境检测 ────────────────────────────

const isNode = typeof process !== 'undefined' && process.versions?.node;
const isBrowser = typeof Worker !== 'undefined' && typeof window !== 'undefined';

// Node 内置模块的 ESM 动态 import 缓存 (避免每次调用都 import)
let _nodeOs: any = null;
let _nodeWorker: any = null;
let _nodeImportPromise: Promise<void> | null = null;

/** 异步预加载 Node 内置模块 (在第一次用 worker 前调用) */
async function ensureNodeModules(): Promise<void> {
  if (_nodeImportPromise) return _nodeImportPromise;
  _nodeImportPromise = (async () => {
    if (!isNode) return;
    try {
      _nodeOs = await import('node:os');
      _nodeWorker = await import('node:worker_threads');
    } catch {
      // 降级: 模块不可用
    }
  })();
  return _nodeImportPromise;
}

/** CPU 核心数 (用于决定 worker 池大小) */
function cpuCount(): number {
  if (isNode) {
    // Node.js — 优先用已缓存的 os 模块, 否则用环境变量兜底
    if (_nodeOs?.cpus) return _nodeOs.cpus()?.length || 4;
    // UV_THREADPOOL_SIZE 默认 4
    const tp = process.env?.UV_THREADPOOL_SIZE;
    if (tp) return parseInt(tp, 10) || 4;
    return 4;
  }
  if (isBrowser && (navigator as any).hardwareConcurrency) {
    return (navigator as any).hardwareConcurrency;
  }
  return 4;
}

/** 代码长度阈值: 超过此长度才考虑用 worker */
const WORKER_CODE_LENGTH_THRESHOLD = 5000;

/** 批量任务阈值: 超过此数量才分发到 worker 池 */
const WORKER_BATCH_THRESHOLD = 3;

// ──────────────────────────── 任务类型 ────────────────────────────

export interface TranslateTask {
  /** 源代码 */
  code: string;
  /** 语言标识 (省略则自动检测) */
  language?: string;
  /** 任务 ID (调用方指定, 用于结果匹配) */
  id?: string | number;
}

export interface TranslateTaskResult {
  id?: string | number;
  /** 翻译出的 AST (失败时为 null) */
  node: UniversalNode | null;
  /** 使用的语言 */
  language: string;
  /** 错误信息 (失败时) */
  error?: string;
  /** 耗时 (ms) */
  durationMs: number;
}

// ──────────────────────────── Node worker_threads 池 ────────────────────────────

/**
 * Node worker_threads 实现
 *
 * worker 脚本是内联的 (new Worker 传代码字符串), 避免 ESM/CJS 文件路径问题。
 * worker 内部通过 require/import 加载翻译器模块。
 */

interface NodeWorkerPool {
  workers: any[];
  queue: Array<{ task: TranslateTask; resolve: (r: TranslateTaskResult) => void; reject: (e: Error) => void }>;
  busy: Set<any>;
  workerCode: string;
  initialized: boolean;
}

let nodePool: NodeWorkerPool | null = null;

/** worker 内联脚本 — 接收 task, 翻译后 postMessage 返回 */
function buildWorkerCode(): string {
  // 注意: worker 内是独立 V8 isolate, 不能闭包外部变量
  // 用 require 动态加载翻译器
  return `
const { parentPort } = require('worker_threads');
const path = require('path');

// 缓存翻译器模块 (避免每次任务重新 require)
let translateCodeFn = null;
let detectLanguageFn = null;
let getSupportedLanguagesFn = null;
let initError = null;

async function ensureTranslators() {
  if (translateCodeFn) return;
  try {
    // 尝试 ESM 动态 import (Vite build 后)
    const mod = await import(path.resolve(__dirname, './index.js'));
    translateCodeFn = mod.translateCode;
    detectLanguageFn = mod.detectLanguage;
    getSupportedLanguagesFn = mod.getSupportedLanguages;
  } catch (e1) {
    try {
      // 回退到 tsx 运行时 (开发环境)
      const mod = require(path.resolve(__dirname, './index.ts'));
      translateCodeFn = mod.translateCode;
      detectLanguageFn = mod.detectLanguage;
      getSupportedLanguagesFn = mod.getSupportedLanguages;
    } catch (e2) {
      initError = e2.message || String(e2);
    }
  }
}

parentPort.on('message', async (task) => {
  await ensureTranslators();

  const start = Date.now();
  const result = { id: task.id, node: null, language: '', error: undefined, durationMs: 0 };

  if (initError) {
    result.error = 'translator init failed: ' + initError;
    result.durationMs = Date.now() - start;
    parentPort.postMessage(result);
    return;
  }

  try {
    // 自动检测语言 (如果没指定)
    let lang = task.language;
    if (!lang) {
      const t = detectLanguageFn(task.code);
      lang = t ? t.language : 'unknown';
    }
    result.language = lang;
    result.node = translateCodeFn(task.code, lang);
  } catch (err) {
    result.error = err.message || String(err);
    result.language = task.language || 'auto';
  }

  result.durationMs = Date.now() - start;
  parentPort.postMessage(result);
});
`;
}

function initNodeWorkerPool(): NodeWorkerPool | null {
  if (!isNode) return null;
  if (nodePool) return nodePool;

  // 模块还没加载完 → 返回 null, 调用方会降级到 in-thread
  // 真正的初始化在 ensureNodeModules() 之后
  if (!_nodeWorker) {
    // 触发异步加载 (不等待, 下次调用就能用)
    ensureNodeModules();
    return null;
  }

  try {
    const pool: NodeWorkerPool = {
      workers: [],
      queue: [],
      busy: new Set(),
      workerCode: buildWorkerCode(),
      initialized: false,
    };

    nodePool = pool;
    return pool;
  } catch (err) {
    return null;
  }
}

/** 从池里拿一个空闲 worker, 没有则新建 */
function getIdleWorker(pool: NodeWorkerPool): any | null {
  if (!_nodeWorker?.Worker) return null;
  const { Worker } = _nodeWorker;

  // 找空闲的
  for (const w of pool.workers) {
    if (!pool.busy.has(w)) return w;
  }

  // 没空闲 + 没超上限 → 新建
  if (pool.workers.length < Math.min(cpuCount(), 4)) {
    try {
      const worker = new Worker(pool.workerCode, { eval: true });
      pool.workers.push(worker);
      return worker;
    } catch (err) {
      return null;
    }
  }

  return null; // 池满, 等待
}

/** 分发任务到 worker, 返回 Promise */
function dispatchToWorker(pool: NodeWorkerPool, task: TranslateTask): Promise<TranslateTaskResult> {
  return new Promise((resolve, reject) => {
    const tryAssign = () => {
      const worker = getIdleWorker(pool);
      if (worker) {
        pool.busy.add(worker);

        const onMessage = (msg: TranslateTaskResult) => {
          worker.off('message', onMessage);
          worker.off('error', onError);
          pool.busy.delete(worker);
          // worker 内翻译器初始化失败 → 降级到 in-thread
          if (msg.error && msg.error.includes('translator init failed')) {
            resolve(translateInThread(task));
          } else {
            resolve(msg);
          }

          // 处理队列里的下一个
          if (pool.queue.length > 0) {
            const next = pool.queue.shift()!;
            dispatchToWorker(pool, next.task).then(next.resolve).catch(next.reject);
          }
        };
        const onError = (err: Error) => {
          worker.off('message', onMessage);
          worker.off('error', onError);
          pool.busy.delete(worker);
          // worker 出错 → 降级到 in-thread (不 reject, 避免整批失败)
          resolve(translateInThread(task));
        };

        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.postMessage(task);
      } else {
        // 池满, 入队等待
        pool.queue.push({ task, resolve, reject });
      }
    };

    tryAssign();
  });
}

// ──────────────────────────── 浏览器 Web Worker 池 ────────────────────────────

interface BrowserWorkerPool {
  workers: Worker[];
  queue: Array<{ task: TranslateTask; resolve: (r: TranslateTaskResult) => void; reject: (e: Error) => void }>;
  busy: Set<Worker>;
  workerUrl: string | null;
}

let browserPool: BrowserWorkerPool | null = null;

function initBrowserWorkerPool(): BrowserWorkerPool | null {
  if (!isBrowser) return null;
  if (browserPool) return browserPool;

  try {
    // 浏览器 worker 需要单独的 .worker.ts 文件
    // 这里用 import.meta.url 构造 URL, 让 bundler 处理
    const url = new URL('./translatorWorker.entry.ts', import.meta.url);
    const pool: BrowserWorkerPool = {
      workers: [],
      queue: [],
      busy: new Set(),
      workerUrl: url.href,
    };
    browserPool = pool;
    return pool;
  } catch (err) {
    return null;
  }
}

function getIdleBrowserWorker(pool: BrowserWorkerPool): Worker | null {
  for (const w of pool.workers) {
    if (!pool.busy.has(w)) return w;
  }
  if (pool.workers.length < Math.min(cpuCount(), 4)) {
    try {
      const worker = new Worker(pool.workerUrl!, { type: 'module' });
      pool.workers.push(worker);
      return worker;
    } catch (err) {
      return null;
    }
  }
  return null;
}

function dispatchToBrowserWorker(pool: BrowserWorkerPool, task: TranslateTask): Promise<TranslateTaskResult> {
  return new Promise((resolve, reject) => {
    const tryAssign = () => {
      const worker = getIdleBrowserWorker(pool);
      if (worker) {
        pool.busy.add(worker);
        const onMessage = (ev: MessageEvent) => {
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          pool.busy.delete(worker);
          const msg = ev.data as TranslateTaskResult;
          // worker 内翻译器初始化失败 → 降级到 in-thread
          if (msg.error && msg.error.includes('translator init failed')) {
            resolve(translateInThread(task));
          } else {
            resolve(msg);
          }
          if (pool.queue.length > 0) {
            const next = pool.queue.shift()!;
            dispatchToBrowserWorker(pool, next.task).then(next.resolve).catch(next.reject);
          }
        };
        const onError = (ev: ErrorEvent) => {
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          pool.busy.delete(worker);
          resolve(translateInThread(task));
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.postMessage(task);
      } else {
        pool.queue.push({ task, resolve, reject });
      }
    };
    tryAssign();
  });
}

// ──────────────────────────── in-thread fallback ────────────────────────────

function translateInThread(task: TranslateTask): TranslateTaskResult {
  const start = Date.now();
  const result: TranslateTaskResult = {
    id: task.id,
    node: null,
    language: '',
    durationMs: 0,
  };

  try {
    let lang = task.language;
    if (!lang) {
      const t = detectLanguage(task.code);
      lang = t ? t.language : 'unknown';
    }
    result.language = lang;
    result.node = translateCode(task.code, lang);
  } catch (err: any) {
    result.error = err.message || String(err);
    result.language = task.language || 'auto';
  }

  result.durationMs = Date.now() - start;
  return result;
}

// ──────────────────────────── 公共 API ────────────────────────────

/**
 * 单个翻译 (异步, 自动选 in-thread 或 worker)
 *
 * - 代码 < 5K 字符 → in-thread (起 worker 的成本 > 翻译本身)
 * - 代码 >= 5K 字符 → worker (避免卡主线程)
 * - worker 不可用 → in-thread
 *
 * @param code 源代码
 * @param language 语言标识 (省略则自动检测)
 * @returns 翻译结果 (含 AST + 耗时)
 */
export async function translateCodeAsync(
  code: string,
  language?: string,
): Promise<TranslateTaskResult> {
  const task: TranslateTask = { code, language };

  // 短代码 → in-thread
  if (code.length < WORKER_CODE_LENGTH_THRESHOLD) {
    return translateInThread(task);
  }

  // 长代码 → 尝试 worker
  if (isNode) {
    // 确保内置模块已加载 (ESM 动态 import)
    await ensureNodeModules();
    const pool = initNodeWorkerPool();
    if (pool) {
      try {
        return await dispatchToWorker(pool, task);
      } catch (err) {
        // worker 失败 → 降级
        return translateInThread(task);
      }
    }
  }

  if (isBrowser) {
    const pool = initBrowserWorkerPool();
    if (pool) {
      try {
        return await dispatchToBrowserWorker(pool, task);
      } catch (err) {
        return translateInThread(task);
      }
    }
  }

  return translateInThread(task);
}

/**
 * 批量并行翻译 (worker 池加速)
 *
 * - 任务数 <= 3 → 全部 in-thread (顺序执行)
 * - 任务数 > 3 → 分发到 worker 池并行执行
 * - 结果顺序与输入顺序一致
 *
 * @param tasks 翻译任务数组
 * @returns 翻译结果数组 (顺序与输入一致)
 */
export async function translateBatchParallel(
  tasks: TranslateTask[],
): Promise<TranslateTaskResult[]> {
  // 小批量 → 顺序 in-thread
  if (tasks.length <= WORKER_BATCH_THRESHOLD) {
    return tasks.map(translateInThread);
  }

  // 大批量 → 尝试 worker 池
  if (isNode) {
    await ensureNodeModules();
    const pool = initNodeWorkerPool();
    if (pool) {
      try {
        const promises = tasks.map(task => dispatchToWorker(pool, task));
        const results = await Promise.all(promises);
        return results;
      } catch (err) {
        // worker 池失败 → 降级到顺序 in-thread
        return tasks.map(translateInThread);
      }
    }
  }

  if (isBrowser) {
    const pool = initBrowserWorkerPool();
    if (pool) {
      try {
        const promises = tasks.map(task => dispatchToBrowserWorker(pool, task));
        return await Promise.all(promises);
      } catch (err) {
        return tasks.map(translateInThread);
      }
    }
  }

  // 兜底: 顺序 in-thread
  return tasks.map(translateInThread);
}

/**
 * 批量翻译 (简单 API, 不暴露 worker 细节)
 *
 * 内部调用 translateBatchParallel, 自动决定是否并行。
 */
export async function translateBatch(
  tasks: TranslateTask[],
): Promise<TranslateTaskResult[]> {
  return translateBatchParallel(tasks);
}

// ──────────────────────────── 状态查询 ────────────────────────────

export interface TranslatorPoolStatus {
  /** 当前环境 */
  env: 'node' | 'browser' | 'unknown';
  /** 是否启用了 worker 加速 */
  workerEnabled: boolean;
  /** worker 池大小 */
  poolSize: number;
  /** CPU 核心数 */
  cpuCount: number;
  /** 阈值: 代码长度超过此值才用 worker */
  codeLengthThreshold: number;
  /** 阈值: 批量任务数超过此值才并行 */
  batchThreshold: number;
}

/** 查询翻译池状态 (用于调试 / 性能监控) */
export function getTranslatorPoolStatus(): TranslatorPoolStatus {
  const env = isNode ? 'node' : isBrowser ? 'browser' : 'unknown';
  const pool = nodePool || browserPool;
  return {
    env,
    workerEnabled: pool !== null,
    poolSize: pool?.workers.length || 0,
    cpuCount: cpuCount(),
    codeLengthThreshold: WORKER_CODE_LENGTH_THRESHOLD,
    batchThreshold: WORKER_BATCH_THRESHOLD,
  };
}

/**
 * 强制设置 worker 模式 (调试用)
 *   - 'auto' (默认): 自动判断
 *   - 'thread': 强制 in-thread, 不用 worker
 *   - 'worker': 强制 worker (失败会抛错)
 */
let forcedMode: 'auto' | 'thread' | 'worker' = 'auto';

export function setTranslatorMode(mode: 'auto' | 'thread' | 'worker'): void {
  forcedMode = mode;
}

/** 内部: 根据强制模式判断是否应该用 worker */
function shouldUseWorker(): boolean {
  if (forcedMode === 'thread') return false;
  if (forcedMode === 'worker') return true;
  // auto
  return isNode || isBrowser;
}
