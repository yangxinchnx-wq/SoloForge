// ─────────────────────────────────────────────────────────────────
// tokenstore_test.go — security 高级特性迁移自测 (keychain/token 轮换家族)
//
// 覆盖: tokenStore v2 状态机 (init/rotate/grace/GC/整族吊销)、
// v1 → v2 迁移、复用检测三态、轮换服务 tick (lead 窗口)、
// auth 中间件接入 (active 放行 / 宽限放行 / 过期拒绝)。
// ─────────────────────────────────────────────────────────────────
package security

import (
	"context"
	"encoding/base64"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"soloforge/next/internal/bus"
	"soloforge/next/internal/store"
)

func newTestTokenStore(t *testing.T) *TokenStore {
	t.Helper()
	ts := NewTokenStore(NewVault())
	ts.Init()
	return ts
}

func TestTokenStoreLifecycle(t *testing.T) {
	ts := newTestTokenStore(t)
	ctx := time.Now()

	// init: 无 parent → 新族 active
	root, err := ts.CreateToken(CreateTokenOptions{Source: TokenSourceInit, Now: ctx})
	if err != nil {
		t.Fatal(err)
	}
	if root.Status != TokenActive || root.ParentKID != "" {
		t.Fatalf("root token 状态错误: %+v", root)
	}
	// rotate: 有 parent → 同族, parent 进 rotating
	fresh, err := ts.CreateToken(CreateTokenOptions{ParentKID: root.KID, Source: TokenSourceRotate, Now: ctx})
	if err != nil {
		t.Fatal(err)
	}
	if fresh.FamilyID != root.FamilyID || fresh.ParentKID != root.KID {
		t.Fatalf("轮换链错误: %+v", fresh)
	}
	parent := ts.FindByKid(root.KID)
	if parent.Status != TokenRotating || parent.GraceUntil == 0 {
		t.Fatalf("parent 应进入 rotating+宽限: %+v", parent)
	}
	// GC: 未过宽限 → 不吊销
	if n := ts.GCExpiredTokens(ctx.Add(DefaultTokenGracePeriod / 2)); n != 0 {
		t.Fatalf("宽限期内 GC 不应吊销: %d", n)
	}
	// 过宽限 → rotating 转 revoked
	if n := ts.GCExpiredTokens(ctx.Add(DefaultTokenGracePeriod + time.Minute)); n != 1 {
		t.Fatalf("过宽限 GC 应吊销 1 条: %d", n)
	}
	if got := ts.FindByKid(root.KID); got.Status != TokenRevoked {
		t.Fatalf("GC 后应为 revoked: %+v", got)
	}
	if got := ts.FindByKid(fresh.KID); got.Status != TokenActive {
		t.Fatalf("新 token 应保持 active: %+v", got)
	}
}

func TestReuseDetectionRevokesFamily(t *testing.T) {
	ts := newTestTokenStore(t)
	now := time.Now()

	root, _ := ts.CreateToken(CreateTokenOptions{Source: TokenSourceInit, Now: now})
	// 1. active → allow
	if d := ts.CheckReuse(root.Token, now); d.Decision != ReuseAllow {
		t.Fatalf("active 应 allow: %+v", d)
	}
	// 轮换 → parent rotating
	fresh, _ := ts.CreateToken(CreateTokenOptions{ParentKID: root.KID, Source: TokenSourceRotate, Now: now})
	// 2. 宽限期内 → allow_in_grace
	if d := ts.CheckReuse(root.Token, now.Add(time.Second)); d.Decision != ReuseAllowInGrace {
		t.Fatalf("宽限内应 allow_in_grace: %+v", d)
	}
	// 3. 宽限期过 → reuse_detected
	d3 := ts.CheckReuse(root.Token, now.Add(DefaultTokenGracePeriod+time.Minute))
	if d3.Decision != ReuseDetected {
		t.Fatalf("过宽限应 reuse_detected: %+v", d3)
	}
	// 4. 处置: 整族吊销 (root + fresh 连坐)
	if n := ts.HandleReuseDetected(d3.Record, now); n != 2 {
		t.Fatalf("整族吊销应影响 2 条, 实际 %d", n)
	}
	// 5. 族内新 token 也 revoked
	if d := ts.CheckReuse(fresh.Token, now); d.Decision != ReuseRevoked {
		t.Fatalf("族内新 token 应连坐 revoked: %+v", d)
	}
	// 6. unknown: 不在库
	if d := ts.CheckReuse("not-in-store", now); d.Decision != ReuseUnknown {
		t.Fatalf("未知 token 应 unknown: %+v", d)
	}
}

