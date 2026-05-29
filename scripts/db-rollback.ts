// ─────────────────────────────────────────────────────────────────
// SoloForge Database Migration Rollback Executor
// Path: scripts/db-rollback.ts
// Description: 数据库回滚执行器 - 回滚最近一个迁移
// 文档要求：支持回滚、保证幂等
// ─────────────────────────────────────────────────────────────────

import path from 'path';
import {
  connectDb,
  getAppliedVersions,
  listMigrations,
  readSql,
  removeAppliedMigration,
  updateMigrationStatus
} from './db-common';

/**
 * 执行回滚
 */
async function rollback(): Promise<void> {
  const migrationsDir = path.join(process.cwd(), 'migrations');
  const downDir = path.join(migrationsDir, 'down');

  const migrations = await listMigrations(migrationsDir);
  const downMigrations = await listMigrations(downDir);
  const downByVersion = new Map(downMigrations.map((m) => [m.version, m]));

  const db = await connectDb();

  try {
    const appliedVersions = await getAppliedVersions(db);

    if (appliedVersions.length === 0) {
      console.log('[Rollback] 没有已应用的迁移可以回滚');
      return;
    }

    // 获取最近的迁移版本
    const sortedApplied = [...appliedVersions].sort((a, b) => b.localeCompare(a));
    const latestVersion = sortedApplied[0];

    console.log(`[Rollback] 回滚迁移版本: ${latestVersion}`);

    const latestMigration = migrations.find((m) => m.version === latestVersion);
    const downMigration = downByVersion.get(latestVersion);

    if (!latestMigration) {
      throw new Error(`[Rollback] 找不到原始迁移文件: ${latestVersion}`);
    }

    if (!downMigration) {
      throw new Error(`[Rollback] 找不到回滚脚本: ${latestVersion}`);
    }

    console.log(`[Rollback] 执行回滚脚本: ${downMigration.fileName}`);

    const downSql = await readSql(downMigration.filePath);
    const statements = downSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    // 开启事务
    await db.query('BEGIN TRANSACTION');

    try {
      for (const statement of statements) {
        if (statement.trim()) {
          try {
            await db.query(statement);
          } catch (error: any) {
            // REMOVE TABLE 可能因表不存在而失败，这是可接受的
            if (!error.message?.includes('not found') && !error.message?.includes('not a table')) {
              throw error;
            }
            console.warn(`[Rollback] 忽略非致命错误: ${error.message}`);
          }
        }
      }

      await db.query('COMMIT');

      // 更新迁移状态为已回滚
      await updateMigrationStatus(db, latestVersion, 'rolled_back');

      console.log(`[Rollback] ✅ 回滚成功: ${latestVersion}`);

    } catch (error: any) {
      await db.query('CANCEL TRANSACTION');
      console.error(`[Rollback] ❌ 回滚失败: ${error.message}`);
      throw error;
    }

  } finally {
    await db.close();
  }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  try {
    await rollback();
  } catch (error) {
    console.error('[Rollback] 执行失败:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
