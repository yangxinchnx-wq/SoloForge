import React, { useRef, useEffect } from 'react';

// 仅在文本溢出时接管滚轮,横向滚动,边界硬钳制,不影响行拖拽
export const ScrollableText: React.FC<{ children: React.ReactNode; className?: string; title?: string }> = ({ children, className, title }) => {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!el) return;
      // 未溢出就完全放行,让事件继续传给父级滚动容器
      if (el.scrollWidth <= el.clientWidth + 1) return;
      e.preventDefault();
      e.stopPropagation();
      // 优先 deltaY(普通滚轮),其次 deltaX(水平触摸板/水平滚轮)
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const maxScroll = el.scrollWidth - el.clientWidth;
      const next = el.scrollLeft + delta;
      el.scrollLeft = Math.max(0, Math.min(maxScroll, next));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);
  return (
    <span
      ref={ref}
      title={title}
      className={`block overflow-x-auto overflow-y-hidden whitespace-nowrap max-w-full pointer-events-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] ${className || ''}`}
    >
      {children}
    </span>
  );
};

export default ScrollableText;
