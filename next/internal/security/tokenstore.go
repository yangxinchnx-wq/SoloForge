// ─────────────────────────────────────────────────────────────────
// tokenstore.go — Token + Token Family 存储层 v2
// (从 TS src/security/tokenStore.ts 迁移 — 补齐清单标注的 security
//
//	高级特性; 早期迁移曾有意裁剪, 见 token.go 头部历史注释)
//
// 数据模型 (对齐 TS):
//
//	TokenRecord {
//	  kid        "k_<8hex>"        唯一 Key ID
//	  token      64 hex            明文 token
//	  status     active|rotating|revoked
//	  familyId   "f_<8hex>"        轮换族
//	  parentKid  轮换链: 当前 kid 从哪个 kid 继承
//	  createdAt / expiresAt (active TTL) / rotatedAt /
//	  graceUntil (rotating 宽限截止) / revokedAt / source
//	}
//	FamilyRecord { familyId, currentKid, revoked, revokedAt, revokeReason }
//
// 状态机:
//
//	active → (RotationWorker) → rotating (宽限期内仍可用)
//	       → (宽限期过 OR 复用检测命中) → revoked (物理拒绝)
//
// 物理存储: Go 金库 (AES-256-GCM, vault.go) provider id =
//
//	'soloforge.api.tokens.v2', base64url(JSON) 快照。
//	v1 ('soloforge.api.tokens', 纯 string[]) 启动时一次性迁移:
//	全部旧 token 视为同一族 active。
//
// 并发: 内存快照 + mutex (单进程一致; 写穿透到金库)。
// ─────────────────────────────────────────────────────────────────
package security

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// TokenStatus token 状态 (对齐 TS TokenStatus)
type TokenStatus string

const (
	TokenActive   TokenStatus = "active"
	TokenRotating TokenStatus = "rotating"
	TokenRevoked  TokenStatus = "revoked"
)

// FamilyRevokeReason 整族吊销原因 (对齐 TS)
type FamilyRevokeReason string

const (
	FamilyRevokeReuse   FamilyRevokeReason = "reuse_detected"
	FamilyRevokeManual  FamilyRevokeReason = "manual"
	FamilyRevokeExpired FamilyRevokeReason = "expired"
)

// TokenSource token 来源 (对齐 TS)
type TokenSource string

const (
	TokenSourceInit   TokenSource = "init"
	TokenSourceRotate TokenSource = "rotate"
	TokenSourceManual TokenSource = "manual"
	TokenSourceEnv    TokenSource = "env"
)

// 常量 (对齐 TS tokenStore.ts)
const (
	TokenVaultProviderIDV2 = "soloforge.api.tokens.v2"
	TokenVaultProviderIDV1 = "soloforge.api.tokens" // 旧版, 仅一次性迁移

	DefaultTokenTTL         = 90 * 24 * 60 * 60 * 1000 * time.Millisecond // 90 天
	DefaultTokenGracePeriod = 24 * 60 * 60 * 1000 * time.Millisecond      // 24 小时
	DefaultRotationInterval = 5 * 60 * 1000 * time.Millisecond            // 5 分钟
	RotationLeadRatio       = 0.1                                         // 提前 10% TTL 开始轮换
)

// TokenRecord 单条 token (字段语义对齐 TS)
type TokenRecord struct {
	KID        string      `json:"kid"`
	Token      string      `json:"token"`
	Status     TokenStatus `json:"status"`
	FamilyID   string      `json:"familyId"`
	ParentKID  string      `json:"parentKid"`
	CreatedAt  int64       `json:"createdAt"`
	ExpiresAt  int64       `json:"expiresAt"`
	RotatedAt  int64       `json:"rotatedAt"`
	GraceUntil int64       `json:"graceUntil"`
	RevokedAt  int64       `json:"revokedAt"`
	Source     TokenSource `json:"source"`
}

// FamilyRecord 轮换族 (对齐 TS)
type FamilyRecord struct {
	FamilyID     string             `json:"familyId"`
	CurrentKID   string             `json:"currentKid"`
	Revoked      bool               `json:"revoked"`
	RevokedAt    int64              `json:"revokedAt"`
	RevokeReason FamilyRevokeReason `json:"revokeReason"`
}

// TokenStoreSnapshot v2 快照 (金库存储形态)
type TokenStoreSnapshot struct {
	Version  int            `json:"version"`
	Tokens   []TokenRecord  `json:"tokens"`
	Families []FamilyRecord `json:"families"`
}

// TokenStore token 存储层 (Go 金库承载; 并发安全)
type TokenStore struct {
	vault *Vault

	mu       sync.Mutex
	snapshot *TokenStoreSnapshot
	loaded   bool
}

