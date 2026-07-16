/**
 * Tool result relay - forwards tool calls from Java Agent to appropriate backend.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Routes tool calls to Obscura, Browser-Use, Windows-MCP based on tool name</li>
 *   <li>Returns raw result to Java Agent (dumb pipe)</li>
 *   <li>No LLM processing - just relay</li>
 * </ul>
 */

import { JavaAgentTcpClient, TcpMessage } from '../../runtime/tcp-client';
import { logger } from '../logger';

export class ToolResultRelay {
  private client: JavaAgentTcpClient;

  constructor(client: JavaAgentTcpClient) {
    this.client = client;
  }

  /**
   * Handle incoming tool call from Java Agent.
   *
   * @param message Tool call message from Java Agent
   */
  async handleToolCall(message: TcpMessage): Promise<void> {
    const { dispatchId, workerIdx, tool, args } = message;

    logger.info('ToolResultRelay', `Relaying tool call: ${tool} for dispatch ${dispatchId}`);

    try {
      const result = await this.executeTool(tool, args);

      // Send result back to Java Agent
      await this.sendToolResult(dispatchId, workerIdx, tool, args, result);
    } catch (error) {
      logger.error('ToolResultRelay', `Tool execution failed: ${error}`);
      try {
        await this.sendToolResult(dispatchId, workerIdx, tool, args, `ERROR: ${error}`);
      } catch (sendErr) {
        logger.error('ToolResultRelay', `Failed to send error result back to Java: ${sendErr}`);
      }
    }
  }

  /**
   * Execute a tool and return the result without sending back to Java.
   * Used by HTTP endpoint and other direct callers.
   */
  async executeTool(tool: string, args: any): Promise<string> {
    logger.info('ToolResultRelay', `Executing tool: ${tool}`);

    let result: string;

    // Route to appropriate backend based on tool name
    switch (tool) {
      case 'browser_devtools':
      case 'browser_use':
      case 'bu_run_task':
      case 'bu_pause':
      case 'bu_resume':
      case 'bu_state':
      case 'bu_screenshot':
      case 'bu_history':
        result = await this.executeBrowserTool(tool, args);
        break;
      case 'win_reg_read':
      case 'service_ctrl':
      case 'task_scheduler':
      case 'event_log':
      case 'powershell':
      case 'firewall':
      case 'perfmon':
      case 'windows_mcp':
        result = await this.executeWindowsMcpTool(tool, args);
        break;
      case 'console':
      case 'network':
      case 'dom_inspect':
      case 'screenshot':
      case 'perf_trace':
      case 'cookies':
      case 'obscura':
        result = await this.executeObscuraTool(tool, args);
        break;
      default:
        result = `ERROR: Unknown tool: ${tool}`;
    }

    return result;
  }

  private async executeBrowserTool(tool: string, args: any): Promise<string> {
    // TODO: Implement browser tool execution via Playwright/Puppeteer
    // This should interface with the existing Browser-Use MCP server
    logger.info('ToolResultRelay', `Executing browser tool: ${tool}`);
    return `Browser tool ${tool} executed (placeholder)`;
  }

  private async executeWindowsMcpTool(tool: string, args: any): Promise<string> {
    // TODO: Implement Windows MCP tool execution
    // This should interface with Windows-MCP server for native Windows operations
    logger.info('ToolResultRelay', `Executing Windows MCP tool: ${tool}`);
    return `Windows MCP tool ${tool} executed (placeholder)`;
  }

  private async executeObscuraTool(tool: string, args: any): Promise<string> {
    // TODO: Implement Obscura tool execution
    // This should interface with Obscura for private browsing
    logger.info('ToolResultRelay', `Executing Obscura tool: ${tool}`);
    return `Obscura tool ${tool} executed (placeholder)`;
  }

  private async sendToolResult(
    dispatchId: string,
    workerIdx: number,
    tool: string,
    args: any,
    result: string
  ): Promise<void> {
    const message: TcpMessage = {
      type: 'tool_result',
      dispatchId,
      workerIdx,
      tool,
      args,
      result,
    };

    this.client.send(message);
    logger.info('ToolResultRelay', `Sent tool result for ${tool} back to Java Agent`);
  }
}
