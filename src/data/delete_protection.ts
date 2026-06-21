// ─────────────────────────────────────────────────────────────────
// SoloForge Data Layer: Delete Protection & Persistent Trash
// Path: src/data/delete_protection.ts
// Description: 软删除 + 持久化回收站 + 自动清理 + 恢复机制
// ─────────────────────────────────────────────────────────────────

import { SurrealDbDriverInterface } from './surreal_persistence';

// ============================================================
// 类型定义
// ============================================================

export interface DeleteCommand {
  targetId: string;
  contentType: string;
  requestedBy: string;
  reason?: string;
}

export interface TrashRecord {
  id: string;
  originalId: string;
  contentType: string;
  deletedBy: string;
  deletedAt: string;        // SurrealDB datetime
  purgesAt: string;         // SurrealDB datetime
  payload: string;          // JSON serialized content
  reason?: string;
  restored: boolean;
  restoredAt?: string;
  restoredBy?: string;
}

export interface DeleteResult {
  success: boolean;
  action: 'BLOCKED' | 'SOFT_DELETED';
  trashId?: string;
  reason?: string;
}

export interface RestoreResult {
  success: boolean;
  payload?: any;
  error?: string;
}

export interface PurgeResult {
  purgedCount: number;
  errors: string[];
}

// ============================================================
// Trash 持久化回收站
// ============================================================

/**
 * 🗑️ TrashDatabase: SurrealDB 持久化回收站
 *
 * 替代原先的内存 Map (mockTrashDb)，实现：
 * - 持久化存储：重启后回收站数据不丢失
 * - 过期自动清理：30天后自动删除
 * - 恢复机制：可从回收站恢复已删除数据
 * - 查询能力：支持按类型/实体/时间筛选
 */
export class TrashDatabase {
  private driver: SurrealDbDriverInterface;
  private readonly TABLE = 'trash';

  constructor(driver: SurrealDbDriverInterface) {
    this.driver = driver;
  }

  /**
   * 存入回收站
   */
  async insert(record: {
    originalId: string;
    contentType: string;
    deletedBy: string;
    deletedAt: number;
    purgesAt: number;
    payload: any;
    reason?: string;
  }): Promise<string> {
    const trashId = `trash_${record.originalId}_${record.deletedAt}`;

    await this.driver.query(
      `CREATE type::thing('trash', $trashId) CONTENT {
        originalId: $originalId,
        contentType: $contentType,
        deletedBy: $deletedBy,
        deletedAt: time::from::millis($deletedAt),
        purgesAt: time::from::millis($purgesAt),
        payload: $payload,
        reason: $reason,
        restored: false
      }`,
      {
        trashId,
        originalId: record.originalId,
        contentType: record.contentType,
        deletedBy: record.deletedBy,
        deletedAt: record.deletedAt,
        purgesAt: record.purgesAt,
        payload: JSON.stringify(record.payload),
        reason: record.reason || '',
      }
    );

    return trashId;
  }

