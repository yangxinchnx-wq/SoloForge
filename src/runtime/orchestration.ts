// src/runtime/orchestration.ts
import { RuntimeKernel } from './kernel';
import { TracingManager } from './tracing';
import { StateManager } from './state/state';

export class OrchestrationManager {
  private kernel = RuntimeKernel.getInstance();
  private tracer = new TracingManager();
  private state = new StateManager();

  async orchestrateStartup(): Promise<void> {
    const spanId = this.tracer.startSpan('system_startup');

    try {
      console.log('🎼 开始系统编排启动...');

      this.tracer.addEvent(spanId, 'kernel_initializing');
      await this.kernel.start();

      this.tracer.addEvent(spanId, 'state_restored');
      this.tracer.addEvent(spanId, 'components_registered');

      this.tracer.endSpan(spanId, 'completed');
      console.log('🎼 系统编排启动完成');
    } catch (error) {
      this.tracer.endSpan(spanId, 'error', error);
      console.error('❌ 系统编排启动失败', error);
      throw error;
    }
  }

  getStateManager(): StateManager {
    return this.state;
  }

  getTracer(): TracingManager {
    return this.tracer;
  }
}
