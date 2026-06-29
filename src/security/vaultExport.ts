/**
 * vaultExport.ts — 金库导入导出 (2026-06-28 引入)
 *
 * 用 passphrase 把 OS 钥匙串里的所有 API key 打包成一个加密文件,
 * 用户可以拷到另一台机器 / 备份 / 团队内分发。
 *
 * 加密方案:
 *   - KDF: PBKDF2-SHA256, 200k 迭代, 16B salt (前端同步/异步加密 都能在合理时间完成)
 *   - Cipher: AES-256-GCM, 12B IV, 16B auth tag
 *   - Output: base64(JSON({ v, salt, iv, tag, payload }))
 *     payload 是密文 (string, JSON.stringify({items:[...]}) 后加密)
 *
 * 设计取舍:
 *   - 用 JSON + base64 (而不是二进制) 是为了让导出文件可以直接粘到 issue / chat / git
 *   - 文件里不包含 env var (env 是机器级配置, 不该被备份/分发)
 *   - 不暴露给前端任何明文, 全程后端处理
 *
 * 跨设备兼容性:
 *   - Windows → Linux 也能导入 (keytar 在两台机器的 service 都是 'SoloForge')
 *   - macOS Keychain 的 access control 可能绑定了创建时的应用 bundle id
 *     → 导入到 macOS 时如果遇到权限弹窗, 用户需要在系统弹窗里批准 "Always Allow"
 */

import crypto from 'crypto';
import { logger } from '../core/logger';
import { apiKeyVault } from './apiKeyVault';

const SCHEMA_VERSION = 1;
const PBKDF2_ITERATIONS = 200_000;
const SALT_LEN = 16;
const IV_LEN = 12;

interface ExportItem {
  id: string;
  apiKey: string;
  baseUrl: string;
  createdAt: number;
  updatedAt: number;
}

interface ExportPayload {
  v: number;
  exportedAt: number;
  source: string;
  items: ExportItem[];
}

interface ExportBlob {
  v: number;
  salt: string;  // base64
  iv: string;    // base64
  tag: string;   // base64
  ct: string;    // base64, encrypted JSON.stringify(ExportPayload)
}

export interface ExportSummary {
  exportedCount: number;
  skippedCount: number;
  exportedAt: number;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  errors: Array<{ id: string; reason: string }>;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, 'sha256');
}

