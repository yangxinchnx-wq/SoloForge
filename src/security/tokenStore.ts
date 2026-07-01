/**
 * tokenStore.ts — Token + Token Family 存储层 (vault 升级版 v2)
 *
 * 数据模型 (替代旧版纯 string[] 数组):
 *
 *   TokenRecord {
 *     kid: string              // "k_<8char>", 唯一 Key ID
 *     token: string            // 64 字符 hex (明文存在 OS 钥匙串)
 *     status: 'active' | 'rotating' | 'revoked'
 *     familyId: string         // "f_<8char>"
 *     parentKid: string | null // 轮换链: 当前 kid 从哪个 kid 继承
 *     createdAt: number        // ms
 *     expiresAt: number        // active 状态过期时间 (TTL 到了自动开始轮换)
 *     rotatedAt: number | null // 进入 rotating 的时间
 *     graceUntil: number | null // rotating 结束时间 (= rotatedAt + GRACE_PERIOD)
 *     revokedAt: number | null
 *     source: 'init' | 'rotate' | 'manual' | 'env'
 *   }
 *
 *   FamilyRecord {
 *     familyId: string
 *     currentKid: string       // 该族当前 active 的 kid (单点)
 *     revoked: boolean         // 整族是否被吊销 (例如复用检测命中)
 *     revokedAt: number | null
 *     revokeReason: 'reuse_detected' | 'manual' | 'expired' | null
 *   }
 *
 * 物理存储:
 *   - 仍走 ApiKeyVault (OS 钥匙串), provider id = 'soloforge.api.tokens.v2'
 *   - 与旧版 (provider = 'soloforge.api.tokens') 隔离, 自动迁移
 *
 * 向后兼容:
 *   - 旧版 vault 内容是 [string, string, ...], 启动时检测并迁移到 v2
 *   - 旧版 provider 不删除 (供回滚), 但代码只读 v2
 *
 * 状态机:
 *                       createdAt
 *                          ↓
 *                      ┌────────┐
 *                      │ active │
 *                      └────────┘
 *                          ↓ RotationWorker 触发轮换
 *                      ┌──────────┐
 *                      │ rotating │ (还能用, 但已不是 currentKid)
 *                      └──────────┘
 *                          ↓ graceUntil 到期 OR 复用检测命中
 *                      ┌──────────┐
 *                      │ revoked  │ (物理拒绝)
 *                      └──────────┘
 */

import { randomBytes } from 'crypto';

// ============================================================
// 类型
// ============================================================

export type TokenStatus = 'active' | 'rotating' | 'revoked';

export interface TokenRecord {
  kid: string;
  token: string;
  status: TokenStatus;
  familyId: string;
  parentKid: string | null;
  createdAt: number;
  expiresAt: number;
  rotatedAt: number | null;
  graceUntil: number | null;
  revokedAt: number | null;
  source: 'init' | 'rotate' | 'manual' | 'env';
}

export type FamilyRevokeReason = 'reuse_detected' | 'manual' | 'expired';

export interface FamilyRecord {
  familyId: string;
  currentKid: string;
  revoked: boolean;
  revokedAt: number | null;
  revokeReason: FamilyRevokeReason | null;
}

export interface TokenStoreSnapshot {
  version: 2;
  tokens: TokenRecord[];
  families: FamilyRecord[];
}

export const VAULT_PROVIDER_ID_V2 = 'soloforge.api.tokens.v2';
export const VAULT_PROVIDER_ID_V1 = 'soloforge.api.tokens'; // 旧版, 仅用于一次性迁移

export const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;          // 90 天
export const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;      // 24 小时
export const DEFAULT_ROTATION_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟

// ============================================================
// Kid / Family ID 生成
// ============================================================

function shortId(prefix: 'k' | 'f', len = 8): string {
  return `${prefix}_${randomBytes(len).toString('hex').slice(0, len)}`;
}

export function newKid(): string {
  return shortId('k', 8);
}

