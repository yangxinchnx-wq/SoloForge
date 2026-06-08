// ─────────────────────────────────────────────────────────────────
// URL 路由化 overlay (P1-13)
// - 打开 overlay → 写 ?overlay=<id>
// - 浏览器前进/后退 → 自动开关
// - 刷新页面 → 状态恢复
// - 关闭 overlay → 清除 query string
// ─────────────────────────────────────────────────────────────────

import { useEffect, useCallback } from 'react';

const PARAM = 'overlay';

export function useOverlayUrl(overlayId: string, open: boolean, onOpenChange: (open: boolean) => void) {
  // 初始化:从 URL 读
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const current = params.get(PARAM);
    if (current === overlayId && !open) {
      onOpenChange(true);
    } else if (current && current !== overlayId && open) {
      // 其他 overlay 抢占了 URL,关闭自己
      onOpenChange(false);
    }
    // 仅在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 同步:open 变化时写 URL
  useEffect(() => {
    const url = new URL(window.location.href);
    const current = url.searchParams.get(PARAM);
    if (open && current !== overlayId) {
      url.searchParams.set(PARAM, overlayId);
      window.history.pushState({}, '', url.toString());
    } else if (!open && current === overlayId) {
      url.searchParams.delete(PARAM);
      window.history.pushState({}, '', url.toString());
    }
  }, [open, overlayId]);

  // 监听 popstate(浏览器后退/前进)
  useEffect(() => {
    const handler = () => {
      const params = new URLSearchParams(window.location.search);
      const current = params.get(PARAM);
      if (current === overlayId && !open) onOpenChange(true);
      else if (current !== overlayId && open) onOpenChange(false);
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [open, overlayId, onOpenChange]);

  const close = useCallback(() => {
    onOpenChange(false);
    const url = new URL(window.location.href);
    if (url.searchParams.get(PARAM) === overlayId) {
      url.searchParams.delete(PARAM);
      window.history.pushState({}, '', url.toString());
    }
  }, [overlayId, onOpenChange]);

  return { close };
}
