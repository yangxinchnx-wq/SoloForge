// src/runtime/registry.ts
import { RuntimeComponent } from './lifecycle';
import { RuntimeKernel } from './kernel';

export class ComponentRegistry {
  private static instance: ComponentRegistry;
  private components: Map<string, RuntimeComponent> = new Map();

  static getInstance(): ComponentRegistry {
    if (!ComponentRegistry.instance) {
      ComponentRegistry.instance = new ComponentRegistry();
    }
    return ComponentRegistry.instance;
  }

  register(component: RuntimeComponent): void {
    this.components.set(component.id, component);
    RuntimeKernel.getInstance().registerComponent(component);
    console.log(`[Registry] ✅ 组件已注册: ${component.id}`);
  }

  getComponent(id: string): RuntimeComponent | undefined {
    return this.components.get(id);
  }

  getAllComponents(): RuntimeComponent[] {
    return Array.from(this.components.values());
  }

  async startAllRegistered(): Promise<void> {
    await RuntimeKernel.getInstance().start();
  }
}