  /**
   * 查询回收站列表（支持过滤）
   */
  async list(options?: {
    contentType?: string;
    restored?: boolean;
    limit?: number;
  }): Promise<TrashRecord[]> {
    let sql = 'SELECT * FROM trash';
    const conditions: string[] = [];

    if (options?.contentType) {
      conditions.push(`contentType = $contentType`);
    }
    if (options?.restored !== undefined) {
      conditions.push(`restored = $restored`);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY deletedAt DESC';

    if (options?.limit) {
      sql += ` LIMIT ${options.limit}`;
    }

    const result = await this.driver.query(sql, {
      contentType: options?.contentType || '',
      restored: options?.restored ?? false,
    });

    return (result[0] || []) as TrashRecord[];
  }

  /**
   * 根据 originalId 查找未恢复的记录
   */
  async findByOriginalId(originalId: string): Promise<TrashRecord | null> {
    const result = await this.driver.query(
      `SELECT * FROM trash WHERE originalId = $originalId AND restored = false ORDER BY deletedAt DESC LIMIT 1`,
      { originalId }
    );

    const records = result[0] || [];
    return records[0] as TrashRecord || null;
  }

  /**
   * 标记已恢复
   */
  async markRestored(trashId: string, restoredBy: string): Promise<void> {
    await this.driver.query(
      `UPDATE type::thing('trash', $trashId) SET
        restored = true,
        restoredAt = time::now(),
        restoredBy = $restoredBy
      `,
      { trashId, restoredBy }
    );
  }

  /**
   * 清理过期记录
   */
  async purgeExpired(): Promise<PurgeResult> {
    const errors: string[] = [];

    // 查找所有过期且未恢复的记录
    const expired = await this.driver.query(
      `SELECT * FROM trash WHERE purgesAt < time::now() AND restored = false`,
      {}
    );

    const records = (expired[0] || []) as TrashRecord[];
    let purgedCount = 0;

    for (const record of records) {
      try {
        await this.driver.query(
          `DELETE type::thing('trash', $id)`,
          { id: record.id }
        );
        purgedCount++;
      } catch (err: any) {
        errors.push(`purge ${record.id}: ${err.message}`);
      }
    }

    return { purgedCount, errors };
  }

  /**
   * 物理删除指定回收站记录
   */
  async remove(trashId: string): Promise<void> {
    await this.driver.query(
      `DELETE type::thing('trash', $trashId)`,
      { trashId }
    );
  }

  /**
   * 获取回收站统计
   */
  async stats(): Promise<{
    total: number;
    active: number;
    restored: number;
    expired: number;
  }> {
    const [total, active, restored, expired] = await Promise.all([
      this.driver.query('SELECT count() FROM trash GROUP ALL', {}),
      this.driver.query('SELECT count() FROM trash WHERE restored = false GROUP ALL', {}),
      this.driver.query('SELECT count() FROM trash WHERE restored = true GROUP ALL', {}),
      this.driver.query('SELECT count() FROM trash WHERE purgesAt < time::now() AND restored = false GROUP ALL', {}),
    ]);

    return {
      total: (total[0]?.[0] as any)?.count || 0,
      active: (active[0]?.[0] as any)?.count || 0,
      restored: (restored[0]?.[0] as any)?.count || 0,
      expired: (expired[0]?.[0] as any)?.count || 0,
    };
  }
}

// ============================================================
// Delete Protection 主逻辑
// ============================================================

export class DeleteProtection {
  private readonly immutablePrefixes = new Set([
    'constitution_',
    'inst_core_',
    'culture_constitution',
    'core_scheduler'
  ]);

  private trashDb: TrashDatabase | null = null;
  private memoryTrash: any[] = [];
  private autoPurgeTimer: NodeJS.Timeout | null = null;

  constructor(driver?: SurrealDbDriverInterface) {
    if (driver) {
      this.trashDb = new TrashDatabase(driver);
    }
  }

  /**
   * 绑定数据库驱动（延迟初始化）
   */
  setDriver(driver: SurrealDbDriverInterface): void {
    this.trashDb = new TrashDatabase(driver);
  }

  /**
   * 启动自动清理定时器
   * @param intervalMs 清理间隔，默认每小时一次
   */
  startAutoPurge(intervalMs: number = 3600000): void {
    if (this.autoPurgeTimer) return;

    this.autoPurgeTimer = setInterval(async () => {
      try {
        const result = await this.purgeExpired();
        if (result.purgedCount > 0) {
          console.log(`[Trash] 自动清理: ${result.purgedCount} 条过期记录已物理删除`);
        }
      } catch (err: any) {
        console.error(`[Trash] 自动清理失败: ${err.message}`);
      }
    }, intervalMs);

    console.log(`[Trash] 自动清理已启动，间隔 ${intervalMs / 1000}s`);
  }

  /**
   * 停止自动清理
   */
  stopAutoPurge(): void {
    if (this.autoPurgeTimer) {
      clearInterval(this.autoPurgeTimer);
      this.autoPurgeTimer = null;
    }
  }

  /**
   * 检查资源是否可以删除
   */
  canDelete(contentType: string, targetId: string): { allowed: boolean; reason?: string } {
    for (const prefix of this.immutablePrefixes) {
      if (targetId.startsWith(prefix)) {
        return {
          allowed: false,
          reason: `Resource ${targetId} is protected by immutable prefix ${prefix}`
        };
      }
    }
    return { allowed: true };
  }

