/**
 * useRttInput — s1.8: RTT 屏内输入事件 React hook (hook 预留)
 *
 * 用途: 在 Model3DOverlay 或更高层组件订阅屏内输入事件
 *   - 每 N 毫秒拉一次 main 端队列 (drain)
 *   - 把事件分发给 onTap / onPan / onLongPress 回调
 *
 * s1.8 阶段: hook 框架 + 轮询机制完成, 真实使用在 s3.2 接入
 *  - 现在没有 three_d 命中测试 → main 端队列始终为空
 *  - 接入后会通过 Canvas3DClient.drainRttInputs() 拿到事件
 *
 * 设计原则:
 *  - 不在 hook 内部管理 Canvas3DClient (由调用方传入, 跟其他 client 一致)
 *  - 默认轮询间隔 100ms (10 FPS), s3.2 接入后可调到 16ms (60 FPS)
 *  - 提供 enabled 开关, 切设备/卸载时关闭
 *  - 提供 latestEvent ref, 业务方可以读最新事件而不用维护 state (避免高频 re-render)
 *
 * 2026-06-24 性能优化:
 *  - 队列连续空 N 次后自动暂停轮询,降低持续 fetch 负担
 *  - drainNow 改为返回事件数,业务方需要时可手动唤醒轮询
 */

import { useEffect, useRef, useCallback } from 'react';
import type { Canvas3DClient, RttInputEventRecord, RttInputType } from '../services/canvas/Canvas3DClient';

export interface UseRttInputOptions {
  /** 客户端实例, 跟 PreviewPanel 共享 */
  client: Canvas3DClient | null;
  /** 过滤: 只处理该 session 的事件 */
  sessionId?: string;
  /** 过滤: 只处理该 device 的事件 */
  deviceId?: string;
  /** 轮询间隔 ms, 默认 100 (10 FPS) */
  pollIntervalMs?: number;
  /** 是否启用, 默认 true */
  enabled?: boolean;
  /** 连续空轮询多少次后自动暂停, 默认 30 (≈ 3s @ 100ms 间隔) */
  emptyThreshold?: number;
  /** 事件分发回调 */
  onInput?: (event: RttInputEventRecord) => void;
  /** 按 type 单独分发 (可选) */
  onTap?: (event: RttInputEventRecord) => void;
  onDoubleTap?: (event: RttInputEventRecord) => void;
  onLongPress?: (event: RttInputEventRecord) => void;
  onPanStart?: (event: RttInputEventRecord) => void;
  onPanMove?: (event: RttInputEventRecord) => void;
  onPanEnd?: (event: RttInputEventRecord) => void;
}

export interface UseRttInputResult {
  /** 手动触发一次拉取, 并自动唤醒暂停的轮询; 返回本次拉到的事件数 */
  drainNow: () => Promise<number>;
  /** 最新一帧的事件, 用于业务方读 ref */
  latestEvent: React.MutableRefObject<RttInputEventRecord | null>;
  /** 当前是否在轮询 */
  isPolling: React.MutableRefObject<boolean>;
}

/**
 * 订阅 RTT 屏内输入事件
 *
 * @example
 *   const { latestEvent, drainNow } = useRttInput({
 *     client: canvasClient,
 *     sessionId: currentSession,
 *     pollIntervalMs: 100,
 *     onTap: (e) => console.log('tap at', e.u, e.v),
 *   });
 */
