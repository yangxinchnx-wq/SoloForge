// ─────────────────────────────────────────────────────────────────
// kernel — 事务管理器 (从 TS src/kernel/transaction-manager.ts 迁移)
//
// 语义对齐:
//   - begin(commandId, domain, payload) → 活跃事务表登记
//     (TS id 格式 tx_<ulid>; Go 无 ulid 依赖, 用 tx_<unixmilli>_<hex8>)
//   - commit(txId): 移出活跃表, 发 TransactionCommitted
//     {txId, commandId, domain, version, timestamp, data}
//     (payload 对齐 TS commit 事件 + docs/protocol.md §6)
//   - rollback(commandId, cause): 清理该 commandId 的全部活跃事务,
//     逐个发 TransactionRolledBack {txId, commandId, error}
//   - drain(): 清空活跃表
//
// Go 增强 (TS 无):
//   - 乐观锁: Begin 记录内核版本基线, Commit 校验 ExpectedVersion == 内核
//     当前版本, 冲突则 ErrVersionConflict; 成功后内核 version 单调 +1
//   - 事务超时: 默认 30s, 过期事务 Commit 时自动按回滚处理 (ErrTxExpired)
//   - 事件纪律对齐 court.go: 先 store.AppendEvent 落库后 bus.Publish 广播
//
// ─────────────────────────────────────────────────────────────────
package kernel

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// 事务事件名 (对齐 docs/protocol.md §6 RuntimeEvent)
const (
	EventTransactionCommitted  = "transaction.committed"
	EventTransactionRolledBack = "transaction.rolledback"
)

// 事务错误 (错误码前缀对齐 TS ERR_SF_TX)
var (
	// ErrTxNotFound 事务不存在或已提交
	ErrTxNotFound = errors.New("ERR_SF_TX: transaction not found or already committed")
	// ErrTxExpired 事务超时 (Begin 后超过 Timeout 未提交)
	ErrTxExpired = errors.New("ERR_SF_TX: transaction expired")
	// ErrVersionConflict 乐观锁冲突 (Commit 时内核版本已前进)
	ErrVersionConflict = errors.New("ERR_SF_TX: optimistic version conflict")
)

// DefaultTxTimeout 默认事务超时 (TS 无此概念, Go 增强默认 30s)
const DefaultTxTimeout = 30 * time.Second

// Transaction 活跃事务记录 (字段对齐 TS activeTransactions 条目)
type Transaction struct {
	ID              string `json:"id"`              // tx_<unixmilli>_<hex8>
	CommandID       string `json:"commandId"`       // 关联命令
	Domain          string `json:"domain"`          // 执行域
	StartedAt       int64  `json:"startedAt"`       // 开始时间 (unix ms)
	ExpectedVersion int64  `json:"expectedVersion"` // 乐观锁基线 (Begin 时内核版本)
	Data            any    `json:"data,omitempty"`  // 初始载荷 (提交时随事件广播)
}

// TransactionManager 事务管理器
type TransactionManager struct {
	kernel  *RuntimeKernel // 反向引用: 取版本号 / 发事件
	timeout time.Duration  // 事务超时
	mu      sync.Mutex
	active  map[string]*Transaction // txID → 事务
}

// NewTransactionManager 构造事务管理器 (挂接到内核; 对齐 TS 构造器注入 kernel)
func NewTransactionManager(k *RuntimeKernel) *TransactionManager {
	return &TransactionManager{
		kernel:  k,
		timeout: DefaultTxTimeout,
		active:  make(map[string]*Transaction),
	}
}

// SetTimeout 调整事务超时 (<=0 视为永不超时)
func (m *TransactionManager) SetTimeout(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.timeout = d
}

// Begin 开启事务: 登记活跃表并记录乐观锁版本基线
// (对齐 TS begin(commandId, domain, initialPayload))
func (m *TransactionManager) Begin(commandID, domain string, data any) (*Transaction, error) {
	tx := &Transaction{
		ID:              newTxID(),
		CommandID:       commandID,
		Domain:          domain,
		StartedAt:       time.Now().UnixMilli(),
		ExpectedVersion: m.kernel.currentVersion(),
		Data:            data,
	}
	m.mu.Lock()
	m.active[tx.ID] = tx
	m.mu.Unlock()
	return tx, nil
}

