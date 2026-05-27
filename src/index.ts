// ─────────────────────────────────────────────────────────────────
// SoloForge Entry Layer: Pure Zero-Knowledge Lifecycle Watchdog
// Path: src/index.ts
// ─────────────────────────────────────────────────────────────────

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { Surreal } from 'surrealdb';

import { kernel, RuntimeMode } from './kernel/runtime-kernel';
import { logger } from './core/logger';

class SoloForgePureSupervisor {
  private readonly kernel = kernel;
  private surrealRawClient: Surreal | null = null;
  private databaseProcess: ChildProcess | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private telemetryCycles = 0;
  private isShuttingDown = false;
  private readonly DB_PORT = 8003;

  constructor() {
    logger.info('Supervisor', '⚓ SoloForge 纯净零知识生命周期看门狗启动...');
  }

  private async checkPortAvailability(): Promise<boolean> {
    return new Promise((resolve) => {
      const tester = net.createServer();
      tester.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          logger.error('Supervisor', `💥 端口 ${this.DB_PORT} 已被占用`);
          resolve(false);
        }
      });
      tester.once('listening', () => {
        tester.close();
        resolve(true);
      });
      tester.listen(this.DB_PORT, '127.0.0.1');
    });
  }

  private startEmbeddedDatabase() {
    const base = process.cwd();
    const ext = process.platform === 'win32' ? '.exe' : '';
    const binary = path.join(base, 'bin', `surreal${ext}`);

    if (!fs.existsSync(binary)) {
      logger.error('Supervisor', `SurrealDB binary not found: ${binary}`);
      process.exit(1);
    }

    this.databaseProcess = spawn(binary, [
      'start',
      '--user', 'root',
      '--pass', 'root',
      '--bind', `127.0.0.1:${this.DB_PORT}`,
      'surrealkv:data/soloforge_db'
    ]);

    this.databaseProcess.stderr?.on('data', (data) => {
      logger.debug('SurrealDB', data.toString().trim());
    });
  }

  public async bootPipeline(): Promise<void> {
    if (!(await this.checkPortAvailability())) {
      process.exit(1);
    }

    this.startEmbeddedDatabase();

    let retries = 10;
    this.surrealRawClient = new Surreal();

    while (retries > 0) {
      try {
        await Promise.race([
          this.surrealRawClient.connect(`ws://127.0.0.1:${this.DB_PORT}/rpc`),
          new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 1500))
        ]);

        await this.surrealRawClient.signin({ username: 'root', password: 'root' });
        await this.surrealRawClient.use({ namespace: 'soloforge_core', database: 'autonomous_network' });

        const schemaPath = path.join(process.cwd(), 'infra', 'schema.surql');
        if (fs.existsSync(schemaPath)) {
          try {
            await this.surrealRawClient.query(fs.readFileSync(schemaPath, 'utf8'));
          } catch (e: any) {
            if (!e.message?.includes('already exists')) throw e;
          }
        }

        const { bootstrapSystemNetwork } = await import('./bootstrap').catch(() => ({
          bootstrapSystemNetwork: async (k: any) => {
            logger.warn('Bootstrap', '使用轻量兜底装配');
            k.bootstrapCoreLinkages({
              commandBus: { execute: async (cmd: any) => ({ success: true, cmd }) },
              transactionManager: { begin: async () => ({ id: 'tx' }), commit: async () => {}, rollback: async () => {}, drain: async () => {} },
              projectionManager: { updateAll: () => {}, replayEvent: async () => {} },
              snapshotManager: { createFullSnapshot: async () => 'snap', recover: async () => {}, replayEvent: async () => {} },
              scheduler: { drain: async () => {} }
            });
          }
        }));

        await bootstrapSystemNetwork(this.kernel, this.surrealRawClient);
        logger.info('Supervisor', '✅ SoloForge 纯净看门狗基础设施就绪');
        return;
      } catch (err) {
        retries--;
        logger.warn('Supervisor', `启动重试中... 剩余 ${retries} 次`);
        await new Promise(r => setTimeout(r, 600));
      }
    }

    logger.error('Supervisor', '💥 持久化底座启动失败');
    process.exit(1);
  }

  public startEventLoop(): void {
    const runCycle = async () => {
      if (this.isShuttingDown || this.kernel.getMode() === RuntimeMode.RECOVERY) return;
      this.telemetryCycles++;

      try {
        await Promise.race([
          this.kernel.executeCommand({
            type: 'SYS_HEARTBEAT',
            domain: 'WorkspaceRuntime',
            caller: 'SYSTEM_MASTER_DAEMON',   // 关键修复
            payload: {
              tickId: this.telemetryCycles,
              timestamp: Date.now()
            }
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('HEARTBEAT_TIMEOUT')), 1000))
        ]);

        logger.info('Supervisor', `❤️ 心跳 #${this.telemetryCycles} 执行成功`);
      } catch (err: any) {
        logger.error('Supervisor', `💥 心跳异常 #${this.telemetryCycles}`, { error: err.message });
        this.kernel.setMode(RuntimeMode.RECOVERY);
        setTimeout(() => this.kernel.setMode(RuntimeMode.NORMAL), 2000);
      }
    };

    this.pollingTimer = setInterval(runCycle, 2000);
  }

  public async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.warn('Supervisor', `接收终止信号 [${signal}]，优雅关闭...`);
    if (this.pollingTimer) clearInterval(this.pollingTimer);

    try {
      await this.kernel.shutdown();
      if (this.surrealRawClient) await this.surrealRawClient.close();
      if (this.databaseProcess) this.databaseProcess.kill();
    } catch (e) {
      logger.error('Supervisor', '关闭时发生错误', e);
    }

    logger.info('Supervisor', '✅ SoloForge 安全退出');
    process.exit(0);
  }
}

async function main() {
  const supervisor = new SoloForgePureSupervisor();

  process.on('SIGINT', () => supervisor.shutdown('SIGINT'));
  process.on('SIGTERM', () => supervisor.shutdown('SIGTERM'));

  await supervisor.bootPipeline();
  supervisor.startEventLoop();
}

main().catch(err => {
  console.error('[FATAL] 启动失败:', err);
  process.exit(1);
});