export function useRttInput(options: UseRttInputOptions): UseRttInputResult {
  const {
    client,
    sessionId,
    deviceId,
    pollIntervalMs = 100,
    enabled = true,
    emptyThreshold = 30,
    onInput,
    onTap,
    onDoubleTap,
    onLongPress,
    onPanStart,
    onPanMove,
    onPanEnd,
  } = options;

  const latestEvent = useRef<RttInputEventRecord | null>(null);
  const isPolling = useRef<boolean>(false);
  // 用 ref 存回调, 避免轮询 setup 因回调变化而重启
  const callbacksRef = useRef({
    onInput, onTap, onDoubleTap, onLongPress,
    onPanStart, onPanMove, onPanEnd,
  });
  callbacksRef.current = {
    onInput, onTap, onDoubleTap, onLongPress,
    onPanStart, onPanMove, onPanEnd,
  };

  // 轮询控制 refs (不进入依赖,避免重置 interval)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const emptyStreakRef = useRef(0);
  // 配置 refs — 让 startPolling 能读到最新值,不重启 effect
  const configRef = useRef({ client, sessionId, deviceId, pollIntervalMs, enabled, emptyThreshold });
  configRef.current = { client, sessionId, deviceId, pollIntervalMs, enabled, emptyThreshold };

  const dispatch = useCallback((event: RttInputEventRecord) => {
    latestEvent.current = event;
    callbacksRef.current.onInput?.(event);
    switch (event.type as RttInputType) {
      case 'tap':         callbacksRef.current.onTap?.(event); break;
      case 'doubleTap':   callbacksRef.current.onDoubleTap?.(event); break;
      case 'longPress':   callbacksRef.current.onLongPress?.(event); break;
      case 'panStart':    callbacksRef.current.onPanStart?.(event); break;
      case 'panMove':     callbacksRef.current.onPanMove?.(event); break;
      case 'panEnd':      callbacksRef.current.onPanEnd?.(event); break;
    }
  }, []);

  // 内部:单次拉取(无轮询控制)
  const fetchOnce = useCallback(async (): Promise<number> => {
    const cfg = configRef.current;
    if (!cfg.client || !cfg.enabled) return 0;
    try {
      const filter: { sessionId?: string; deviceId?: string } = {};
      if (cfg.sessionId) filter.sessionId = cfg.sessionId;
      if (cfg.deviceId) filter.deviceId = cfg.deviceId;
      const result = await cfg.client.drainRttInputs(filter);
      if (result.ok && result.events.length > 0) {
        for (const ev of result.events) dispatch(ev);
        return result.events.length;
      }
      return 0;
    } catch (_) {
      return 0;
    }
  }, [dispatch]);

  // 启动轮询 (内部用,不会因为 client/enabled 变化重启 — 用 configRef)
  const startPolling = useCallback(() => {
    if (intervalRef.current) return; // 已在跑
    const cfg = configRef.current;
    if (!cfg.client || !cfg.enabled) return;
    isPolling.current = true;
    emptyStreakRef.current = 0;
    intervalRef.current = setInterval(async () => {
      const count = await fetchOnce();
      if (count > 0) {
        emptyStreakRef.current = 0;
      } else {
        emptyStreakRef.current += 1;
        if (emptyStreakRef.current >= cfg.emptyThreshold && intervalRef.current) {
          // 队列连续空,暂停轮询
          clearInterval(intervalRef.current);
          intervalRef.current = null;
          isPolling.current = false;
        }
      }
    }, cfg.pollIntervalMs);
  }, [fetchOnce]);

  // 手动 drain + 自动唤醒
  const drainNow = useCallback(async (): Promise<number> => {
    const count = await fetchOnce();
    if (count > 0) {
      // 有事件 → 重置 streak 并唤醒轮询
      emptyStreakRef.current = 0;
      startPolling();
    } else {
      // 没事件,但 drainNow 是主动调用 → 也算"业务方想看",唤醒
      startPolling();
    }
    return count;
  }, [fetchOnce, startPolling]);

  // 主 effect:挂载/卸载时管理轮询生命周期
  useEffect(() => {
    if (!client || !enabled) return;
    startPolling();
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      isPolling.current = false;
      emptyStreakRef.current = 0;
    };
    // 只在 client 引用变化或 enabled 翻转时重启
  }, [client, enabled, startPolling]);

  return {
    drainNow,
    latestEvent,
    isPolling,
  };
}
