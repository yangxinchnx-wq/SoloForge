// ────────────────────────────────────────────────────────────
// SoloForge API Server — WebSocket / SSE Manager
// Path: src/server/ws-manager.ts
//
// Manages:
//   - SSE client connections (add / remove / broadcast)
//   - AgentEventHub lifecycle (attaches to HTTP server)
// ────────────────────────────────────────────────────────────

import http from 'http';
import type { RuntimeKernel } from '../kernel/runtime-kernel';
import type { AgentEventHub } from '../core/agent/agent-event-hub';
import type { AuthConfig } from '../security/auth';

// ------------------------------------------------------------
// SSE Client Manager
// ------------------------------------------------------------

export class SseManager {
  private clients: Set<http.ServerResponse> = new Set();

  /** Register a new SSE client connection */
  add(client: http.ServerResponse): void {
    this.clients.add(client);
  }

  /** Remove a client (on disconnect) */
  remove(client: http.ServerResponse): void {
    this.clients.delete(client);
  }

  /** Number of active SSE connections */
  get size(): number {
    return this.clients.size;
  }

  /** Send an SSE event to all connected clients; prune dead connections */
  broadcast(event: string, payload: any): void {
    const data = JSON.stringify({ event, payload, timestamp: Date.now() });
    const sseData = `data: ${data}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(sseData);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** Close all connections (used during shutdown) */
  closeAll(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  /**
   * Set up a new SSE connection:
   *   - Write 200 + headers
   *   - Send initial "connected" event
   *   - Register for future broadcasts
   *   - Auto-remove on disconnect
   */
  handleConnection(req: http.IncomingMessage, res: http.ServerResponse, authConfig: AuthConfig): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': authConfig.allowedOrigins.includes(String(req.headers['origin'] || ''))
        ? String(req.headers['origin'])
        : (authConfig.allowedOrigins[0] || ''),
    });

    res.write(`data: ${JSON.stringify({ event: 'connected', timestamp: Date.now() })}\n\n`);
    this.add(res);

    req.on('close', () => {
      this.remove(res);
    });
  }
}

// ------------------------------------------------------------
// Agent Event Hub Wrapper
// ------------------------------------------------------------

export class AgentEventHubManager {
  private hub: AgentEventHub | null = null;

  /**
   * Lazily initialise and attach the AgentEventHub to the HTTP server.
   * Safe to call multiple times — will no-op if already attached.
   */
  ensureAttached(kernel: RuntimeKernel, server: http.Server): void {
    if (!this.hub) {
      // Use dynamic import() instead of require() for ESM compatibility
      import('../core/agent/agent-event-hub').then(({ AgentEventHub }) => {
        this.hub = new AgentEventHub(kernel);
        this.hub.attach(server);
      }).catch(err => {
        // [Quality Fix] Conditional error output — suppress in production
        if (process.env.NODE_ENV !== 'production') {
          console.error('[AgentEventHubManager] Failed to load AgentEventHub:', err.message);
        }
      });
    }
  }

  /** Reference to the underlying hub (may be null before first attach) */
  getHub(): AgentEventHub | null {
    return this.hub;
  }
}