export function newFamilyId(): string {
  return shortId('f', 8);
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

// ============================================================
// Vault 读/写 (走 ApiKeyVault, base64url(JSON) 编码)
// ============================================================

async function readSnapshotFromVault(): Promise<TokenStoreSnapshot | null> {
  const { apiKeyVault } = await import('./apiKeyVault');
  await apiKeyVault.init();
  const stored = await apiKeyVault.getKey(VAULT_PROVIDER_ID_V2);
  if (!stored || !stored.apiKey) return null;
  try {
    const json = Buffer.from(stored.apiKey, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (parsed && parsed.version === 2 && Array.isArray(parsed.tokens) && Array.isArray(parsed.families)) {
      return parsed as TokenStoreSnapshot;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeSnapshotToVault(snapshot: TokenStoreSnapshot): Promise<void> {
  const { apiKeyVault } = await import('./apiKeyVault');
  await apiKeyVault.init();
  const blob = Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64url');
  await apiKeyVault.setKey(VAULT_PROVIDER_ID_V2, blob, 'vault://api-tokens-v2');
}

/**
 * 从 v1 (纯 string[]) 迁移到 v2。
 * 返回迁移后的 snapshot, 如果 v1 也不存在则返回 null。
 */
async function migrateFromV1(): Promise<TokenStoreSnapshot | null> {
  const { apiKeyVault } = await import('./apiKeyVault');
  await apiKeyVault.init();
  const v1 = await apiKeyVault.getKey(VAULT_PROVIDER_ID_V1);
  if (!v1 || !v1.apiKey) return null;

  let v1Tokens: string[] = [];
  try {
    const arr = JSON.parse(Buffer.from(v1.apiKey, 'base64url').toString('utf8'));
    if (Array.isArray(arr)) {
      v1Tokens = arr.filter((t: any) => typeof t === 'string' && t.length > 0);
    }
  } catch {
    return null;
  }
  if (v1Tokens.length === 0) return null;

  // 把所有旧 token 视为同一族, status=active, expiresAt=now+TTL
  const familyId = newFamilyId();
  const now = Date.now();
  const tokens: TokenRecord[] = v1Tokens.map((t, i) => ({
    kid: newKid(),
    token: t,
    status: 'active' as TokenStatus,
    familyId,
    parentKid: i === 0 ? null : null, // 旧版没有父子链, 全部为顶层
    createdAt: now,
    expiresAt: now + DEFAULT_TTL_MS,
    rotatedAt: null,
    graceUntil: null,
    revokedAt: null,
    source: 'manual' as const,
  }));
  const family: FamilyRecord = {
    familyId,
    currentKid: tokens[0]!.kid,
    revoked: false,
    revokedAt: null,
    revokeReason: null,
  };
  return { version: 2, tokens, families: [family] };
}

// ============================================================
// 内存快照缓存 (单进程内一致, 不跨进程; 跨进程依赖 vault 自身原子性)
// ============================================================

let cached: TokenStoreSnapshot | null = null;
let initPromise: Promise<TokenStoreSnapshot> | null = null;

async function loadOrMigrate(): Promise<TokenStoreSnapshot> {
  const v2 = await readSnapshotFromVault();
  if (v2) return v2;
  const migrated = await migrateFromV1();
  if (migrated) {
    await writeSnapshotToVault(migrated);
    return migrated;
  }
  return { version: 2, tokens: [], families: [] };
}

async function getSnapshot(): Promise<TokenStoreSnapshot> {
  if (cached) return cached;
  if (!initPromise) {
    initPromise = loadOrMigrate().then((s) => {
      cached = s;
      return s;
    });
  }
  return initPromise;
}

async function saveSnapshot(s: TokenStoreSnapshot): Promise<void> {
  cached = s;
  await writeSnapshotToVault(s);
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 初始化 (幂等): 确保内存缓存已加载。
 * 后端启动时调用一次, 之后所有 read 操作走内存, 写操作穿透到 vault。
 */
export async function tokenStoreInit(): Promise<TokenStoreSnapshot> {
  return getSnapshot();
}

/**
 * 当前生效的 active token 列表 (按 createdAt 倒序, 最新在前)。
 * 用于鉴权层 evaluateRequest。
 */
export async function getActiveTokens(): Promise<string[]> {
  const s = await getSnapshot();
  return s.tokens
    .filter((t) => t.status === 'active' || t.status === 'rotating')
    .map((t) => t.token);
}

/**
 * 通过 kid 查 token record。
 */
export async function findByToken(plain: string): Promise<TokenRecord | null> {
  if (!plain) return null;
  const s = await getSnapshot();
  return s.tokens.find((t) => t.token === plain) ?? null;
}

/**
 * 通过 kid 查 token record。
 */
export async function findByKid(kid: string): Promise<TokenRecord | null> {
  if (!kid) return null;
  const s = await getSnapshot();
  return s.tokens.find((t) => t.kid === kid) ?? null;
}

/**
 * 创建新 token (init / rotate 都会调)。
 *
 * - 如果提供了 parentKid, 新 token 与 parent 同 family, parentKid 指向 parent
 * - 如果不提供 (init), 创建新 family
 *
 * 状态机: 新 token 进入 active, parentKid 若有则自动进入 rotating (轮换链)
 */
export interface CreateTokenOptions {
  parentKid?: string | null;
  source?: TokenRecord['source'];
  ttlMs?: number;
  graceMs?: number;
  now?: number;
}

export async function createToken(opts: CreateTokenOptions = {}): Promise<TokenRecord> {
  const s = await getSnapshot();
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const grace = opts.graceMs ?? DEFAULT_GRACE_PERIOD_MS;
  const source = opts.source ?? 'rotate';

  let familyId: string;
  let parent: TokenRecord | null = null;
  if (opts.parentKid) {
    parent = s.tokens.find((t) => t.kid === opts.parentKid) ?? null;
    if (!parent) throw new Error(`parent kid not found: ${opts.parentKid}`);
    if (parent.status === 'revoked') {
      throw new Error(`parent kid is revoked: ${opts.parentKid}`);
    }
    familyId = parent.familyId;
  } else {
    familyId = newFamilyId();
  }

  const kid = newKid();
  const token = generateToken();
  const record: TokenRecord = {
    kid,
    token,
    status: 'active',
    familyId,
    parentKid: parent?.kid ?? null,
    createdAt: now,
    expiresAt: now + ttl,
    rotatedAt: null,
    graceUntil: null,
    revokedAt: null,
    source,
  };

  // 父 token 进入 rotating
  if (parent) {
    parent.status = 'rotating';
    parent.rotatedAt = now;
    parent.graceUntil = now + grace;
  }

  // 找/建 family
  let family = s.families.find((f) => f.familyId === familyId);
  if (!family) {
    family = {
      familyId,
      currentKid: kid,
      revoked: false,
      revokedAt: null,
      revokeReason: null,
    };
    s.families.push(family);
  } else {
    if (family.revoked) {
      throw new Error(`family is revoked: ${familyId}`);
    }
    family.currentKid = kid;
  }

  s.tokens.push(record);
  await saveSnapshot(s);
  return record;
}

/**
 * 把整族吊销 (复用检测命中 / 手动吊销 / 整族过期)。
 */
export interface RevokeFamilyOptions {
  familyId: string;
  reason: FamilyRevokeReason;
  now?: number;
}

export async function revokeFamily(opts: RevokeFamilyOptions): Promise<{ revokedTokens: number }> {
  const s = await getSnapshot();
  const now = opts.now ?? Date.now();
  const family = s.families.find((f) => f.familyId === opts.familyId);
  if (!family) return { revokedTokens: 0 };
  if (family.revoked) return { revokedTokens: 0 };

  family.revoked = true;
  family.revokedAt = now;
  family.revokeReason = opts.reason;

  let count = 0;
  for (const t of s.tokens) {
    if (t.familyId === opts.familyId && t.status !== 'revoked') {
      t.status = 'revoked';
      t.revokedAt = now;
      count++;
    }
  }
  await saveSnapshot(s);
  return { revokedTokens: count };
}

/**
 * 把单个 token 标记为 revoked (不等同于 family)。
 * 主要用于 cli 主动撤销, 不影响其他 token。
 */
export interface RevokeTokenOptions {
  kid: string;
  reason?: string;
  now?: number;
}

export async function revokeToken(opts: RevokeTokenOptions): Promise<boolean> {
  const s = await getSnapshot();
  const t = s.tokens.find((x) => x.kid === opts.kid);
  if (!t) return false;
  if (t.status === 'revoked') return false;
  t.status = 'revoked';
  t.revokedAt = opts.now ?? Date.now();
  await saveSnapshot(s);
  return true;
}

/**
 * 清理过期的 rotating/revoked token (减少元信息噪音)。
 * 不会触碰 active。
 */
export async function gcExpiredTokens(now: number = Date.now()): Promise<number> {
  const s = await getSnapshot();
  let removed = 0;
  for (const t of s.tokens) {
    if (t.status === 'rotating' && t.graceUntil !== null && now > t.graceUntil) {
      t.status = 'revoked';
      t.revokedAt = now;
      removed++;
    }
  }
  if (removed > 0) await saveSnapshot(s);
  return removed;
}

/**
 * 列出 active token 数量 + 当前 family 状态 (供 /api/auth/bootstrap 选最新 active)。
 */
export interface BootstrapCandidate {
  token: string;
  kid: string;
  familyId: string;
  createdAt: number;
  expiresAt: number;
  source: TokenRecord['source'];
}

export async function pickBootstrapToken(): Promise<BootstrapCandidate | null> {
  const s = await getSnapshot();
  const candidates = s.tokens
    .filter((t) => t.status === 'active')
    .sort((a, b) => b.createdAt - a.createdAt);
  const top = candidates[0];
  if (!top) return null;
  return {
    token: top.token,
    kid: top.kid,
    familyId: top.familyId,
    createdAt: top.createdAt,
    expiresAt: top.expiresAt,
    source: top.source,
  };
}

/**
 * 列出所有 active+rotating 的 kid (供审计 / 调试)。
 */
export async function listActiveKids(): Promise<Array<{ kid: string; status: TokenStatus; familyId: string; expiresAt: number }>> {
  const s = await getSnapshot();
  return s.tokens
    .filter((t) => t.status !== 'revoked')
    .map((t) => ({ kid: t.kid, status: t.status, familyId: t.familyId, expiresAt: t.expiresAt }));
}

/**
 * 测试用: 强制清空内存缓存, 重新从 vault 读。
 */
export function __resetTokenStoreCacheForTest(): void {
  cached = null;
  initPromise = null;
}