// Commit 提交事务 (对齐 TS commit + Go 增强校验):
//  1. 事务必须存在 (否则 ErrTxNotFound, 对齐 TS 抛错)
//  2. 超时检查: 过期 → 移出并按回滚广播, 返回 ErrTxExpired
//  3. 乐观锁: ExpectedVersion != 内核当前版本 → 移出并广播回滚,
//     返回 ErrVersionConflict (内核版本已被并发事务推进)
//  4. 成功: 移出活跃表, 内核 version 单调 +1, 广播 TransactionCommitted
func (m *TransactionManager) Commit(ctx context.Context, txID string) error {
	m.mu.Lock()
	tx, ok := m.active[txID]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrTxNotFound, txID)
	}

	// 超时检查 (Go 增强)
	if m.timeout > 0 && time.Since(time.UnixMilli(tx.StartedAt)) > m.timeout {
		delete(m.active, txID)
		m.mu.Unlock()
		m.emitRolledBack(ctx, tx, ErrTxExpired.Error())
		return fmt.Errorf("%w: %s (startedAt=%d, timeout=%s)", ErrTxExpired, txID, tx.StartedAt, m.timeout)
	}

	// 乐观锁版本校验 (Go 增强): 版本已前进说明存在并发提交, 本事务作废
	current := m.kernel.currentVersion()
	if tx.ExpectedVersion != current {
		delete(m.active, txID)
		m.mu.Unlock()
		m.emitRolledBack(ctx, tx, fmt.Sprintf("version conflict: expected %d, current %d", tx.ExpectedVersion, current))
		return fmt.Errorf("%w: tx %s expected %d, current %d", ErrVersionConflict, txID, tx.ExpectedVersion, current)
	}

	delete(m.active, txID)
	newVersion := m.kernel.bumpVersion() // 提交成功 → 内核版本推进
	m.mu.Unlock()

	m.emitCommitted(ctx, tx, newVersion)
	return nil
}

// Rollback 按 commandId 回滚: 清理该命令的全部活跃事务并逐个广播
// TransactionRolledBack {txId, commandId, error} (对齐 TS rollback 语义)
// 返回实际回滚的事务数。
func (m *TransactionManager) Rollback(ctx context.Context, commandID string, cause error) int {
	msg := ""
	if cause != nil {
		msg = cause.Error()
	}
	m.mu.Lock()
	var doomed []*Transaction
	for id, tx := range m.active {
		if tx.CommandID == commandID {
			doomed = append(doomed, tx)
			delete(m.active, id)
		}
	}
	m.mu.Unlock()
	for _, tx := range doomed {
		m.emitRolledBack(ctx, tx, msg)
	}
	return len(doomed)
}

// Drain 清空全部活跃事务 (对齐 TS drain; 不发事件)
func (m *TransactionManager) Drain() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.active = make(map[string]*Transaction)
}

// Active 活跃事务快照 (观测/对账用, 按 Start 时间升序)
func (m *TransactionManager) Active() []Transaction {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Transaction, 0, len(m.active))
	for _, tx := range m.active {
		out = append(out, *tx)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt < out[j].StartedAt })
	return out
}

// ── 事件广播 (先落库后广播, 对齐 court.go emit 纪律) ───────────────

// emitCommitted 广播 TransactionCommitted
// (载荷对齐 TS commit 事件 + protocol §6: domain/txId/version/data)
func (m *TransactionManager) emitCommitted(ctx context.Context, tx *Transaction, version int64) {
	data := tx.Data
	if data == nil {
		data = map[string]any{} // 对齐 TS: data: tx.payload || {}
	}
	m.kernel.emit(ctx, EventTransactionCommitted, map[string]any{
		"txId":      tx.ID,
		"commandId": tx.CommandID,
		"domain":    tx.Domain,
		"version":   version,
		"timestamp": time.Now().UnixMilli(),
		"data":      data,
	})
}

// emitRolledBack 广播 TransactionRolledBack (载荷对齐 TS rollback 事件)
func (m *TransactionManager) emitRolledBack(ctx context.Context, tx *Transaction, errMsg string) {
	m.kernel.emit(ctx, EventTransactionRolledBack, map[string]any{
		"txId":      tx.ID,
		"commandId": tx.CommandID,
		"domain":    tx.Domain,
		"error":     errMsg,
	})
}

// newTxID 生成事务 ID (TS 用 tx_<ulid>; Go 标准库无 ulid,
// 用 tx_<unixmilli>_<hex8> 等价保证唯一性)
func newTxID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b) // crypto/rand 失败概率可忽略, 忽略错误
	return fmt.Sprintf("tx_%d_%s", time.Now().UnixMilli(), hex.EncodeToString(b))
}
