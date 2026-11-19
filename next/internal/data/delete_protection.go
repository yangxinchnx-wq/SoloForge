// ─────────────────────────────────────────────────────────────────
// data — 删除保护 (从 TS src/data/delete_protection.ts 迁移)
//
// 语义对齐 TS DeleteProtection:
//   - 不可变前缀硬拦截: constitution_/law_core_/sovereign_/core_scheduler
//     一律 BLOCKED, 不产生回收站条目
//   - 类型级锁: lock(type) 后该类型全部禁止删除 (canDelete 拒绝)
//   - 软删除归档: 允许删除的目标进入 trash 回收站 (30 天 TTL)
//
// Go 增强 (任务要求):
//   - Restore: 从回收站恢复 (返回原载荷, 供上游重建实体)
//   - Purge / PurgeExpired: 彻底清除 / 30 天 TTL 到期清扫
//   - 全程审计事件: data.delete.blocked / data.trash.soft_deleted /
//     data.trash.restored / data.trash.purged (先落库后广播)
//
// ─────────────────────────────────────────────────────────────────
package data

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// ── 常量 (对齐 TS IMMUTABLE_PREFIXES / 30 天 TTL) ────────────────

// IMMUTABLE_PREFIXES 宪法级不可变资产前缀 — 硬拦截一切删除
var ImmutablePrefixes = []string{"constitution_", "law_core_", "sovereign_", "core_scheduler"}

// TrashTTL 回收站保留期 (TS 注释: 30-day TTL)
const TrashTTL = 30 * 24 * time.Hour

// 删除保护审计事件类型 (data.* 前缀; 均为审计事实, 先落库后广播)
const (
	EventTypeDeleteBlocked    = "data.delete.blocked"
	EventTypeTrashSoftDeleted = "data.trash.soft_deleted"
	EventTypeTrashRestored    = "data.trash.restored"
	EventTypeTrashPurged      = "data.trash.purged"
)

// 拦截动作 (对齐 TS InterceptResult.action)
const (
	ActionBlocked    = "BLOCKED"
	ActionSoftDelete = "SOFT_DELETED"
)

// ── 结构 (字段对齐 TS) ───────────────────────────────────────────

// DeleteCommand 删除命令 (对齐 TS DeleteCommand)
type DeleteCommand struct {
	TargetID    string `json:"targetId"`    // 目标实体 ID
	ContentType string `json:"contentType"` // 实体类型
	RequestedBy string `json:"requestedBy"` // 请求者
}

// TrashEntry 回收站条目 (对齐 TS TrashEntry)
type TrashEntry struct {
	TargetID    string          `json:"targetId"`
	ContentType string          `json:"contentType"`
	DeletedBy   string          `json:"deletedBy"`
	Payload     json.RawMessage `json:"payload"`    // 原始载荷快照 (恢复用)
	ArchivedAt  int64           `json:"archivedAt"` // epoch ms
}

// InterceptResult 拦截结果 (对齐 TS InterceptResult)
type InterceptResult struct {
	Success bool   `json:"success"`
	Action  string `json:"action"` // BLOCKED | SOFT_DELETED
	Reason  string `json:"reason,omitempty"`
}

// ── 服务 ─────────────────────────────────────────────────────────

// DeleteProtection 删除保护 (策略分层: 不可变前缀 > 类型锁 > 软删归档)
type DeleteProtection struct {
	st *store.Store
	b  *bus.EventBus

	mu          sync.Mutex
	lockedTypes map[string]bool // 类型级锁 (对齐 TS lockedTypes)
	trash       []*TrashEntry   // 回收站 (按归档时间升序)
}

// NewDeleteProtection 构造删除保护
func NewDeleteProtection(st *store.Store, b *bus.EventBus) *DeleteProtection {
	return &DeleteProtection{
		st:          st,
		b:           b,
		lockedTypes: make(map[string]bool),
	}
}

// Lock 锁定某实体类型 — 该类型全部禁止删除 (对齐 TS lock)
func (d *DeleteProtection) Lock(typ string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.lockedTypes[typ] = true
}

// Unlock 解锁 (对齐 TS unlock)
func (d *DeleteProtection) Unlock(typ string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.lockedTypes, typ)
}

// CanDelete 检查该类型是否允许删除 (对齐 TS canDelete;
// 不可变前缀在此不做判定 — 硬拦截发生在 intercept 阶段)
func (d *DeleteProtection) CanDelete(typ, _id string) (bool, string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.lockedTypes[typ] {
		return false, fmt.Sprintf("Entity type %q is protected and cannot be deleted.", typ)
	}
	return true, ""
}

