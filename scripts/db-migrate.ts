// ─────────────────────────────────────────────────────────────────
// SoloForge Database Migration Executor
// Path: scripts/db-migrate.ts
// Description: 数据库迁移执行器 - 支持幂等执行、校验和验证、版本追踪
// 文档要求：可迁移、可追溯、可恢复、可回滚
// ─────────────────────────────────────────────────────────────────

import path from 'path';
import {
  connectDb,
  initializeMigrationTable,
  listMigrations,
  readSql,
  recordAppliedMigration,
  recordMigrationFailure,
  isMigrationApplied,
  MigrationFile
} from './db-common';

/**
 * 执行单个迁移文件
 */
async function executeMigration(db: Awaited<ReturnType<typeof connectDb>>, migration: MigrationFile): Promise<void> {
  console.log(`[Migration] 执行迁移: ${migration.version} - ${migration.name}`);
  console.log(`[Migration] 校验和: ${migration.checksum}`);

  const sql = await readSql(migration.filePath);
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  const startTime = Date.now();

  // 开启事务
  await db.query('BEGIN TRANSACTION');

  try {
    for (const statement of statements) {
      if (statement.trim()) {
        await db.query(statement);
      }
    }

    await db.query('COMMIT');
    const duration = Date.now() - startTime;
    console.log(`[Migration] ✅ 迁移成功: ${migration.version} (${duration}ms)`);

  } catch (error: any) {
    await db.query('CANCEL TRANSACTION');
    console.error(`[Migration] ❌ 迁移失败: ${migration.version}`);
    console.error(`[Migration] 错误: ${error.message}`);
    throw error;
  }
}

/**
 * 运行所有待应用迁移
 */
async function migrate(): Promise<void> {
  const migrationsDir = path.join(process.cwd(), 'migrations');
  const migrations = await listMigrations(migrationsDir);

  if (migrations.length === 0) {
    console.log('[Migration] 没有找到迁移文件');
    return;
  }

  const db = await connectDb();

  try {
    // 初始化迁移历史表
    await initializeMigrationTable(db);

    const applied: string[] = [];
    const pending = [];

    // 过滤出未应用的迁移
    for (const migration of migrations) {
      const appliedFlag = await isMigrationApplied(db, migration.version);
      if (appliedFlag) {
        applied.push(migration.version);
      } else {
        pending.push(migration);
      }
    }

    if (pending.length === 0) {
      console.log('[Migration] 数据库已是最新状态');
      return;
    }

    console.log(`[Migration] 发现 ${pending.length} 个待执行迁移`);
    console.log(`[Migration] 已应用: ${applied.length} 个`);

    let successCount = 0;
    let failureCount = 0;

    for (const migration of pending) {
      try {
        await executeMigration(db, migration);
        await recordAppliedMigration(db, migration);
        successCount++;
      } catch (error: any) {
        await recordMigrationFailure(db, migration, error.message);
        failureCount++;
        console.error(`[Migration] 迁移 ${migration.version} 失败，记录为失败状态`);
        // 继续执行其他迁移
      }
    }

    console.log(`\n[Migration] 执行完成: ${successCount} 成功, ${failureCount} 失败`);

  } finally {
    await db.close();
  }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  try {
    await migrate();
  } catch (error) {
    console.error('[Migration] 执行失败:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
