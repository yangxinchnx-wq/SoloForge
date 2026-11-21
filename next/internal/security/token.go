// ─────────────────────────────────────────────────────────────────
// token — HTTP 认证中间件 (Bootstrap token + Bearer token 验证)
// (从 TS src/security/auth.ts 的 evaluateRequest / evaluateRequestAsync /
//
//	Principal / ROLE_BY_ROUTE 迁移)
//
// 标准: OWASP Node.js Security Cheat Sheet (常数时间比对) + RFC 6750
// (Bearer Token Usage: 401 + WWW-Authenticate)。
//
// 认证顺序 (对齐 TS evaluateRequest):
//
//	OPTIONS 预检放行 → 公开路径 → 回环信任 (SOLOFORGE_TRUST_LOOPBACK≠0)
//	→ Bearer header / ?token= 查询参数 (引导 token 或 SOLOFORGE_API_TOKENS)
//	→ 全部未命中 → 401 {error, reason}
//
// 放行后注入租户上下文 (对齐 TS addTenantContext):
//
//	租户格式非法 → 403 invalid_tenant_id; Bindings 校验不过 → 403
//	cross_tenant_access; 否则 ActiveTenantID = 显式租户或 PickDefaultTenant。
//
// 与 TS 的差异:
//   - TS 引导凭证来自 env SOLOFORGE_API_TOKENS / vault tokenStore;
//     Go 侧新增内存引导 token (auth.go Bootstrap) 作为 admin 凭证,
//     env tokens 作为 operator 凭证, 无 tokenStore/kid 体系
//     (inGrace/轮换家族语义随 tokenStore 不迁移)。
//   - TS 匹配到 token 后实际不再比对路由角色 (仅用于 401 reason 文案),
//     Go 保持同一行为; 另提供 RequireAdmin 严格守卫供敏感路由显式加挂。
//
// ─────────────────────────────────────────────────────────────────
package security

import (
	"context"
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// ── 角色与主体 ──────────────────────────────────────────────────

// Role 主体角色 (对齐 TS auth.ts Role)
type Role string

const (
	RoleAdmin    Role = "admin"
	RoleOperator Role = "operator"
	RoleAgent    Role = "agent"
	RolePublic   Role = "public"
)

// Principal 请求主体 (对齐 TS auth.ts Principal)
type Principal struct {
	ID             string   `json:"id"`                  // bootstrap | token | loopback | anonymous
	Role           Role     `json:"role"`                // admin | operator | agent | public
	Source         string   `json:"source"`              // bootstrap | bearer | env-token | loopback | anonymous
	TenantIDs      []string `json:"tenantIds,omitempty"` // 允许租户; nil = 全通 (对齐 TS 缺省 ['*'])
	ActiveTenantID string   `json:"activeTenantId,omitempty"`
	Kid            string   `json:"kid,omitempty"` // 凭证标识 (供审计)
	InGrace        bool     `json:"inGrace,omitempty"`
}

// IsTokenPrincipal 是否持凭证主体 (仅这类主体做 Bindings 显式绑定校验,
// 对齐 TS: bindings 校验只发生在 bearer tokenStore 路径)
func (p Principal) IsTokenPrincipal() bool {
	switch p.Source {
	case "bootstrap", "bearer", "env-token":
		return true
	}
	return false
}

// ── 路由角色表 / 公开路径 (对齐 TS ROLE_BY_ROUTE / defaultAuthConfig) ──

// routeRoles 路由前缀 → 最低角色 (对齐 TS ROLE_BY_ROUTE)
var routeRoles = []struct {
	prefix string
	role   Role
}{
	{"/api/vault", RoleAdmin},
	{"/api/admin", RoleAdmin},
	{"/api/audit", RoleAdmin},
	{"/api/agents", RoleOperator},
	{"/api/governor", RoleOperator},
	{"/api/decisions", RoleOperator},
	{"/api/court", RoleOperator},
	{"/api/kernel", RoleOperator},
	{"/api/scheduler", RoleOperator},
	{"/ui/", RolePublic},
}

// defaultPublicRoutes 默认公开路径 (对齐 TS defaultAuthConfig.publicRoutes)
var defaultPublicRoutes = []string{
	"/api/health",
	"/api/kernel/health",
	"/api/kernel/status",
	"/", "/admin", "/ui",
}

// requiredRoleFor 路由所需角色 (对齐 TS ROLE_BY_ROUTE 匹配逻辑)
func requiredRoleFor(reqPath string) Role {
	for _, rr := range routeRoles {
		if reqPath == rr.prefix ||
			strings.HasPrefix(reqPath, rr.prefix+"/") ||
			strings.HasPrefix(reqPath, rr.prefix) {
			return rr.role
		}
	}
	return RolePublic
}

// isPublicPath 公开路径匹配 (对齐 TS: 精确相等, 或以 '/' 结尾的目录前缀)
func isPublicPath(reqPath string) bool {
	for _, pub := range defaultPublicRoutes {
		if reqPath == pub {
			return true
		}
		if len(pub) > 1 && strings.HasSuffix(pub, "/") && strings.HasPrefix(reqPath, pub) {
			return true
		}
	}
	return false
}

// ── 凭证来源 ────────────────────────────────────────────────────

const (
	maxAuthHeaderLen = 4096 // Authorization 头上限 (对齐 TS maxAuthHeaderLength)
	maxTokenLen      = 1024 // token 本体上限 (对齐 TS extractBearerToken)
	// piiSalt hashPii 盐 (进程内固定串; PII 仅落脱敏哈希)
	piiSalt = "soloforge.pii"
)

// envAPITokens env 配置的 API token 列表 (SOLOFORGE_API_TOKENS, 逗号分隔;
// 进程内只读一次, 对齐 TS loadApiTokens 的 env 热路径)
var envAPITokens = sync.OnceValue(func() []string {
	raw := os.Getenv("SOLOFORGE_API_TOKENS")
	if raw == "" {
		return nil
	}
	out := make([]string, 0, 8)
	for _, t := range strings.Split(raw, ",") {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, t)
		}
	}
	return out
})

