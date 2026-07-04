/**
 * usePendingConfirmBadge — StatusBar 用的"待确认红点"hook
 *
 * 行为:
 *   - 订阅 confirmQueueStore (pending 数)
 *   - window 派发 soloforge-pending-confirms 事件 (跨组件通知)
 *   - 暴露 focusConfirmDock() —— 触发 soloforge-confirm-focus CustomEvent
 *     (由 ConfirmationDock 监听, 收到时滚动到视口 + 高亮)
 *
 * 用法:
 *   const { count, focusConfirmDock } = usePendingConfirmBadge();
 *   if (count > 0) <span className="badge">{count}</span>
 */
import { useEffect, useState, useCallback } from 'react';
import { useConfirmQueueStore } from '../store/confirmQueueStore';

const EVT_PENDING = 'soloforge-pending-confirms';
const EVT_FOCUS = 'soloforge-confirm-focus';

export interface PendingConfirmBadgeApi {
  count: number;
  focusConfirmDock: () => void;
}

export function usePendingConfirmBadge(): PendingConfirmBadgeApi {
  const queue = useConfirmQueueStore((s) => s.queue);
  const count = queue.filter((q) => q.resolution === 'pending').length;
  const [, setRenderTick] = useState(0);

  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent(EVT_PENDING, { detail: { count } }));
    } catch {
      /* ignore */
    }
  }, [count]);

  useEffect(() => {
    const id = setInterval(() => setRenderTick((t) => (t + 1) % 1e9), 1000);
    return () => clearInterval(id);
  }, []);

  const focusConfirmDock = useCallback(() => {
    try {
      window.dispatchEvent(new CustomEvent(EVT_FOCUS, { detail: { count, at: Date.now() } }));
    } catch {
      /* ignore */
    }
  }, [count]);

  return { count, focusConfirmDock };
}
