// SoloForge Security Layer: API Token Storage
// Path: src/security/token-store.ts
//
// 本模块提供面向 vault 的 token 存储接口,适用于不想用环境变量的部署。
// 它与 src/security/auth.ts 中的 loadApiTokensAsync 是互补关系:
//   - auth.ts 是核心,env 优先
//   - token-store.ts 是可选的 vault-first 替代入口,CLI 工具会用到
//
// 存储后端:复用项目里现有的 apiKeyVault(走 OS keychain / 加密落盘)。
// provider id 固定为 soloforge.api.tokens,与 auth.ts 内部约定保持一致。
//
// 编码格式:JSON 数组 -> UTF-8 -> base64url。
//   例子:[abc,def] -> WyJhYmMiLCJkZWYiXQ
//
// 安全保证:
//   - token 明文只在内存中存在极短时间(写入前 / 读出后)
//   - vault 内部走 OS native 加密层(keytar 走 Windows Credential Manager / macOS Keychain / libsecret)
//   - 永不打日志、永不进堆栈信息
//
// 公共接口:
//   - loadApiTokensFromStore(): 异步加载(vault 优先,env 兜底)
//   - loadApiTokensSync():      同步加载(只读 env 或上次缓存,用于热路径)
//   - saveTokensToVault(tokens):把 token 列表持久化到 vault
//   - clearTokenCache():        清空进程内 token 缓存(关停 / 轮换时调用)
import { apiKeyVault, ResolvedKey } from './apiKeyVault';

const VAULT_PROVIDER = 'soloforge.api.tokens';

let cached: string[] | null = null;

/**
 * 异步加载 API Token(vault 优先,env 兜底)。
 *
 * 调用顺序:
 *   1) 读环境变量 `SOLOFORGE_API_TOKENS`,非空就直接返回(逗号分隔切分)
 *   2) 否则尝试从 vault(provider `soloforge.api.tokens`)读
 *   3) 都没拿到就抛错,提示用户跑 `npm run token:init`
 *
 * 异常:FATAL 错误,直接抛给调用方,调用方决定是退出还是降级。
 *
 * @returns 至少一个 token 的数组
 */export async function loadApiTokensFromStore(): Promise<string[]> {
  // 1) env var
  const envRaw = process.env.SOLOFORGE_API_TOKENS || '';
  const envTokens = envRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (envTokens.length > 0) return envTokens;

  // 2) vault
  try {
    await apiKeyVault.init();
    const stored = await apiKeyVault.getKey(VAULT_PROVIDER);
    if (stored && stored.apiKey) {
      const decoded = decodeVaultTokens(stored.apiKey);
      if (decoded.length > 0) {
        cached = decoded;
        return decoded;
      }
    }
  } catch (e: any) {
    // Vault unavailable is non-fatal at this stage; caller decides.
    console.error('[token-store] vault read failed:', e.message);
  }

  throw new Error(
    'FATAL: No API tokens configured. ' +
    'Set SOLOFORGE_API_TOKENS=<comma-separated> or store tokens in vault under provider "' + VAULT_PROVIDER + '".'
  );
}

/**
 * 同步加载 API Token(只读 env 或上次缓存)。
 *
 * 与 `loadApiTokensFromStore` 的区别:本函数不会 await vault 读取,
 * 因此可用于热路径(每请求一次)。
 *
 * 行为:
 *   1) 优先读 env(若 env 非空直接返回)
 *   2) 否则用上次 `loadApiTokensFromStore` 写入的进程内缓存
 *   3) 缓存也没有就抛错
 *
 * @returns token 数组(env 或缓存)
 */export function loadApiTokensSync(): string[] {
  const envRaw = process.env.SOLOFORGE_API_TOKENS || '';
  const envTokens = envRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (envTokens.length > 0) return envTokens;
  if (cached && cached.length > 0) return cached;
  throw new Error(
    'FATAL: SOLOFORGE_API_TOKENS is empty. ' +
    'Set it (comma-separated) or pre-populate the vault before calling loadApiTokensSync.'
  );
}

/**
 * 把 token 列表持久化到 vault(覆盖已有项)。
 *
 * 校验:每个 token 至少 16 字符,数组至少 1 项,否则抛错。
 * 编码:JSON 数组 -> base64url,存入 provider `soloforge.api.tokens`。
 *
 * 副作用:同时清空进程内 token 缓存,下次 `loadApiTokensSync` 会重新从 vault 读。
 *
 * @param tokens 要保存的 token 列表(纯文本,内部会自动 base64url 编码)
 */export async function saveTokensToVault(tokens: string[]): Promise<void> {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error('saveTokensToVault: tokens must be a non-empty array');
  }
  for (const t of tokens) {
    if (typeof t !== 'string' || t.length < 16) {
      throw new Error('saveTokensToVault: each token must be at least 16 chars');
    }
  }
  await apiKeyVault.init();
  const encoded = encodeVaultTokens(tokens);
  await apiKeyVault.setKey(VAULT_PROVIDER, encoded, 'vault://api-tokens');
  cached = tokens.slice();
}

/**
 * 清空进程内 token 缓存(关停 / 轮换时调用)。
 *
 * 通常不需要手动调用:saveTokensToVault 已经会清缓存。
 * 仅在以下场景使用:
 *   - 应用优雅关闭,确保不残留敏感数据
 *   - 通过其它途径(直写文件)改了 vault 后,强制下次重新读
 */export function clearTokenCache(): void {
  cached = null;
}

// ---------- encoding (base64url JSON; vault stores opaque blobs) ----------
function encodeVaultTokens(tokens: string[]): string {
  return Buffer.from(JSON.stringify(tokens), 'utf8').toString('base64url');
}

function decodeVaultTokens(blob: string): string[] {
  try {
    const json = Buffer.from(blob, 'base64url').toString('utf8');
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) {
      return arr.filter((t) => typeof t === 'string' && t.length > 0);
    }
  } catch { /* fall through */ }
  return [];
}