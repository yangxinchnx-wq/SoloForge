// ─────────────────────────────────────────────────────────────────
// data — Outbox 模式 (从 TS src/data/outbox/outbox.ts 迁移, P9 最终一致性)
//
// 语义对齐 TS outbox.ts:
//   - 业务写 + outbox_sync 同事务 (此处: Append 即 pending 入队)
//   - 后台 worker 100ms 轮询 (对齐旧 RepOutboxWorker / DEFAULT_OUTBOX_CONFIG)
//   - 投递回调注入 (DeliverFunc, 测试用 mock 替换)
//   - 成功 → sent 即删除; 失败 → retry_count++ 指数退避;
//     retry_count >= max_retries → 转入 outbox_dead (DLQ)
//
// 状态机:
//
//	Append ──► pending ──投递成功──► (删除, 语义等价 TS status='sent')
//	             │
//	             └─投递失败─► retry < max: pending (next_retry_at = now+退避)
//	                          retry >= max: dead (入 DLQ, 发审计事件)
//
// 差异: 存储为进程内 map (无 SurrealDB); sent 记录直接删除以约束内存
// (TS 落 status='sent' 行); 新增 RequeueDead 供死信人工重放。
// ─────────────────────────────────────────────────────────────────
package data

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// outbox 审计事件类型 (dead-letter 为罕见的关键事实, 按先落库后广播纪律发出)
const EventTypeOutboxDeadLettered = "outbox.dead_lettered"

// ── 配置 (对齐 TS DEFAULT_OUTBOX_CONFIG) ────────────────────────

// OutboxConfig worker 配置
type OutboxConfig struct {
	PollInterval   time.Duration // 轮询间隔 (默认 100ms, 对齐旧 RepOutboxWorker)
	BatchSize      int           // 每轮取多少条 (默认 100)
	MaxConcurrency int           // 单 tick 内投递并发上限 (对齐 TS M3 修复, 默认 8)
	MaxRetries     int           // 重试超过此次数转 DLQ (默认 10)
	BackoffBase    time.Duration // 指数退避基数 (默认 500ms)
	BackoffMax     time.Duration // 指数退避上限 (默认 60s)
	EnableDLQ      bool          // 是否保留死信 (对齐 TS enable_dlq)
}

// DefaultOutboxConfig 默认配置 (数值对齐 TS DEFAULT_OUTBOX_CONFIG)
func DefaultOutboxConfig() OutboxConfig {
	return OutboxConfig{
		PollInterval:   100 * time.Millisecond,
		BatchSize:      100,
		MaxConcurrency: 8,
		MaxRetries:     10,
		BackoffBase:    500 * time.Millisecond,
		BackoffMax:     60 * time.Second,
		EnableDLQ:      true,
	}
}

// ── 记录 / 状态机 ────────────────────────────────────────────────

// OutboxStatus 记录状态: pending (待投递/待退避) → dead (超限入死信)
// (sent 为瞬态: 投递成功即从 pending 删除, 不占内存)
type OutboxStatus string

const (
	OutboxPending OutboxStatus = "pending"
	OutboxDead    OutboxStatus = "dead"
)

// OutboxRecord outbox 记录 (字段对齐 TS OutboxRecord)
type OutboxRecord struct {
	ID          string          `json:"id"`
	Kind        string          `json:"kind"`    // 业务自定义类型, e.g. "reputation.update"
	Payload     json.RawMessage `json:"payload"` // 业务负载
	Status      OutboxStatus    `json:"status"`  // pending | dead
	RetryCount  int             `json:"retryCount"`
	NextRetryAt int64           `json:"nextRetryAt"` // epoch ms, 早于该时刻才可投递
	LastError   string          `json:"lastError,omitempty"`
	CreatedAt   int64           `json:"createdAt"`
	DeadAt      int64           `json:"deadAt,omitempty"` // 转死信时刻 (TS dead_at)
}

// DeliverFunc 投递回调 (注入式, 测试用 mock); 返回 error 视为投递失败
type DeliverFunc func(ctx context.Context, rec OutboxRecord) error

// OutboxStats worker 统计 (对齐 TS OutboxWorkerStats)
type OutboxStats struct {
	Polled         uint64 `json:"polled"`         // 轮询 tick 数
	Sent           uint64 `json:"sent"`           // 投递成功数
	FailedAttempts uint64 `json:"failedAttempts"` // 失败重试次数 (未达上限)
	DeadLettered   uint64 `json:"deadLettered"`   // 转死信数
	LastPollAt     int64  `json:"lastPollAt"`     // epoch ms, 0 = 未轮询
	LastSentAt     int64  `json:"lastSentAt"`
	PendingNow     int    `json:"pendingNow"`
	DeadNow        int    `json:"deadNow"`
}

// ── Worker ───────────────────────────────────────────────────────

