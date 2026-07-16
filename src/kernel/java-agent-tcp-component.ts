/**
 * src/kernel/java-agent-tcp-component.ts
 *
 * Runtime component for Java Agent TCP communication.
 *
 * <p>Implements the RuntimeComponent interface to integrate with RuntimeKernel.
 */

import { RuntimeComponent, RuntimeKernel } from './runtime-component';
import { RuntimeState } from './runtime-kernel';
import type { EventBusInterface } from './runtime-kernel';
import { JavaAgentTcpIntegration } from '../core/agent/tcp-integration';
import { logger } from '../core/logger';

export class JavaAgentTcpComponent implements RuntimeComponent {
  readonly name = 'java-agent-tcp';
  private integration: JavaAgentTcpIntegration | null = null;
  private eventBus: EventBusInterface;
  private kernel: RuntimeKernel;

  constructor(kernel: RuntimeKernel, eventBus: EventBusInterface) {
    this.kernel = kernel;
    this.eventBus = eventBus;
  }

  async start(): Promise<void> {
    logger.info('JavaAgentTcpComponent', 'Starting Java Agent TCP component...');

    try {
      // Initialize the integration layer (creates its own internal client)
      this.integration = new JavaAgentTcpIntegration(this.eventBus);
      await this.integration.initialize();

      // Register with kernel
      (this.kernel as any).javaAgentTcp = this;

      logger.info('JavaAgentTcpComponent', 'Java Agent TCP component started successfully');
    } catch (error) {
      logger.error('JavaAgentTcpComponent', `Failed to start: ${error}`);
      // Non-fatal: RACER can still function without Java Agent
      console.warn('[JavaAgentTcpComponent] Java Agent not available, running in standalone mode');
    }
  }

  async stop(): Promise<void> {
    logger.info('JavaAgentTcpComponent', 'Stopping Java Agent TCP component...');

    if (this.integration) {
      this.integration.shutdown();
    }

    logger.info('JavaAgentTcpComponent', 'Java Agent TCP component stopped');
  }

  async healthCheck(): Promise<boolean> {
    return this.integration?.isConnected() ?? false;
  }

  getIntegration(): JavaAgentTcpIntegration | null {
    return this.integration;
  }
}
