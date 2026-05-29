// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Component Registry
// Path: src/kernel/registry.ts
// ─────────────────────────────────────────────────────────────────

import { kernel } from './runtime-kernel';
import { BackpressureManager } from './backpressure';

/**
 * @deprecated 旧接口，保留向后兼容
 * 请使用 RuntimeComponent 接口和 kernel.register()
 */
export interface RuntimeComponent {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<boolean>;
}

interface HealthSnapshot {
  implicitHealthyComponents: number;
  totalComponents: number;
}

export class ComponentRegistry {
  private static instance: ComponentRegistry | null = null;
  private readonly components = new Map<string, RuntimeComponent>();
  private backpressureManager = new BackpressureManager();

  private constructor() {}

  public static getInstance(): ComponentRegistry {
    if (!ComponentRegistry.instance) {
      ComponentRegistry.instance = new ComponentRegistry();
    }
    return ComponentRegistry.instance;
  }

  public register(component: RuntimeComponent): void {
    if (this.components.has(component.id)) {
      throw new Error(`[ComponentRegistry] Component already registered: ${component.id}`);
    }
    this.components.set(component.id, component);
    console.log(`[ComponentRegistry] Registered: ${component.id}`);
  }

  public getComponent(id: string): RuntimeComponent | undefined {
    return this.components.get(id);
  }

  public getAllComponents(): RuntimeComponent[] {
    return Array.from(this.components.values());
  }

  public getBackpressureManager() {
    return this.backpressureManager;
  }

  public getGlobalHealthSnapshotSync(): HealthSnapshot {
    return {
      implicitHealthyComponents: this.components.size,
      totalComponents: this.components.size
    };
  }
}
