/**
 * useRenderTrace — 渲染追踪调试 Hook
 *
 * 在组件中使用: useRenderTrace('ComponentName')
 * 每次渲染时在控制台打印组件名 + 渲染次数 + 触发渲染的 props
 *
 * 用于诊断"修改一个部分后全局刷新"问题:
 *   - 在 App/MainLayout/ChatPanel/Header/PreviewPanel 中使用
 *   - 用户重现问题时, 控制台会打印哪些组件在重渲染
 *   - 根据日志判断是全局重渲染还是局部重渲染
 *
 * ★ 调试完成后移除 import 和调用即可, 不影响生产
 */

import { useRef, useEffect } from 'react';

export function useRenderTrace(name: string, props?: Record<string, any>): void {
  const renderCount = useRef(0);
  const prevProps = useRef<Record<string, any> | undefined>(props);

  renderCount.current++;

  // 在渲染时打印 (不是 useEffect, 确保即使在 concurrent mode 下也打印)
  if (process.env.NODE_ENV !== 'production') {
    const changedProps: string[] = [];
    if (props && prevProps.current) {
      for (const key of Object.keys(props)) {
        if (prevProps.current[key] !== props[key]) {
          changedProps.push(key);
        }
      }
    }

    if (changedProps.length > 0) {
      console.log(
        `%c[RenderTrace] ${name} #${renderCount.current} (changed: ${changedProps.join(', ')})`,
        'color: #f59e0b; font-weight: bold',
      );
    } else {
      console.log(
        `%c[RenderTrace] ${name} #${renderCount.current}`,
        'color: #3b82f6; font-weight: bold',
      );
    }

    // 更新 prevProps 用于下次比较
    prevProps.current = props;
  }
}
