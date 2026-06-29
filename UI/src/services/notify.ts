/**
 * 统一通知服务
 *
 * 复用 App.tsx 的 `soloforge-toast` 全局事件机制,
 * 把 success / error / warn / info 四种类型用统一 API 暴露。
 *
 * 用法:
 *   import { notify } from '../services/notify';
 *   notify.success('已保存');
 *   notify.error('保存失败: ' + err.message);
 *   notify.warn('Garnet 连接断开');
 *   notify.info('正在生成...');
 *
 * 不依赖任何第三方库。
 */

export type NotifyLevel = 'success' | 'error' | 'warn' | 'info';

export interface NotifyOptions {
  level?: NotifyLevel;
  /** 自动消失时间 (ms), 默认 5000 */
  duration?: number;
  /** 不自动消失, 需用户手动关闭 */
  sticky?: boolean;
}

const DEFAULT_DURATION = 5000;

/**
 * 发送一条通知
 */
export function notify(message: string, options: NotifyOptions = {}): void {
  if (typeof window === 'undefined') return;
  const detail = {
    message,
    level: options.level ?? 'info',
    duration: options.sticky ? 0 : (options.duration ?? DEFAULT_DURATION),
    sticky: options.sticky ?? false,
  };
  window.dispatchEvent(new CustomEvent('soloforge-toast', { detail }));
}

/**
 * 成功通知 (绿色调, 短停留)
 */
notify.success = (message: string, duration?: number): void => {
  notify(message, { level: 'success', duration: duration ?? 3000 });
};

/**
 * 错误通知 (红色调, 长停留)
 */
notify.error = (message: string, sticky = false): void => {
  notify(message, { level: 'error', duration: sticky ? 0 : 8000, sticky });
};

/**
 * 警告通知 (橙色调)
 */
notify.warn = (message: string, duration?: number): void => {
  notify(message, { level: 'warn', duration: duration ?? 5000 });
};

/**
 * 普通信息 (默认色)
 */
notify.info = (message: string, duration?: number): void => {
  notify(message, { level: 'info', duration: duration ?? 5000 });
};

/**
 * 异步操作错误处理帮手:
 * - 在 catch 里调用, 自动从 Error 提取消息
 * - 不会丢失原始堆栈 (在 console 输出)
 *
 * 用法:
 *   try {
 *     await canvas.pushUI(...);
 *   } catch (e) {
 *     notify.fromError(e, '推送 UI 失败');
 *   }
 */
notify.fromError = (e: unknown, prefix = '操作失败'): void => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[notify] ${prefix}:`, e);
  notify.error(`${prefix}: ${msg}`);
};
