// ─────────────────────────────────────────────────────────────────
// SoloForge Entry Layer: Pure Zero-Knowledge Lifecycle Watchdog
// Path: src/index.ts
// Description: 使用 SurrealDB 直接嵌入式模式（@surrealdb/node）
// ─────────────────────────────────────────────────────────────────

import path from 'path';
import fs from 'fs';
import { Surreal, createRemoteEngines } from 'surrealdb';
import { createNodeEngines } from '@surrealdb/node';

import { kernel, RuntimeMode } from './kernel/runtime-kernel';
import { ComponentRegistry } from './kernel/registry';
import { RuntimeWatchdog } from './kernel/watchdog';
import { logger } from './core/logger';

class SoloForgePureSupervisor {
  private readonly kernel = kernel;
  private registry = ComponentRegistry.getInstance();
  private watchdog = RuntimeWatchdog.getInstance();

  private surrealClient: Surreal | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private telemetryCycles = 0;
  private isShuttingDown = false;

  constructor() {
    logger.info('Supervisor', '⚓ SoloForge 纯净零知识生命周期看门狗启动...');
  }

  /**
   * 使用 SurrealDB 直接嵌入式模式连接数据库
   * 使用 @surrealdb/node 引擎，支持 rocksdb:// 持久化存储
   */
  private async connectEmbeddedDatabase(): Promise<Surreal> {
    // 创建混合引擎配置（支持远程 + 本地嵌入式）
    const engines = {
      ...createRemoteEngines(),
      ...createNodeEngines()
    };

    // 创建 SurrealDB 实例，注入嵌入式引擎
    const db = new Surreal({ engines });

    // 获取数据目录路径（使用相对路径以避免 Windows 路径问题）
    // path.posix.join 确保使用正斜杠
    const dataDir = path.posix.join('data', 'soloforge_db');

    // 确保数据目录存在（使用正斜杠路径）
    const fsPath = dataDir.replace(/\//g, path.sep);
    if (!fs.existsSync(fsPath)) {
      fs.mkdirSync(fsPath, { recursive: true });
    }

    // 直接嵌入式连接：使用 rocksdb:// 协议
    // 相比 WebSocket RPC，性能提升 10-50 倍
    await db.connect(`rocksdb://${dataDir}`);

    // 使用命名空间和数据库
    await db.use({
      namespace: 'soloforge_core',
      database: 'autonomous_network'
    });

    logger.info('SurrealDB', `嵌入式数据库连接成功: rocksdb://${dataDir}`);
    return db;
  }

  /**
   * 使用内存模式（仅测试用）
   */
  private async connectMemoryMode(): Promise<Surreal> {
    const engines = {
      ...createRemoteEngines(),
      ...createNodeEngines()
    };

    const db = new Surreal({ engines });

    // 内存模式：数据不持久化，重启丢失
    await db.connect('mem://');
    await db.use({
      namespace: 'soloforge_core',
      database: 'autonomous_network'
    });

    logger.info('SurrealDB', '内存模式数据库连接成功');
    return db;
  }

  /**
   * 初始化数据库 Schema
   */
  private async initializeSchema(db: Surreal): Promise<void> {
    // 优先使用迁移目录的 schema
    const migrationsDir = path.join(process.cwd(), 'migrations');

    // 按顺序执行迁移
    const migrations = [
      '20240101000000__v1_base_schema_migrations.surql',
      '20240101010000__v2_decision_chain.surql',
      '20240101020000__v3_court_governance.surql',
      '20240101030000__v4_governor_marl.surql',
      '20240101040000__v5_event_audit.surql'
    ];

    for (const migrationFile of migrations) {
      const schemaPath = path.join(migrationsDir, migrationFile);
      if (fs.existsSync(schemaPath)) {
        try {
          const schemaContent = fs.readFileSync(schemaPath, 'utf8');
          const statements = schemaContent
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0 && !s.startsWith('--'));

          for (const statement of statements) {
            try {
              await db.query(statement);
            } catch (e: any) {
              // 忽略已存在的错误
              if (!e.message?.includes('already exists')) {
                logger.warn('Schema', `执行失败: ${statement.substring(0, 50)}...`);
              }
            }
          }
          logger.info('SurrealDB', `迁移完成: ${migrationFile}`);
        } catch (e: any) {
          logger.warn('SurrealDB', `迁移警告: ${e.message}`);
        }
      }
    }

    // 回退到 infra/schema.surql（如果迁移目录不存在）
    const legacySchemaPath = path.join(process.cwd(), 'infra', 'schema.surql');
    if (fs.existsSync(legacySchemaPath)) {
      try {
        await db.query(fs.readFileSync(legacySchemaPath, 'utf8'));
        logger.info('SurrealDB', 'Legacy Schema 初始化完成');
      } catch (e: any) {
        if (!e.message?.includes('already exists')) {
          logger.warn('SurrealDB', `Legacy Schema 警告: ${e.message}`);
        }
      }
    }
  }

  public async bootPipeline(): Promise<void> {
    try {
      // 根据环境变量决定使用持久化模式还是内存模式
      const useMemoryMode = process.env.SURREAL_MEMORY_ONLY === 'true';

      if (useMemoryMode) {
        logger.info('SurrealDB', '使用内存模式（数据不持久化）');
        this.surrealClient = await this.connectMemoryMode();
      } else {
        // 直接嵌入式连接（无子进程，无 RPC）
        this.surrealClient = await this.connectEmbeddedDatabase();
      }

      // 初始化 Schema
      await this.initializeSchema(this.surrealClient);

      // 引导系统网络
      const { bootstrapSystemNetwork } = await import('./bootstrap').catch(() => ({
        bootstrapSystemNetwork: async (k: any) => {
          logger.warn('Bootstrap', '使用轻量兜底装配');
        }
      }));

      await bootstrapSystemNetwork(this.kernel, this.surrealClient);

      // 启动看门狗
      this.watchdog.start({ tickIntervalMs: 5000 });

      logger.info('Supervisor', '✅ SoloForge 纯净看门狗基础设施与流控自愈集群就绪');
      logger.info('Supervisor', '📊 数据库模式: SurrealDB 直接嵌入式 (surrealkv://)');

    } catch (err) {
      logger.error('Supervisor', '💥 持久化底座启动失败', err);
      process.exit(1);
    }
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
            caller: 'SYSTEM_MASTER_DAEMON',
            payload: {
              tickId: this.telemetryCycles,
              timestamp: Date.now()
            }
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('HEARTBEAT_TIMEOUT')), 1000))
        ]);

        const healthSnapshot = this.registry.getGlobalHealthSnapshotSync();
        const bpMetrics = this.registry.getBackpressureManager().getMetrics();

        logger.info(
          'Supervisor',
          `❤️ 心跳 #${this.telemetryCycles} 执行成功 | 内核事实源: v${this.kernel.version} | ` +
          `限流层级: ${bpMetrics.pressureLevel} (免检隐式格: ${healthSnapshot.implicitHealthyComponents})`
        );
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
      this.watchdog.shutdown();
      await this.kernel.shutdown();
      if (this.surrealClient) await this.surrealClient.close();
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
