// ─────────────────────────────────────────────────────────────────
// vault — 进程内密钥库 (对齐 TS apiKeyVault.ts / vaultHandler.ts 语义)
//
// 与旧版差异: 旧版明文交 OS 钥匙串 (keytar), 新架构无外部凭据库,
// 采用进程内 map, apiKey 只以 AES-256-GCM 密文存放:
//   主密钥 = PBKDF2-SHA256(SOLOFORGE_VAULT_MASTER | 进程随机32B, 固定盐, 200k 迭代)
//   单条   = AES-256-GCM(主密钥, 12B 随机 nonce) → nonce + 密文(尾部 16B tag)
//
// reveal (明文揭示) 必须通过 vault passphrase 门禁:
//   门禁口令以 PBKDF2-SHA256(200k) hash + 16B 盐存内存, 常数时间比对,
//   每次校验 ~100ms 顺带抑制暴力枚举。首次"带 passphrase 的写入"即注册口令。
// ─────────────────────────────────────────────────────────────────
package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2" // Go 1.24+ 标准库 (RFC 8018)
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// KeyRecord 库内条目 — apiKey 只存密文 (Nonce/Cipher 不序列化)
type KeyRecord struct {
	ID        string `json:"id"`
	BaseURL   string `json:"baseUrl"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
	Nonce     []byte `json:"-"` // GCM nonce (12B, crypto/rand)
	Cipher    []byte `json:"-"` // 密文 (GCM Seal 输出, 尾部含 16B auth tag)
}

// PublicKeyInfo 脱敏视图 — 绝不携带 apiKey 明文 (对齐 TS PublicKeyInfo)
type PublicKeyInfo struct {
	ID        string `json:"id"`
	BaseURL   string `json:"baseUrl"`
	HasKey    bool   `json:"hasKey"`
	Source    string `json:"source"` // memory (旧版: keychain/memory/env)
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

// masterSalt 主密钥派生盐 (固定串即可: 主口令本身是随机 32B / 运维配置)
var masterSalt = []byte("soloforge.vault.master.v1")

// Vault 进程内密钥库
type Vault struct {
	mu     sync.Mutex
	keys   map[string]*KeyRecord
	master []byte // AES-256 主密钥 (32B, PBKDF2 派生)

	passSalt []byte // reveal 门禁口令 KDF 盐 (16B)
	passHash []byte // reveal 门禁口令 PBKDF2 hash (32B); nil = 未设置
}

// NewVault 构造密钥库并派生主密钥。
// 主口令优先取环境变量 SOLOFORGE_VAULT_MASTER (跨重启稳定),
// 缺省用进程内随机 32B (重启轮换 — 与"进程内存储重启清零"纪律一致)。
func NewVault() *Vault {
	secret := os.Getenv("SOLOFORGE_VAULT_MASTER")
	if secret == "" {
		secret = hex.EncodeToString(randBytes(32))
	}
	master, err := pbkdf2.Key(sha256.New, secret, masterSalt, pbkdf2Iterations, 32)
	if err != nil {
		panic("security: vault 主密钥派生失败: " + err.Error())
	}
	return &Vault{keys: make(map[string]*KeyRecord), master: master}
}

// randBytes crypto/rand 封装 (失败即 panic — rand 不可用等于运行环境崩溃)
func randBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("security: crypto/rand 读取失败: " + err.Error())
	}
	return b
}

// ── 加解密 ──────────────────────────────────────────────────────

// seal 明文 apiKey → AES-256-GCM 密文 (随机 12B nonce)
func (v *Vault) seal(plain string) (nonce, ciphertext []byte, err error) {
	block, err := aes.NewCipher(v.master)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce = randBytes(gcm.NonceSize()) // 12B
	return nonce, gcm.Seal(nil, nonce, []byte(plain), nil), nil
}

// open 密文 → 明文 apiKey (GCM 自带认证: tag 不符即失败)
func (v *Vault) open(nonce, ciphertext []byte) (string, error) {
	block, err := aes.NewCipher(v.master)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("密钥解密失败 (主密钥不匹配?): %w", err)
	}
	return string(plain), nil
}

// ── CRUD ────────────────────────────────────────────────────────

// SetKey 写入/更新 (语义对齐 TS ApiKeyVault.setKey: baseUrl 空串时保留旧值)
func (v *Vault) SetKey(id, apiKey, baseURL string) (*KeyRecord, error) {
	if id == "" {
		return nil, fmt.Errorf("providerId is required")
	}
	if apiKey == "" {
		return nil, fmt.Errorf("apiKey is required")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	now := time.Now().UnixMilli()
	rec, existed := v.keys[id]
	if !existed {
		rec = &KeyRecord{ID: id, CreatedAt: now}
		v.keys[id] = rec
	}
	nonce, ct, err := v.seal(apiKey)
	if err != nil {
		return nil, err
	}
	rec.Nonce, rec.Cipher = nonce, ct
	if baseURL != "" || !existed {
		rec.BaseURL = baseURL
	}
	rec.UpdatedAt = now
	cp := *rec
	return &cp, nil
}

// Meta 脱敏元信息 (不存在 → nil, 由 HTTP 层转 200 + item:null)
func (v *Vault) Meta(id string) *PublicKeyInfo {
	v.mu.Lock()
	defer v.mu.Unlock()
	rec, ok := v.keys[id]
	if !ok {
		return nil
	}
	return rec.public()
}

// Delete 删除 (不存在返回 false — 幂等语义, 对齐 TS deleteKey)
func (v *Vault) Delete(id string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, ok := v.keys[id]; !ok {
		return false
	}
	delete(v.keys, id)
	return true
}

// List 列出全部脱敏条目 (按 ID 排序, 保证响应确定性)
func (v *Vault) List() []PublicKeyInfo {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := make([]PublicKeyInfo, 0, len(v.keys))
	for _, rec := range v.keys {
		out = append(out, *rec.public())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// IDs 全部 providerId (导出/replace 清空用, 对齐 TS listKeychainProviderIds)
func (v *Vault) IDs() []string {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := make([]string, 0, len(v.keys))
	for id := range v.keys {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Resolve 内部读取: 解密返回明文 key + baseUrl + 来源 (对齐 TS getKey, 供 llm proxy 等)
func (v *Vault) Resolve(id string) (apiKey, baseURL, source string, ok bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	rec, exists := v.keys[id]
	if !exists {
		return "", "", "", false
	}
	plain, err := v.open(rec.Nonce, rec.Cipher)
	if err != nil {
		return "", "", "", false
	}
	return plain, rec.BaseURL, SourceMemory, true
}

// public 脱敏视图 (r 已在锁内, 直接读)
func (r *KeyRecord) public() *PublicKeyInfo {
	return &PublicKeyInfo{
		ID:        r.ID,
		BaseURL:   r.BaseURL,
		HasKey:    true,
		Source:    SourceMemory,
		CreatedAt: r.CreatedAt,
		UpdatedAt: r.UpdatedAt,
	}
}

// ── reveal 门禁口令 ─────────────────────────────────────────────

// SetVaultPassphrase 设置/更换门禁口令。
// 首次设置无需旧口令; 已设置则必须给出正确旧口令。
func (v *Vault) SetVaultPassphrase(old, next string) error {
	if len(next) < 6 {
		return fmt.Errorf("passphrase 至少 6 个字符")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.passHash != nil && subtle.ConstantTimeCompare(pbkdf2Key(old, v.passSalt), v.passHash) != 1 {
		return fmt.Errorf("旧 passphrase 校验失败")
	}
	v.passSalt = randBytes(saltLen)
	v.passHash = pbkdf2Key(next, v.passSalt)
	return nil
}

// VerifyVaultPassphrase 常数时间校验门禁口令 (未设置 → false)
func (v *Vault) VerifyVaultPassphrase(pass string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.passHash == nil {
		return false
	}
	return subtle.ConstantTimeCompare(pbkdf2Key(pass, v.passSalt), v.passHash) == 1
}

// PassphraseSet 门禁口令是否已设置 (reveal 报错提示用)
func (v *Vault) PassphraseSet() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.passHash != nil
}

// pbkdf2Key 口令派生 (每次校验 200k 迭代 ≈ 100ms, 天然抑制暴力枚举)
func pbkdf2Key(pass string, salt []byte) []byte {
	dk, err := pbkdf2.Key(sha256.New, pass, salt, pbkdf2Iterations, 32)
	if err != nil {
		panic("security: PBKDF2 派生失败: " + err.Error())
	}
	return dk
}

// ── 导出 / 导入 (对齐 TS vaultExport.ts v1 格式) ────────────────
// blob = hex( salt(16B) + nonce(12B) + AES-256-GCM(主口令=passphrase 派生) )
// 明文载荷 = [{id, baseUrl, apiKey}...]; passphrase 错误 → GCM 认证失败

type exportItem struct {
	ID      string `json:"id"`
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
}

// Export 用 passphrase 加密导出全部密钥 (hex blob)
func (v *Vault) Export(passphrase string) (string, error) {
	v.mu.Lock()
	items := make([]exportItem, 0, len(v.keys))
	for _, rec := range v.keys {
		plain, err := v.open(rec.Nonce, rec.Cipher)
		if err != nil {
			v.mu.Unlock()
			return "", err
		}
		items = append(items, exportItem{ID: rec.ID, BaseURL: rec.BaseURL, APIKey: plain})
	}
	v.mu.Unlock()
	plain, _ := json.Marshal(items)

	salt := randBytes(saltLen)
	key := pbkdf2Key(passphrase, salt)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	nonce := randBytes(gcm.NonceSize())
	blob := append(append(salt, nonce...), gcm.Seal(nil, nonce, plain, nil)...)
	return hex.EncodeToString(blob), nil
}

// Import 用 passphrase 解密导入 (v1 blob; replace=true 清空后导入, 对齐 TS import)
func (v *Vault) Import(passphrase, blob string, replace bool) (int, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(blob))
	if err != nil {
		return 0, fmt.Errorf("blob 非 hex: %w", err)
	}
	if len(raw) < saltLen+nonceLen+16 {
		return 0, fmt.Errorf("blob 长度不足")
	}
	salt := raw[:saltLen]
	nonce := raw[saltLen : saltLen+nonceLen]
	ct := raw[saltLen+nonceLen:]
	key := pbkdf2Key(passphrase, salt)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return 0, fmt.Errorf("passphrase 校验失败 (GCM 认证不过)")
	}
	var items []exportItem
	if err := json.Unmarshal(plain, &items); err != nil {
		return 0, fmt.Errorf("blob 载荷损坏: %w", err)
	}

	v.mu.Lock()
	defer v.mu.Unlock()
	if replace {
		v.keys = make(map[string]*KeyRecord)
	}
	n := 0
	for _, it := range items {
		nonce2, ct2, err := v.seal(it.APIKey)
		if err != nil {
			return n, err
		}
		rec := &KeyRecord{ID: it.ID, BaseURL: it.BaseURL, Nonce: nonce2, Cipher: ct2, CreatedAt: time.Now().UnixMilli(), UpdatedAt: time.Now().UnixMilli()}
		v.keys[rec.ID] = rec
		n++
	}
	return n, nil
}