// trustLoopbackEnabled 回环信任开关 (对齐 TS trustLoopback: 缺省开)
func trustLoopbackEnabled() bool {
	return os.Getenv("SOLOFORGE_TRUST_LOOPBACK") != "0"
}

// extractBearerToken 提取 Bearer 凭证 (对齐 TS extractBearerToken / RFC 6750)
func extractBearerToken(r *http.Request) string {
	raw := r.Header.Get("Authorization")
	if raw == "" || len(raw) > maxAuthHeaderLen || len(raw) < 7 {
		return ""
	}
	if !strings.EqualFold(raw[:7], "bearer ") {
		return ""
	}
	token := strings.TrimSpace(raw[7:])
	if token == "" || len(token) > maxTokenLen {
		return ""
	}
	return token
}

// constantTimeEqual 常数时间字符串比对 (crypto/subtle; 长度不等立即失败,
// 与 TS safeEqual 的手工循环等价且为 Go 惯用实现)
func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// isLoopbackAddr 回环地址判定 (对齐 TS isLoopback; Go RemoteAddr 带端口先剥离)
func isLoopbackAddr(remoteAddr string) bool {
	host := remoteAddr
	if h, _, err := net.SplitHostPort(remoteAddr); err == nil {
		host = h
	}
	if host == "127.0.0.1" || host == "::1" || host == "localhost" {
		return true
	}
	return strings.HasSuffix(host, "127.0.0.1")
}

// hashPii PII 脱敏哈希 (对齐 TS auth.ts hashPii: 双通道 FNV-1a → 16 hex)。
// IP 等被审计字段只落哈希, 不落原文。
func hashPii(value, salt string) string {
	const (
		fnvInit1 = 0x811c9dc5
		fnvInit2 = 0x1000193
		fnvPrime = 0x01000193
	)
	h1, h2 := uint32(fnvInit1), uint32(fnvInit2)
	combined := salt + value
	for _, ch := range combined {
		h1 ^= uint32(ch)
		h1 *= fnvPrime
		h2 ^= uint32(ch) << 1
		h2 *= fnvPrime
	}
	return fmt.Sprintf("%08x%08x", h1, h2)
}

