// ─────────────────────────────────────────────────────────────────
// SoloForge Agent Event Hub
// Path: src/api-server/agent-event-hub.ts
//
// 职责: 把后端 agent 相关事件 (AgentTaskDispatched / Executed / ReputationUpdated / DisputeRaised)
//        + court 事件 (ARBITRATION_DECIDED / DEADLOCK_DETECTED)
//        实时广播给所有已连接的 WebSocket 客户端 (Electron main process)
//
// 协议 (与 Electron main.cjs 约定的简单 JSON):
//   server → client: { type, payload, ts }
//   client → server: { type: 'ping' }  → reply { type: 'pong', ts }
// ─────────────────────────────────────────────────────────────────

import type { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket as WSClient } from 'ws';
import { logger } from '../logger';
import type { RuntimeKernel } from '../../kernel/runtime-kernel';
import { RuntimeEvent } from '../events/runtime-events';
import { CourtEvent } from '../events/court-events';

export interface AgentEventMessage {
  type: string;
  payload: any;
  ts: number;
}

/**
 * 🛰️ Agent 事件广播中心 — WebSocket Hub
 *
 * 单例, 挂载在 api-server 的 HTTP server 上, 通过 `upgrade` 事件拦截
 * `/ws/agents` 路径的连接请求
 */
export class AgentEventHub {
  private readonly moduleName = 'AgentEventHub';
  private readonly wss: WebSocketServer;
  private readonly clients: Set<WSClient> = new Set();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private subscribed = false;
  private eventHandlers: Array<{ event: string; handler: (payload: any) => void }> = [];

  constructor(private readonly kernel: RuntimeKernel) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * 挂载到 HTTP server 的 upgrade 事件上
   */
  public attach(httpServer: HttpServer): void {
    httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
      const url = req.url || '';
      if (!url.startsWith('/ws/agents')) {
        return;
      }

      // Token authentication: check ?token=xxx query parameter
      // (Browser WebSocket API doesn't support custom headers, so token goes in URL)
      try {
        const parsedUrl = new URL(url, 'http://localhost');
        const token = parsedUrl.searchParams.get('token');
        const apiTokens = this.kernel.configCenter?.get?.('security.apiTokens', []) ?? [];
        const requireTokens = process.env.SOLOFORGE_REQUIRE_TOKENS !== '0';

        if (requireTokens && apiTokens.length > 0) {
          if (!token || !apiTokens.includes(token)) {
            logger.warn(this.moduleName, `WS auth failed: invalid or missing token`);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
        }
      } catch (authErr: any) {
        logger.warn(this.moduleName, `WS auth error: ${authErr.message}`);
      }

      this.wss.handleUpgrade(req, socket as any, head, (ws) => {
        this.onConnection(ws);
      });
    });
    this.subscribeToBackendEvents();
    this.startHeartbeat();
    logger.info(this.moduleName, `🛰️ Agent WebSocket hub attached at ws://<host>/ws/agents`);
  }

  private onConnection(ws: WSClient): void {
    this.clients.add(ws);
    logger.info(this.moduleName, `🔗 client connected (total=${this.clients.size})`);

    // 立即推送当前快照
    this.sendSnapshotOnConnect(ws);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } else if (msg?.type === 'fiaacl.relay') {
          // FIPA-ACL 跨进程中继: 广播给除发送者外的所有客户端
          this.broadcastExcept(ws, msg);
        }
      } catch (e: any) {
        logger.debug(this.moduleName, `non-JSON message ignored: ${e.message}`);
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      logger.info(this.moduleName, `🔌 client disconnected (total=${this.clients.size})`);
    });

    ws.on('error', (e) => {
      logger.warn(this.moduleName, `client socket error: ${e.message}`);
      this.clients.delete(ws);
    });
  }

  /**
   * 订阅后端所有 agent 相关事件
   */
  private subscribeToBackendEvents(): void {
    if (this.subscribed || !this.kernel?.eventBus) return;
    const bus = this.kernel.eventBus;
    const eventsToForward: string[] = [
      RuntimeEvent.AgentTaskDispatched,
      RuntimeEvent.AgentTaskExecuted,
      RuntimeEvent.AgentReputationUpdated,
      RuntimeEvent.AgentDisputeRaised,
      CourtEvent.ARBITRATION_DECIDED,
      CourtEvent.DEADLOCK_DETECTED,
      CourtEvent.CLAIM_SUBMITTED,
      // 流送区 phase 事件 (Orchestrator v3)
      'phase0_subtask',
      'phase0_skip',
      'phase1_worker_start',
      'phase1_worker_done',
      'phase1_worker_error',
      'phase2_judge',
      'phase2_judge_error',
      'phase3_deliver_start',
      'phase3_deliver_done',
    ];
    for (const evt of eventsToForward) {
      const handler = (payload: any) => {
        this.broadcast({ type: evt, payload, ts: Date.now() });
      };
      bus.on(evt, handler);
      this.eventHandlers.push({ event: evt, handler });
    }
    this.subscribed = true;
  }

  private async sendSnapshotOnConnect(ws: WSClient): Promise<void> {
    try {
      const proxy = (this.kernel as any).agentRegistryProxy;
      if (proxy && typeof proxy.snapshot === 'function') {
        const snap = proxy.snapshot();
        this.send(ws, { type: 'agent.snapshot', payload: { agents: snap, cpuLoad: proxy.getCpuLoad?.() }, ts: Date.now() });
      }
    } catch (e: any) {
      logger.debug(this.moduleName, `snapshot on connect skipped: ${e.message}`);
    }
  }

  private broadcast(msg: AgentEventMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WSClient.OPEN) {
        try { ws.send(data); } catch (e: any) {
          logger.debug(this.moduleName, `send failed: ${e.message}`);
        }
      }
    }
  }

  /**
   * 广播给除发送者外的所有客户端 — 用于 FIPA-ACL 跨进程中继
   */
  private broadcastExcept(sender: WSClient, msg: any): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws !== sender && ws.readyState === WSClient.OPEN) {
        try { ws.send(data); } catch (e: any) {
          logger.debug(this.moduleName, `relay send failed: ${e.message}`);
        }
      }
    }
  }

  private send(ws: WSClient, msg: AgentEventMessage): void {
    if (ws.readyState === WSClient.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  /**
   * 30s 心跳 — 清理僵死连接
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.readyState !== WSClient.OPEN) {
          this.clients.delete(ws);
          continue;
        }
        try { ws.ping(); } catch { this.clients.delete(ws); }
      }
    }, 30000);
    this.heartbeatTimer.unref?.();
  }

  public close(): void {
    // 清理 eventBus 订阅
    if (this.kernel?.eventBus) {
      for (const { event, handler } of this.eventHandlers) {
        this.kernel.eventBus.off(event, handler);
      }
    }
    this.eventHandlers = [];
    this.subscribed = false;

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const ws of this.clients) {
      try { ws.close(1001, 'server shutdown'); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.wss.close();
  }
}
