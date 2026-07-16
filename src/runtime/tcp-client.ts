/**
 * src/runtime/tcp-client.ts
 *
 * TCP client for communication with Java Agent (port 8771).
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Connects to Java Agent's TCP server at 127.0.0.1:8771</li>
 *   <li>Newline-delimited JSON protocol</li>
 *   <li>Auto-reconnect with exponential backoff</li>
 *   <li>Message correlation for request-response pattern</li>
 * </ul>
 */

import * as net from 'net';
import { EventEmitter } from 'events';

export interface TcpMessage {
  type: string;
  dispatchId?: string;
  workerIdx?: number;
  [key: string]: any;
}

export class JavaAgentTcpClient extends EventEmitter {
  private host: string;
  private port: number;
  private socket: net.Socket | null = null;
  private connected = false;
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 2000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private buffer = '';
  private messageId = 0;
  private pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(host = '127.0.0.1', port = 8771) {
    super();
    this.host = host;
    this.port = port;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected && this.socket) {
        resolve();
        return;
      }

      // Reset intentionalClose on a fresh connect attempt
      this.intentionalClose = false;

      this.socket = new net.Socket();

      this.socket.connect(this.port, this.host, () => {
        console.log(`[tcp-client] Connected to Java Agent at ${this.host}:${this.port}`);
        this.connected = true;
        this.reconnectAttempts = 0;
        this.emit('connected');
        resolve();
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.emit('disconnected');
        // Only attempt reconnect if this was NOT an intentional disconnect
        if (!this.intentionalClose) {
          this.attemptReconnect();
        }
      });

      this.socket.on('error', (error) => {
        console.error(`[tcp-client] Connection error: ${error.message}`);
        this.emit('error', error);
        // Only reject if the connection attempt is still pending
        if (!this.connected) {
          reject(error);
        }
      });
    });
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');

    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (e) {
          console.error(`[tcp-client] Failed to parse message: ${line}`);
        }
      }
    }
  }

  private handleMessage(message: TcpMessage): void {
    // Handle responses to pending requests
    if (message.messageId && this.pendingRequests.has(message.messageId)) {
      const pending = this.pendingRequests.get(message.messageId)!;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.messageId);

      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message);
      }
      return;
    }

    // Handle events
    this.emit('message', message);

    // Handle specific event types
    switch (message.type) {
      case 'worker_started':
        this.emit('workerStarted', message);
        break;
      case 'worker_chunk':
        this.emit('workerChunk', message);
        break;
      case 'worker_done':
        this.emit('workerDone', message);
        break;
      case 'worker_failed':
        this.emit('workerFailed', message);
        break;
      case 'tool_call':
        this.emit('toolCall', message);
        break;
      case 'pool_share':
        this.emit('poolShare', message);
        break;
      case 'dispatch_done':
        this.emit('dispatchDone', message);
        break;
      case 'pong':
        // Heartbeat response, ignore
        break;
    }
  }

  private attemptReconnect(): void {
    if (this.intentionalClose) {
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[tcp-client] Max reconnection attempts reached');
      this.emit('reconnectFailed');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`[tcp-client] Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // Reconnect failed, will retry
      });
    }, delay);
  }

  send(message: TcpMessage): void {
    if (!this.connected || !this.socket) {
      console.error('[tcp-client] Cannot send message: not connected');
      return;
    }

    const json = JSON.stringify(message);
    this.socket.write(json + '\n');
  }

  sendAndWait(message: TcpMessage, timeoutMs = 30000): Promise<TcpMessage> {
    return new Promise((resolve, reject) => {
      const messageId = `msg_${++this.messageId}`;
      message.messageId = messageId;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(messageId);
        reject(new Error(`Request timeout: ${message.type}`));
      }, timeoutMs);

      this.pendingRequests.set(messageId, { resolve, reject, timeout });
      this.send(message);
    });
  }

  disconnect(): void {
    this.intentionalClose = true;

    // Cancel any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject any pending requests so callers don't wait for full timeout
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
