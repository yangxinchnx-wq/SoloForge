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
 * 🦀 跨语言 Rust 高性能 Aging 调度看门狗物理 IPC 客户端
 * 
 * 当 Rust 二进制不存在时自动切入高仿真内存桩，桩内实现完整的
 * Priority + Aging 优先队列语义：
 *   effectiveScore = basePriority + (elapsedSeconds * agingFactor)
 * pop 时返回当前 effectiveScore 最高的任务名（string），队列空时返回 null。
 */
export class GeminiRustSchedulerClient {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;

  // 核心时序锁：用 UUID 唯一标识每一次跨语言调用，防止高并发下串线
  private responseResolvers: Map<string, (val: any) => void> = new Map();

  // 仿真桩任务队列（仅在 Rust 进程不可用时使用）
  private simulatedQueue: SimTask[] = [];

  /**
   * 点火：动态探测并自拉起本地内置的 Rust 物理肉体
   */
  public initialize(): void {
    const baseWorkspace = process.cwd();
    const ext = process.platform === 'win32' ? '.exe' : '';
    const rustBinaryPath = path.join(baseWorkspace, 'bin', `scheduler${ext}`);

    // 弹性防御：若物理资产丢失，自动开启内存高仿真算法桩，保护大盘点火
    if (!fs.existsSync(rustBinaryPath)) {
      console.warn(`\n[RUST_IPC_WARN] ⚠️  未能在便携路径 [${rustBinaryPath}] 下找到 Rust 二进制资产。`);
      console.warn(`[RUST_IPC_WARN] 🔌 调度看门狗已平滑切入【高性能本地内存堆栈仿真桩（含 Aging 优先队列）】托管运作。\n`);
      return;
    }

    this.process = spawn(rustBinaryPath, []);

    if (this.process.stdout) {
      this.rl = readline.createInterface({ input: this.process.stdout });
      this.rl.on('line', (line) => {
        try {
          const packet = JSON.parse(line);
          const resolver = this.responseResolvers.get(packet.id);
          if (resolver) {
            resolver(packet.result);
            this.responseResolvers.delete(packet.id);
          }
        } catch (e) {
          console.error(`[RUST_IPC_ERROR] 💥 解析 Rust Stdout 流原始数据破损:`, line);
        }
      });
    }

    this.process.stderr?.on('data', (data) => {
      console.error(`[RUST_CORE_STDERR] 🦀 Rust 内核抛出系统级故障:`, data.toString().trim());
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

    const requestId = crypto.randomUUID();
    const outgoingPacket = { id: requestId, action: 'PING', data: {} };

    return new Promise((resolve) => {
      // 500ms 超时保护
      const timer = setTimeout(() => {
        this.responseResolvers.delete(requestId);
        resolve(false);
      }, 500);
      this.responseResolvers.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result === 'PONG');
      });
      this.process!.stdin!.write(JSON.stringify(outgoingPacket) + '\n');
    });
  }

  /**
   * 📥 推入任务：含 Aging 因子
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

    const requestId = crypto.randomUUID();
    const outgoingPacket = {
      id: requestId,
      action: 'PUSH_TASK',
      data: { taskName, priority, agingFactor },
    };

    return new Promise((resolve) => {
      this.responseResolvers.set(requestId, () => resolve(true));
      this.process!.stdin!.write(JSON.stringify(outgoingPacket) + '\n');
    });
  }

  /**
   * 📤 弹出当前有效分最高的任务
   * effectiveScore = basePriority + (elapsedSeconds * agingFactor)
   * 队列为空时返回 null
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

    const requestId = crypto.randomUUID();
    const outgoingPacket = { id: requestId, action: 'POP_TASK', data: {} };

    return new Promise((resolve) => {
      this.responseResolvers.set(requestId, (result) => {
        resolve(result ?? null);
      });
      this.process!.stdin!.write(JSON.stringify(outgoingPacket) + '\n');
    });
  }

  /**
   * ⚡ 物理调度博弈：将候选智能体队列通过 Stdin 砸进 Rust 内核，并异步等待最大堆重排结果
   */
  public async schedulePrioritySort(candidates: any[]): Promise<any[]> {
    if (!this.process || !this.process.stdin) {
      return candidates.sort((a, b) => (b.historicalSuccessIndex || 0) - (a.historicalSuccessIndex || 0));
    }

    const requestId = crypto.randomUUID();
    const outgoingPacket = {
      id: requestId,
      action: 'PRIORITY_SORT',
      data: candidates,
    };

    return new Promise((resolve) => {
      this.responseResolvers.set(requestId, resolve);
      this.process!.stdin!.write(JSON.stringify(outgoingPacket) + '\n');
    });
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
  }
}
