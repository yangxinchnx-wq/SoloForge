// ============================================================
// browser_use_service MCP stdio client
// ============================================================
//
// 跟 python/browser_use_service/server.py 通过 JSON-RPC 2.0 over stdio 通信
// 协议细节参考 MCP 规范: https://modelcontextprotocol.io/
//
// 生命周期:
//   - 第一次调用时 lazy 启动 Python 子进程
//   - 服务异常退出时自动重启 (最多 3 次)
//   - 优雅关闭: 进程级 SIGTERM + stdio drain

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';

const PROTOCOL_VERSION = '2024-11-05';

export interface McpResponse<T = any> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: any };
}

export interface McpNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: any;
}

export interface McpRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
}

type PendingResolver = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
};

export class BrowserUseMcpClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingResolver>();
  private buffer = '';
  private started = false;
  private initializing: Promise<void> | null = null;
  private restartCount = 0;
  private maxRestarts = 3;
  private tools: McpToolInfo[] = [];

  constructor(private readonly pythonPath: string, private readonly cwd: string) {
    super();
  }

  /**
   * 启动 MCP server 子进程并完成 initialize 握手
   */
  async start(): Promise<void> {
    if (this.started) return;
    if (this.initializing) return this.initializing;
    this.initializing = this._start();
    await this.initializing;
    this.initializing = null;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    this._killProc();
    for (const [id, p] of this.pending) {
      p.reject(new Error('MCP client stopped'));
      this.pending.delete(id);
    }
  }

  /**
   * 列出 MCP server 暴露的工具
   */
  async listTools(): Promise<McpToolInfo[]> {
    await this.start();
    if (this.tools.length > 0) return this.tools;
    const result = await this._request('tools/list', {});
    this.tools = result?.tools ?? [];
    return this.tools;
  }

  /**
   * 调用 MCP 工具
   */
  async callTool<T = any>(name: string, args: Record<string, any>): Promise<T> {
    await this.start();
    const result = await this._request('tools/call', { name, arguments: args });
    if (!result) return null as any;
    // 解析 text content
    if (result.content && Array.isArray(result.content)) {
      const textItem = result.content.find((c: any) => c.type === 'text');
      if (textItem) {
        try {
          return JSON.parse(textItem.text);
        } catch {
          return textItem.text as any;
        }
      }
    }
    if (result.isError) {
      const text = result.content?.[0]?.text ?? 'unknown error';
      throw new Error(`MCP tool error: ${text}`);
    }
    return result;
  }

  // ============================================================
  // 内部
  // ============================================================

  private async _start(): Promise<void> {
    const cmd = this._buildCommand();
    console.log('[bu-mcp] starting:', cmd.join(' '));

    this.proc = spawn(cmd[0], cmd.slice(1), {
      cwd: this.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf-8');
    this.proc.stderr.setEncoding('utf-8');

    this.proc.stdout.on('data', (chunk: string) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk: string) => {
      console.debug('[bu-mcp stderr]', chunk.trim());
    });
    this.proc.on('exit', (code) => this._onExit(code));
    this.proc.on('error', (err) => {
      console.error('[bu-mcp] process error:', err);
      this.emit('error', err);
    });

    // initialize 握手
    await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'soloforge-ui', version: '1.0.0' },
    });
    // initialized 通知
    this._notify('notifications/initialized', {});
  }

  private _onStdout(chunk: string): void {
    this.buffer += chunk;
    // LSP/MCP 风格: headers + \r\n\r\n + body
    // 我们简化为按行 \n 分割 (Python mcp SDK 输出每行一条 JSON)
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this._handleMessage(msg);
      } catch (e) {
        // 非 JSON 行可能是 banner
        console.debug('[bu-mcp stdout non-json]', line.slice(0, 200));
      }
    }
  }

  private _handleMessage(msg: any): void {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      // response
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(msg.error.message ?? 'MCP error'));
      } else {
        p.resolve(msg.result);
      }
    } else if (msg.method) {
      // notification
      this.emit('notification', msg);
      this.emit(`notification:${msg.method}`, msg.params);
    }
  }

  private _onExit(code: number | null): void {
    console.warn(`[bu-mcp] process exited with code ${code}`);
    this.proc = null;
    for (const [id, p] of this.pending) {
      p.reject(new Error(`MCP process exited (code ${code})`));
      this.pending.delete(id);
    }
    if (this.started && this.restartCount < this.maxRestarts) {
      this.restartCount++;
      console.log(`[bu-mcp] restarting (attempt ${this.restartCount}/${this.maxRestarts})`);
      setTimeout(() => this._start().catch((e) => console.error('[bu-mcp] restart failed', e)), 2000);
    } else {
      this.emit('exit', code);
    }
  }

  private _killProc(): void {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }

  private _request(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin.writable) {
        return reject(new Error('MCP process not running'));
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const req: McpRequest = { jsonrpc: '2.0', id, method, params };
      try {
        this.proc.stdin.write(JSON.stringify(req) + '\n');
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
      // 30s 超时
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request ${method} timed out after 30s`));
        }
      }, 30_000);
    });
  }

  private _notify(method: string, params?: any): void {
    if (!this.proc || !this.proc.stdin.writable) return;
    const msg = { jsonrpc: '2.0', method, params };
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      console.error('[bu-mcp] notify write failed', e);
    }
  }

  private _buildCommand(): string[] {
    // 优先用项目内 python (3.13 standalone), 退到 PATH python
    const candidates: string[] = [];
    const repoRoot = resolve(this.cwd, '..', '..');
    candidates.push(join(repoRoot, 'bin', 'python-3.13', 'python.exe'));
    candidates.push(this.pythonPath);
    candidates.push('python');
    candidates.push('python3');

    const python = candidates.find((c) => c === 'python' || c === 'python3' || existsSync(c)) ?? 'python';

    return [python, '-m', 'browser_use_service.server'];
  }
}