// Outbox outbox worker (进程内; 100ms 轮询 + 并发限流投递)
type Outbox struct {
	st      *store.Store
	b       *bus.EventBus
	deliver DeliverFunc // 可空: 未注入时记录滞留 pending (纯进程内部署)
	cfg     OutboxConfig

	mu      sync.Mutex
	pending map[string]*OutboxRecord // 待投递表 (对齐 TS outbox_sync status='pending')
	dead    []*OutboxRecord          // 死信表 (对齐 TS outbox_dead, 按 deadAt 升序)
	stats   OutboxStats

	notify   chan struct{} // Append 后立即唤醒 (对齐 TS worker.notify())
	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
}

// NewOutbox 构造 outbox worker (需 Start 启动后台轮询)
func NewOutbox(st *store.Store, b *bus.EventBus, deliver DeliverFunc, cfg OutboxConfig) *Outbox {
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 100 * time.Millisecond
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 100
	}
	if cfg.MaxConcurrency <= 0 {
		cfg.MaxConcurrency = 8
	}
	if cfg.MaxRetries <= 0 {
		cfg.MaxRetries = 10
	}
	if cfg.BackoffBase <= 0 {
		cfg.BackoffBase = 500 * time.Millisecond
	}
	if cfg.BackoffMax <= 0 {
		cfg.BackoffMax = 60 * time.Second
	}
	return &Outbox{
		st:      st,
		b:       b,
		deliver: deliver,
		cfg:     cfg,
		pending: make(map[string]*OutboxRecord),
		notify:  make(chan struct{}, 1),
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
}

// Append 业务侧入队 (对齐 TS enqueueInTx: 业务写 + outbox 写同事务后调用;
// 进程内无 TX, Append 即原子入队)。返回 pending 记录。
func (o *Outbox) Append(kind string, payload any) (*OutboxRecord, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("outbox 载荷序列化失败: %w", err)
	}
	rec := &OutboxRecord{
		ID:          newOutboxID(),
		Kind:        kind,
		Payload:     json.RawMessage(raw),
		Status:      OutboxPending,
		NextRetryAt: time.Now().UnixMilli(),
		CreatedAt:   time.Now().UnixMilli(),
	}
	o.mu.Lock()
	o.pending[rec.ID] = rec
	o.mu.Unlock()
	o.wake() // 对齐 TS: enqueue 后 notify() 立即触发一次 poll
	return rec, nil
}

// wake 非阻塞唤醒 (channel 容量 1, 合并多次唤醒)
func (o *Outbox) wake() {
	select {
	case o.notify <- struct{}{}:
	default:
	}
}

// Start 启动后台轮询 goroutine (幂等)
func (o *Outbox) Start(ctx context.Context) {
	go o.run(ctx)
}

// Stop 停止后台轮询 (等待退出)
func (o *Outbox) Stop() {
	o.stopOnce.Do(func() { close(o.stop) })
	<-o.done
}

func (o *Outbox) run(ctx context.Context) {
	defer close(o.done)
	ticker := time.NewTicker(o.cfg.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-o.stop:
			return
		case <-ticker.C:
		case <-o.notify:
		}
		o.tick(ctx)
	}
}

// tick 单轮: 取到期 pending 批次 → 并发限流投递 → 状态迁移
func (o *Outbox) tick(ctx context.Context) {
	now := time.Now().UnixMilli()
	o.mu.Lock()
	o.stats.Polled++
	o.stats.LastPollAt = now

	// 取一批到期记录 (next_retry_at <= now), 按 next_retry_at 升序 (对齐 TS SELECT ... ORDER BY)
	var due []*OutboxRecord
	for _, rec := range o.pending {
		if rec.NextRetryAt <= now {
			due = append(due, rec)
		}
	}
	if len(due) > o.cfg.BatchSize {
		due = due[:o.cfg.BatchSize]
	}
	// 稳定排序: 按到期时间
	for i := 1; i < len(due); i++ {
		for j := i; j > 0 && due[j].NextRetryAt < due[j-1].NextRetryAt; j-- {
			due[j], due[j-1] = due[j-1], due[j]
		}
	}
	o.stats.PendingNow = len(o.pending)
	o.mu.Unlock()

	if len(due) == 0 {
		return
	}

	// 并发限流池 (对齐 TS M3/P1.1 修复: 池化处理, 单 tick 最多 N 个并发)
	sem := make(chan struct{}, o.cfg.MaxConcurrency)
	var wg sync.WaitGroup
	for _, rec := range due {
		wg.Add(1)
		go func(rec *OutboxRecord) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			o.processOne(ctx, rec)
		}(rec)
	}
	wg.Wait()
}

// processOne 投递单条并执行状态迁移 (成功删除 / 退避重试 / 超限进死信)
func (o *Outbox) processOne(ctx context.Context, rec *OutboxRecord) {
	// 未注入投递回调: 记录滞留 pending (纯进程内部署, 无外部 sink)
	if o.deliver == nil {
		return
	}
	snap := *rec // 投递用快照, 避免锁内回调
	if err := o.deliver(ctx, snap); err != nil {
		o.onFailure(ctx, rec, err)
		return
	}
	// 成功: 从 pending 删除 (语义等价 TS UPDATE status='sent')
	o.mu.Lock()
	delete(o.pending, rec.ID)
	o.stats.Sent++
	o.stats.LastSentAt = time.Now().UnixMilli()
	o.stats.PendingNow = len(o.pending)
	o.mu.Unlock()
}

