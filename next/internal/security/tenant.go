// ─────────────────────────────────────────────────────────────────
// tenant — 多租户上下文解析 + 显式绑定 (Bindings) 校验
// (从 TS src/security/tenantContext.ts 迁移)
//
// 语义对齐:
//   IsValidTenantID    ← isValidTenantId (^[A-Za-z0-9_-]{1,64}$)
//   ExtractTenantID    ← extractTenantId (路径前缀优先于 header)
//   CheckTenantAccess  ← checkTenantAccess (wildcard / explicit / 跨租户拒绝)
//   ParseBindings      ← parseBindings ('kid1:t1,kid2:t1+t2,kid3:*')
//   PickDefaultTenant  ← pickDefaultTenant
//
// 配置来源 (security.go Service.tenant, 对齐 TS TenantContextConfig):
//   HeaderName    租户头, 默认 X-Tenant-Id
//   PathPrefix    路径前缀式租户, 默认 /api/t/
//   DefaultTenant 缺省租户, 默认 _default
//   Bindings      主体 → 允许租户列表 (TS bindings[kid]), 见 CheckTenantBinding
//
// 对齐 docs/protocol.md §2: Kafka 审计消息 key = tenantId|'_default',
// 故每个审计事件必须带确定的租户归属。
// ─────────────────────────────────────────────────────────────────
package security

import (
	"net/http"
	"regexp"
	"strings"
)

const (
	// defaultTenantID 缺省租户 (对齐 TS DEFAULT_TENANT)
	defaultTenantID = "_default"
	// tenantWildcard 全通标记 (对齐 TS WILDCARD)
	tenantWildcard = "*"
)

var (
	// tenantIDRE 租户 ID 白名单: 字母/数字/下划线/连字符, 1-64 字符
	tenantIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	// tenantPathSegRE 路径前缀后的租户段: /api/t/<id>/ 或 /api/t/<id> 结尾
	tenantPathSegRE = regexp.MustCompile(`^([A-Za-z0-9_-]{1,64})(?:/|$)`)
)

// IsValidTenantID 租户 ID 格式校验 (对齐 TS isValidTenantId)
func IsValidTenantID(id string) bool {
	return tenantIDRE.MatchString(id)
}

// ExtractTenantID 从请求解析租户 ID, 优先级对齐 TS extractTenantId:
//  1. 路径前缀 /api/t/<id>/... (兼容性最好)
//  2. 租户 header (X-Tenant-Id, 名字可经 TenantConfig.HeaderName 配置)
//  3. 都没有 → ("", false), 由调用方决定 fallback
//
// 返回 (tenantID, 是否显式指定)。格式非法的 header/路径段视为未指定
// (对齐 TS: isValidTenantId 不通过则继续向下找)。
func ExtractTenantID(reqPath, headerValue, pathPrefix string) (string, bool) {
	// 1) 路径前缀
	if reqPath != "" && pathPrefix != "" && strings.HasPrefix(reqPath, pathPrefix) {
		rest := reqPath[len(pathPrefix):]
		if m := tenantPathSegRE.FindStringSubmatch(rest); m != nil {
			return m[1], true
		}
	}
	// 2) header
	if headerValue != "" && IsValidTenantID(headerValue) {
		return headerValue, true
	}
	return "", false
}

// ── 跨租户检查 ──────────────────────────────────────────────────

// TenantCheckResult 跨租户检查结果 (对齐 TS TenantCheckResult)
type TenantCheckResult struct {
	OK       bool   `json:"ok"`
	TenantID string `json:"tenantId"`
	// Reason: ok_wildcard | ok_explicit | invalid_id | cross_tenant
	Reason string `json:"reason,omitempty"`
}

// CheckTenantAccess 跨租户检查: 给定主体允许的租户列表与请求租户, 决定放行。
// 对齐 TS checkTenantAccess:
//   - 请求租户格式非法 → invalid_id
//   - allowed 为空/nil → 全通 (admin-like)
//   - allowed 含 * → 全通
//   - 精确命中 → 放行
//   - 其余 → cross_tenant (403)
func CheckTenantAccess(allowed []string, requested string) TenantCheckResult {
	if !IsValidTenantID(requested) {
		return TenantCheckResult{OK: false, TenantID: requested, Reason: "invalid_id"}
	}
	if len(allowed) == 0 {
		return TenantCheckResult{OK: true, TenantID: requested, Reason: "ok_wildcard"}
	}
	for _, t := range allowed {
		if t == tenantWildcard {
			return TenantCheckResult{OK: true, TenantID: requested, Reason: "ok_wildcard"}
		}
	}
	for _, t := range allowed {
		if t == requested {
			return TenantCheckResult{OK: true, TenantID: requested, Reason: "ok_explicit"}
		}
	}
	return TenantCheckResult{OK: false, TenantID: requested, Reason: "cross_tenant"}
}

