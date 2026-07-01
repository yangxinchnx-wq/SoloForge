/**
 * useAgentSync — 把 preload bridge (Electron IPC) 连接到 zustand store
 *
 * 用法:
 *   function App() {
 *     useAgentSync();  // 应用根调用一次即可
 *     return <MainView />;
 *   }
 *
 * 行为:
 *   1. 挂载时: 拉取初始 snapshot, 订阅全部 agent:event
 *   2. 定期: 30s 检查一次 bridge 状态
 *   3. 卸载时: 取消所有订阅
 *
 * 设计动机:
 *   - 不在每个组件里重复 useEffect 订阅 (避免 5 个组件都连 IPC)
 *   - 单点连接, 集中分发到 store
 *   - 失败静默 (浏览器环境无 window.soloforge 时不报错)
 */

import { useEffect } from 'react';
import { useAgentStore } from '../state/agentStore';

const BRIDGE_CHECK_INTERVAL_MS = 30_000;

export function useAgentSync(): void {
  const applyEvent = useAgentStore((s) => s.applyEvent);
  const refreshSnapshot = useAgentStore((s) => s.refreshSnapshot);
  const setBridgeStatus = useAgentStore((s) => s.setBridgeStatus);

  useEffect(() => {
    // 仅在 Electron 环境下生效
    if (typeof window === 'undefined') return;
    const bridge = (window as any).soloforge?.agent;
    if (!bridge) {
      // 浏览器直连 3001 模式 (非 Electron) — 不做任何事
      return;
    }

    // 1) 初始 snapshot
    refreshSnapshot();

    // 2) 桥状态查询
    const updateBridgeStatus = async () => {
      try {
        const s = await bridge.bridgeStatus();
        if (s) setBridgeStatus(s);
      } catch (e) {
        // 静默
      }
    };
    updateBridgeStatus();

    // 3) 订阅全部事件 (使用 'agent:event' 通配, 转发到 store.applyEvent 做 routing)
    const unsubscribe = bridge.on('agent:event', (msg: any) => {
      applyEvent(msg);
    });

    // 4) 定期检查桥状态
    const timer = setInterval(updateBridgeStatus, BRIDGE_CHECK_INTERVAL_MS);

    return () => {
      try { unsubscribe?.(); } catch { /* ignore */ }
      clearInterval(timer);
    };
  }, [applyEvent, refreshSnapshot, setBridgeStatus]);
}
