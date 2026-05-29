// ─────────────────────────────────────────────────────────────────
// SoloForge Database Common Module
// Path: scripts/db-common.ts
// Description: 数据库迁移和连接公共模块
// ─────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import path from 'path';
import { Surreal, createRemoteEngines } from 'surrealdb';
import { createNodeEngines } from '@surrealdb/node';
import * as crypto from 'crypto';

// ============================================================
// 常量定义
// ============================================================
export const DB_PATH = 'data/soloforge_db';
export const NS = 'soloforge_core';
export const DB = 'autonomous_network';
export const MIGRATION_TABLE = 'migration_history';

// ============================================================
// 类型定义
// ============================================================
export interface MigrationFile {
  version: string;
  name: string;
  fileName: string;
  filePath: string;
  checksum: string;
}

export interface MigrationRecord {
  id?: string;
  version: string;
  name: string;
  status: 'pending' | 'applied' | 'rolled_back' | 'failed';
  direction: 'up' | 'down';
  checksum: string;
  appliedAt?: Date;
  rolledBackAt?: Date;
  errorMessage?: string;
  executedBy: string;
  metadata?: Record<string, unknown>;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 计算文件内容的 SHA256 校验和
 */
export function calculateChecksum(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * 解析迁移文件名
 * 格式: YYYYMMDDHHMM__description.surql (支持单下划线作为描述分隔符)
 */
export function parseMigrationFile(filePath: string): MigrationFile {
  const fileName = path.basename(filePath);
  // 支持多种格式: version__name.surql 或 version__name_part2.surql
  // 使用惰性匹配 (.+?) 来确保正确捕获
  const matched = /^(\d+)__(.+)\.surql$/.exec(fileName);

  if (!matched) {
    throw new Error(`无效的迁移文件名格式: ${fileName}，期望格式: YYYYMMDDHHMM__description.surql`);
  }

  return {
    version: matched[1],
    name: matched[2].replace(/_/g, ' '),
    fileName,
    filePath,
    checksum: '' // 稍后计算
  };
}

/**
 * 列出指定目录的所有迁移文件
 */
export async function listMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  const migrations: MigrationFile[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.surql')) {
      const filePath = path.join(dir, entry.name);
      const content = await fs.readFile(filePath, 'utf8');
      const migration = parseMigrationFile(filePath);
      migration.checksum = calculateChecksum(content);
      migrations.push(migration);
    }
  }

  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * 读取 SQL 文件内容
 */
export async function readSql(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

/**
 * 连接数据库（直接嵌入式模式）
 * 使用 @surrealdb/node 引擎 + rocksdb:// 协议
 * 无子进程，无网络 RPC 开销，性能比 WebSocket RPC 高 10-50 倍
 */
export async function connectDb(): Promise<Surreal> {
  // 创建混合引擎配置（支持远程 + 本地嵌入式）
  const engines = {
    ...createRemoteEngines(),
    ...createNodeEngines()
  };

  // 创建 SurrealDB 实例，注入嵌入式引擎
  const db = new Surreal({ engines });

  // 确保数据目录存在（使用相对路径以避免 Windows 路径中的冒号导致 URL 解析错误）
  const dataDir = DB_PATH; // 已经是相对路径: data/soloforge_db
  await fs.mkdir(dataDir, { recursive: true });

  // 直接嵌入式连接：使用 rocksdb:// 协议
  // 协议格式: rocksdb://data/soloforge_db
  await db.connect(`rocksdb://${dataDir}`);

  // 使用命名空间和数据库
  await db.use({
    namespace: NS,
    database: DB
  });

  return db;
}

/**
 * 初始化迁移历史表（如果不存在）
 */
export async function initializeMigrationTable(db: Surreal): Promise<void> {
  const checkSql = `
    DEFINE TABLE IF NOT EXISTS ${MIGRATION_TABLE} SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS version ON ${MIGRATION_TABLE} TYPE string;
    DEFINE INDEX IF NOT EXISTS migration_version_idx ON ${MIGRATION_TABLE} FIELDS version UNIQUE;
    DEFINE FIELD IF NOT EXISTS name ON ${MIGRATION_TABLE} TYPE string;
    DEFINE FIELD IF NOT EXISTS status ON ${MIGRATION_TABLE} TYPE string;
    DEFINE FIELD IF NOT EXISTS direction ON ${MIGRATION_TABLE} TYPE string;
    DEFINE FIELD IF NOT EXISTS checksum ON ${MIGRATION_TABLE} TYPE string;
    DEFINE FIELD IF NOT EXISTS appliedAt ON ${MIGRATION_TABLE} TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS rolledBackAt ON ${MIGRATION_TABLE} TYPE option<datetime>;
    DEFINE FIELD IF NOT EXISTS errorMessage ON ${MIGRATION_TABLE} TYPE option<string>;
    DEFINE FIELD IF NOT EXISTS executedBy ON ${MIGRATION_TABLE} TYPE string;
    DEFINE FIELD IF NOT EXISTS metadata ON ${MIGRATION_TABLE} TYPE option<object>;
  `;

  try {
    await db.query(checkSql);
  } catch (error: any) {
    // 如果表已存在，可能会报错，继续执行
    if (!error.message?.includes('already exists')) {
      console.warn('[Migration] 初始化迁移表时出现非致命错误:', error.message);
    }
  }
}

/**
 * 获取已应用的迁移版本列表
 */
export async function getAppliedVersions(db: Surreal): Promise<string[]> {
  try {
    const result = await db.query<[MigrationRecord[]]>(
      `SELECT version FROM ${MIGRATION_TABLE} WHERE status = 'applied' ORDER BY appliedAt ASC`
    );
    return result[0]?.map(r => r.version) || [];
  } catch {
    return [];
  }
}

/**
 * 检查迁移是否已应用
 */
export async function isMigrationApplied(db: Surreal, version: string): Promise<boolean> {
  try {
    const result = await db.query<[MigrationRecord[]]>(
      `SELECT * FROM ${MIGRATION_TABLE} WHERE version = $version AND status = 'applied'`,
      { version }
    );
    return (result[0]?.length || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 记录迁移应用
 */
export async function recordAppliedMigration(
  db: Surreal,
  migration: MigrationFile,
  executedBy: string = 'system'
): Promise<void> {
  const sql = `
    CREATE ${MIGRATION_TABLE} CONTENT {
      version: $version,
      name: $name,
      status: 'applied',
      direction: 'up',
      checksum: $checksum,
      appliedAt: time::now(),
      executedBy: $executedBy
    }
  `;

  await db.query(sql, {
    version: migration.version,
    name: migration.name,
    checksum: migration.checksum,
    executedBy
  });
}

/**
 * 记录迁移失败
 */
export async function recordMigrationFailure(
  db: Surreal,
  migration: MigrationFile,
  errorMessage: string,
  executedBy: string = 'system'
): Promise<void> {
  const sql = `
    CREATE ${MIGRATION_TABLE} CONTENT {
      version: $version,
      name: $name,
      status: 'failed',
      direction: 'up',
      checksum: $checksum,
      appliedAt: time::now(),
      errorMessage: $errorMessage,
      executedBy: $executedBy
    }
  `;

  await db.query(sql, {
    version: migration.version,
    name: migration.name,
    checksum: migration.checksum,
    errorMessage,
    executedBy
  });
}

/**
 * 删除迁移记录（回滚时使用）
 */
export async function removeAppliedMigration(db: Surreal, version: string): Promise<void> {
  try {
    await db.query(`DELETE ${MIGRATION_TABLE} WHERE version = $version`, { version });
  } catch (error: any) {
    // 忽略 "not found" 错误
    if (!error.message?.includes('not found')) {
      throw error;
    }
  }
}

/**
 * 更新迁移状态
 */
export async function updateMigrationStatus(
  db: Surreal,
  version: string,
  status: 'rolled_back' | 'failed',
  errorMessage?: string
): Promise<void> {
  const updateData: Record<string, unknown> = { status };

  if (status === 'rolled_back') {
    updateData.rolledBackAt = new Date();
  }

  if (errorMessage) {
    updateData.errorMessage = errorMessage;
  }

  await db.query(
    `UPDATE ${MIGRATION_TABLE} SET status = $status, rolledBackAt = $rolledBackAt WHERE version = $version`,
    { status, version, rolledBackAt: updateData.rolledBackAt || null }
  );
}