// ── 鉴权判定 ────────────────────────────────────────────────────

// Authenticate 请求鉴权 (对齐 TS evaluateRequest + addTenantContext)。
// 返回 (principal, 拒绝状态码 [0=放行], 拒绝原因)。
// 拒绝原因对齐 TS: unauthenticated | insufficient_credentials |
// invalid_tenant_id | cross_tenant_access。
func (s *Service) Authenticate(r *http.Request) (Principal, int, string) {
	// 0) CORS 预检放行 (对齐 TS OPTIONS 分支)
	if r.Method == http.MethodOptions {
		return Principal{ID: "anonymous", Role: RolePublic, Source: "anonymous"}, 0, ""
	}

	// 1) 公开路径 → 匿名主体
	if isPublicPath(r.URL.Path) {
		p := Principal{ID: "anonymous", Role: RolePublic, Source: "anonymous"}
		return s.withTenantContext(r, p, 0, "")
	}

	// 2) 回环信任 (本机 UI / dev, 对齐 TS loopback → admin)
	if trustLoopbackEnabled() && isLoopbackAddr(r.RemoteAddr) {
		p := Principal{ID: "loopback", Role: RoleAdmin, Source: "loopback"}
		return s.withTenantContext(r, p, 0, "")
	}

	// 3) Bearer header / ?token= 查询参数 (对齐 TS candidate = bearer || queryToken)
	candidate := extractBearerToken(r)
	source := "bearer"
	if candidate == "" {
		candidate = r.URL.Query().Get("token")
		source = "env-token" // 对齐 TS: query token 命中记 env-token 来源
	}
	if candidate != "" {
		// 3a) 引导 token (admin; 吊销/为空 → Verify=false, 常数时间比对)
		if s.auth.Verify(candidate) {
			p := Principal{ID: "bootstrap", Role: RoleAdmin, Source: "bootstrap", Kid: "bootstrap"}
			return s.withTenantContext(r, p, 0, "")
		}
		// 3b) env token (operator; 全表比对不短路, 抑制时序侧信道)
		matched := false
		for _, t := range envAPITokens() {
			if t != "" && constantTimeEqual(candidate, t) {
				matched = true
			}
		}
		if matched {
			p := Principal{ID: "token", Role: RoleOperator, Source: source, Kid: "token"}
			return s.withTenantContext(r, p, 0, "")
		}
		// 3c) token 轮换族 v2 (keychain 高级特性迁移): 复用检测三态
		//   active → operator; rotating+宽限内 → operator (网络重试容忍);
		//   rotating+宽限过 → reuse_detected → 整族吊销 + 401;
		//   revoked → 401; 不在族中 → 落到步骤 4 拒绝 (对齐 TS auth.ts)
		if s.tokens != nil {
			decision := s.tokens.CheckReuse(candidate, time.Now())
			switch decision.Decision {
			case ReuseAllow, ReuseAllowInGrace:
				p := Principal{ID: "token:" + decision.Record.KID, Role: RoleOperator,
					Source: source, Kid: decision.Record.KID}
				return s.withTenantContext(r, p, 0, "")
			case ReuseDetected:
				revoked := s.tokens.HandleReuseDetected(decision.Record, time.Now())
				return Principal{}, http.StatusUnauthorized,
					fmt.Sprintf("token_reuse_detected (family revoked, %d tokens)", revoked)
			case ReuseRevoked:
				return Principal{}, http.StatusUnauthorized, "token_revoked"
			}
			// unknown (不在族中) → 步骤 4
		}
	}

	// 4) 拒绝: 401, reason 按路由角色 (对齐 TS 尾部分支)
	reason := "unauthenticated"
	if role := requiredRoleFor(r.URL.Path); role != RolePublic {
		reason = "insufficient_credentials"
	}
	return Principal{}, http.StatusUnauthorized, reason
}

