/**
 * RouteErrorBoundary — 路由级 ErrorBoundary (class component)
 *
 * 用于 react-router <Route errorElement={...}> 的场景。
 * fallback 为内联错误提示 + 重试按钮，不会全屏崩溃。
 *
 * 错误码体系: 动态生成，不预注册
 *   - 路由级: R404 (通用路由渲染失败)
 *   - 面板级: P{PanelName} (如 PFileExplorer, PChatPanel)
 *   - 全局壳: G001 (App 根级渲染失败)
 *
 * 捕获错误后:
 *   1. console.error 打印完整错误栈 + 组件栈
 *   2. reportBootError 上报到启动错误系统 (动态错误码)
 *   3. fallback UI 展示错误摘要 + 可展开的详情
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { useRouteError } from 'react-router-dom';
import { reportBootError } from '../boot/bootScreen';
import ErrorBox from './ErrorBox';

// ─── 动态错误码生成 ────────────────────────────────────────────

/** 路由级通用错误码 */
const ROUTE_ERROR_CODE = 'R404';
/** 全局壳错误码 */
const GLOBAL_SHELL_CODE = 'G001';

/** 根据面板名称生成面板级错误码 */
function panelErrorCode(panelName: string): string {
  return `P${panelName.replace(/\s+/g, '')}`;
}

// ─── RouteErrorDisplay — 配合 useRouteError 的函数组件 ─────────

/**
 * 路由级错误展示组件 — 作为 <Route errorElement={<RouteErrorDisplay />} /> 使用。
 * 通过 useRouteError() 获取路由抛出的错误。
 */
export function RouteErrorDisplay(): React.ReactElement {
  const error = useRouteError();
  const errObj = error instanceof Error ? error : new Error(String(error));

  // 上报到启动错误系统 (动态错误码，不预注册)
  React.useEffect(() => {
    reportBootError(ROUTE_ERROR_CODE, {
      detail: `路由渲染失败: ${errObj.message}`,
      error: errObj,
      source: 'RouteErrorBoundary',
      extra: { code: ROUTE_ERROR_CODE, errorName: errObj.name },
    });
  }, [errObj]);

  const handleRetry = () => {
    window.location.reload();
  };

  return (
    <div className="flex items-center justify-center h-full w-full p-4">
      <div className="max-w-lg w-full space-y-2">
        <ErrorBox
          error={errObj}
          message="组件加载失败"
          onRetry={handleRetry}
          variant="card"
        />
        <details className="text-[10px] text-zinc-500 font-mono">
          <summary className="cursor-pointer hover:text-zinc-400 select-none">
            错误详情 (code: {ROUTE_ERROR_CODE})
          </summary>
          <pre className="mt-1 p-2 bg-black/30 rounded text-[9px] text-zinc-400 whitespace-pre-wrap break-all max-h-40 overflow-auto">
            {errObj.stack || errObj.message}
          </pre>
        </details>
      </div>
    </div>
  );
}

// ─── RouteErrorBoundary — class component 版本 ─────────────────

interface RouteErrorBoundaryProps {
  children: ReactNode;
  /** 可选的自定义错误码，默认 R404 */
  errorCode?: string;
}

interface RouteErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

/**
 * 路由级 ErrorBoundary (class component)。
 * 可包裹 Routes 或单个 Route element。
 */
