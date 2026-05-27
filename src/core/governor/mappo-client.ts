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
 * 🐍 顶置资源资源控流 Python MAPPO 神经网络物理 IPC 客户端
 */
export class GeminiMappoResourceGovernorClient {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private responseResolvers: Map<string, (val: number) => void> = new Map();

  constructor() {
    this.bootPythonGovernorContext();
  }

  /**
   * 点火：动态拉起常驻后台的 Python 控流多智能体强化学习网络
   */
  private bootPythonGovernorContext(): void {
    const baseWorkspace = process.cwd();
    const scriptPath = path.join(baseWorkspace, 'infra', 'mappo_governor.py');

    if (!fs.existsSync(scriptPath)) {
      console.warn(`\n[PYTHON_IPC_WARN] ⚠️  未能在指定路径 [${scriptPath}] 下找到 Python 业务模型特征描述脚本。`);
      console.warn(`[PYTHON_IPC_WARN] 🔌 控流大盘已自动切入【高仿真本地内存决策桩】托管运作。\n`);
      return;
    }

    // 跨平台自适应：Windows 优先叫 python，Linux/Mac 优先叫 python3
    const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
    this.process = spawn(pythonExecutable, [scriptPath]);

    if (this.process.stdout) {
      this.rl = readline.createInterface({ input: this.process.stdout });
      this.rl.on('line', (line) => {
        try {
          const packet = JSON.parse(line);
          const resolver = this.responseResolvers.get(packet.id);
          if (resolver !== undefined && resolver !== null) {
            resolver(packet.action);
            this.responseResolvers.delete(packet.id);
          }
        } catch (e) {
          // 容错隔离：过滤掉 Python 脚本中可能原生 print 出来的框架初始化日志（如 PyTorch / CUDA 警告）
        }
      });
    }

    this.process.on('error', (err) => {
      console.warn(`[PYTHON_IPC_WARN] ⚠️  无法调用系统中的 [${pythonExecutable}] 命令启动神经网络: ${err.message}`);
      console.warn(`[PYTHON_IPC_WARN] 🔌 资源控流面已完全切入【高仿真本地内存决策桩】托管运作。`);
      this.process = null;
    });
  }

  /**
   * ⚡ 物理遥测推理：将当前大盘高维物理特征流推入 Stdin，异步等待 MAPPO 神经元做出控流决议
   */
  public async evaluateMappoResourceVector(globalState: number[], localObs: number[]): Promise<number> {
    // 弹性兜底：如果用户没配 Python 环境，走沙盒仿真硬断路器逻辑
    if (!this.process || !this.process.stdin) {
      const currentCpu = globalState[0];
      return currentCpu > 0.95 ? 2 : 0; // 高负载直接触发 2 级强熔断
    }

    const requestId = crypto.randomUUID();
    const outgoingPacket = {
      id: requestId,
      globalState,
      localObs
    };

    return new Promise((resolve) => {
      this.responseResolvers.set(requestId, resolve);
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
  }
}