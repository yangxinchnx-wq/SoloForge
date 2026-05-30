// ─────────────────────────────────────────────────────────────────
// SoloForge Core Layer: Python MAPPO Governor IPC Client
// Path: src/core/governor/mappo-client.ts
//
// 协议: UDS/TCP + MessagePack
// ─────────────────────────────────────────────────────────────────

import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { IPCClient } from './ipc';

/**
 * 🐍 顶置资源控流 Python MAPPO 神经网络 IPC 客户端
 *
 * 调用 Python 服务: python/marl_service/server.py
 * 协议: MessagePack over UDS/TCP
 */
export class GeminiMappoResourceGovernorClient {
  private ipcClient: IPCClient | null = null;
  private pythonProcess: ChildProcess | null = null;
  private useFallback: boolean = true; // 默认使用 fallback
  private isWindows: boolean = process.platform === 'win32';

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
      console.warn(`[MAPPO] ⚠️  使用旧版脚本 [${legacyPath}]`);
      return legacyPath;
    }

    return null;
  }

  /**
   * 点火：启动 Python 服务并建立 IPC 连接
   */
  private async bootPythonGovernorContext(): Promise<void> {
    const scriptPath = this.getPythonScriptPath();

    if (!scriptPath) {
      console.warn(`[MAPPO] ⚠️  未找到 Python MAPPO 服务脚本`);
      console.warn(`[MAPPO]   - python/marl_service/server.py`);
      console.warn(`[MAPPO]   - infra/mappo_governor.py`);
      console.warn(`[MAPPO] 🔌 使用【本地内存决策桩】托管运作`);
      return;
    }

    console.log(`[MAPPO] 🐍 发现 Python 服务: ${scriptPath}`);

    // 跨平台自适应：Windows 优先叫 python，Linux/Mac 优先叫 python3
    const pythonExecutable = this.isWindows ? 'python' : 'python3';

    // 启动 Python 服务（后台运行）
    this.pythonProcess = spawn(pythonExecutable, [scriptPath], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 重定向 Python 输出
    this.pythonProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (line) console.log(`[PYTHON] ${line}`);
      }
    });

    this.pythonProcess.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (line) console.error(`[PYTHON ERROR] ${line}`);
      }
    });

    this.pythonProcess.on('error', (err) => {
      console.warn(`[MAPPO] ⚠️  无法启动 Python 服务: ${err.message}`);
    });

    this.pythonProcess.on('exit', (code) => {
      console.warn(`[MAPPO] ⚠️  Python 服务退出，code=${code}`);
      this.useFallback = true;
    });

    // 等待服务启动并连接
    await this.connectToPythonService();
  }

  /**
   * 连接到 Python IPC 服务
   */
  private async connectToPythonService(): Promise<void> {
    // 等待服务就绪
    await this.sleep(500);

    try {
      this.ipcClient = new IPCClient({
        autoReconnect: true,
        requestTimeout: 3000,
        connectTimeout: 5000,
      });

      this.ipcClient.onConnected(() => {
        this.useFallback = false;
        console.log('[MAPPO] ✅ MAPPO 神经网络已激活');
      });

      this.ipcClient.onDisconnected(() => {
        this.useFallback = true;
        console.warn('[MAPPO] ⚠️ MAPPO 降级为启发式决策');
      });

      await this.ipcClient.connect();
      this.useFallback = false;
      console.log('[MAPPO] ✅ MAPPO 神经网络已激活');
    } catch (err) {
      console.warn(`[MAPPO] ⚠️ IPC 连接失败: ${(err as Error).message}`);
      console.warn(`[MAPPO] 🔌 使用【本地内存决策桩】`);
      this.useFallback = true;
    }
  }

  /**
   * 休眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 启发式 fallback（本地内存决策桩）
   */
  private heuristicFallback(globalState: number[]): number {
    const currentCpu = globalState[0] || 0;

    // 高负载直接触发 2 级强熔断
    if (currentCpu > 0.95) return 2;
    // 中等负载触发 1 级降级
    if (currentCpu > 0.70) return 1;
    // 正常负载放行
    return 0;
  }

  /**
   * ⚡ 物理遥测推理：通过 IPC 推入 Python 服务，获取 MAPPO 决策
   */
  public async evaluateMappoResourceVector(
    globalState: number[],
    localObs: number[]
  ): Promise<number> {
    // Fallback 模式：使用本地启发式
    if (this.useFallback || !this.ipcClient?.isConnected()) {
      return this.heuristicFallback(globalState);
    }

    try {
      const response = await this.ipcClient.send({
        globalState,
        localObs,
        timestamp: Date.now(),
      }) as Record<string, unknown>;

      return response.action as number;
    } catch (err) {
      console.warn(`[MAPPO] IPC 调用失败: ${(err as Error).message}`);
      return this.heuristicFallback(globalState);
    }
  }

  /**
   * 优雅关闭
   */
  public safelyTerminateGovernorContext(): void {
    if (this.ipcClient) {
      this.ipcClient.disconnect();
      this.ipcClient = null;
    }

    if (this.pythonProcess) {
      this.pythonProcess.kill();
      this.pythonProcess = null;
    }

    console.log('[MAPPO] 🔒 Python 强化学习控流常驻句柄已回收');
  }
}
