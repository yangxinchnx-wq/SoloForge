/**
 * logger.ts — 统一前端日志通道
 *
 * 封装 debug/info/warn/error 四级日志：
 *   - debug 仅在 import.meta.env.DEV 下输出
 *   - 所有级别都带时间戳和模块名标签
 *
 * 用法：
 *   import { logger } from '../services/logger';
 *   logger.debug('ChatStore', 'handleSend called', { inputValue });
 *   logger.error('aiBackend', 'SSE parse failed', err);
 */

function timestamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
}

export const logger = {
  debug: (module: string, ...args: unknown[]) => {
    if (import.meta.env.DEV) console.debug(`[${timestamp()}][${module}]`, ...args);
  },
  info: (module: string, ...args: unknown[]) => {
    console.info(`[${timestamp()}][${module}]`, ...args);
  },
  warn: (module: string, ...args: unknown[]) => {
    console.warn(`[${timestamp()}][${module}]`, ...args);
  },
  error: (module: string, ...args: unknown[]) => {
    console.error(`[${timestamp()}][${module}]`, ...args);
  },
};