// NewTokenStore 构造 (绑定金库; vault 为 nil 时金库操作降级为纯内存)
func NewTokenStore(vault *Vault) *TokenStore {
	return &TokenStore{vault: vault, snapshot: &TokenStoreSnapshot{Version: 2}}
}

// ── 金库存取 (base64url(JSON), 对齐 TS read/writeSnapshotFromVault) ──

func (s *TokenStore) readSnapshotFromVault() *TokenStoreSnapshot {
	if s.vault == nil {
		return nil
	}
	blob, _, _, ok := s.vault.Resolve(TokenVaultProviderIDV2)
	if !ok || blob == "" {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(blob)
	if err != nil {
		return nil
	}
	var snap TokenStoreSnapshot
	if json.Unmarshal(raw, &snap) != nil || snap.Version != 2 ||
		snap.Tokens == nil || snap.Families == nil {
		return nil
	}
	return &snap
}

func (s *TokenStore) writeSnapshotToVault(snap *TokenStoreSnapshot) {
	if s.vault == nil {
		return
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		return
	}
	if _, err2 := s.vault.SetKey(TokenVaultProviderIDV2,
		base64.RawURLEncoding.EncodeToString(raw), "vault://api-tokens-v2"); err2 != nil {
		return
	}
}

// migrateFromV1 旧版 (纯 string[]) 一次性迁移 (纯函数, 不写金库):
// 全部旧 token 视为同一族, status=active, expiresAt=now+TTL。
// 返回迁移后的快照; v1 不存在/为空返回 nil。
func (s *TokenStore) migrateFromV1() *TokenStoreSnapshot {
	fmt.Println("DBG0: vault-nil=", s.vault == nil)
	if s.vault == nil {
		return nil
	}
	blob, _, _, ok := s.vault.Resolve(TokenVaultProviderIDV1)
	fmt.Println("DBG1: ok=", ok, "blob=", blob)
	if !ok || blob == "" {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(blob)
	fmt.Println("DBG2: raw=", string(raw), "err=", err)
	if err != nil {
		return nil
	}
	var v1Tokens []string
	if json.Unmarshal(raw, &v1Tokens) != nil {
		fmt.Println("DBG3: unmarshal-fail")
		return nil
	}
	fmt.Println("DBG4: v1Tokens=", v1Tokens)
	valid := v1Tokens[:0]
	for _, t := range v1Tokens {
		if t != "" {
			valid = append(valid, t)
		}
	}
	if len(valid) == 0 {
		return nil
	}

	// 旧版没有父子链, 全部为同族顶层 active
	now := time.Now().UnixMilli()
	familyID := newFamilyID()
	snap := &TokenStoreSnapshot{Version: 2}
	family := FamilyRecord{FamilyID: familyID}
	for _, t := range valid {
		kid := newKID()
		snap.Tokens = append(snap.Tokens, TokenRecord{
			KID: kid, Token: t, Status: TokenActive,
			FamilyID: familyID, CreatedAt: now,
			ExpiresAt: now + DefaultTokenTTL.Milliseconds(),
			Source:    TokenSourceManual,
		})
		if family.CurrentKID == "" {
			family.CurrentKID = kid
		}
	}
	snap.Families = []FamilyRecord{family}
	s.writeSnapshotToVault(snap)
	return snap
}

// ── 快照加载/保存 ────────────────────────────────────────────────

// Init 初始化 (幂等): v2 → v1 迁移 → 空表。
// 启动时调用一次, 之后读走内存, 写穿透金库。
func (s *TokenStore) Init() *TokenStoreSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loaded {
		return s.snapshot
	}
	s.loaded = true

	if v2 := s.readSnapshotFromVault(); v2 != nil {
		s.snapshot = v2
		return s.snapshot
	}
	if migrated := s.migrateFromV1(); migrated != nil {
		s.snapshot = migrated
		return s.snapshot
	}
	s.snapshot = &TokenStoreSnapshot{Version: 2,
		Tokens: []TokenRecord{}, Families: []FamilyRecord{}}
	return s.snapshot
}

func (s *TokenStore) saveLocked() {
	s.writeSnapshotToVault(s.snapshot)
}

// ── 公开 API (对齐 TS) ──────────────────────────────────────────

// ActiveTokens 当前生效 token 列表 (active+rotating; 鉴权层用)
func (s *TokenStore) ActiveTokens() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.InitLocked()
	var out []string
	for i := range s.snapshot.Tokens {
		t := &s.snapshot.Tokens[i]
		if t.Status == TokenActive || t.Status == TokenRotating {
			out = append(out, t.Token)
		}
	}
	return out
}