function deriveKeyAsync(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(passphrase, salt, PBKDF2_ITERATIONS, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function encryptAsync(passphrase: string, payload: ExportPayload): Promise<string> {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = await deriveKeyAsync(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob: ExportBlob = {
    v: SCHEMA_VERSION,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
  return JSON.stringify(blob, null, 2);
}

async function decryptAsync(passphrase: string, blobStr: string): Promise<ExportPayload> {
  let blob: ExportBlob;
  try {
    blob = JSON.parse(blobStr);
  } catch (e: any) {
    throw new Error('Invalid export file: not valid JSON');
  }
  if (!blob || blob.v !== SCHEMA_VERSION) {
    throw new Error(`Unsupported export version: ${blob?.v}`);
  }
  for (const f of ['salt', 'iv', 'tag', 'ct'] as const) {
    if (typeof blob[f] !== 'string' || !blob[f]) {
      throw new Error(`Invalid export file: missing field "${f}"`);
    }
  }
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const key = await deriveKeyAsync(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8'));
    if (!parsed || parsed.v !== SCHEMA_VERSION || !Array.isArray(parsed.items)) {
      throw new Error('Decrypted payload structure invalid');
    }
    return parsed as ExportPayload;
  } catch (e: any) {
    throw new Error(`Decryption failed (wrong passphrase?): ${e.message}`);
  }
}

function decrypt(passphrase: string, blobStr: string): ExportPayload {
  let blob: ExportBlob;
  try {
    blob = JSON.parse(blobStr);
  } catch (e: any) {
    throw new Error('Invalid export file: not valid JSON');
  }
  if (!blob || blob.v !== SCHEMA_VERSION) {
    throw new Error(`Unsupported export version: ${blob?.v}`);
  }
  for (const f of ['salt', 'iv', 'tag', 'ct'] as const) {
    if (typeof blob[f] !== 'string' || !blob[f]) {
      throw new Error(`Invalid export file: missing field "${f}"`);
    }
  }
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8'));
    if (!parsed || parsed.v !== SCHEMA_VERSION || !Array.isArray(parsed.items)) {
      throw new Error('Decrypted payload structure invalid');
    }
    return parsed as ExportPayload;
  } catch (e: any) {
    throw new Error(`Decryption failed (wrong passphrase?): ${e.message}`);
  }
}

/**
 * 导出当前 OS 钥匙串里所有 key + baseUrl
 * @returns JSON 字符串, 可直接存盘或复制
 */
export async function exportVault(passphrase: string): Promise<{ blob: string; summary: ExportSummary }> {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 6) {
    throw new Error('Passphrase must be at least 6 characters');
  }

  const ids = await apiKeyVault.listKeychainProviderIds();
  const cfg = apiKeyVault.getConfigSnapshot();
  const items: ExportItem[] = [];

  for (const id of ids) {
    const apiKey = await apiKeyVault.exportRawKey(id);
    if (!apiKey) continue;
    const meta = cfg[id];
    items.push({
      id,
      apiKey,
      baseUrl: meta?.baseUrl || '',
      createdAt: meta?.createdAt || Date.now(),
      updatedAt: meta?.updatedAt || Date.now(),
    });
  }

  const payload: ExportPayload = {
    v: SCHEMA_VERSION,
    exportedAt: Date.now(),
    source: `keytar:${process.platform}`,
    items,
  };
  const blob = await encryptAsync(passphrase, payload);
  logger.info('VaultExport', `exported ${items.length} key(s) (${process.platform})`);
  return {
    blob,
    summary: {
      exportedCount: items.length,
      skippedCount: 0,
      exportedAt: payload.exportedAt,
    },
  };
}

/**
 * 从导出文件恢复 keychain
 *
 * @param passphrase  - 解密口令
 * @param blobStr     - exportVault 产出的 JSON 字符串
 * @param options.mode - 'replace': 删旧的全量覆盖  'merge': 仅写入, 不删
 */
export async function importVault(
  passphrase: string,
  blobStr: string,
  options: { mode?: 'replace' | 'merge' } = {},
): Promise<ImportSummary> {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('Passphrase is required');
  }
  const mode = options.mode || 'merge';

  const payload = decrypt(passphrase, blobStr);
  const summary: ImportSummary = { imported: 0, skipped: 0, errors: [] };

  if (mode === 'replace') {
    const existing = await apiKeyVault.listKeychainProviderIds();
    for (const id of existing) {
      try {
        await apiKeyVault.deleteKey(id);
      } catch (e: any) {
        logger.warn('VaultExport', `pre-import delete ${id} failed: ${e.message}`);
      }
    }
  }

  for (const item of payload.items) {
    try {
      if (!item || typeof item.id !== 'string' || typeof item.apiKey !== 'string') {
        summary.errors.push({ id: String(item?.id || '?'), reason: 'invalid item shape' });
        summary.skipped++;
        continue;
      }
      await apiKeyVault.importRawKey(item.id, item.apiKey, item.baseUrl || '');
      summary.imported++;
    } catch (e: any) {
      summary.errors.push({ id: item.id, reason: e?.message || String(e) });
      summary.skipped++;
    }
  }

  logger.info('VaultExport', `import complete: ${summary.imported} ok, ${summary.skipped} skipped, mode=${mode}`);
  return summary;
}

/**
 * 验证 passphrase 是否能解开 (不实际导入)
 * 用于 UI "请输入你的密码" 输入框的实时校验
 */
export async function verifyPassphrase(passphrase: string, blobStr: string): Promise<boolean> {
  try {
    await decryptAsync(passphrase, blobStr);
    return true;
  } catch {
    return false;
  }
}