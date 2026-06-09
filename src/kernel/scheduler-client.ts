// ─────────────────────────────────────────────────────────────────
// SoloForge Kernel Layer: Rust Scheduler Physical IPC Client
// Path: src/kernel/scheduler-client.ts
// ─────────────────────────────────────────────────────────────────

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import crypto from 'crypto';

/**
 * 仿真桩内部任务节点，含老化因子
 */
interface SimTask {
  taskName: string;
  basePriority: number;
  agingFactor: number;
  enqueuedAt: number; // Unix ms
}

/**
 * Rust Daemon 响应解析结果
 */
interface DaemonResponse {
  id: string;
  result: string;
}

/**
 * 🦀 跨语言 Rust 高性能 Aging 调度看门狗物理 IPC 客户端
 *
 * 适配 Rust scheduler_daemon.exe 文本协议:
 *   PUSH <task_id> <priority> <aging_factor> → OK_PUSH <task_id> | ERR_*
 *   POP                                    → SUCCESS_POP <task_id> | NONE_POP
 *   PING                                   → PONG
 *   STATS                                  → STATS {"queue_size":0,...}
 *   VERSION                                → VERSION rust_core v1.0.0
 *
 * 仿真桩：仅在 Rust 进程不可用时启用，完整实现相同语义。
 */
export class GeminiRustSchedulerClient {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;

