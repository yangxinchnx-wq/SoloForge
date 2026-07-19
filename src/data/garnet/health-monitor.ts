// ─────────────────────────────────────────────────────────────────
// Garnet 健康监控
// Path: src/data/garnet/health-monitor.ts
// 定期 ping 检测，失败时主动触发重连
// ─────────────────────────────────────────────────────────────────

import { getClient } from './client';

let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
const HEALTH_CHECK_INTERVAL_MS = 30000; // 每 30 秒检查一次

/**
 * 启动 Garnet 健康监控
 * 定期 ping 检测，失败时主动触发重连
 */
export function startHealthMonitor(intervalMs = HEALTH_CHECK_INTERVAL_MS): void {
  if (healthCheckTimer) {
    console.warn('[Garnet] Health monitor already running');
    return;
  }

  console.log(`[Garnet] Starting health monitor (interval: ${intervalMs}ms)`);

  healthCheckTimer = setInterval(async () => {
    try {
      const client = getClient();
      const result = await client.ping();

      if (result !== 'PONG') {
        throw new Error(`Unexpected ping response: ${String(result)}`);
      }
    } catch (error) {
      console.error(
        '[Garnet] Health check failed, attempting reconnect...',
        error instanceof Error ? error.message : error
      );

      try {
        // 主动断开并重新连接，触发 ioredis 重连逻辑
        const client = getClient();
        client.disconnect();
        await client.connect();
        console.log('[Garnet] Reconnection successful');
      } catch (reconnectError) {
        console.error(
          '[Garnet] Reconnection failed:',
          reconnectError instanceof Error ? reconnectError.message : reconnectError
        );
      }
    }
  }, intervalMs);
}

/**
 * 停止健康监控
 * 在应用关闭时调用
 */
export function stopHealthMonitor(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
    console.log('[Garnet] Health monitor stopped');
  }
}

/**
 * 获取健康监控状态
 */
export function isHealthMonitorRunning(): boolean {
  return healthCheckTimer !== null;
}
