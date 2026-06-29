/**
 * apiKeyVault.ts — 后端 API Key 金库 (2026-06-28 重构: 操作系统钥匙串版)
 *
 * 旧版用本地 AES-256-GCM + master.key 文件, 仍然有 "主密钥单独管理" 的麻烦
 * (重装/迁移 home/清理 userData 都会丢)。
 *
 * 新版策略 (对齐 VS Code / Cursor / JetBrains IDE):
 *   - 明文 API Key 全部交给操作系统原生凭据库:
 *       Windows → Credential Manager (Generic Credential)
 *       macOS   → Keychain Access
 *       Linux   → libsecret / KWallet
 *   - 通过 keytar (Node 绑定, 与 IDE 同款) 读写
 *   - 进程里从不落盘, 也不再有 master.key
 *
 * 物理布局 (Electron 模式):
 *   - API Key: 操作系统钥匙串 (keytar service = "SoloForge", account = providerId)
 *   - baseUrl / 元信息:  <userData>/api-keys-config.json  (非敏感, 公开可见)
 *
 * 物理布局 (非 Electron 模式, 如 tsx 调试):
 *   - baseUrl / 元信息:  <cwd>/data/soloforge_vault/config.json  (兜底)
 *   - API Key: 如果 keytar 加载成功 (依赖预编译 native) 则用钥匙串,
 *              否则降级为内存 Map + 进程退出即丢 (开发态 OK, 生产必须 Electron)
 *
 * 对外 API 与旧版完全兼容, 下游 vaultHandler.ts / llmProxyHandler.ts 无需改动。
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { logger } from '../core/logger';
import { resolveEnvKey, envSupportsBaseUrl, listEnvProviders } from './envKeyResolver';

// keytar 是原生模块, 启动时可能加载失败 (build 环境/缺 prebuild)
// 失败时降级为内存 Map, 仅供开发模式使用, 生产环境必须正确加载
type KeytarLike = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
};

const KEYTAR_SERVICE = 'SoloForge';

let keytarInstance: KeytarLike | null = null;
let keytarLoadError: Error | null = null;

// 兼容 ESM: api-server 走的是 tsx ESM 模式, 顶层没有 `require`
// 用 createRequire 拿到 CJS 风格的 require, 才能加载 keytar (原生模块)
const nodeRequire: NodeRequire = (() => {
  try {
    return createRequire(import.meta.url);
  } catch {
    // fallback: 全局 require (CJS 上下文, 比如 npx tsx -e 直接跑)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (typeof require !== 'undefined' ? require : null) as any;
  }
})();

function loadKeytar(): KeytarLike | null {
  if (keytarInstance) return keytarInstance;
  if (keytarLoadError) return null;
  try {
    if (!nodeRequire) throw new Error('require() not available (no createRequire + no global require)');
    const k = nodeRequire('keytar') as KeytarLike;
    if (!k || typeof k.setPassword !== 'function') {
      throw new Error('keytar loaded but API missing');
    }
    keytarInstance = k;
    logger.info('ApiKeyVault', `keytar loaded — OS credential manager active (service=${KEYTAR_SERVICE})`);
    return k;
  } catch (e: any) {
    keytarLoadError = e;
    logger.warn('ApiKeyVault', `keytar unavailable, falling back to in-memory store (DEV ONLY): ${e?.message || e}`);
    return null;
  }
}

/** 内存降级 Map: 仅在 keytar 加载失败时使用 */
const memoryFallback: Map<string, { apiKey: string; baseUrl: string; createdAt: number; updatedAt: number }> = new Map();

// ============================================================
// baseUrl 元信息持久化 (非敏感)
// ============================================================

interface ProviderMeta {
  baseUrl: string;
  createdAt: number;
  updatedAt: number;
}
type ConfigFile = Record<string, ProviderMeta>;

function resolveConfigPath(): string {
  // Electron 模式: <userData>/api-keys-config.json
  if (process.env.SOLOFORGE_USER_DATA && fs.existsSync(process.env.SOLOFORGE_USER_DATA)) {
    return path.join(process.env.SOLOFORGE_USER_DATA, 'api-keys-config.json');
  }
  // 非 Electron (tsx 直接调试 api-server): <cwd>/data/soloforge_vault/config.json
  const dir = path.join(process.cwd(), 'data', 'soloforge_vault');
  return path.join(dir, 'config.json');
}

function ensureConfigDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadConfig(): ConfigFile {
  try {
    const p = resolveConfigPath();
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as ConfigFile;
    return {};
  } catch (e: any) {
    logger.warn('ApiKeyVault', `config load failed: ${e.message}, starting empty`);
    return {};
  }
}