// ParseBindings 解析 SOLOFORGE_TENANT_BINDINGS 风格配置:
//
//	'kid1:t1,kid2:t1+t2,kid3:*' → {kid1:[t1], kid2:[t1,t2], kid3:[*]}
//
// 对齐 TS parseBindings (routes-vault.ts POST /api/audit/sinks/config
// 的 bindings/bindingsRaw 字段即此格式)。
func ParseBindings(raw string) map[string][]string {
	out := map[string][]string{}
	if raw == "" {
		return out
	}
	for _, pair := range strings.Split(raw, ",") {
		kid, list, found := strings.Cut(pair, ":")
		if !found || strings.TrimSpace(kid) == "" || strings.TrimSpace(list) == "" {
			continue
		}
		tenants := make([]string, 0, 4)
		for _, t := range strings.Split(list, "+") {
			if t = strings.TrimSpace(t); t != "" {
				tenants = append(tenants, t)
			}
		}
		if len(tenants) > 0 {
			out[strings.TrimSpace(kid)] = tenants
		}
	}
	return out
}

// PickDefaultTenant 给主体挑一个合理的默认租户 (对齐 TS pickDefaultTenant):
//   - admin / public / agent → _default (单租户模式)
//   - operator 无绑定 / 绑定含 * / 多租户 → _default
//   - operator 单租户绑定 → 那个唯一的租户
func PickDefaultTenant(allowed []string, role string) string {
	if role == string(RoleAdmin) || role == string(RolePublic) || role == string(RoleAgent) {
		return defaultTenantID
	}
	if len(allowed) == 1 && allowed[0] != tenantWildcard {
		return allowed[0]
	}
	return defaultTenantID
}

// ── Service 级租户解析 ──────────────────────────────────────────

// TenantFromRequest 服务级租户解析: 读运行时 TenantConfig
// (HeaderName/PathPrefix), 返回 (tenantID, 是否显式指定)。
func (s *Service) TenantFromRequest(r *http.Request) (string, bool) {
	s.mu.Lock()
	cfg := s.tenant
	s.mu.Unlock()
	headerValue := ""
	if cfg.HeaderName != "" {
		headerValue = r.Header.Get(cfg.HeaderName)
	}
	prefix := cfg.PathPrefix
	if prefix == "" {
		prefix = "/api/t/" // 防御: 配置被清空时回退默认前缀
	}
	return ExtractTenantID(r.URL.Path, headerValue, prefix)
}

// ResolveTenant 请求归属租户: 显式指定 → 用之; 否则 default
// (对齐 TS resolveTenant / auth.go TenantConfig.ResolveFor)
func (s *Service) ResolveTenant(r *http.Request) string {
	if id, ok := s.TenantFromRequest(r); ok {
		return id
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tenant.DefaultTenant != "" {
		return s.tenant.DefaultTenant
	}
	return defaultTenantID
}

// CheckTenantBinding Bindings 显式绑定校验: 主体 principalID 是否被允许
// 访问 requested 租户。Bindings 键 = 主体验 (token kid / principal ID),
// 值 = 允许租户列表 — 对齐 TS tenantContext.ts bindings[kid] 语义
// (注: auth.go TenantConfig.Bindings 字段注释写的是 "tenant → providerIds",
// 实际沿用 TS 的 "主体 → 租户列表" 结构, 键义由调用方约定)。
// 校验规则对齐 checkTenantAccess:
//   - Bindings 为空 / 该主体无条目 → 通配放行 (TS: undefined → 全通)
//   - 有条目 → 精确匹配或 * 放行, 否则 cross_tenant
func (s *Service) CheckTenantBinding(principalID, requested string) TenantCheckResult {
	s.mu.Lock()
	bindings := s.tenant.Bindings
	s.mu.Unlock()
	if len(bindings) == 0 {
		return TenantCheckResult{OK: true, TenantID: requested, Reason: "ok_wildcard"}
	}
	allowed, ok := bindings[principalID]
	if !ok || len(allowed) == 0 {
		return TenantCheckResult{OK: true, TenantID: requested, Reason: "ok_wildcard"}
	}
	return CheckTenantAccess(allowed, requested)
}
