// ─────────────────────────────────────────────────────────────────
// circuit.go — LLM Provider 熔断器
// (从 TS src/llm/circuit-breaker.ts 迁移, 原移植自 Java LlmCommandCenter)
//
// 当某个 LLM provider 连续失败 (429/503/5xx/网络错误) 达到阈值时,
// 熔断器 OPEN — 短路所有后续请求, 避免级联失败。
// 冷却期后进入 HALF_OPEN — 放一个探测请求通过,
// 成功则 CLOSED 恢复正常, 失败则重新 OPEN。
//
// 状态机:
//
//	CLOSED    ──(N 次连续 429/5xx)──►  OPEN
//	OPEN      ──(冷却 30s 后)──────►  HALF_OPEN
//	HALF_OPEN ──(探测成功)────────►  CLOSED
//	HALF_OPEN ──(探测失败)────────►  OPEN
//
// 使用方式:
//
//	decision := llm.DefaultBreaker.Evaluate(key)
//	// decision.Action == Reject → 直接短路; == Wait → 先睡 waitMs
//	llm.DefaultBreaker.RecordSuccess(key, latencyMs)
//	llm.DefaultBreaker.RecordFailure(key, statusCode)
//
// ─────────────────────────────────────────────────────────────────
package llm

import (
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// CircuitState 熔断器状态 (对齐 TS CircuitState)
type CircuitState string

const (
	StateClosed   CircuitState = "CLOSED"
	StateOpen     CircuitState = "OPEN"
	StateHalfOpen CircuitState = "HALF_OPEN"
)

// Action 评估动作 (对齐 TS CircuitDecision.action)
type Action string

const (
	Proceed Action = "proceed"
	Wait    Action = "wait"
	Reject  Action = "reject"
)

// Decision 评估结果 (对齐 TS CircuitDecision)
type Decision struct {
	Action Action
	WaitMs int64
	Reason string
	State  CircuitState
}

// providerCircuit 单个 provider 的熔断状态
type providerCircuit struct {
	state               CircuitState
	consecutiveFailures int
	openedAt            time.Time // OPEN 状态开始时间
	lastSuccessAt       time.Time // 最后一次成功时间
	totalRequests       int64
	totalFailures       int64
}

// 配置常量 (对齐 TS)
const (
	// FailureThreshold 连续 5 次失败触发熔断
	FailureThreshold = 5
	// CooldownMs OPEN → HALF_OPEN 冷却期 30s
	CooldownMs = 30_000 * time.Millisecond
	// HalfOpenTimeoutMs HALF_OPEN 超时回退到 OPEN
	HalfOpenTimeoutMs = 60_000 * time.Millisecond
)

// Breaker LLM Provider 熔断器 (对齐 TS LlmCircuitBreaker; 并发安全)
type Breaker struct {
	mu       sync.Mutex
	circuits map[string]*providerCircuit
}

// NewBreaker 创建熔断器
func NewBreaker() *Breaker {
	return &Breaker{circuits: make(map[string]*providerCircuit)}
}

// DefaultBreaker 进程级单例 (对齐 TS llmCircuitBreaker)
var DefaultBreaker = NewBreaker()

// Evaluate 评估是否允许请求通过 (对齐 TS evaluate)
func (b *Breaker) Evaluate(providerKey string) Decision {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.getOrCreate(providerKey)

	switch c.state {
	case StateClosed:
		return Decision{Action: Proceed, State: StateClosed}

	case StateOpen:
		elapsed := time.Since(c.openedAt)
		if elapsed >= CooldownMs {
			// 冷却期已过 → 进入 HALF_OPEN, 放一个探测请求
			c.state = StateHalfOpen
			slog.Info("熔断器 HALF_OPEN (冷却完成)", "provider", providerKey, "elapsedMs", elapsed.Milliseconds())
			return Decision{Action: Proceed, State: StateHalfOpen}
		}
		waitMs := (CooldownMs - elapsed).Milliseconds()
		return Decision{
			Action: Reject,
			State:  StateOpen,
			Reason: fmt.Sprintf("circuit OPEN (cooldown %ds remaining)", (waitMs+999)/1000),
		}

	case StateHalfOpen:
		// HALF_OPEN 只允许一个探测请求, 如果超时则回退
		elapsed := time.Since(c.openedAt)
		if elapsed > HalfOpenTimeoutMs {
			c.state = StateOpen
			c.openedAt = time.Now()
			slog.Warn("熔断器 HALF_OPEN 超时回退 OPEN", "provider", providerKey)
			return Decision{Action: Reject, State: StateOpen, Reason: "half-open probe timeout"}
		}
		return Decision{Action: Proceed, State: StateHalfOpen}

	default:
		return Decision{Action: Proceed, State: StateClosed}
	}
}

// RecordSuccess 记录请求成功 (对齐 TS recordSuccess)
func (b *Breaker) RecordSuccess(providerKey string, latencyMs int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.getOrCreate(providerKey)
	c.consecutiveFailures = 0
	c.lastSuccessAt = time.Now()
	c.totalRequests++

	if c.state == StateHalfOpen {
		c.state = StateClosed
		slog.Info("熔断器 CLOSED (恢复)", "provider", providerKey)
	}
}

// RecordFailure 记录请求失败 (对齐 TS recordFailure)。
// statusCode: HTTP 状态码 (429, 503, 500, 0=网络错误)。
// 只对 429/503/5xx/网络错误计入熔断 (4xx 其他不算)。
func (b *Breaker) RecordFailure(providerKey string, statusCode int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.getOrCreate(providerKey)
	c.totalRequests++
	c.totalFailures++

	isBreakerError := statusCode == 429 ||
		statusCode == 503 ||
		(statusCode >= 500 && statusCode < 600) ||
		statusCode == 0
	if !isBreakerError {
		return
	}

	c.consecutiveFailures++

	switch {
	case c.state == StateHalfOpen:
		// 探测失败 → 重新 OPEN
		c.state = StateOpen
		c.openedAt = time.Now()
		slog.Warn("熔断器 HALF_OPEN 探测失败 → OPEN", "provider", providerKey, "statusCode", statusCode)
	case c.consecutiveFailures >= FailureThreshold && c.state == StateClosed:
		c.state = StateOpen
		c.openedAt = time.Now()
		slog.Error("熔断器 CIRCUIT OPEN",
			"provider", providerKey,
			"consecutiveFailures", c.consecutiveFailures,
			"lastStatus", statusCode)
	}
}

// Status 获取 provider 的熔断器状态 (用于监控/诊断)
type Status struct {
	State               CircuitState `json:"state"`
	ConsecutiveFailures int          `json:"consecutiveFailures"`
	TotalRequests       int64        `json:"totalRequests"`
	TotalFailures       int64        `json:"totalFailures"`
}

// GetStatus 单个 provider 状态 (无记录时返回 nil)
func (b *Breaker) GetStatus(providerKey string) *Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	c, ok := b.circuits[providerKey]
	if !ok {
		return nil
	}
	return &Status{
		State:               c.state,
		ConsecutiveFailures: c.consecutiveFailures,
		TotalRequests:       c.totalRequests,
		TotalFailures:       c.totalFailures,
	}
}

