// ─────────────────────────────────────────────────────────────────
// SoloForge Garnet Health Check: LifecycleManager 组件
// Path: src/data/garnet/garnet-health.ts
//
// 符合 RuntimeComponent 接口，被 LifecycleManager 统一管理生命周期
// ─────────────────────────────────────────────────────────────────

import { getClient } from './client';

export class GarnetHealthCheck {
  public readonly name = 'garnet-health';
  private client = getClient();
  private startTime = Date.now();

  async start(): Promise<void> {
    console.log('[GarnetHealth] ✓ Hot data layer health monitor started');
  }

  async stop(): Promise<void> {
    console.log('[GarnetHealth] Health monitor stopped');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      if (pong !== 'PONG') return false;

      // 检查内存压力（Garnet 给自己设 maxmemory 时）
      const info = await this.client.info('memory') || '';
      const usedMem = this.parseMemoryInfo(info, 'used_memory');
      const maxMem = this.parseMemoryInfo(info, 'maxmemory');
      if (maxMem > 0 && usedMem > 0) {
        const pressure = usedMem / maxMem;
        if (pressure > 0.95) {
          console.warn('[GarnetHealth] ⚠️ Memory pressure critical:', Math.round(pressure * 100) + '%');
          return false;
        }
        if (pressure > 0.80) {
          console.warn('[GarnetHealth] ⚠️ Memory pressure elevated:', Math.round(pressure * 100) + '%');
        }
      }
      return true;
    } catch (err) {
      console.error('[GarnetHealth] Health check failed:', (err as Error).message);
      return false;
    }
  }

  async getHealthReport(): Promise<{
    status: 'healthy' | 'degraded' | 'failed';
    uptime: number;
    connected: boolean;
    memoryPressure: number;
    latency: number;
  }> {
    const start = Date.now();
    try {
      const pong = await this.client.ping();
      const latency = Date.now() - start;
      const connected = pong === 'PONG';
      const info = await this.client.info('memory') || '';
      const usedMem = this.parseMemoryInfo(info, 'used_memory');
      const maxMem = this.parseMemoryInfo(info, 'maxmemory');
      const memoryPressure = maxMem > 0 ? usedMem / maxMem : 0;
      return {
        status: connected ? (memoryPressure > 0.8 ? 'degraded' : 'healthy') : 'failed',
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        connected,
        memoryPressure: Math.round(memoryPressure * 100) / 100,
        latency,
      };
    } catch {
      return {
        status: 'failed',
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        connected: false,
        memoryPressure: 0,
        latency: Date.now() - start,
      };
    }
  }

  private parseMemoryInfo(info: string, key: string): number {
    const match = info.match(new RegExp(`${key}:(\\d+)`));
    return match ? parseInt(match[1], 10) : 0;
  }
}