  /**
   * 执行软删除：拦截 → 存入持久化回收站
   */
  async interceptAndExecute(command: DeleteCommand, currentContent: any): Promise<DeleteResult> {
    console.log(`[AUDIT_LOG] 接收到来自 Agent [${command.requestedBy}] 针对实体 [${command.targetId}] 的删除请求...`);

    // 不可变前缀硬拦截
    for (const prefix of this.immutablePrefixes) {
      if (command.targetId.startsWith(prefix)) {
        console.error(`[SECURITY_ALERT] 🚨 触发硬拦截! 拒绝 Agent ${command.requestedBy} 对核心 Immutable 制度资产 [${command.targetId}] 的物理删除破坏企图!`);
        return { success: false, action: 'BLOCKED', reason: `Immutable prefix: ${prefix}` };
      }
    }

    const now = Date.now();
    const retentionDays = 30;
    const purgesAt = now + retentionDays * 24 * 60 * 60 * 1000;

    // 持久化存入 SurrealDB 回收站
    if (this.trashDb) {
      try {
        const trashId = await this.trashDb.insert({
          originalId: command.targetId,
          contentType: command.contentType,
          deletedBy: command.requestedBy,
          deletedAt: now,
          purgesAt,
          payload: currentContent,
          reason: command.reason,
        });

        console.warn(`[AUDIT_LOG] 🍃 软删除应用完成. 原始文件 [${command.targetId}] 已移入持久化回收站 [${trashId}]，${retentionDays}天后自动清理。`);
        return { success: true, action: 'SOFT_DELETED', trashId };
      } catch (err: any) {
        console.error(`[AUDIT_LOG] 持久化回收站写入失败，回退到内存模式: ${err.message}`);
      }
    }

    // 回退：无驱动时内存暂存
    const trashPayload = {
      originalId: command.targetId,
      contentType: command.contentType,
      deletedBy: command.requestedBy,
      deletedAt: new Date(now).toISOString(),
      purgesAt: new Date(purgesAt).toISOString(),
      payload: JSON.parse(JSON.stringify(currentContent)),
      reason: command.reason,
      restored: false,
    };

    this.memoryTrash.push(trashPayload);
    console.warn(`[AUDIT_LOG] 🍃 软删除应用完成（内存模式）. 原始文件 [${command.targetId}] 已暂存。`);
    return { success: true, action: 'SOFT_DELETED' };
  }

  /**
   * 恢复已删除的资源
   */
  async restore(targetId: string, restoredBy: string): Promise<RestoreResult> {
    if (!this.trashDb) {
      return { success: false, error: '回收站未初始化（缺少数据库驱动）' };
    }

    const record = await this.trashDb.findByOriginalId(targetId);
    if (!record) {
      return { success: false, error: `未找到 [${targetId}] 的回收站记录` };
    }

    // 标记已恢复
    await this.trashDb.markRestored(record.id, restoredBy);

    // 反序列化原始数据
    let payload: any;
    try {
      payload = typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload;
    } catch {
      payload = record.payload;
    }

    console.log(`[AUDIT_LOG] ♻️ 资源 [${targetId}] 已由 ${restoredBy} 从回收站恢复`);
    return { success: true, payload };
  }

  /**
   * 查看回收站列表
   */
  async getTrashManifest(options?: {
    contentType?: string;
    limit?: number;
  }): Promise<TrashRecord[]> {
    if (!this.trashDb) {
      return this.memoryTrash as TrashRecord[];
    }

    return this.trashDb.list({
      contentType: options?.contentType,
      restored: false,
      limit: options?.limit || 100,
    });
  }

  /**
   * 手动清理过期记录
   */
  async purgeExpired(): Promise<PurgeResult> {
    if (!this.trashDb) {
      return { purgedCount: 0, errors: ['回收站未初始化'] };
    }

    return this.trashDb.purgeExpired();
  }

  /**
   * 获取回收站统计
   */
  async getStats() {
    if (!this.trashDb) {
      return { total: 0, active: 0, restored: 0, expired: 0 };
    }

    return this.trashDb.stats();
  }
}