// AllStatuses 所有 provider 状态 (对齐 TS getAllStatuses)
type ProviderStatus struct {
	ProviderKey         string       `json:"providerKey"`
	State               CircuitState `json:"state"`
	ConsecutiveFailures int          `json:"consecutiveFailures"`
}

func (b *Breaker) AllStatuses() []ProviderStatus {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]ProviderStatus, 0, len(b.circuits))
	for key, c := range b.circuits {
		out = append(out, ProviderStatus{
			ProviderKey:         key,
			State:               c.state,
			ConsecutiveFailures: c.consecutiveFailures,
		})
	}
	return out
}

func (b *Breaker) getOrCreate(providerKey string) *providerCircuit {
	c, ok := b.circuits[providerKey]
	if !ok {
		c = &providerCircuit{state: StateClosed}
		b.circuits[providerKey] = c
	}
	return c
}

// ─── 独立工具函数 ─────────────────────────────────────────────────

// ProviderKey 生成 provider key (baseUrl|model 格式, 对齐 TS circuitProviderKey)
func ProviderKey(baseURL, model string) string {
	return baseURL + "|" + model
}

// httpStatusRe 匹配错误消息中的 "LLM HTTP 429" 格式
var httpStatusRe = regexp.MustCompile(`HTTP\s+(\d+)`)

// ExtractStatusCode 从错误消息中提取 HTTP 状态码 (对齐 TS extractStatusCode)。
// 网络错误 (ECONNRESET / connection 等) 记 0。
func ExtractStatusCode(err error) int {
	if err == nil {
		return 0
	}
	msg := err.Error()
	if m := httpStatusRe.FindStringSubmatch(msg); m != nil {
		if n, perr := strconv.Atoi(m[1]); perr == nil {
			return n
		}
	}
	// 网络错误判定 (对齐 TS: fetch / ECONNRESET / network 关键词)
	for _, kw := range []string{"connect", "ECONNRESET", "network", "timeout", "EOF", "reset"} {
		if containsFold(msg, kw) {
			return 0
		}
	}
	return 0
}

func containsFold(s, sub string) bool {
	// 小规模字符串, 直接手写不区分大小写包含
	ls := len(sub)
	if ls == 0 || len(s) < ls {
		return ls == 0
	}
	for i := 0; i+ls <= len(s); i++ {
		if equalFold(s[i:i+ls], sub) {
			return true
		}
	}
	return false
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}