let configCache: ConfigFile | null = null;
function getConfig(): ConfigFile {
  if (!configCache) configCache = loadConfig();
  return configCache;
}

function saveConfig(): void {
  try {
    const p = resolveConfigPath();
    ensureConfigDir(p);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(configCache, null, 2));
    fs.renameSync(tmp, p);
    // fsync 父目录确保 rename 持久化（防止断电丢配置）
    try {
      const dirFd = fs.openSync(path.dirname(p), 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch { /* 部分文件系统不支持目录 fsync，忽略 */ }
  } catch (e: any) {
    logger.error('ApiKeyVault', `config save failed: ${e.message}`);
  }
}

// ============================================================
// Public 类型与单例
// ============================================================

export interface PublicKeyInfo {
  id: string;
  baseUrl: string;
  hasKey: true;
  /** 真实 key 来源: 'keychain' / 'memory' / 'env' */
  source: 'keychain' | 'memory' | 'env';
  createdAt: number;
  updatedAt: number;
}

/**
 * Resolve: 内部使用, 返回明文 key + baseUrl + 来源标记
 * 优先级:
 *   1) keytar (用户主动写)
 *   2) env var (用户没在 UI 配, 但环境变量里也有)
 *   3) memory fallback (keytar 加载失败的 dev 环境)
 */
export interface ResolvedKey {
  apiKey: string;
  baseUrl: string;
  source: 'keychain' | 'memory' | 'env';
}

export class ApiKeyVault {
  private initialized = false;

  /** 启动时调用, 幂等 */
  public async init(): Promise<void> {
    if (this.initialized) return;
    loadKeytar(); // 探测 native module 是否可用
    configCache = loadConfig();
    this.initialized = true;
    const k = keytarInstance;
    const count = k ? (await safeFindCredentials(k)).length : memoryFallback.size;
    logger.info('ApiKeyVault', `initialized, ${count} key(s) in OS keychain`);
  }

  /** 进程退出前调用 — keytar 不需要 flush, 此方法保留兼容 */
  public flush(): void {
    saveConfig();
  }

  /** 写入/更新一个 provider 的 key + baseUrl (明文 → keychain) */
  public async setKey(providerId: string, apiKey: string, baseUrl: string): Promise<PublicKeyInfo> {
    if (!providerId || typeof providerId !== 'string') {
      throw new Error('providerId is required');
    }
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('apiKey is required');
    }
    const now = Date.now();
    const existing = this.getMetaRaw(providerId);

    const k = loadKeytar();
    if (k) {
      await k.setPassword(KEYTAR_SERVICE, providerId, apiKey);
    } else {
      memoryFallback.set(providerId, {
        apiKey,
        baseUrl: baseUrl || existing?.baseUrl || '',
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      });
    }

    const cfg = getConfig();
    cfg[providerId] = {
      baseUrl: baseUrl || existing?.baseUrl || '',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    saveConfig();

    return this.toPublic(providerId, cfg[providerId], k ? 'keychain' : 'memory');
  }

  /** 读取 provider 的明文 key (内部使用) */
  public async getKey(providerId: string): Promise<ResolvedKey | null> {
    if (!providerId) return null;

    // 1) keychain / memory
    const k = loadKeytar();
    if (k) {
      const password = await safeGetPassword(k, providerId);
      if (password) {
        const meta = this.getMetaRaw(providerId);
        return { apiKey: password, baseUrl: meta?.baseUrl || '', source: 'keychain' };
      }
    } else if (memoryFallback.has(providerId)) {
      const m = memoryFallback.get(providerId)!;
      return { apiKey: m.apiKey, baseUrl: m.baseUrl, source: 'memory' };
    }

    // 2) env fallback (没有 baseUrl 元信息也能跑, baseUrl 走 env 推导)
    const env = resolveEnvKey(providerId);
    if (env) {
      const meta = this.getMetaRaw(providerId);
      const baseUrl = meta?.baseUrl || env.baseUrl || '';
      return { apiKey: env.apiKey, baseUrl, source: 'env' };
    }

    return null;
  }

  /** 删除 provider 的 key (只删 keychain / memory, env 不动) */
  public async deleteKey(providerId: string): Promise<boolean> {
    if (!providerId) return false;
    let removed = false;
    const k = loadKeytar();
    if (k) {
      try {
        removed = await k.deletePassword(KEYTAR_SERVICE, providerId);
      } catch (e: any) {
        logger.warn('ApiKeyVault', `keychain delete failed for ${providerId}: ${e.message}`);
      }
    }
    if (memoryFallback.has(providerId)) {
      memoryFallback.delete(providerId);
      removed = true;
    }
    if (getConfig()[providerId]) {
      delete configCache![providerId];
      saveConfig();
    }
    return removed;
  }

  /** 列出所有已知 provider (keychain + memory + env 三方合并, 脱敏返回) */
  public async listPublic(): Promise<PublicKeyInfo[]> {
    const k = loadKeytar();
    const seen = new Set<string>();
    const items: PublicKeyInfo[] = [];

    // 1) keychain / memory
    let keychainAccounts: string[] = [];
    if (k) {
      try {
        const creds = await safeFindCredentials(k);
        keychainAccounts = creds.map((c) => c.account);
      } catch (e: any) {
        logger.warn('ApiKeyVault', `findCredentials failed: ${e.message}`);
      }
    } else {
      keychainAccounts = Array.from(memoryFallback.keys());
    }
    for (const id of keychainAccounts) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const meta = this.getMetaRaw(id);
      items.push(this.toPublic(id, meta, k ? 'keychain' : 'memory'));
    }

    // 2) 配置里有但 keychain 没有的 (只有 baseUrl 元信息)
    const cfg = getConfig();
    for (const id of Object.keys(cfg)) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(this.toPublic(id, cfg[id], 'memory')); // source 标 memory 实际是"无 key 仅有 baseUrl"
    }

    // 3) env 里有但上面都没有的 (环境变量供的 key)
    const envIds = listEnvProviders();
    for (const id of envIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = this.getMetaRaw(id);
      const envResolved = resolveEnvKey(id);
      items.push({
        id,
        baseUrl: meta?.baseUrl || envResolved?.baseUrl || '',
        hasKey: true,
        source: 'env',
        createdAt: meta?.createdAt || 0,
        updatedAt: meta?.updatedAt || 0,
      });
    }

    return items;
  }

  public async hasKey(providerId: string): Promise<boolean> {
    const got = await this.getKey(providerId);
    return !!got;
  }

  /** 列出所有 keychain 中的 providerId (供 vaultExport 用) */
  public async listKeychainProviderIds(): Promise<string[]> {
    const k = loadKeytar();
    if (k) {
      try {
        const creds = await safeFindCredentials(k);
        return creds.map((c) => c.account);
      } catch (e: any) {
        logger.warn('ApiKeyVault', `findCredentials failed: ${e.message}`);
        return [];
      }
    }
    return Array.from(memoryFallback.keys());
  }

  /** 列出 baseUrl 配置 (非敏感) */
  public getConfigSnapshot(): ConfigFile {
    return JSON.parse(JSON.stringify(getConfig()));
  }

  /** 直接读取 keychain 明文 key (供 vaultExport 用, 不返回给前端) */
  public async exportRawKey(providerId: string): Promise<string | null> {
    const k = loadKeytar();
    if (k) {
      try {
        return await k.getPassword(KEYTAR_SERVICE, providerId);
      } catch (e: any) {
        logger.warn('ApiKeyVault', `exportRawKey failed for ${providerId}: ${e.message}`);
        return null;
      }
    }
    return memoryFallback.get(providerId)?.apiKey || null;
  }

  /** vaultExport import 路径: 直接写 keychain */
  public async importRawKey(providerId: string, apiKey: string, baseUrl: string): Promise<void> {
    await this.setKey(providerId, apiKey, baseUrl);
  }

  // ── 内部 helpers ──

  private getMetaRaw(providerId: string): ProviderMeta | undefined {
    return getConfig()[providerId];
  }

  private toPublic(id: string, meta: ProviderMeta | undefined, source: 'keychain' | 'memory' | 'env'): PublicKeyInfo {
    return {
      id,
      baseUrl: meta?.baseUrl || '',
      hasKey: true,
      source,
      createdAt: meta?.createdAt || 0,
      updatedAt: meta?.updatedAt || 0,
    };
  }
}

// ============================================================
// keytar 容错包装
// ============================================================

async function safeGetPassword(k: KeytarLike, account: string): Promise<string | null> {
  try {
    return await k.getPassword(KEYTAR_SERVICE, account);
  } catch (e: any) {
    logger.warn('ApiKeyVault', `keychain get failed for ${account}: ${e.message}`);
    return null;
  }
}

async function safeFindCredentials(k: KeytarLike): Promise<Array<{ account: string; password: string }>> {
  try {
    return await k.findCredentials(KEYTAR_SERVICE);
  } catch (e: any) {
    // Windows 在某些环境下 findCredentials 抛 "Failed to find credentials" 即使 getPassword 能用
    // 这里 warn 但不抛 — list 时只显示"知道存在但拿不到", 单点 get 仍走 keychain
    logger.warn('ApiKeyVault', `findCredentials failed: ${e.message}`);
    return [];
  }
}

// ============================================================
// 单例
// ============================================================

export const apiKeyVault = new ApiKeyVault();