export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  constructor(props: RouteErrorBoundaryProps) {
    super(props);
    this.state = { error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): Partial<RouteErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    const code = this.props.errorCode ?? ROUTE_ERROR_CODE;
    const stack = info.componentStack?.split('\n').slice(0, 12).join('\n') ?? '';

    // 1. console 完整信息
    console.error(`[RouteErrorBoundary ${code}]`, error, '\nComponentStack:', stack);

    // 2. 上报到启动错误系统 (动态错误码，不预注册)
    reportBootError(code, {
      detail: `路由渲染失败: ${error.message}`,
      error,
      source: 'RouteErrorBoundary',
      extra: { code, componentStack: stack },
    });

    this.setState({ componentStack: stack });
  }

  resetErrorBoundary = () => {
    this.setState({ error: null, componentStack: null });
  };

  override render() {
    if (this.state.error) {
      const code = this.props.errorCode ?? ROUTE_ERROR_CODE;
      return (
        <div className="flex items-center justify-center h-full w-full p-4">
          <div className="max-w-lg w-full space-y-2">
            <ErrorBox
              error={this.state.error}
              message="组件加载失败"
              onRetry={this.resetErrorBoundary}
              variant="card"
            />
            <details className="text-[10px] text-zinc-500 font-mono">
              <summary className="cursor-pointer hover:text-zinc-400 select-none">
                错误详情 (code: {code})
              </summary>
              {this.state.componentStack && (
                <div className="mt-1">
                  <div className="text-[9px] text-zinc-500 mb-0.5">组件栈:</div>
                  <pre className="p-2 bg-black/30 rounded text-[9px] text-zinc-500 whitespace-pre-wrap break-all max-h-24 overflow-auto">
                    {this.state.componentStack}
                  </pre>
                </div>
              )}
              <pre className="mt-1 p-2 bg-black/30 rounded text-[9px] text-zinc-400 whitespace-pre-wrap break-all max-h-40 overflow-auto">
                {this.state.error.stack || this.state.error.message}
              </pre>
            </details>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── PanelErrorBoundary — 面板级轻量 ErrorBoundary ─────────────

interface PanelErrorBoundaryProps {
  children: ReactNode;
  panelName: string;
}

interface PanelErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

/**
 * 面板级轻量 ErrorBoundary。
 * 用于包裹 MainLayout 中的各个 lazy 面板组件。
 * 失败时内联显示 ErrorBox，不影响其他面板。
 * 错误码动态生成: P{PanelName} (如 PFileExplorer)。
 */
export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  constructor(props: PanelErrorBoundaryProps) {
    super(props);
    this.state = { error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): Partial<PanelErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    const code = panelErrorCode(this.props.panelName);
    const stack = info.componentStack?.split('\n').slice(0, 12).join('\n') ?? '';

    // 1. console 完整信息
    console.error(`[PanelErrorBoundary ${code}] ${this.props.panelName} crashed:`, error, '\nComponentStack:', stack);

    // 2. 上报到启动错误系统 (动态错误码，不预注册)
    reportBootError(code, {
      detail: `面板 "${this.props.panelName}" 渲染失败: ${error.message}`,
      error,
      source: 'PanelErrorBoundary',
      extra: { code, panelName: this.props.panelName, componentStack: stack },
    });

    this.setState({ componentStack: stack });
  }

  resetErrorBoundary = () => {
    this.setState({ error: null, componentStack: null });
  };

  override render() {
    if (this.state.error) {
      const code = panelErrorCode(this.props.panelName);
      return (
        <div className="flex items-center justify-center h-full w-full p-3">
          <div className="w-full space-y-1">
            <ErrorBox
              error={this.state.error}
              message={`${this.props.panelName} 加载失败`}
              onRetry={this.resetErrorBoundary}
              variant="inline"
            />
            <details className="text-[10px] text-zinc-500 font-mono">
              <summary className="cursor-pointer hover:text-zinc-400 select-none">
                错误详情 (code: {code})
              </summary>
              {this.state.componentStack && (
                <div className="mt-1">
                  <div className="text-[9px] text-zinc-500 mb-0.5">组件栈:</div>
                  <pre className="p-2 bg-black/30 rounded text-[9px] text-zinc-500 whitespace-pre-wrap break-all max-h-20 overflow-auto">
                    {this.state.componentStack}
                  </pre>
                </div>
              )}
              <pre className="mt-1 p-2 bg-black/30 rounded text-[9px] text-zinc-400 whitespace-pre-wrap break-all max-h-32 overflow-auto">
                {this.state.error.stack || this.state.error.message}
              </pre>
            </details>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export { GLOBAL_SHELL_CODE, ROUTE_ERROR_CODE, panelErrorCode };
