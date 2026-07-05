/**
 * LoadingSpinner - 统一 loading UI
 *
 * 用法:
 *   <LoadingSpinner />                                      // 16px, 默认色
 *   <LoadingSpinner size="lg" />                            // 32px
 *   <LoadingSpinner message="正在加载模型..." />
 *   <LoadingSpinner overlay />                              // 全屏遮罩
 *   <LoadingSpinner variant="dots" />                       // 三点动画
 */

import React from 'react';
import { Loader2 } from '../utils/icons';

export interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  message?: string;
  /** 全屏遮罩 */
  overlay?: boolean;
  /** 动画风格 */
  variant?: 'spin' | 'dots' | 'pulse';
  className?: string;
}

const SIZE_PX: Record<NonNullable<LoadingSpinnerProps['size']>, number> = {
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
};

export default function LoadingSpinner({
  size = 'md',
  message,
  overlay = false,
  variant = 'spin',
  className = '',
}: LoadingSpinnerProps): React.ReactElement {
  const px = SIZE_PX[size];

  const spinner = (): React.ReactElement => {
    if (variant === 'dots') {
      return (
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </div>
      );
    }
    if (variant === 'pulse') {
      return (
        <div
          className="rounded-full bg-current animate-pulse"
          style={{ width: `${px}px`, height: `${px}px` }}
        />
      );
    }
    return <Loader2 className="animate-spin" style={{ width: `${px}px`, height: `${px}px` }} />;
  };

  const content = (
    <div
      className={`flex flex-col items-center justify-center gap-2 text-on-surface/70 ${className}`}
    >
      {spinner()}
      {message && (
        <span className="text-[10px] font-mono uppercase tracking-wider">{message}</span>
      )}
    </div>
  );

  if (overlay) {
    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm pointer-events-auto">
        {content}
      </div>
    );
  }

  return content;
}