// SoftDelete 拦截并执行删除命令 (对齐 TS interceptAndExecute):
//   - 不可变前缀命中 → BLOCKED, 不入回收站, 发 data.delete.blocked 审计
//   - 其余 → 软删除入回收站, 发 data.trash.soft_deleted 审计
func (d *DeleteProtection) SoftDelete(ctx context.Context, cmd DeleteCommand, payload any) (InterceptResult, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return InterceptResult{}, fmt.Errorf("删除载荷序列化失败: %w", err)
	}

	// 第 1 层: 不可变前缀硬拦截 (对齐 TS: matched prefix → BLOCKED, 无 trash 条目)
	for _, prefix := range ImmutablePrefixes {
		if strings.HasPrefix(cmd.TargetID, prefix) {
			res := InterceptResult{
				Success: false,
				Action:  ActionBlocked,
				Reason:  fmt.Sprintf("Immutable prefix %q matched", prefix),
			}
			d.emit(ctx, EventTypeDeleteBlocked, map[string]any{
				"targetId": cmd.TargetID, "contentType": cmd.ContentType,
				"requestedBy": cmd.RequestedBy, "reason": res.Reason,
			})
			return res, nil
		}
	}

	// 第 2 层: 类型锁拒绝
	if ok, reason := d.CanDelete(cmd.ContentType, cmd.TargetID); !ok {
		res := InterceptResult{Success: false, Action: ActionBlocked, Reason: reason}
		d.emit(ctx, EventTypeDeleteBlocked, map[string]any{
			"targetId": cmd.TargetID, "contentType": cmd.ContentType,
			"requestedBy": cmd.RequestedBy, "reason": reason,
		})
		return res, nil
	}

	// 第 3 层: 软删除归档 (对齐 TS trash.push)
	entry := &TrashEntry{
		TargetID:    cmd.TargetID,
		ContentType: cmd.ContentType,
		DeletedBy:   cmd.RequestedBy,
		Payload:     json.RawMessage(raw),
		ArchivedAt:  time.Now().UnixMilli(),
	}
	d.mu.Lock()
	d.trash = append(d.trash, entry)
	d.mu.Unlock()
	d.emit(ctx, EventTypeTrashSoftDeleted, map[string]any{
		"targetId": entry.TargetID, "contentType": entry.ContentType,
		"deletedBy": entry.DeletedBy, "archivedAt": entry.ArchivedAt,
	})
	return InterceptResult{Success: true, Action: ActionSoftDelete}, nil
}

// Restore 从回收站恢复 (Go 增强, 任务要求; 返回原载荷供上游重建实体)
func (d *DeleteProtection) Restore(ctx context.Context, targetID string) (*TrashEntry, error) {
	d.mu.Lock()
	var entry *TrashEntry
	for i, t := range d.trash {
		if t.TargetID == targetID {
			entry = t
			d.trash = append(d.trash[:i], d.trash[i+1:]...)
			break
		}
	}
	d.mu.Unlock()
	if entry == nil {
		return nil, fmt.Errorf("回收站中不存在: %s", targetID)
	}
	d.emit(ctx, EventTypeTrashRestored, map[string]any{
		"targetId": entry.TargetID, "contentType": entry.ContentType,
		"restoredAt": time.Now().UnixMilli(),
	})
	return entry, nil
}

// Purge 彻底清除回收站条目 (Go 增强; 硬删, 发 data.trash.purged 审计)
func (d *DeleteProtection) Purge(ctx context.Context, targetID string) (bool, error) {
	d.mu.Lock()
	var entry *TrashEntry
	for i, t := range d.trash {
		if t.TargetID == targetID {
			entry = t
			d.trash = append(d.trash[:i], d.trash[i+1:]...)
			break
		}
	}
	d.mu.Unlock()
	if entry == nil {
		return false, nil
	}
	d.emit(ctx, EventTypeTrashPurged, map[string]any{
		"targetId": entry.TargetID, "contentType": entry.ContentType,
		"purgedAt": time.Now().UnixMilli(), "expired": false,
	})
	return true, nil
}

// PurgeExpired 按 TTL 清扫到期回收站条目, 返回清除数 (Go 增强, 落实 30 天 TTL)
func (d *DeleteProtection) PurgeExpired(ctx context.Context) int {
	cutoff := time.Now().Add(-TrashTTL).UnixMilli()
	d.mu.Lock()
	var expired []*TrashEntry
	var keep []*TrashEntry
	for _, t := range d.trash {
		if t.ArchivedAt <= cutoff {
			expired = append(expired, t)
		} else {
			keep = append(keep, t)
		}
	}
	d.trash = keep
	d.mu.Unlock()
	now := time.Now().UnixMilli()
	for _, t := range expired {
		d.emit(ctx, EventTypeTrashPurged, map[string]any{
			"targetId": t.TargetID, "contentType": t.ContentType,
			"purgedAt": now, "expired": true,
		})
	}
	return len(expired)
}

// TrashManifest 当前回收站清单 (对齐 TS getTrashManifest, 按归档时间升序)
func (d *DeleteProtection) TrashManifest() []TrashEntry {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]TrashEntry, 0, len(d.trash))
	for _, t := range d.trash {
		out = append(out, *t)
	}
	return out
}

// LockedTypes 当前锁定类型列表 (观测用)
func (d *DeleteProtection) LockedTypes() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]string, 0, len(d.lockedTypes))
	for typ := range d.lockedTypes {
		out = append(out, typ)
	}
	return out
}

// emit 审计事件 (先落库后广播, 对齐 court.go emit 纪律)
func (d *DeleteProtection) emit(ctx context.Context, typ string, payload map[string]any) {
	raw, _ := json.Marshal(payload)
	if ev, err := d.st.AppendEvent(ctx, typ, "data", raw); err == nil {
		d.b.Publish(ev)
	}
}