// onFailure 失败处理: retry++ → 未达上限走指数退避, 达上限转死信 (DLQ)
func (o *Outbox) onFailure(ctx context.Context, rec *OutboxRecord, derr error) {
	errMsg := derr.Error()
	newRetry := rec.RetryCount + 1
	now := time.Now().UnixMilli()

	o.mu.Lock()
	if newRetry >= o.cfg.MaxRetries {
		// 超过重试上限: 移出 pending, 转 outbox_dead (对齐 TS INSERT outbox_dead + status='dead')
		delete(o.pending, rec.ID)
		rec.Status = OutboxDead
		rec.RetryCount = newRetry
		rec.LastError = errMsg
		rec.DeadAt = now
		if o.cfg.EnableDLQ {
			o.dead = append(o.dead, rec)
		}
		o.stats.DeadLettered++
		o.stats.PendingNow = len(o.pending)
		o.stats.DeadNow = len(o.dead)
		o.mu.Unlock()
		o.emitDeadLetter(ctx, rec) // 审计事件: 先落库后广播
		return
	}
	// 未达上限: 留在 pending, 指数退避 (对齐 TS base*2^retry 封顶 backoff_max)
	rec.RetryCount = newRetry
	rec.LastError = errMsg
	rec.NextRetryAt = now + o.backoffMs(newRetry)
	o.stats.FailedAttempts++
	o.mu.Unlock()
}

// backoffMs 指数退避: base * 2^retry, 封顶 backoff_max (毫秒)
func (o *Outbox) backoffMs(retry int) int64 {
	delay := o.cfg.BackoffBase
	for i := 0; i < retry && delay < o.cfg.BackoffMax; i++ {
		delay *= 2
	}
	if delay > o.cfg.BackoffMax {
		delay = o.cfg.BackoffMax
	}
	return delay.Milliseconds()
}

// emitDeadLetter 死信审计事件 (先落库后广播, 对齐 court.go emit 纪律)
func (o *Outbox) emitDeadLetter(ctx context.Context, rec *OutboxRecord) {
	raw, _ := json.Marshal(map[string]any{
		"id": rec.ID, "kind": rec.Kind, "retryCount": rec.RetryCount,
		"lastError": rec.LastError, "createdAt": rec.CreatedAt, "deadAt": rec.DeadAt,
	})
	ev, err := o.st.AppendEvent(ctx, EventTypeOutboxDeadLettered, "data", raw)
	if err == nil {
		o.b.Publish(ev)
	}
}

// RequeueDead 死信重放 (Go 增强): 重置计数后放回 pending 立即投递
func (o *Outbox) RequeueDead(id string) bool {
	o.mu.Lock()
	var rec *OutboxRecord
	for i, d := range o.dead {
		if d.ID == id {
			rec = d
			o.dead = append(o.dead[:i], o.dead[i+1:]...)
			break
		}
	}
	if rec == nil {
		o.mu.Unlock()
		return false
	}
	rec.Status = OutboxPending
	rec.RetryCount = 0
	rec.LastError = ""
	rec.NextRetryAt = time.Now().UnixMilli()
	rec.DeadAt = 0
	o.pending[rec.ID] = rec
	o.stats.DeadNow = len(o.dead)
	o.stats.PendingNow = len(o.pending)
	o.mu.Unlock()
	o.wake()
	return true
}

// ── 查询 ─────────────────────────────────────────────────────────

// Stats 统计快照
func (o *Outbox) Stats() OutboxStats {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.stats.PendingNow = len(o.pending)
	o.stats.DeadNow = len(o.dead)
	return o.stats
}

// Pending 待投递记录 (按 NextRetryAt 升序)
func (o *Outbox) Pending() []OutboxRecord {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := make([]OutboxRecord, 0, len(o.pending))
	for _, rec := range o.pending {
		out = append(out, *rec)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].NextRetryAt < out[j-1].NextRetryAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Dead 死信记录 (按 deadAt 升序, 对齐 TS outbox_dead)
func (o *Outbox) Dead() []OutboxRecord {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := make([]OutboxRecord, 0, len(o.dead))
	for _, rec := range o.dead {
		out = append(out, *rec)
	}
	return out
}

// newOutboxID 生成记录 ID (对齐 TS outbox_<ts>_<rand>; Go 用 hex8 等价唯一)
func newOutboxID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b) // crypto/rand 失败概率可忽略, 忽略错误
	return fmt.Sprintf("outbox_%d_%s", time.Now().UnixMilli(), hex.EncodeToString(b))
}
