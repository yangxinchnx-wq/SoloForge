/**
 * delete_protection.ts — Centralized delete guard for protected entities
 *
 * Provides:
 *   - Simple allow/deny check before soft-deleting protected resources
 *   - Hard-block interceptor for immutable constitution assets (prefix-based)
 *   - Soft-delete archival with trash manifest for audit trail
 *
 * Used by InstitutionEngine, governance tests, and other society modules.
 */

export interface DeleteCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface DeleteCommand {
  targetId: string;
  contentType: string;
  requestedBy: string;
}

export interface TrashEntry {
  targetId: string;
  contentType: string;
  deletedBy: string;
  payload: any;
  archivedAt: number;
}

export interface InterceptResult {
  success: boolean;
  action: 'BLOCKED' | 'SOFT_DELETED';
  reason?: string;
}

/** Prefixes that are constitutionally immutable — hard-block any delete attempt */
const IMMUTABLE_PREFIXES = ['constitution_', 'law_core_', 'sovereign_', 'core_scheduler'];

/**
 * DeleteProtection — controls which entity types can be deleted.
 *
 * Policy layers:
 *   1. Immutable prefix hard-block: targets matching IMMUTABLE_PREFIXES are never deletable
 *   2. Type-level lock: specific entity types can be locked via lock(type)
 *   3. Soft-delete archival: allowed deletes are routed to a trash manifest (30-day TTL)
 */
export class DeleteProtection {
  private readonly lockedTypes = new Set<string>();
  private readonly trash: TrashEntry[] = [];

  /** Lock a specific entity type — prevents all deletions of that type */
  lock(type: string): void {
    this.lockedTypes.add(type);
  }

  /** Unlock a previously locked type */
  unlock(type: string): void {
    this.lockedTypes.delete(type);
  }

  /**
   * Check if an entity of the given type can be deleted.
   * Returns { allowed: true } by default.
   * Returns { allowed: false, reason } if the type is locked.
   */
  canDelete(type: string, _id: string): DeleteCheckResult {
    if (this.lockedTypes.has(type)) {
      return {
        allowed: false,
        reason: `Entity type "${type}" is protected and cannot be deleted.`,
      };
    }
    return { allowed: true };
  }

  /**
   * Intercept and execute a delete command.
   * - Immutable prefix match → hard BLOCK, no trash entry
   * - Otherwise → soft-delete: archive to trash manifest
   */
  async interceptAndExecute(command: DeleteCommand, data: any): Promise<InterceptResult> {
    // Hard-block immutable assets
    for (const prefix of IMMUTABLE_PREFIXES) {
      if (command.targetId.startsWith(prefix)) {
        return { success: false, action: 'BLOCKED', reason: `Immutable prefix "${prefix}" matched` };
      }
    }

    // Soft-delete: archive to trash
    this.trash.push({
      targetId: command.targetId,
      contentType: command.contentType,
      deletedBy: command.requestedBy,
      payload: data,
      archivedAt: Date.now(),
    });

    return { success: true, action: 'SOFT_DELETED' };
  }

  /** Return the current trash manifest (for audit assertions) */
  async getTrashManifest(): Promise<TrashEntry[]> {
    return [...this.trash];
  }
}