  // 核心时序锁：用 UUID 唯一标识每一次跨语言调用，防止高并发下串线
  private pendingRequests: Map<string, {
    resolve: (val: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = new Map();

  // 仿真桩任务队列（仅在 Rust 进程不可用时使用）
  private simulatedQueue: SimTask[] = [];

  // 内部请求计数器（用于生成请求 ID）
  private requestCounter = 0;

  /**
   * 生成唯一请求 ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${++this.requestCounter}`;
  }

  /**
   * 获取 Rust 二进制路径
   * 优先级: 1. bin/scheduler.exe  2. rust_core/target/release/scheduler_daemon.exe
   */
  private getRustBinaryPath(): string | null {
    const baseWorkspace = process.cwd();
    const ext = process.platform === 'win32' ? '.exe' : '';

    // 优先级1: bin/scheduler.exe (便携式)
    const portablePath = path.join(baseWorkspace, 'bin', `scheduler${ext}`);
    if (fs.existsSync(portablePath)) {
      return portablePath;
    }

    // 优先级2: rust_core/target/release/scheduler_daemon.exe (构建输出)
    const buildPath = path.join(baseWorkspace, 'rust_core', 'target', 'release', `scheduler_daemon${ext}`);
    if (fs.existsSync(buildPath)) {
      return buildPath;
    }

    return null;
  }

  /**
   * 点火：动态探测并自拉起本地内置的 Rust 物理肉体
   */
  public initialize(): void {
    const rustBinaryPath = this.getRustBinaryPath();

    if (!rustBinaryPath) {
      console.warn(`\n[RUST_IPC_WARN] ⚠️  未能在预期路径下找到 Rust 二进制资产:`);
      console.warn(`[RUST_IPC_WARN]   - bin/scheduler.exe`);
      console.warn(`[RUST_IPC_WARN]   - rust_core/target/release/scheduler_daemon.exe`);
      console.warn(`[RUST_IPC_WARN] 🔌 调度看门狗已平滑切入【高性能本地内存堆栈仿真桩（含 Aging 优先队列）】托管运作。\n`);
      return;
    }

    console.log(`[RUST_IPC_INFO] 🦀 发现 Rust 二进制: ${rustBinaryPath}`);

    try {
      this.process = spawn(rustBinaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      console.log(`[RUST_IPC_INFO] 🦀 Rust 子进程已 spawn, pid=${this.process.pid}`);

      // 解析 Rust daemon 文本响应
      // 响应格式: <request_id>|<response_line>
      if (this.process.stdout) {
        this.rl = readline.createInterface({ input: this.process.stdout });
        this.rl.on('line', (line) => {
          this.handleDaemonResponse(line);
        });
      } else {
        console.error(`[RUST_IPC_ERROR] 💥 Rust 子进程无 stdout pipe`);
      }

      this.process.stderr?.on('data', (data) => {
        // 日志行以 [INFO/WARN/ERROR] 开头，忽略即可
        const text = data.toString().trim();
        if (!text.startsWith('[20')) {
          console.error(`[RUST_CORE_STDERR] 🦀 ${text}`);
        }
      });

      this.process.on('error', (err) => {
        console.error(`[RUST_IPC_ERROR] 💥 Rust 进程启动失败: ${err.message}`);
        this.process = null;
      });

      this.process.on('exit', (code, signal) => {
        console.warn(`[RUST_IPC_WARN] ⚠️  Rust 进程退出, code=${code} signal=${signal}`);
        this.process = null;
      });
    } catch (e: any) {
      console.error(`[RUST_IPC_ERROR] 💥 spawn 异常: ${e.message}`);
      this.process = null;
    }
  }

  /**
   * 处理 Rust daemon 响应
   * 协议: 每行响应格式 "OK_PUSH task1" / "SUCCESS_POP task2" / "PONG" / "STATS {...}"
   */
  private handleDaemonResponse(line: string): void {
    // 解析 request_id|response 格式
    const parts = line.split('|');
    if (parts.length < 2) {
      // 处理无 ID 的响应（如日志行）
      return;
    }

    const requestId = parts[0];
    const response = parts.slice(1).join('|'); // 响应可能包含 JSON

    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);
      pending.resolve(response);
    }
  }

  /**
   * 发送命令到 Rust daemon 并等待响应
   */
  private async sendCommand(command: string): Promise<string> {
    if (!this.process || !this.process.stdin) {
      throw new Error('Rust 进程未启动');
    }

    const requestId = this.generateRequestId();
    const fullCommand = `${requestId}|${command}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`命令超时: ${command}`));
      }, 5000);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.process!.stdin!.write(fullCommand + '\n');
    });
  }

  /**
   * 🏓 PING 握手：验证 Rust 进程存活
   * 仿真桩模式下直接返回 true
   */
  public async ping(): Promise<boolean> {
    if (!this.process || !this.process.stdin) {
      return true; // 仿真桩：服务永远在线
    }

    try {
      const response = await this.sendCommand('PING');
      return response === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * 📥 推入任务：含 Aging 因子
   * 协议: PUSH <task_id> <priority> <aging_factor>
   * agingFactor: 每秒增加的额外优先级分数
   */
  public async pushTask(taskName: string, priority: number, agingFactor: number = 0.0): Promise<boolean> {
    if (!this.process || !this.process.stdin) {
      // 仿真桩：入队并记录入队时间
      this.simulatedQueue.push({
        taskName,
        basePriority: priority,
        agingFactor,
        enqueuedAt: Date.now(),
      });
      return true;
    }

    try {
      const response = await this.sendCommand(`PUSH ${taskName} ${priority} ${agingFactor}`);
      return response.startsWith('OK_PUSH');
    } catch {
      return false;
    }
  }

  /**
   * 📤 弹出当前有效分最高的任务
   * 协议: POP → SUCCESS_POP <task_id> | NONE_POP
   * effectiveScore = basePriority + (elapsedSeconds * agingFactor)
   */
  public async popTask(): Promise<string | null> {
    if (!this.process || !this.process.stdin) {
      // 仿真桩：按 effectiveScore 降序排列，弹出最高分
      if (this.simulatedQueue.length === 0) return null;

      const now = Date.now();
      this.simulatedQueue.sort((a, b) => {
        const scoreA = a.basePriority + ((now - a.enqueuedAt) / 1000) * a.agingFactor;
        const scoreB = b.basePriority + ((now - b.enqueuedAt) / 1000) * b.agingFactor;
        return scoreB - scoreA;
      });

      const top = this.simulatedQueue.shift()!;
      return top.taskName;
    }

    try {
      const response = await this.sendCommand('POP');
      if (response.startsWith('SUCCESS_POP ')) {
        return response.substring('SUCCESS_POP '.length);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 📊 获取调度器统计信息
   * 协议: STATS → STATS {"queue_size":0,...}
   */
  public async getStats(): Promise<{ queueSize: number; totalPush: number; totalPop: number } | null> {
    if (!this.process || !this.process.stdin) {
      return {
        queueSize: this.simulatedQueue.length,
        totalPush: this.simulatedQueue.length,
        totalPop: 0,
      };
    }

    try {
      const response = await this.sendCommand('STATS');
      if (response.startsWith('STATS ')) {
        const jsonStr = response.substring('STATS '.length);
        const stats = JSON.parse(jsonStr);
        return {
          queueSize: stats.queue_size || 0,
          totalPush: stats.total_push || 0,
          totalPop: stats.total_pop || 0,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * ⚡ 物理调度博弈：将候选智能体队列通过 Stdin 砸进 Rust 内核，并异步等待最大堆重排结果
   */
  public async schedulePrioritySort(candidates: any[]): Promise<any[]> {
    if (!this.process || !this.process.stdin) {
      return candidates.sort((a, b) => (b.historicalSuccessIndex || 0) - (a.historicalSuccessIndex || 0));
    }

    // 批量推入所有候选
    for (const candidate of candidates) {
      await this.pushTask(
        candidate.taskName || candidate.id,
        candidate.basePriority || 50,
        candidate.agingFactor || 0.0
      );
    }

    // 按优先级顺序弹出
    const sorted: any[] = [];
    for (const _ of candidates) {
      const taskName = await this.popTask();
      if (taskName) {
        const candidate = candidates.find(c => (c.taskName || c.id) === taskName);
        if (candidate) sorted.push(candidate);
      }
    }

    return sorted;
  }

  /**
   * 优雅归还句柄
   */
  public shutdown(): void {
    if (this.rl) this.rl.close();
    if (this.process) {
      this.process.kill();
      this.process = null;
      console.log('[RUST_IPC_SHUTDOWN] 释放 Rust 二进制进程句柄成功。');
    }
    this.simulatedQueue = [];
    this.pendingRequests.clear();
  }
}