// withTenantContext 放行路径上的租户上下文注入 + 显式绑定校验
// (对齐 TS addTenantContext / checkTenantAccess):
//   - 显式租户格式非法 → 403 invalid_tenant_id (深度防御, 提取层已过滤)
//   - 持凭证主体: TenantIDs 有值 → 直接校验; 否则查 Bindings[principalID]
//   - 校验不过 → 403 cross_tenant_access
//   - 未显式指定 → PickDefaultTenant
func (s *Service) withTenantContext(r *http.Request, p Principal, deny int, reason string) (Principal, int, string) {
	if deny != 0 {
		return p, deny, reason
	}
	requested, explicit := s.TenantFromRequest(r)
	if explicit {
		if !IsValidTenantID(requested) {
			return p, http.StatusForbidden, "invalid_tenant_id"
		}
		var chk TenantCheckResult
		if len(p.TenantIDs) > 0 {
			chk = CheckTenantAccess(p.TenantIDs, requested)
		} else {
			chk = s.CheckTenantBinding(p.ID, requested)
		}
		if !chk.OK {
			return p, http.StatusForbidden, "cross_tenant_access"
		}
		p.ActiveTenantID = requested
		return p, 0, ""
	}
	if !p.IsTokenPrincipal() {
		// 匿名/回环主体强制单租户模式 (对齐 TS public/loopback → '_default')
		p.ActiveTenantID = defaultTenantID
		return p, 0, ""
	}
	p.ActiveTenantID = PickDefaultTenant(p.TenantIDs, string(p.Role))
	return p, 0, ""
}

// ── HTTP 中间件 ─────────────────────────────────────────────────

type principalCtxKey struct{}

// PrincipalFrom 从请求上下文取主体 (经 AuthMiddleware 注入)
func PrincipalFrom(r *http.Request) (Principal, bool) {
	p, ok := r.Context().Value(principalCtxKey{}).(Principal)
	return p, ok
}

// WithPrincipal 显式注入主体 (供测试 / 内部桥接)
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalCtxKey{}, p)
}

// AuthMiddleware 认证中间件:
//   - 放行 → 注入 Principal (含 ActiveTenantID) 进 context
//   - 401/403 → 写审计 (auth.denied, remoteAddress 走 hashPii 脱敏) 后
//     返回 JSON {error, reason}; 401 带 WWW-Authenticate (RFC 6750)
func (s *Service) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, deny, reason := s.Authenticate(r)
		if deny != 0 {
			s.emit(r.Context(), "auth.denied", r.URL.Path, r.Method, deny, map[string]any{
				"reason":        reason,
				"remoteAddress": hashPii(r.RemoteAddr, piiSalt), // PII 只落哈希
				"userAgent":     r.UserAgent(),
			})
			if deny == http.StatusUnauthorized {
				// RFC 6750: 携带过凭证才标 invalid_token
				if extractBearerToken(r) != "" || r.URL.Query().Get("token") != "" {
					w.Header().Set("WWW-Authenticate", `Bearer realm="soloforge", error="invalid_token"`)
				} else {
					w.Header().Set("WWW-Authenticate", `Bearer realm="soloforge"`)
				}
			}
			writeJSON(w, deny, map[string]any{
				"error":  http.StatusText(deny),
				"reason": reason,
			})
			return
		}
		if p.ActiveTenantID == "" {
			p.ActiveTenantID = s.ResolveTenant(r)
		}
		next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), p)))
	})
}

// RequireRole 严格角色守卫 (挂在 AuthMiddleware 之后; 对齐 TS
// ROLE_BY_ROUTE 的 admin/operator 语义, 供敏感路由显式加挂)
func RequireRole(role Role, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p, ok := PrincipalFrom(r); ok && p.Role == role {
			next.ServeHTTP(w, r)
			return
		}
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error":  http.StatusText(http.StatusForbidden),
			"reason": "insufficient_role",
		})
	})
}

// RequireAdmin 管理员守卫 (vault / admin / audit 等敏感路由)
func RequireAdmin(next http.Handler) http.Handler {
	return RequireRole(RoleAdmin, next)
}
