// src/runtime/supervisor.ts
import { RuntimeComponent, RuntimePhase } from './lifecycle';

export class Supervisor {
  private watched: Map<string, RuntimeComponent> = new Map();
  private restartCounts: Map<string, number> = new Map();

  watch(component: RuntimeComponent): void {
    this.watched.set(component.id, component);
  }

  async handleFailure(componentId: string, error: Error): Promise<void> {
    const count = (this.restartCounts.get(componentId) || 0) + 1;
    this.restartCounts.set(componentId, count);

    console.warn(`[Supervisor] ${componentId} 发生故障 (重启次数: ${count})`);

    if (count > 5) {
      console.error(`[Supervisor] ${componentId} 超过最大重启次数，进入 FAILED 状态`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, count - 1), 10000);
    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      const comp = this.watched.get(componentId);
      if (comp) {
        await comp.start();
      }
    } catch (e) {
      console.error(`[Supervisor] 重启 ${componentId} 失败`, e);
    }
  }
}