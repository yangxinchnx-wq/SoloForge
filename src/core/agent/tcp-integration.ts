/**
 * src/core/agent/tcp-integration.ts
 *
 * Integration layer between RACER and Java Agent TCP client.
 *
 * <p>Handles:
 * <ul>
 *   <li>Sending dispatch requests to Java Agent</li>
 *   <li>Receiving worker events from Java Agent</li>
 *   <li>Forwarding tool execution results</li>
 *   <li>Handling judge evaluation / stop commands</li>
 * </ul>
 */

import { JavaAgentTcpClient, TcpMessage } from '../../runtime/tcp-client';
import type { EventBusInterface } from '../../kernel/runtime-kernel';
import { logger } from '../logger';
import { ToolResultRelay } from './tool-result-relay';

export class JavaAgentTcpIntegration {
  private client: JavaAgentTcpClient;
  private eventBus: EventBusInterface;
  private toolRelay: ToolResultRelay;
  private initialized = false;

  constructor(eventBus: EventBusInterface) {
    this.eventBus = eventBus;
    this.client = new JavaAgentTcpClient('127.0.0.1', 8771);
    this.toolRelay = new ToolResultRelay(this.client);

    this.setupEventHandlers();
  }

  async initialize(): Promise<void> {
    try {
      await this.client.connect();
      this.initialized = true;
      logger.info('JavaAgentTcpIntegration', 'Connected to Java Agent TCP server');

      // Send ping to verify connection
      this.client.send({ type: 'ping' });
    } catch (error) {
      logger.error('JavaAgentTcpIntegration', `Failed to connect to Java Agent: ${error}`);
      // Re-throw so callers can react (e.g. component logs honest status)
      throw error;
    }
  }

  private setupEventHandlers(): void {
    // Prevent Node.js from crashing on unhandled 'error' events from the TCP client
    // (e.g. ECONNRESET when Java Agent restarts). Reconnect logic is handled by the
    // socket 'close' event in tcp-client.ts.
    this.client.on('error', (error: Error) => {
      logger.error('JavaAgentTcpIntegration', `TCP client error (non-fatal): ${error.message}`);
    });

    // Worker events from Java Agent
    this.client.on('workerStarted', (message: TcpMessage) => {
      logger.info('JavaAgentTcpIntegration', `TCP event worker_started: dispatchId=${message.dispatchId}, workerIdx=${message.workerIdx}`);
      this.eventBus.emit('worker_started', {
        dispatchId: message.dispatchId,
        workerIdx: message.workerIdx,
        agentId: message.agentId,
      });
    });

    this.client.on('workerChunk', (message: TcpMessage) => {
      logger.debug('JavaAgentTcpIntegration', `TCP event worker_chunk: dispatchId=${message.dispatchId}, workerIdx=${message.workerIdx}, len=${message.content?.length ?? 0}`);
      this.eventBus.emit('worker_chunk', {
        dispatchId: message.dispatchId,
        workerIdx: message.workerIdx,
        content: message.content,
        agentId: message.agentId,
      });
    });

    this.client.on('workerDone', (message: TcpMessage) => {
      logger.info('JavaAgentTcpIntegration', `TCP event worker_done: dispatchId=${message.dispatchId}, workerIdx=${message.workerIdx}`);
      this.eventBus.emit('worker_done', {
        dispatchId: message.dispatchId,
        workerIdx: message.workerIdx,
        output: message.output,
      });
    });

    this.client.on('workerFailed', (message: TcpMessage) => {
      logger.info('JavaAgentTcpIntegration', `TCP event worker_failed: dispatchId=${message.dispatchId}, workerIdx=${message.workerIdx}, error=${message.error}`);
      this.eventBus.emit('worker_failed', {
        dispatchId: message.dispatchId,
        workerIdx: message.workerIdx,
        error: message.error,
      });
    });

    this.client.on('toolCall', async (message: TcpMessage) => {
      logger.info('JavaAgentTcpIntegration', `TCP event tool_call: dispatchId=${message.dispatchId}, tool=${message.tool}`);
      try {
        await this.toolRelay.handleToolCall(message);
      } catch (e) {
        logger.error('JavaAgentTcpIntegration', `Unhandled tool call error: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    this.client.on('poolShare', (message: TcpMessage) => {
      logger.info('JavaAgentTcpIntegration', `TCP event pool_share: dispatchId=${message.dispatchId}`);
      this.eventBus.emit('pool_share', {
        dispatchId: message.dispatchId,
        entries: message.entries,
      });
    });

    this.client.on('dispatchDone', (message: TcpMessage) => {
      logger.info('JavaAgentTcpIntegration', `TCP event dispatch_done: dispatchId=${message.dispatchId}`);
      this.eventBus.emit('dispatch_done', {
        dispatchId: message.dispatchId,
      });
    });
  }

  /**
   * Send dispatch request to Java Agent.
   * 
   * @param dispatchId Unique dispatch identifier
   * @param chatId Conversation ID
   * @param prompt User prompt
   * @param workers Worker configurations
   * @param settings Agent settings
   * @param tools Available tools
   * @param permissionMode Permission mode
   */
  async sendDispatch(
    dispatchId: string,
    chatId: string,
    prompt: string,
    workers: any[],
    settings: any,
    tools: any[],
    permissionMode: string = 'normal'
  ): Promise<void> {
    if (!this.initialized) {
      logger.warn('JavaAgentTcpIntegration', 'Cannot send dispatch: not connected to Java Agent');
      return;
    }

    const message: TcpMessage = {
      type: 'dispatch',
      dispatchId,
      chatId,
      prompt,
      workers,
      settings,
      tools,
      permissionMode,
    };

    this.client.send(message);
    logger.info('JavaAgentTcpIntegration', `Sent dispatch ${dispatchId} to Java Agent`);
  }

  /**
   * Send tool execution result back to Java Agent.
   */
  async sendToolResult(
    dispatchId: string,
    workerIdx: number,
    toolName: string,
    toolArgs: any,
    result: string
  ): Promise<void> {
    if (!this.initialized) {
      logger.warn('JavaAgentTcpIntegration', 'Cannot send tool result: not connected');
      return;
    }

    const message: TcpMessage = {
      type: 'tool_result',
      dispatchId,
      workerIdx,
      tool: toolName,
      args: toolArgs,
      result,
    };

    this.client.send(message);
  }

  /**
   * Execute a tool directly (for HTTP endpoint or other callers).
   * Returns the tool result without sending back to Java via TCP.
   */
  async executeTool(tool: string, args: any): Promise<string> {
    if (!this.initialized) {
      throw new Error('Java Agent TCP not connected');
    }
    return this.toolRelay.executeTool(tool, args);
  }

  /**
   * Send stop command to Java Agent to terminate workers.
   */
  async sendStopCommand(dispatchId: string, workerIdx?: number): Promise<void> {
    if (!this.initialized) {
      logger.warn('JavaAgentTcpIntegration', 'Cannot send stop: not connected');
      return;
    }

    const message: TcpMessage = {
      type: 'evaluate',
      dispatchId,
      action: 'STOP',
      workerIdx,
    };

    this.client.send(message);
    logger.info('JavaAgentTcpIntegration', `Sent STOP command for dispatch ${dispatchId}`);
  }

  /**
   * Check if connected to Java Agent.
   */
  isConnected(): boolean {
    return this.initialized && this.client.isConnected();
  }

  /**
   * Shutdown the TCP integration.
   */
  shutdown(): void {
    this.client.disconnect();
    this.initialized = false;
  }
}
