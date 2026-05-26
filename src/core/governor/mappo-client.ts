// ─────────────────────────────────────────────────────────────────
// SoloForge Coordination Layer: MAPPO Resource Telemetry Pipe Client
// Path: src/core/governor/mappo-client.ts
// ─────────────────────────────────────────────────────────────────

import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import * as crypto from 'crypto';

export interface MappoResponse {
  action: number;
  mode: string;
  reason: string;
  _id: string;
}

export class GeminiMappoResourceGovernorClient {
  private pythonSubprocess: ChildProcess;
  private lineInterface: readline.Interface;
  // ✅ 完美修复 Flaw #5: 使用 Map 代替简单 Array 队列，通过唯一 UUID 锁死绑定，彻底杜绝高并发串线
  private pendingTransactions: Map<string, { resolve: (action: number) => void; reject: (err: any) => void; timer: NodeJS.Timeout }> = new Map();
  private totalSystemEpisodes = 0;

  constructor() {
    // 定向搜寻我们刚刚重构的物理 Python 脚本路径
    const targetPath = path.join(__dirname, '../../../python/marl_service/server.py');
    
    // 拉起底层原生常驻子进程
    this.pythonSubprocess = spawn('python3', [targetPath]);

    this.lineInterface = readline.createInterface({
      input: this.pythonSubprocess.stdout!,
      terminal: false
    });

    // 严密监听行切分流缓冲区，天然防御 TCP 粘包
    this.lineInterface.on('line', (lineData) => {
      try {
        const envelope: MappoResponse = JSON.parse(lineData);
        const transactionId = envelope._id;

        // 精准提取匹配的事务上下文
        const activeTx = this.pendingTransactions.get(transactionId);
        if (activeTx) {
          clearTimeout(activeTx.timer); // 撤销超时炸弹
          this.pendingTransactions.delete(transactionId); // 释放内存
          activeTx.resolve(envelope.action); // 顺利通关返回
        }
      } catch (err) {
        console.error(`[IPC_CORRUPTION] 串行流解析异常，强行丢弃受损帧:`, err);
      }
    });

    this.pythonSubprocess.stderr?.on('data', (diagnostics) => {
      console.warn(`[PYTHON_DIAGNOSTICS]`, diagnostics.toString().trim());
    });
  }

  /**
   * 向 Python 核心发射高速资源矩阵遥测数据
   */
  public async evaluateMappoResourceVector(
    globalStateMatrix: number[],
    agentObservationMatrix: number[]
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const transactionUUID = crypto.randomUUID(); // 生成唯一所有权令牌

      // 🛡️ 安全防御：建立 5000ms 硬熔断机制，防止 Python 端卡死导致主线程挂起
      const timeoutBomb = setTimeout(() => {
        if (this.pendingTransactions.has(transactionUUID)) {
          this.pendingTransactions.delete(transactionUUID);
          reject(new Error(`ERR_MAPPO_IPC_TIMEOUT: Python core failed to respond within 5000ms barrier.`));
        }
      }, 5000);

      // 注册事务上下文
      this.pendingTransactions.set(transactionUUID, { resolve, reject, timer: timeoutBomb });

      const outboundPacket = {
        _id: transactionUUID, // 注入钥匙
        episode_count: this.totalSystemEpisodes++,
        state: globalStateMatrix,
        obs: agentObservationMatrix
      };

      // 强行附加换行符，强力冲刷物理 Stdin 缓冲区
      this.pythonSubprocess.stdin?.write(JSON.stringify(outboundPacket) + '\n');
    });
  }

  public safelyTerminateGovernorContext(): void {
    this.lineInterface.close();
    this.pendingTransactions.forEach(tx => clearTimeout(tx.timer));
    this.pendingTransactions.clear();
    this.pythonSubprocess.kill('SIGTERM');
  }
}