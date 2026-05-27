// src/index.ts
import crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { Surreal } from 'surrealdb';

import { kernel, RuntimeMode } from './kernel/runtime-kernel';
import { CommandBus } from './kernel/command-bus';
import { TransactionManager } from './kernel/transaction-manager';
import { logger, LogLevel } from './core/logger';

import { GeminiRustSchedulerClient } from './kernel/scheduler-client';
import { GeminiMappoResourceGovernorClient } from './core/governor/mappo-client';
import { GeminiPersistenceManager } from './data/surreal_persistence';
import { SurrealLiveWebSocketDriver } from './data/surreal_driver_live';
import { AIRuntimeModule } from './kernel/domains/ai-runtime';

class SoloForgeMasterSupervisor {
  private readonly kernel = kernel;
  private rustScheduler: GeminiRustSchedulerClient;
  private governorClient: GeminiMappoResourceGovernorClient;
  private aiModule!: AIRuntimeModule;

  private surrealRawClient: Surreal | null = null;
  private databaseProcess: ChildProcess | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;

  private telemetryCycles = 0;
  private isShuttingDown = false;
  private readonly DB_PORT = 8003;

  constructor() {
    logger.info('Supervisor', '⚓ SoloForge 生产级生命周期看门狗启动...');
    (logger as any).minLevel = LogLevel.INFO; // 生产环境屏蔽 DEBUG 噪音

    this.rustScheduler = new GeminiRustSchedulerClient();
    this.governorClient = new GeminiMappoResourceGovernorClient();
  }

  /** 物理环境安全校验 */
  private async verifyPhysicalEnvironmentReady(): Promise<boolean> {
    return new Promise((resolve) => {
      const tester = net.createServer();
      tester.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          logger.error('Supervisor', `端口 ${this.DB_PORT} 已被占用，启动中止`);
          resolve(false);
        }
      });
      tester.once('listening', () => {
        tester.close();
        this.cleanupLockFiles();
        resolve(true);
      });
      tester.listen(this.DB_PORT, '127.0.0.1');
    });
  }

  private cleanupLockFiles() {
    const lockPath = path.join(process.cwd(), 'data', 'soloforge_db', 'LOCK');
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
        logger.warn('Supervisor', '已清理残留数据库锁文件');
      } catch (e) {
        logger.error('Supervisor', '清理锁文件失败', e);
      }
    }
  }

  private spawnDatabaseDaemon() {
    const base = process.cwd();
    const ext = process.platform === 'win32' ? '.exe' : '';
    const binary = path.join(base, 'bin', `surreal${ext}`);

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

  /** 核心启动流水线 */
  public async bootPipeline(): Promise<void> {
    if (!(await this.verifyPhysicalEnvironmentReady())) {
      process.exit(1);
    }

    this.spawnDatabaseDaemon();
    this.rustScheduler.initialize();

    let retries = 12;
    this.surrealRawClient = new Surreal();

    while (retries > 0) {
      try {
        await Promise.race([
          this.surrealRawClient.connect(`ws://127.0.0.1:${this.DB_PORT}/rpc`),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 1200))
        ]);

        await this.surrealRawClient.signin({ username: 'root', password: 'root' });
        await this.surrealRawClient.use({ namespace: 'soloforge_core', database: 'autonomous_network' });

        // Schema 迁移（幂等）
        const schemaPath = path.join(process.cwd(), 'infra', 'schema.surql');
        if (fs.existsSync(schemaPath)) {
          try {
            await this.surrealRawClient.query(fs.readFileSync(schemaPath, 'utf8'));
          } catch (e: any) {
            if (!e.message?.includes('already exists')) throw e;
          }
        }

        const liveDriver = new SurrealLiveWebSocketDriver(this.surrealRawClient);
        const persistence = new GeminiPersistenceManager(liveDriver);

        // 组装微内核
        const commandBus = new CommandBus(this.kernel);
        const transactionManager = new TransactionManager(this.kernel);

        commandBus.registerHandler('SYSTEM_LOG_EVENT', async (cmd) => persistence.logEvent(cmd.payload));
        commandBus.registerHandler('TELEMETRY_LOG_MARL', async (cmd) => persistence.logMarlEpisode(cmd.payload));

        this.kernel.bootstrapCoreLinkages({
          commandBus,
          transactionManager,
          projectionManager: { updateAll: () => {}, replayEvent: async () => {} },
          snapshotManager: { createFullSnapshot: async () => 'snap', recover: async () => {}, replayEvent: async () => {} },
          scheduler: this.rustScheduler
        });

        // 挂载 AI 领域板卡
        this.aiModule = new AIRuntimeModule(this.kernel, liveDriver, this.rustScheduler);
        this.aiModule.mount();

        logger.info('Supervisor', '✅ SoloForge 核心系统已完全就绪');
        return;
      } catch (err) {
        retries--;
        logger.warn('Supervisor', `数据库连接重试中... 剩余 ${retries} 次`);
        await new Promise(r => setTimeout(r, 400));
      }
    }

    logger.error('Supervisor', '❌ 数据库启动失败');
    process.exit(1);
  }

  public startEventLoop(): void {
    this.pollingTimer = setInterval(async () => {
      if (this.isShuttingDown) return;
      if (this.kernel.getMode() === RuntimeMode.RECOVERY) return;

      this.telemetryCycles++;
      const uuid = crypto.randomUUID();
      const mockCpu = this.telemetryCycles % 4 === 0 ? 0.96 : 0.45;

      try {
        await this.governorClient.evaluateMappoResourceVector([mockCpu, 0.35, 0.12], [0, 0]);

        if (this.aiModule) {
          await this.aiModule.tickRacerFlow(uuid, mockCpu);
          if (this.telemetryCycles % 2 === 0) {
            await this.aiModule.tickJudicialCourt(uuid);
          }
        }

        logger.info('Supervisor', `⚡ [CYCLE #${this.telemetryCycles}] 执行完成 | 版本钟: v${this.kernel.version}`);
      } catch (err: any) {
        logger.error('Supervisor', `脉冲异常，触发自愈`, err);
        this.kernel.setMode(RuntimeMode.RECOVERY);
        setTimeout(() => this.kernel.setMode(RuntimeMode.NORMAL), 1500);
      }
    }, 2000);
  }

  public async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.warn('Supervisor', `捕获终止信号 [${signal}]，开始优雅关闭...`);
    if (this.pollingTimer) clearInterval(this.pollingTimer);

    try {
      await this.kernel.shutdown();
      this.rustScheduler.shutdown();
      if (this.surrealRawClient) await this.surrealRawClient.close();
      if (this.databaseProcess) this.databaseProcess.kill();
    } catch (e) {
      logger.error('Supervisor', '关闭过程中出现异常', e);
    }

    logger.info('Supervisor', '✅ SoloForge 已安全关闭');
    process.exit(0);
  }
}

// ====================== 主启动入口 ======================
async function main() {
  const supervisor = new SoloForgeMasterSupervisor();

  process.on('SIGINT', () => supervisor.shutdown('SIGINT'));
  process.on('SIGTERM', () => supervisor.shutdown('SIGTERM'));

  await supervisor.bootPipeline();
  supervisor.startEventLoop();
}

main().catch(err => {
  logger.error('Main', '致命启动失败', err);
  process.exit(1);
});