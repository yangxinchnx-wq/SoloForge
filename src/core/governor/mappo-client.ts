// ─────────────────────────────────────────────────────────────────
// SoloForge Core Layer: Python MAPPO Governor Physical IPC Client
// Path: src/core/governor/mappo-client.ts
// ─────────────────────────────────────────────────────────────────

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import crypto from 'crypto';

/**
 * 🐍 顶置资源控流 Python MAPPO 神经网络物理 IPC 客户端
 *
 * 调用 Python 服务: python/marl_service/server.py
 * 协议: {id, globalState, localObs} → {id, action, mode, reason}
 */
export class GeminiMappoResourceGovernorClient {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private responseResolvers: Map<string, (val: number) => void> = new Map();
  private pendingRequests: Map<string, {
    resolve: (val: number) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = new Map();

  constructor() {
    this.bootPythonGovernorContext();
  }

  /**
   * 获取 Python 服务路径
   * 优先级: python/marl_service/server.py → infra/mappo_governor.py (向后兼容)
   */
  private getPythonScriptPath(): string | null {
    const baseWorkspace = process.cwd();

    // 优先: python/marl_service/server.py
    const primaryPath = path.join(baseWorkspace, 'python', 'marl_service', 'server.py');
    if (fs.existsSync(primaryPath)) {
      return primaryPath;
    }

    // 回退: infra/mappo_governor.py (向后兼容旧代码)
    const legacyPath = path.join(baseWorkspace, 'infra', 'mappo_governor.py');
    if (fs.existsSync(legacyPath)) {
      console.warn(`[PYTHON_IPC_WARN] ⚠️  使用旧版脚本 [${legacyPath}]，建议迁移到 python/marl_service/server.py`);
      return legacyPath;
    }

    return null;
  }

  /**
   * 点火：动态拉起常驻后台的 Python 控流多智能体强化学习网络
   */
  private bootPythonGovernorContext(): void {
    const scriptPath = this.getPythonScriptPath();

    if (!scriptPath) {
      console.warn(`\n[PYTHON_IPC_WARN] ⚠️  未找到 Python MAPPO 服务脚本:`);
      console.warn(`[PYTHON_IPC_WARN]   - python/marl_service/server.py`);
      console.warn(`[PYTHON_IPC_WARN]   - infra/mappo_governor.py`);
      console.warn(`[PYTHON_IPC_WARN] 🔌 控流大盘已自动切入【高仿真本地内存决策桩】托管运作。\n`);
      return;
    }

    console.log(`[PYTHON_IPC_INFO] 🐍 发现 Python 服务: ${scriptPath}`);

    // 跨平台自适应：Windows 优先叫 python，Linux/Mac 优先叫 python3
    const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
    this.process = spawn(pythonExecutable, [scriptPath]);

    if (this.process.stdout) {
      this.rl = readline.createInterface({ input: this.process.stdout });
      this.rl.on('line', (line) => {
        this.handlePythonResponse(line);
      });
    }

    this.process.on('error', (err) => {
      console.warn(`[PYTHON_IPC_WARN] ⚠️  无法启动 Python 服务: ${err.message}`);
      console.warn(`[PYTHON_IPC_WARN] 🔌 资源控流面已完全切入【高仿真本地内存决策桩】托管运作。`);
      this.process = null;
    });

    this.process.on('exit', (code) => {
      console.warn(`[PYTHON_IPC_WARN] ⚠️  Python 服务意外退出，code=${code}`);
      this.process = null;
    });
  }

  /**
   * 处理 Python 服务响应
   */
  private handlePythonResponse(line: string): void {
    try {
      const packet = JSON.parse(line);
      const requestId = packet.id;

      if (requestId && this.pendingRequests.has(requestId)) {
        const pending = this.pendingRequests.get(requestId)!;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);
        pending.resolve(packet.action);
      }
    } catch (e) {
      // 忽略非 JSON 行（如日志）
    }
  }

  /**
   * 检查进程是否仍然存活
   */
  private isProcessAlive(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /**
   * 检查 stdin 是否可用
   */
  private isStdinWritable(): boolean {
    if (!this.process?.stdin) return false;
    try {
      // 检查流是否可写
      return (this.process.stdin as any).writableLength !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * ⚡ 物理遥测推理：将当前大盘高维物理特征流推入 Stdin，异步等待 MAPPO 神经元做出控流决议
   */
  public async evaluateMappoResourceVector(globalState: number[], localObs: number[]): Promise<number> {
    const currentCpu = globalState[0];

    // 弹性兜底：如果 Python 进程不可用或不可写，走沙盒仿真硬断路器逻辑
    if (!this.isProcessAlive() || !this.isStdinWritable()) {
      // 高负载直接触发 2 级强熔断
      if (currentCpu > 0.95) return 2;
      // 中等负载触发 1 级降级
      if (currentCpu > 0.70) return 1;
      // 正常负载放行
      return 0;
    }

    const requestId = crypto.randomUUID();
    const outgoingPacket = {
      id: requestId,
      globalState,
      localObs
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        // 超时时走仿真桩逻辑
        resolve(currentCpu > 0.95 ? 2 : (currentCpu > 0.70 ? 1 : 0));
      }, 3000);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.process!.stdin!.write(JSON.stringify(outgoingPacket) + '\n');
    });
  }

  /**
   * 优雅归还句柄
   */
  public safelyTerminateGovernorContext(): void {
    if (this.rl) this.rl.close();
    if (this.process) {
      this.process.kill();
      this.process = null;
      console.log('[PYTHON_IPC_SHUTDOWN] 回收 Python 强化学习控流常驻句柄成功。');
    }
    this.pendingRequests.clear();
  }
}