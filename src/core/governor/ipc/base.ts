// ─────────────────────────────────────────────────────────────────
// SoloForge IPC Client Base: 跨平台 Socket 通信客户端
// Path: src/core/governor/ipc/base.ts
//
// 支持:
//   - Unix Domain Socket (Linux/Mac)
//   - TCP Socket (Windows 回退)
// ─────────────────────────────────────────────────────────────────

import { Socket, createConnection } from 'net';
import * as msgpack from '@msgpack/msgpack';

const SOCKET_NAME = 'soloforge_mappo';
const TCP_PORT = 18765;
const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 3;

export interface IPCClientOptions {
  /** 自动重连 */
  autoReconnect?: boolean;
  /** 连接超时 (ms) */
  connectTimeout?: number;
  /** 请求超时 (ms) */
  requestTimeout?: number;
}

/**
 * 跨平台 IPC 客户端
 */
export class IPCClient {
  private socket: Socket | null = null;
  private socketPath: string;
  private isWindows: boolean;
  private options: Required<IPCClientOptions>;

  private responseResolvers: Map<string, {
    resolve: (val: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = new Map();

  private recvBuffer: Buffer = Buffer.alloc(0);
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private onDisconnect?: () => void;
  private onConnect?: () => void;

  constructor(options: IPCClientOptions = {}) {
    this.options = {
      autoReconnect: options.autoReconnect ?? true,
      connectTimeout: options.connectTimeout ?? 5000,
      requestTimeout: options.requestTimeout ?? 3000,
    };

    // 检测平台
    this.isWindows = process.platform === 'win32';

    // 设置套接字路径
    if (this.isWindows) {
      this.socketPath = `\\\\.\\pipe\\${SOCKET_NAME}`;
    } else {
      this.socketPath = `/tmp/${SOCKET_NAME}.sock`;
    }
  }

  /**
   * 连接到 IPC 服务
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`连接超时 (${this.options.connectTimeout}ms)`));
      }, this.options.connectTimeout);

      if (this.isWindows) {
        // Windows: Named Pipe (实际上是 TCP)
        this.socket = createConnection({ port: TCP_PORT, host: '127.0.0.1' });
      } else {
        // Unix: Domain Socket
        this.socket = createConnection(this.socketPath);
      }

      this.socket.on('connect', () => {
        clearTimeout(timeout);
        this.connected = true;
        this.reconnectAttempts = 0;
        console.log('[IPC] ✅ 已连接到 Python 服务');
        this.onConnect?.();
        resolve();
      });

      this.socket.on('data', (chunk: Buffer) => {
        this.handleData(chunk);
      });

      this.socket.on('close', () => {
        this.connected = false;
        console.log('[IPC] ⚠️ 与 Python 服务断开');
        this.onDisconnect?.();
        this.tryReconnect();
      });

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        console.error(`[IPC] ❌ 连接错误: ${err.message}`);
        if (!this.connected) {
          reject(err);
        }
      });
    });
  }

  /**
   * 处理接收到的数据（处理粘包）
   */
  private handleData(chunk: Buffer): void {
    this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);

    while (this.recvBuffer.length >= 4) {
      // 解析长度头 (4字节大端序)
      const length = this.recvBuffer.readUInt32BE(0);
      const totalLength = 4 + length;

      if (this.recvBuffer.length < totalLength) {
        // 数据不完整，等待更多
        break;
      }

      // 提取消息
      const msgBytes = this.recvBuffer.slice(4, totalLength);
      this.recvBuffer = this.recvBuffer.slice(totalLength);

      // 解码 MessagePack
      try {
        const msg = msgpack.decode(msgBytes) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch (e) {
        console.error('[IPC] 解码消息失败:', e);
      }
    }
  }

  /**
   * 处理完整的消息
   */
  private handleMessage(msg: Record<string, unknown>): void {
    const requestId = msg.id as string;

    if (requestId && this.responseResolvers.has(requestId)) {
      const pending = this.responseResolvers.get(requestId)!;
      clearTimeout(pending.timer);
      this.responseResolvers.delete(requestId);
      pending.resolve(msg);
    }
  }

  /**
   * 发送请求并等待响应
   */
  async send(data: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || !this.connected) {
      throw new Error('未连接到 IPC 服务');
    }

    const requestId = (data.id as string) || crypto.randomUUID();
    data.id = requestId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responseResolvers.delete(requestId);
        reject(new Error(`请求超时 (${this.options.requestTimeout}ms)`));
      }, this.options.requestTimeout);

      this.responseResolvers.set(requestId, { resolve, reject, timer });

      // 编码 MessagePack
      const msgBytes = msgpack.encode(data);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(msgBytes.byteLength);
      const packet = Buffer.concat([length, Buffer.from(msgBytes)]);

      this.socket!.write(packet);
    });
  }

  /**
   * 尝试重连
   */
  private tryReconnect(): void {
    if (!this.options.autoReconnect) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[IPC] 重连次数已达上限');
      return;
    }

    this.reconnectAttempts++;
    console.log(`[IPC] ${RECONNECT_DELAY_MS * this.reconnectAttempts}ms 后尝试重连 (${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

    setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // 重连失败，下次继续
      }
    }, RECONNECT_DELAY_MS * this.reconnectAttempts);
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.options.autoReconnect = false; // 防止自动重连
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.responseResolvers.clear();
  }

  /**
   * 设置断开回调
   */
  onDisconnected(cb: () => void): void {
    this.onDisconnect = cb;
  }

  /**
   * 设置连接回调
   */
  onConnected(cb: () => void): void {
    this.onConnect = cb;
  }
}
