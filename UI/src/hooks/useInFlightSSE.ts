/**
 * useInFlightSSE — 统一管理 in-flight SSE 请求的 AbortController
 *
 * 拆成两层:
 *   - AbortManager: 纯逻辑 (无 React 依赖), 单元测试
 *   - useInFlightSSE: React hook 薄壳, 把 useEffect 桥接到 AbortManager
 *
 * 用法:
 *   const { run, cancel } = useInFlightSSE(activeChatId);
 *   await run(async (signal) => {
 *     const res = await fetch('/api/...', { signal });
 *     ...
 *   });
 */
import { useEffect, useRef, useCallback } from 'react';

/**
 * AbortManager — 单 chatId 的 in-flight AbortController 容器
 * 纯逻辑, 单元测试友好
 */
export class AbortManager {
  private current: AbortController | null = null;

  /** 当前是否有 in-flight (且未 abort) */
  hasInFlight(): boolean {
    return this.current !== null && !this.current.signal.aborted;
  }

  /** 取当前 signal (若无, 返回 undefined) */
  getSignal(): AbortSignal | undefined {
    return this.current?.signal;
  }

  /** 取消当前 (若有) */
  cancel(): void {
    this.current?.abort();
    this.current = null;
  }

  /**
   * 启动一个新任务。如果已有 in-flight, 先取消旧的。
   * @param fn 业务函数, 接收新创建的 AbortSignal
   * @returns fn 的返回值
   */
  async run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    this.cancel();
    const ctrl = new AbortController();
    this.current = ctrl;
    try {
      return await fn(ctrl.signal);
    } catch (err) {
      // AbortError: 用户主动取消, 静默吞掉
      if (err instanceof Error && err.name === 'AbortError') {
        return undefined;
      }
      throw err;
    } finally {
      // 只有当前 controller 仍是 ref 指向的那个时才清 (避免误清新 controller)
      if (this.current === ctrl) {
        this.current = null;
      }
    }
  }
}

export interface InFlightSSEApi {
  run: <T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>;
  cancel: () => void;
  hasInFlight: () => boolean;
}

/**
 * useInFlightSSE — React hook 包装
 * 行为: chatId 变化或组件卸载时, 自动 cancel 当前 in-flight
 */
export function useInFlightSSE(chatId: string): InFlightSSEApi {
  const managerRef = useRef<AbortManager>(new AbortManager());

  // 切换 chatId 时取消
  useEffect(() => {
    managerRef.current.cancel();
  }, [chatId]);

  // 卸载时取消
  useEffect(() => {
    return () => {
      managerRef.current.cancel();
    };
  }, []);

  const cancel = useCallback(() => managerRef.current.cancel(), []);
  const hasInFlight = useCallback(() => managerRef.current.hasInFlight(), []);
  const run = useCallback(
    <T,>(fn: (signal: AbortSignal) => Promise<T>) => managerRef.current.run(fn),
    [],
  );

  return { run, cancel, hasInFlight };
}
