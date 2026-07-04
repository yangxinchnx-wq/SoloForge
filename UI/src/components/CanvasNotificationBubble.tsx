/**
 * CanvasNotificationBubble
 * ---------------------------------------------------------------------------
 * 画布修改通知气泡 — 叠在 PreviewPanel 画布上方, 3 秒淡入淡出
 *
 * 设计:
 *   - 单个气泡: 显示 "谁 干了什么", 例如 "chat-B 修改了画布 1"
 *   - 配色: border-primary + bg-primary/10 (主题色)
 *   - 动画: fadeIn + slideUp (淡入, 不突兀), 3 秒后 fadeOut
 *   - 多气泡冲突: 由父组件队列轮换, 同一时刻只显示一个
 *   - 不可关闭 (自动消失)
 *
 * Props:
 *   - note: 当前正在显示的通知
 *   - onDone: 动画结束回调 (父组件 pop queue)
 */

import React from 'react';
import { User } from 'lucide-react';
import type { CanvasNotification } from '../services/canvas/sessionApi';

interface Props {
  note: CanvasNotification;
}

const ACTION_LABEL: Record<CanvasNotification['action'], string> = {
  write_device: '修改了',
  remove_device: '移除了设备',
  rename: '改了备注',
  delete: '删除了',
};

export function CanvasNotificationBubble({ note }: Props) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="
        pointer-events-none
        absolute top-3 left-1/2 -translate-x-1/2
        z-30
        flex items-center gap-2
        px-3 py-2 rounded-lg
        bg-primary/10
        border border-primary/60
        backdrop-blur-sm
        shadow-md
        animate-canvas-bubble-in
        max-w-[80%]
      "
    >
      <User size={14} className="text-primary shrink-0" />
      <span className="text-xs text-on-surface whitespace-nowrap">
        <span className="font-medium text-primary">{note.actorChatSessionId}</span>
        <span className="mx-1 opacity-70">{ACTION_LABEL[note.action]}</span>
        <span className="font-medium">画布 {note.canvasDisplayName}</span>
      </span>
    </div>
  );
}

/**
 * BubbleStack
 * ---------------------------------------------------------------------------
 * 同一画布可能有多个气泡并存, 但视觉上只能一个, 排队轮换
 *
 * 队列模式:
 *   - 父组件持有 queue: CanvasNotification[]
 *   - 当前显示 queue[0]
 *   - 3 秒后自动 onDone(0), 父组件 pop
 *   - 新的 push 到 queue 末尾, 自动接续
 */

interface StackProps {
  notes: CanvasNotification[];
  onExpire: (id: string) => void;
}

export function CanvasNotificationStack({ notes, onExpire }: StackProps) {
  if (notes.length === 0) return null;
  const top = notes[0];
  // 关键: 用 key={note.id} 让 fadeOut 完整播放, 否则同一 div 切换内容不会触发动画
  return (
    <div key={top.id} className="absolute inset-0 pointer-events-none">
      <CanvasNotificationBubbleWithTimeout note={top} onDone={() => onExpire(top.id)} />
    </div>
  );
}

function CanvasNotificationBubbleWithTimeout({ note, onDone }: { note: CanvasNotification; onDone: () => void }) {
  React.useEffect(() => {
    // 3000ms 后开始 fadeOut (css 用 300ms 渐出)
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [note.id, onDone]);
  return <CanvasNotificationBubble note={note} />;
}
