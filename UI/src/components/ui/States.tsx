// ─────────────────────────────────────────────────────────────────
// 统一三态组件 (P0-4)
// - <EmptyState />  数据为空
// - <ErrorState />  出错 (含重试)
// - <LoadingState /> 加载中
// - <ErrorBoundary>  组件级错误兜底
// ─────────────────────────────────────────────────────────────────

import { Component, type ReactNode, type ErrorInfo } from 'react';
import { apiErrorMessage } from '../../hooks/useApi';
import { Button } from './Button';

export function EmptyState({
  icon = 'inbox',
  title = '暂无数据',
  description,
  action,
}: {
  icon?: string;
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 text-center text-text-secondary">
      <span className="material-symbols-outlined text-3xl mb-2 opacity-40">{icon}</span>
      <p className="text-sm font-medium text-text mb-1">{title}</p>
      {description && <p className="text-[11px] max-w-xs">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = '出错了',
}: {
  error: Error | null;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
      <span className="material-symbols-outlined text-3xl mb-2 text-danger opacity-70">error</span>
      <p className="text-sm font-medium text-text mb-1">{title}</p>
      <p className="text-[11px] text-text-secondary max-w-xs mb-3">{apiErrorMessage(error)}</p>
      {onRetry && <Button size="sm" icon="refresh" variant="primary" onClick={onRetry}>重试</Button>}
    </div>
  );
}

export function LoadingState({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-text-secondary text-[11px]">
      <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
      <span>{label}</span>
    </div>
  );
}

// ── ErrorBoundary ──
interface BoundaryProps {
  children: ReactNode;
  fallback?: (err: Error, reset: () => void) => ReactNode;
}
interface BoundaryState { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error): BoundaryState {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // 避免 console 在生产刷屏
    if ((import.meta as any).env?.DEV) {
      console.error('[ErrorBoundary]', error, info);
    }
  }
  reset = () => this.setState({ hasError: false, error: null });
  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return <ErrorState error={this.state.error} onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