func TestTokenStoreV1Migration(t *testing.T) {
	v := NewVault()
	// 预置 v1: base64url(JSON string[])
	blob := base64.RawURLEncoding.EncodeToString(
		[]byte(`["legacy-token-a","legacy-token-b"]`))
	if _, err := v.SetKey(TokenVaultProviderIDV1, blob, "v1"); err != nil {
		t.Fatal(err)
	}
	ts := NewTokenStore(v)
	snap := ts.Init()
	if len(snap.Tokens) != 2 || len(snap.Families) != 1 {
		t.Fatalf("v1 迁移应得 2 token/1 族: %+v", snap)
	}
	if snap.Tokens[0].Token != "legacy-token-a" {
		t.Fatalf("迁移 token 明文错误: %+v", snap.Tokens[0])
	}
	if ts.FindByToken("legacy-token-b") == nil {
		t.Fatal("迁移后旧 token 应可查")
	}
	// v2 已落金库 (下次启动直接读 v2)
	if _, _, _, ok := v.Resolve(TokenVaultProviderIDV2); !ok {
		t.Fatal("迁移后应写 v2 快照")
	}
}

func TestRotationServiceTick(t *testing.T) {
	ts := newTestTokenStore(t)
	t.Setenv("SOLOFORGE_ROTATION_LEAD_MS", "10") // lead=10ms
	now := time.Now()
	// 造两条: near (TTL 50ms → 40ms 时已过 lead 窗口边界) 与 far (远期)
	near, _ := ts.CreateToken(CreateTokenOptions{Source: TokenSourceInit, Now: now, TTL: 50 * time.Millisecond})
	far, _ := ts.CreateToken(CreateTokenOptions{Source: TokenSourceInit, Now: now, TTL: 90 * 24 * time.Hour})

	svc := NewTokenRotationService(ts)
	res, err := svc.TickOnce(now.Add(40 * time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.RotatedKids) != 1 {
		t.Fatalf("应轮换 1 条 (临期), 实际 %+v", res.RotatedKids)
	}
	fresh := ts.FindByKid(res.RotatedKids[0])
	if fresh == nil || fresh.ParentKID != near.KID {
		t.Fatalf("轮换链错误: %+v", fresh)
	}
	if got := ts.FindByKid(far.KID); got.Status != TokenActive {
		t.Fatalf("远期 token 不应轮换: %+v", got)
	}
}

func TestAuthMiddlewareTokenFamily(t *testing.T) {
	st := store.New()
	svc := New(st, bus.NewEventBus())
	ts := newTestTokenStore(t)
	svc.SetTokens(ts)
	now := time.Now()

	root, _ := ts.CreateToken(CreateTokenOptions{Source: TokenSourceInit, Now: now})

	authGet := func(token string) (int, string) {
		req := httptest.NewRequest("GET", "/api/agents/snapshot", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		_, code, reason := svc.Authenticate(req)
		return code, reason
	}

	// 1. active → 放行
	if code, _ := authGet(root.Token); code != 0 {
		t.Fatalf("active token 应放行: %d", code)
	}
	// 2. 轮换后旧 token 宽限内仍放行
	fresh, _ := ts.CreateToken(CreateTokenOptions{ParentKID: root.KID, Source: TokenSourceRotate, Now: now})
	if code, _ := authGet(root.Token); code != 0 {
		t.Fatalf("宽限内应放行: %d", code)
	}
	// 3. 宽限过 + GC → 401 token_revoked
	ts.GCExpiredTokens(now.Add(DefaultTokenGracePeriod + time.Minute))
	if code, reason := authGet(root.Token); code != 401 || !strings.Contains(reason, "token_revoked") {
		t.Fatalf("过期后应 401 token_revoked: %d %s", code, reason)
	}
	// 4. 新 token 仍可用
	if code, _ := authGet(fresh.Token); code != 0 {
		t.Fatalf("新 token 应放行: %d", code)
	}
	// 5. context 携带主体 (WithPrincipal → PrincipalFrom 路径)
	req := httptest.NewRequest("GET", "/api/agents/snapshot", nil)
	req.Header.Set("Authorization", "Bearer "+fresh.Token)
	p, code, _ := svc.Authenticate(req)
	if code != 0 {
		t.Fatal("应放行")
	}
	req = req.WithContext(WithPrincipal(context.Background(), p))
	if got, ok := PrincipalFrom(req); !ok || got.ID != p.ID {
		t.Fatal("PrincipalFrom 应取回主体")
	}
}
