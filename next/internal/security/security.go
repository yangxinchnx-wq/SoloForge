// ─────────────────────────────────────────────────────────────────
// security — 安全层: 密钥库 / 审计 / 认证引导
// (从 TS src/server/routes-vault.ts + src/security/ 迁移)
//
// 覆盖 docs/protocol.md §12.1 routes-vault + audit + auth 全部 15 条:
//   vault: GET/POST /api/vault/keys, GET/PUT/DELETE /api/vault/keys/{id},
//          GET /api/vault/keys/{id}/reveal, POST /api/vault/keys/{id}/verify,
//          POST /api/vault/export|import|verify-passphrase
//   auth : GET /api/auth/bootstrap (启动 token, crypto/rand 32B, 内存有效)
//   audit: GET /api/audit/list|stats|sinks, POST /api/audit/sinks/config
//
// 存储纪律: 项目无 SQLite — 密钥库/审计/配置全部进程内 (重启清零)。
// 密钥值落"库"前经 AES-256-GCM 加密, 主密钥 PBKDF2-SHA256(200k) 派生;
// 导出 blob (v1) 与旧 TS 实现 vaultExport.ts 格式逐字段互通。
//
// 事件: 密钥增删改/导入导出等先落 store 后广播 bus ("先写后发"纪律),
// 事件名 audit.recorded (对齐旧系统审计语义), action 前缀 vault.* / audit.*,
// 供 GET /api/audit/list 按 type=audit.* 前缀过滤查询。
// ─────────────────────────────────────────────────────────────────
package security

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

// ── 常量 ────────────────────────────────────────────────────────

const (
	// EventAuditRecorded 审计事件类型 (对齐旧系统 audit.recorded 语义)
	EventAuditRecorded = "audit.recorded"

	// SourceMemory 密钥来源标记 (新实现统一进程内密文库; 旧版有 keychain/env 两级)
	SourceMemory = "memory"

	// pbkdf2Iterations KDF 迭代次数 (对齐旧 vaultExport.ts: 200k)
	pbkdf2Iterations = 200_000
	// saltLen / nonceLen blob 布局参数 (对齐旧版: 16B salt, 12B GCM IV)
	saltLen  = 16
	nonceLen = 12
)

// ── 服务 ────────────────────────────────────────────────────────

// Service 安全层服务 (密钥库 + 引导 token + 审计/租户/sink 配置)
type Service struct {
	store *store.Store
	bus   *bus.EventBus

	vault *Vault     // 密钥库 (AES-GCM 密文 map)
	auth  *Bootstrap // 启动 token

	mu     sync.Mutex
	tenant TenantConfig          // 多租户上下文配置 (POST /api/audit/sinks/config 可改)
	sinks  map[string]*SinkState // 已挂载 sink 注册表 (memory=store 落库, bus=广播)
}

// New 创建安全层服务: 启动即派生主密钥/生成引导 token, 注册默认 sink
func New(st *store.Store, b *bus.EventBus) *Service {
	s := &Service{
		store: st,
		bus:   b,
		vault: NewVault(),
		auth:  NewBootstrap(),
		tenant: TenantConfig{
			HeaderName:    "X-Tenant-Id", // 对齐 TS tenantContext.ts 默认值
			PathPrefix:    "/api/t/",
			DefaultTenant: "_default",
			Bindings:      map[string][]string{},
		},
		sinks: map[string]*SinkState{},
	}
	// 默认 sink: store (审计事件落库, 恒开) + bus (进程内广播, 可经 config 关闭)
	s.sinks["memory"] = &SinkState{Name: "memory", Type: "store", Enabled: true}
	s.sinks["bus"] = &SinkState{Name: "bus", Type: "bus", Enabled: true}
	return s
}

// Vault 密钥库句柄 (供其他包内部解析密钥, 如 llm proxy)
func (s *Service) Vault() *Vault { return s.vault }

// ── 审计事件 ────────────────────────────────────────────────────

// emit 审计事件: 先落库 (type=audit.recorded) 后广播 (bus)。
// payload 结构对齐 TS auth.ts AuditEvent; 只记元信息, 绝不写密钥明文。
func (s *Service) emit(ctx context.Context, action, route, method string, status int, extra map[string]any) {
	s.mu.Lock()
	defaultTenant := s.tenant.DefaultTenant
	busOn := true
	if st, ok := s.sinks["bus"]; ok {
		busOn = st.Enabled
	}
	if st, ok := s.sinks["memory"]; ok && st.Enabled {
		st.Received++ // memory sink = store 落库本身
	}
	s.mu.Unlock()

	payload := map[string]any{
		"id":        fmt.Sprintf("aud_%d", time.Now().UnixNano()),
		"timestamp": time.Now().UnixMilli(),
		"action":    action,
		"route":     route,
		"method":    method,
		"status":    status,
		"tenantId":  defaultTenant,
	}
	for k, v := range extra {
		payload[k] = v
	}
	raw, _ := json.Marshal(payload)
	if ev, err := s.store.AppendEvent(ctx, EventAuditRecorded, "security", raw); err == nil && busOn {
		s.bus.Publish(ev.Type, ev.Source, ev.Payload)
	}
}