// FindByToken 按明文查记录 (查不到返回 nil)
func (s *TokenStore) FindByToken(plain string) *TokenRecord {
	if plain == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.InitLocked()
	for i := range s.snapshot.Tokens {
		if s.snapshot.Tokens[i].Token == plain {
			t := s.snapshot.Tokens[i]
			return &t
		}
	}
	return nil
}

// FindByKid 按 kid 查记录
func (s *TokenStore) FindByKid(kid string) *TokenRecord {
	if kid == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.InitLocked()
	for i := range s.snapshot.Tokens {
		if s.snapshot.Tokens[i].KID == kid {
			t := s.snapshot.Tokens[i]
			return &t
		}
	}
	return nil
}

// CreateTokenOptions CreateToken 入参 (对齐 TS CreateTokenOptions)
type CreateTokenOptions struct {
	ParentKID string
	Source    TokenSource // 缺省 rotate
	TTL       time.Duration
	Grace     time.Duration
	Now       time.Time
}

// CreateToken 创建新 token (init / rotate 共用):
//   - 有 parentKid → 与 parent 同族, parentKid 指向 parent
//   - 无 → 新建 family
//   - parent 自动进入 rotating (轮换链)
func (s *TokenStore) CreateToken(opts CreateTokenOptions) (*TokenRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.InitLocked()

	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	ttl := opts.TTL
	if ttl == 0 {
		ttl = DefaultTokenTTL
	}
	grace := opts.Grace
	if grace == 0 {
		grace = DefaultTokenGracePeriod
	}
	source := opts.Source
	if source == "" {
		source = TokenSourceRotate
	}

	var parent *TokenRecord
	var familyID string
	if opts.ParentKID != "" {
		for i := range s.snapshot.Tokens {
			if s.snapshot.Tokens[i].KID == opts.ParentKID {
				p := s.snapshot.Tokens[i]
				parent = &p
				break
			}
		}
		if parent == nil {
			return nil, fmt.Errorf("parent kid not found: %s", opts.ParentKID)
		}
		if parent.Status == TokenRevoked {
			return nil, fmt.Errorf("parent kid is revoked: %s", opts.ParentKID)
		}
		familyID = parent.FamilyID
	} else {
		familyID = newFamilyID()
	}

	kid := newKID()
	parentKID := ""
	if parent != nil {
		parentKID = parent.KID
	}
	record := TokenRecord{
		KID:       kid,
		Token:     generateToken(),
		Status:    TokenActive,
		FamilyID:  familyID,
		ParentKID: parentKID,
		CreatedAt: now.UnixMilli(),
		ExpiresAt: now.UnixMilli() + ttl.Milliseconds(),
		Source:    source,
	}

	// 父 token 进入 rotating (轮换链)
	if parent != nil {
		for i := range s.snapshot.Tokens {
			if s.snapshot.Tokens[i].KID == parent.KID {
				s.snapshot.Tokens[i].Status = TokenRotating
				s.snapshot.Tokens[i].RotatedAt = now.UnixMilli()
				s.snapshot.Tokens[i].GraceUntil = now.UnixMilli() + grace.Milliseconds()
			}
		}
	}

	// 找/建 family (用索引写回 — append 重分配后取地址指针会失效)
	famIdx := -1
	for i := range s.snapshot.Families {
		if s.snapshot.Families[i].FamilyID == familyID {
			famIdx = i
			break
		}
	}
	if famIdx == -1 {
		s.snapshot.Families = append(s.snapshot.Families, FamilyRecord{FamilyID: familyID})
		famIdx = len(s.snapshot.Families) - 1
	}
	if s.snapshot.Families[famIdx].Revoked {
		return nil, fmt.Errorf("family is revoked: %s", familyID)
	}
	s.snapshot.Families[famIdx].CurrentKID = kid

	s.snapshot.Tokens = append(s.snapshot.Tokens, record)
	s.saveLocked()
	return &record, nil
}

