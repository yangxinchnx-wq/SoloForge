// ─────────────────────────────────────────────────────────────────
// rotation.go — Token 定时轮换 worker
// (从 TS src/security/tokenRotationService.ts 迁移 — security 高级特性补齐)
//
// 启动后每 5 分钟 tick 一次 (对齐 TS DEFAULT_ROTATION_CHECK_INTERVAL_MS):
//  1. 扫描 vault, 找出 expiresAt 临近的 active token
//     (默认: 距 expiresAt 不足 TTL * 0.1 → 90 天 TTL 提前 9 天;
//     SOLOFORGE_ROTATION_LEAD_MS 可覆盖)
//  2. 为每个即将过期的 token 生成新 active kid
//     旧 token 自动进入 rotating (grace period 内仍可用)
//  3. 清理已过 grace period 的 rotating token (标记 revoked)
//  4. 审计事件 token.rotation.*
//
// 关闭: SOLOFORGE_ROTATION_DISABLED=1 (测试环境避免时间漂移)
// 复用安全: 轮换只创建新 active, 不复用 kid; 每次轮换建立 parent 链。
// ─────────────────────────────────────────────────────────────────
package security

import (
	"log/slog"
	"os"
	"strconv"
	"sync"
	"time"
)

// RotationTickResult 单次 tick 结果 (对齐 TS RotationTickResult)
type RotationTickResult struct {
	RotatedKids []string `json:"rotatedKids"`
	GCRemoved   int      `json:"gcRemoved"`
	DurationMs  int64    `json:"durationMs"`
}

// RotationServiceOptions 轮换服务配置 (对齐 TS RotationServiceOptions)
type RotationServiceOptions struct {
	IntervalMS int64 // 默认 5 分钟
	LeadMS     int64 // 默认 TTL * 0.1
	TTLMS      int64 // 默认 90 天
	GraceMS    int64 // 默认 24 小时
}

// TokenRotationService 定时轮换 worker (对齐 TS TokenRotationService)
type TokenRotationService struct {
	store *TokenStore
	emit  func(event string, payload map[string]any) // 审计出口 (可空)

	mu       sync.Mutex
	running  bool
	inFlight bool
	stop     chan struct{}
}

// NewTokenRotationService 构造轮换服务
func NewTokenRotationService(store *TokenStore) *TokenRotationService {
	return &TokenRotationService{store: store, stop: make(chan struct{})}
}

// SetAuditSink 注入审计出口 (security.Service.emit 适配)
func (r *TokenRotationService) SetAuditSink(fn func(event string, payload map[string]any)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.emit = fn
}

// rotationOpts 解析配置 (env 覆盖 > 默认)
func (r *TokenRotationService) rotationOpts() RotationServiceOptions {
	opts := RotationServiceOptions{
		IntervalMS: DefaultRotationInterval.Milliseconds(),
		LeadMS:     int64(float64(DefaultTokenTTL.Milliseconds()) * RotationLeadRatio),
		TTLMS:      DefaultTokenTTL.Milliseconds(),
		GraceMS:    DefaultTokenGracePeriod.Milliseconds(),
	}
	if v := os.Getenv("SOLOFORGE_ROTATION_LEAD_MS"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			opts.LeadMS = n
		}
	}
	if v := os.Getenv("SOLOFORGE_ROTATION_INTERVAL_MS"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			opts.IntervalMS = n
		}
	}
	return opts
}

// Start 启动后台 worker (幂等; SOLOFORGE_ROTATION_DISABLED=1 时跳过)
func (r *TokenRotationService) Start() {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return
	}
	if os.Getenv("SOLOFORGE_ROTATION_DISABLED") == "1" {
		r.mu.Unlock()
		slog.Info("TokenRotation disabled by SOLOFORGE_ROTATION_DISABLED=1")
		return
	}
	interval := r.rotationOpts().IntervalMS
	r.running = true
	r.mu.Unlock()

	go func() {
		ticker := time.NewTicker(time.Duration(interval) * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-r.stop:
				return
			case <-ticker.C:
				if _, err := r.TickOnce(time.Now()); err != nil {
					slog.Error("TokenRotation tick failed", "err", err)
				}
			}
		}
	}()
	slog.Info("TokenRotation started", "intervalMs", interval, "leadMs", r.rotationOpts().LeadMS)
}

// Stop 停止 worker
func (r *TokenRotationService) Stop() {
	r.mu.Lock()
	if !r.running {
		r.mu.Unlock()
		return
	}
	r.running = false
	r.mu.Unlock()
	close(r.stop)
	slog.Info("TokenRotation stopped")
}

// TickOnce 立即执行一次 tick (启动时主动触发 / 测试; 对齐 TS tickOnce)。
// 防重叠: inFlight 期间忽略并发 tick。
func (r *TokenRotationService) TickOnce(now time.Time) (RotationTickResult, error) {
	r.mu.Lock()
	if r.inFlight {
		r.mu.Unlock()
		return RotationTickResult{}, nil
	}
	r.inFlight = true
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.inFlight = false
		r.mu.Unlock()
	}()
	return r.runTick(now), nil
}

// runTick tick 主体 (对齐 TS runTick):
// 过 lead 阈值的 active → CreateToken(parentKid, source=rotate) → GC
func (r *TokenRotationService) runTick(now time.Time) RotationTickResult {
	t0 := time.Now()
	opts := r.rotationOpts()
	result := RotationTickResult{RotatedKids: []string{}}

	active := r.store.ListActiveKids()
	for _, info := range active {
		if info.Status != TokenActive {
			continue
		}
		if info.ExpiresAt-now.UnixMilli() > opts.LeadMS {
			continue // 还没到轮换窗口
		}
		fresh, err := r.store.CreateToken(CreateTokenOptions{
			ParentKID: info.KID,
			Source:    TokenSourceRotate,
			TTL:       time.Duration(opts.TTLMS) * time.Millisecond,
			Grace:     time.Duration(opts.GraceMS) * time.Millisecond,
			Now:       now,
		})
		if err != nil {
			slog.Error("TokenRotation 轮换失败", "kid", info.KID, "err", err)
			continue
		}
		result.RotatedKids = append(result.RotatedKids, fresh.KID)
		if r.emit != nil {
			r.emit("token.rotation.rotated", map[string]any{
				"parentKid": info.KID, "newKid": fresh.KID,
				"familyId": fresh.FamilyID, "expiresAt": fresh.ExpiresAt,
			})
		}
	}

	result.GCRemoved = r.store.GCExpiredTokens(now)
	result.DurationMs = time.Since(t0).Milliseconds()

	if len(result.RotatedKids) > 0 || result.GCRemoved > 0 {
		if r.emit != nil {
			r.emit("token.rotation.tick", map[string]any{
				"rotated": result.RotatedKids, "gcRemoved": result.GCRemoved,
				"durationMs": result.DurationMs,
			})
		}
	}
	return result
}
