// ─────────────────────────────────────────────────────────────────
// SoloForge Database Migration Status Viewer
// Path: scripts/db-status.ts
// Description: 查看数据库迁移状态
// 文档要求：可追溯、清晰展示
// ─────────────────────────────────────────────────────────────────

import path from 'path';
import { connectDb, getAppliedVersions, listMigrations } from './db-common';

/**
 * 显示迁移状态
 */
async function status(): Promise<void> {
  const migrationsDir = path.join(process.cwd(), 'migrations');
  const migrations = await listMigrations(migrationsDir);

  if (migrations.length === 0) {
    console.log('[Status] 没有找到迁移文件');
    return;
  }

  const db = await connectDb();

  try {
    const appliedVersions = await getAppliedVersions(db);
    const appliedSet = new Set(appliedVersions);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('   SoloForge 数据库迁移状态');
    console.log('═══════════════════════════════════════════════════════════════\n');
    console.log('版本           状态      名称');
    console.log('─'.repeat(70));

    for (const migration of migrations) {
      const status = appliedSet.has(migration.version) ? '✅ 已应用' : '⏳ 待执行';
      const name = migration.name;
      console.log(`${migration.version}  ${status.padEnd(10)} ${name}`);
    }

    console.log('─'.repeat(70));
    console.log(`总计: ${migrations.length} 个迁移, ${appliedVersions.length} 个已应用\n`);

    if (appliedVersions.length > 0) {
      console.log('═══════════════════════════════════════════════════════════════\n');
      console.log('最近应用的迁移:');
      const sortedApplied = [...appliedVersions].sort((a, b) => b.localeCompare(a));
      for (const version of sortedApplied.slice(0, 5)) {
        const migration = migrations.find(m => m.version === version);
        if (migration) {
          console.log(`  • ${migration.version} - ${migration.name}`);
        }
      }
      console.log('');
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
    await status();
  } catch (error) {
    console.error('[Status] 获取状态失败:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