// RevokeFamily 把整族吊销 (复用检测命中 / 手动 / 整族过期)。
// 返回被吊销的 token 数量。
func (s *TokenStore) RevokeFamily(familyID string, reason FamilyRevokeReason, now time.Time) int {
	if now.IsZero() {
		now = time.Now()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.InitLocked()

	for i := range s.snapshot.Families {
		f := &s.snapshot.Families[i]
		if f.FamilyID != familyID || f.Revoked {
			continue
		}
		f.Revoked = true
		f.RevokedAt = now.UnixMilli()
		f.RevokeReason = reason

		count := 0
		for j := range s.snapshot.Tokens {
			t := &s.snapshot.Tokens[j]
			if t.FamilyID == familyID && t.Status != TokenRevoked {
				t.Status = TokenRevoked
				t.RevokedAt = now.UnixMilli()
				count++
			}
		}
		s.saveLocked()
		return count
	}
	return 0
}

// RevokeToken 单个 token 吊销 (cli 主动撤销; 不影响同族其他 token)
func (s *TokenStore) RevokeToken(kid string, now time.Time) bool {
	if now.IsZero() {
		now = time.Now()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.InitLocked()
	for i := range s.snapshot.Tokens {
		t := &s.snapshot.Tokens[i]
		if t.KID == kid && t.Status != TokenRevoked {
			t.Status = TokenRevoked
			t.RevokedAt = now.UnixMilli()
			s.saveLocked()
			return true
		}
	}
	return false
}

// GCExpiredTokens 清理过期的 rotating (宽限期过 → revoked)。
// 不触碰 active。返回吊销数量。
func (s *TokenStore) GCExpiredTokens(now time.Time) int {
	if now.IsZero() {
		now = time.Now()
	}
	nowMs := now.UnixMilli()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.InitLocked()
	removed := 0
	for i := range s.snapshot.Tokens {
		t := &s.snapshot.Tokens[i]
		if t.Status == TokenRotating && t.GraceUntil != 0 && nowMs > t.GraceUntil {
			t.Status = TokenRevoked
			t.RevokedAt = nowMs
			removed++
		}
	}
	if removed > 0 {
		s.saveLocked()
	}
	return removed
}

// BootstrapCandidate /api/auth/bootstrap 的候选 (最新 active)
type BootstrapCandidate struct {
	Token     string      `json:"token"`
	KID       string      `json:"kid"`
	FamilyID  string      `json:"familyId"`
	CreatedAt int64       `json:"createdAt"`
	ExpiresAt int64       `json:"expiresAt"`
	Source    TokenSource `json:"source"`
}

// PickBootstrapToken 选最新 active 的 token (对齐 TS pickBootstrapToken)
func (s *TokenStore) PickBootstrapToken() *BootstrapCandidate {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.InitLocked()
	var top *TokenRecord
	for i := range s.snapshot.Tokens {
		t := &s.snapshot.Tokens[i]
		if t.Status != TokenActive {
			continue
		}
		if top == nil || t.CreatedAt > top.CreatedAt {
			top = t
		}
	}
	if top == nil {
		return nil
	}
	return &BootstrapCandidate{
		Token: top.Token, KID: top.KID, FamilyID: top.FamilyID,
		CreatedAt: top.CreatedAt, ExpiresAt: top.ExpiresAt, Source: top.Source,
	}
}

// TokenKidInfo 审计/调试用的 kid 摘要
type TokenKidInfo struct {
	KID       string      `json:"kid"`
	Status    TokenStatus `json:"status"`
	FamilyID  string      `json:"familyId"`
	ExpiresAt int64       `json:"expiresAt"`
}

// ListActiveKids 所有非 revoked 的 kid (供审计/调试; 对齐 TS listActiveKids)
func (s *TokenStore) ListActiveKids() []TokenKidInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.InitLocked()
	out := make([]TokenKidInfo, 0, len(s.snapshot.Tokens))
	for i := range s.snapshot.Tokens {
		t := &s.snapshot.Tokens[i]
		if t.Status != TokenRevoked {
			out = append(out, TokenKidInfo{
				KID: t.KID, Status: t.Status, FamilyID: t.FamilyID, ExpiresAt: t.ExpiresAt,
			})
		}
	}
	return out
}

// InitLocked 无锁版 Init (须持 s.mu; 供持锁方法内部调用)
func (s *TokenStore) InitLocked() {
	if !s.loaded {
		s.loaded = true
		if v2 := s.readSnapshotFromVault(); v2 != nil {
			s.snapshot = v2
			return
		}
		// v1 迁移路径与 Init 相同 (持锁版内联)
		if migrated := s.migrateFromV1(); migrated != nil {
			s.snapshot = migrated
			return
		}
		s.snapshot = &TokenStoreSnapshot{Version: 2,
			Tokens: []TokenRecord{}, Families: []FamilyRecord{}}
	}
}

// ── ID / token 生成 (对齐 TS shortId/generateToken) ─────────────

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}

func newKID() string        { return "k_" + randHex(4)[:8] }
func newFamilyID() string   { return "f_" + randHex(4)[:8] }
func generateToken() string { return randHex(32) }
