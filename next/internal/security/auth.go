// ─────────────────────────────────────────────────────────────────
// auth — 认证引导 token + 租户配置 + 审计 sink 状态
// (补齐 security.go 引用的三个类型; 语义对齐 TS auth.ts / tenantContext.ts /
//  auditSinkFactory.ts)
// ─────────────────────────────────────────────────────────────────
package security

import (
	"crypto/subtle"
	"encoding/hex"
	"sync"
	"time"
)

// ── Bootstrap 认证引导 ───────────────────────────────────────────

// Bootstrap 启动引导 token (对齐 TS GET /api/auth/bootstrap: 启动时生成,
// 进程内有效; UI 拿它作为初始凭证)。64 hex (32B crypto/rand)。
type Bootstrap struct {
	mu      sync.Mutex
	token   string
	issued  time.Time
	revoked bool
}

// NewBootstrap 生成新的引导 token
func NewBootstrap() *Bootstrap {
	return &Bootstrap{
		token:  hex.EncodeToString(randBytes(32)),
		issued: time.Now(),
	}
}

// Token 返回当前引导 token (已吊销 → 空串)
func (b *Bootstrap) Token() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.revoked {
		return ""
	}
	return b.token
}

// IssuedAt 签发时间 (RFC3339)
func (b *Bootstrap) IssuedAt() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.issued.Format(time.RFC3339)
}

// Revoke 吊销引导 token (首次真实登录后调用)
func (b *Bootstrap) Revoke() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.revoked = true
}

// Verify 校验 token (常数时间比对; 未设置/已吊销 → false)
func (b *Bootstrap) Verify(token string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.revoked || b.token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(b.token)) == 1
}

// Rotate 轮换 token (返回新 token)
func (b *Bootstrap) Rotate() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.token = hex.EncodeToString(randBytes(32))
	b.issued = time.Now()
	b.revoked = false
	return b.token
}

// ── TenantConfig 多租户上下文 ────────────────────────────────────

// TenantConfig 租户解析配置 (对齐 TS tenantContext.ts 的运行时可调项)
type TenantConfig struct {
	HeaderName    string              `json:"headerName"`    // 租户头 (默认 X-Tenant-Id)
	PathPrefix    string              `json:"pathPrefix"`    // 路径前缀式租户 (/api/t/<id>/)
	DefaultTenant string              `json:"defaultTenant"` // 缺省租户 (_default)
	Bindings      map[string][]string `json:"bindings"`      // 显式绑定: tenant → providerIds
}

// ResolveFor 请求归属租户 (header 缺失 → default; 对齐 TS resolveTenant)
func (t TenantConfig) ResolveFor(headerValue string) string {
	if headerValue != "" {
		return headerValue
	}
	return t.DefaultTenant
}

// ── SinkState 审计 sink 状态 ─────────────────────────────────────

// SinkState 已挂载审计 sink 的运行时状态 (对齐 TS auditSinkFactory 注册表:
// 新架构仅 memory(store)/bus 两类, 概念位保留 stdout/http/kafka 供 UI 显示)
type SinkState struct {
	Name     string `json:"name"`     // memory | bus (旧版兼容显示: stdout/http/kafka)
	Type     string `json:"type"`     // store | bus | stdout | http | kafka
	Enabled  bool   `json:"enabled"`  // 可经 POST /api/audit/sinks/config 开关 (memory 恒开)
	Received uint64 `json:"received"` // 累计接收条数 (memory=落库计数, bus=广播计数)
}
