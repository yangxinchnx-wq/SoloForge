import { Component, ErrorInfo, ReactNode } from 'react';
import { reportBootError } from './bootScreen';

interface Props {
  code: string;
  children: ReactNode;
  fallback?: (err: Error, reset: () => void) => ReactNode;
  detail?: string;
}

interface State {
  error: Error | null;
}

/**
 * SoloForge 全局 ErrorBoundary
 * 包裹每个高风险子树, 子树挂掉时调用 reportBootError 在屏幕上画错误码
 */
export class BootErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    reportBootError(this.props.code, {
      detail: this.props.detail
        ? `${this.props.detail} | ${info.componentStack?.split('\n').slice(0, 3).join(' / ')}`
        : info.componentStack?.split('\n').slice(0, 6).join('\n'),
      error,
      source: 'ErrorBoundary',
      extra: { boundary: this.props.code, componentStack: info.componentStack },
    });
  }

  reset = () => this.setState({ error: null });

  override render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      // 默认 fallback: 让 BootScreen 接管 (它已经画在 document.body 上了)
      return (
        <div style={{ padding: 16, color: '#f43f5e', fontFamily: 'monospace', fontSize: 12 }}>
          组件 {this.props.code} 渲染失败。看错误屏。
        </div>
      );
    }
    return this.props.children;
  }
}
