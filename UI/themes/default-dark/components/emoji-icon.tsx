// ─────────────────────────────────────────────────────────────────
// SoloForge EmojiIcon Component
// 表情图标组件
// ─────────────────────────────────────────────────────────────────

import React from 'react';
import { useTheme } from './theme-context';

type EmojiType =
  | 'happy' | 'sad' | 'angry' | 'surprised' | 'thinking'
  | 'star' | 'fire' | 'warning' | 'check' | 'cross'
  | 'rocket' | 'lightning' | 'gear' | 'bell' | 'heart'
  | 'thumbsup' | 'thumbsdown' | 'flag' | 'target' | 'trophy';

interface EmojiIconProps {
  emoji: EmojiType | string;
  size?: number;
  className?: string;
}

// 表情映射
const EMOJI_MAP: Record<EmojiType, string> = {
  'happy': 'happy.svg',
  'sad': 'sad.svg',
  'angry': 'angry.svg',
  'surprised': 'surprised.svg',
  'thinking': 'thinking.svg',
  'star': 'star.svg',
  'fire': 'fire.svg',
  'warning': 'warning.svg',
  'check': 'check.svg',
  'cross': 'cross.svg',
  'rocket': 'rocket.svg',
  'lightning': 'lightning.svg',
  'gear': 'gear.svg',
  'bell': 'bell.svg',
  'heart': 'heart.svg',
  'thumbsup': 'thumbsup.svg',
  'thumbsdown': 'thumbsdown.svg',
  'flag': 'flag.svg',
  'target': 'target.svg',
  'trophy': 'trophy.svg'
};

// 内联 SVG 备用表情
const INLINE_EMOJIS: Record<EmojiType, React.ReactNode> = {
  'happy': <span>😊</span>,
  'sad': <span>😢</span>,
  'angry': <span>😠</span>,
  'surprised': <span>😮</span>,
  'thinking': <span>🤔</span>,
  'star': <span>⭐</span>,
  'fire': <span>🔥</span>,
  'warning': <span>⚠️</span>,
  'check': <span>✅</span>,
  'cross': <span>❌</span>,
  'rocket': <span>🚀</span>,
  'lightning': <span>⚡</span>,
  'gear': <span>⚙️</span>,
  'bell': <span>🔔</span>,
  'heart': <span>❤️</span>,
  'thumbsup': <span>👍</span>,
  'thumbsdown': <span>👎</span>,
  'flag': <span>🚩</span>,
  'target': <span>🎯</span>,
  'trophy': <span>🏆</span>
};

export function EmojiIcon({ emoji, size = 24, className }: EmojiIconProps) {
  const { emojisPath } = useTheme();

  // 检查是否是预定义的表情类型
  if (emoji in EMOJI_MAP) {
    const emojiFile = EMOJI_MAP[emoji as EmojiType];
    return (
      <img
        src={`${emojisPath}/${emojiFile}`}
        alt={emoji}
        width={size}
        height={size}
        className={className}
        style={{ objectFit: 'contain' }}
      />
    );
  }

  // 如果是 emoji 字符或文件名
  if (emoji.includes('.svg')) {
    return (
      <img
        src={`${emojisPath}/${emoji}`}
        alt={emoji}
        width={size}
        height={size}
        className={className}
        style={{ objectFit: 'contain' }}
      />
    );
  }

  // 回退到 emoji 字符
  return (
    <span style={{ fontSize: size }} className={className}>
      {emoji}
    </span>
  );
}

export default EmojiIcon;
