/**
 * ErrorBox - 统一错误展示
 *
 * 用法:
 *   <ErrorBox error={error} onRetry={refetch} />
 */

import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

export interface ErrorBoxProps {
  error: Error | string;
  onRetry?: () => void;
  message?: string;
  variant?: 'inline' | 'card' | 'banner';
  className?: string;
}

export default function ErrorBox({
  error,
  onRetry,
  message,
  variant = 'card',
  className = '',
}: ErrorBoxProps): React.ReactElement {
  const errText = error instanceof Error ? error.message : error;

  const inner = (
    <>
      <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
      <div className="flex-1 min-w-0">
        {message && (
          <div className="text-[11px] font-bold text-red-300 mb-0.5">{message}</div>
        )}
        <div className="text-[10px] text-red-200/80 font-mono break-all">{errText}</div>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded bg-red-500/15 hover:bg-red-500/25 text-red-300 text-[10px] font-mono transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          重试
        </button>
      )}
    </>
  );

  if (variant === 'inline') {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        {inner}
      </div>
    );
  }
  if (variant === 'banner') {
    return (
      <div className={`px-3 py-2 bg-red-500/10 border-y border-red-500/30 flex items-center gap-2 ${className}`}>
        {inner}
      </div>
    );
  }
  return (
    <div className={`p-3 bg-red-500/5 border border-red-500/20 rounded-lg flex items-center gap-2 ${className}`}>
      {inner}
    </div>
  );
}
