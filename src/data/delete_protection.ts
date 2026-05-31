export interface DeleteCommand {
  targetId: string;
  contentType: string;
  requestedBy: string;
}

export class DeleteProtection {
  private readonly immutablePrefixes = new Set([
    'constitution_',
    'inst_core_',
    'culture_constitution',
    'core_scheduler'
  ]);

  private mockTrashDb = new Map();

  /**
   * Check if a resource can be deleted based on protection rules
   */
  public canDelete(contentType: string, targetId: string): { allowed: boolean; reason?: string } {
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

  public interceptAndExecute(command: DeleteCommand, currentContent: any) {
    console.log("[AUDIT_LOG] 接收到来自 Agent [" + command.requestedBy + "] 针对实体 [" + command.targetId + "] 的删除请求...");

    for (const prefix of this.immutablePrefixes) {
      if (command.targetId.startsWith(prefix)) {
        console.error("[SECURITY_ALERT] 🚨 触发硬拦截! 拒绝 Agent " + command.requestedBy + " 对核心 Immutable 制度资产 [" + command.targetId + "] 的物理删除破坏企图!");
        return { success: false, action: 'BLOCKED' };
      }
    }

    const trashPayload = {
      originalId: command.targetId,
      deletedBy: command.requestedBy,
      deletedAt: Date.now(),
      purgesAt: Date.now() + (30 * 24 * 60 * 60 * 1000),
      payload: JSON.parse(JSON.stringify(currentContent))
    };

    this.mockTrashDb.set(command.targetId, trashPayload);
    console.warn("[AUDIT_LOG] 🍃 软删除应用完成. 原始文件 [" + command.targetId + "] 已移入回收站冷归档，原存储区已被抹平。");
    return { success: true, action: 'SOFT_DELETED' };
  }

  public getTrashManifest() {
    return Array.from(this.mockTrashDb.values());
  }
}