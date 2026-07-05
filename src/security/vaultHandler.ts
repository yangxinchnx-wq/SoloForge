/**
 * vaultHandler.ts ÃÂ¢ÃÂÃÂ /api/vault/* HTTP ÃÂ¥ÃÂ¤ÃÂÃÂ§ÃÂÃÂÃÂ¥ÃÂÃÂ¨ (2026-06-28 ÃÂ©ÃÂÃÂÃÂ¦ÃÂÃÂ)
 *
 * ÃÂ¨ÃÂ·ÃÂ¯ÃÂ§ÃÂÃÂ±:
 *   GET    /api/vault/keys                      ÃÂ¥ÃÂÃÂÃÂ¥ÃÂÃÂºÃÂ¦ÃÂÃÂÃÂ¦ÃÂÃÂ provider (keychain + env, ÃÂ¨ÃÂÃÂ±ÃÂ¦ÃÂÃÂ)
 *   GET    /api/vault/keys/:id                  ÃÂ¥ÃÂÃÂÃÂ¤ÃÂ¸ÃÂª provider ÃÂ¥ÃÂÃÂÃÂ¤ÃÂ¿ÃÂ¡ÃÂ¦ÃÂÃÂ¯
 *   PUT    /api/vault/keys/:id                  ÃÂ¥ÃÂÃÂÃÂ¥ÃÂÃÂ¥/ÃÂ¦ÃÂÃÂ´ÃÂ¦ÃÂÃÂ° apiKey + baseUrl ÃÂ¢ÃÂÃÂ ÃÂ¦ÃÂÃÂÃÂ¤ÃÂ½ÃÂÃÂ§ÃÂ³ÃÂ»ÃÂ§ÃÂ»ÃÂÃÂ©ÃÂÃÂ¥ÃÂ¥ÃÂÃÂÃÂ¤ÃÂ¸ÃÂ²
 *   DELETE /api/vault/keys/:id                  ÃÂ¤ÃÂ»ÃÂÃÂ©ÃÂÃÂ¥ÃÂ¥ÃÂÃÂÃÂ¤ÃÂ¸ÃÂ²ÃÂ¥ÃÂÃÂ ÃÂ©ÃÂÃÂ¤
 *   POST   /api/vault/keys/:id/verify           ÃÂ¦ÃÂµÃÂÃÂ¨ÃÂ¯ÃÂÃÂ¨ÃÂ¿ÃÂÃÂ©ÃÂÃÂÃÂ¦ÃÂÃÂ§ (ÃÂ¦ÃÂÃÂ /models)
 *   POST   /api/vault/export                    ÃÂ¥ÃÂ¯ÃÂ¼ÃÂ¥ÃÂÃÂºÃÂ¦ÃÂÃÂÃÂ¦ÃÂÃÂ key ÃÂ¤ÃÂ¸ÃÂºÃÂ¥ÃÂÃÂ ÃÂ¥ÃÂ¯ÃÂ blob (passphrase)
 *   POST   /api/vault/import                    ÃÂ¤ÃÂ»ÃÂÃÂ¥ÃÂÃÂ ÃÂ¥ÃÂ¯ÃÂ blob ÃÂ¦ÃÂÃÂ¢ÃÂ¥ÃÂ¤ÃÂ (passphrase + mode)
 *   POST   /api/vault/verify-passphrase         ÃÂ©ÃÂªÃÂÃÂ¨ÃÂ¯ÃÂ passphrase ÃÂ¦ÃÂÃÂ¯ÃÂ¥ÃÂÃÂ¦ÃÂ¦ÃÂ­ÃÂ£ÃÂ§ÃÂ¡ÃÂ® (ÃÂ¤ÃÂ¸ÃÂÃÂ¥ÃÂ¯ÃÂ¼ÃÂ¥ÃÂÃÂ¥)
 *
 * ÃÂ¥ÃÂ®ÃÂÃÂ¥ÃÂÃÂ¨:
 *   - ÃÂ¥ÃÂÃÂªÃÂ§ÃÂ»ÃÂÃÂ¥ÃÂ®ÃÂ 127.0.0.1 (api-server ÃÂ¥ÃÂ·ÃÂ²ÃÂ©ÃÂÃÂÃÂ¥ÃÂÃÂ¶)
 *   - GET ÃÂ¤ÃÂ¸ÃÂÃÂ¨ÃÂ¿ÃÂÃÂ¥ÃÂÃÂ apiKey ÃÂ¦ÃÂÃÂÃÂ¦ÃÂÃÂ (PublicKeyInfo ÃÂ¤ÃÂ¸ÃÂÃÂ¥ÃÂÃÂ« apiKey)
 *   - PUT ÃÂ¦ÃÂÃÂ¥ÃÂ¥ÃÂÃÂÃÂ¦ÃÂÃÂÃÂ¦ÃÂÃÂ (ÃÂ¥ÃÂÃÂ ÃÂ¤ÃÂ¸ÃÂºÃÂ¦ÃÂÃÂ¯ÃÂ¥ÃÂÃÂÃÂ¦ÃÂºÃÂ HTTP, ÃÂ¥ÃÂ·ÃÂ²ÃÂ§ÃÂ»ÃÂÃÂ¨ÃÂÃÂ½ÃÂ¦ÃÂÃÂ¿ÃÂ¥ÃÂÃÂ°), ÃÂ¥ÃÂÃÂÃÂ§ÃÂÃÂÃÂ¥ÃÂÃÂÃÂ¤ÃÂºÃÂ¤ÃÂ§ÃÂ»ÃÂ OS ÃÂ©ÃÂÃÂ¥ÃÂ¥ÃÂÃÂÃÂ¤ÃÂ¸ÃÂ²
 *   - ÃÂ¥ÃÂ¯ÃÂ¼ÃÂ¥ÃÂÃÂºÃÂ¦ÃÂÃÂÃÂ¤ÃÂ»ÃÂ¶ÃÂ¦ÃÂÃÂ¬ÃÂ¨ÃÂºÃÂ«ÃÂ§ÃÂÃÂ¨ÃÂ§ÃÂÃÂ¨ÃÂ¦ÃÂÃÂ· passphrase ÃÂ¤ÃÂºÃÂÃÂ¦ÃÂ¬ÃÂ¡ÃÂ¥ÃÂÃÂ ÃÂ¥ÃÂ¯ÃÂ, OS ÃÂ©ÃÂÃÂ¥ÃÂ¥ÃÂÃÂÃÂ¤ÃÂ¸ÃÂ²ÃÂ¨ÃÂ¢ÃÂ«ÃÂ¦ÃÂÃÂ·ÃÂ¨ÃÂµÃÂ°ÃÂ¤ÃÂ¹ÃÂÃÂ¦ÃÂÃÂÃÂ¤ÃÂ¸ÃÂÃÂ¥ÃÂ¼ÃÂ
 */

import { apiKeyVault, type PublicKeyInfo } from './apiKeyVault';
import { logger } from '../core/logger';
import { exportVault, importVault, verifyPassphrase } from './vaultExport';

interface VaultRouteResult {
  status: number;
  headers?: Record<string, string>;
  body: any;
}

function jsonResponse(status: number, body: any): VaultRouteResult {
  return { status, headers: { 'Content-Type': 'application/json' }, body };
}

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
function isValidId(id: string): boolean {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

export async function handleVaultList(): Promise<VaultRouteResult> {
  try {
    const items: PublicKeyInfo[] = await apiKeyVault.listPublic();
    return jsonResponse(200, { items, count: items.length });
  } catch (e: any) {
    logger.error('Vault', `list failed: ${e.message}`);
    return jsonResponse(500, { error: e.message });
  }
}

export async function handleVaultGet(providerId: string): Promise<VaultRouteResult> {
  if (!isValidId(providerId)) {
    return jsonResponse(400, { error: 'Invalid providerId' });
  }
  try {
    // [2026-06-28 ÃÂ¤ÃÂ¿ÃÂ®ÃÂ¥ÃÂ¤ÃÂ] key ÃÂ¤ÃÂ¸ÃÂÃÂ¥ÃÂ­ÃÂÃÂ¥ÃÂÃÂ¨ÃÂ¦ÃÂÃÂ¶ÃÂ¨ÃÂ¿ÃÂÃÂ¥ÃÂÃÂ 200 + null, ÃÂ¨ÃÂÃÂÃÂ¤ÃÂ¸ÃÂÃÂ¦ÃÂÃÂ¯ 404
    //   ÃÂ§ÃÂÃÂÃÂ§ÃÂÃÂ±:
    //   - ÃÂ¥ÃÂÃÂÃÂ§ÃÂ«ÃÂ¯ SettingsModal ÃÂ§ÃÂÃÂ VaultStatusBadge ÃÂ¦ÃÂÃÂ¯"ÃÂ¦ÃÂÃÂ¢ÃÂ¦ÃÂµÃÂÃÂ¥ÃÂ¼ÃÂ"ÃÂ¨ÃÂ°ÃÂÃÂ§ÃÂÃÂ¨, ÃÂ¦ÃÂÃÂ³ÃÂ§ÃÂÃÂÃÂ¦ÃÂÃÂÃÂ¤ÃÂ¸ÃÂª id ÃÂ¦ÃÂÃÂÃÂ¦ÃÂ²ÃÂ¡ÃÂ¦ÃÂÃÂ key
    //     (ÃÂ§ÃÂ±ÃÂ»ÃÂ¤ÃÂ¼ÃÂ¼ GET /api/settings/:key ÃÂ¦ÃÂÃÂ¾ÃÂ¤ÃÂ¸ÃÂÃÂ¥ÃÂÃÂ°ÃÂ¦ÃÂÃÂ¶ÃÂ¤ÃÂ¹ÃÂÃÂ¦ÃÂÃÂ¯ÃÂ¨ÃÂ¿ÃÂÃÂ¥ÃÂÃÂ { value: null })
    //   - 404 ÃÂ¤ÃÂ¼ÃÂÃÂ¨ÃÂ®ÃÂ© dev console ÃÂ¦ÃÂ±ÃÂ¡ÃÂ¦ÃÂÃÂ (ÃÂ§ÃÂÃÂ¨ÃÂ¦ÃÂÃÂ·ÃÂ§ÃÂÃÂÃÂ¥ÃÂÃÂ°ÃÂ¤ÃÂ¸ÃÂÃÂ¥ÃÂ ÃÂÃÂ§ÃÂºÃÂ¢ÃÂ¨ÃÂÃÂ² 404 ÃÂ¨ÃÂ§ÃÂÃÂ¥ÃÂ¾ÃÂÃÂ¦ÃÂÃÂ¯ bug)
    //   - ÃÂ¥ÃÂÃÂÃÂ§ÃÂ«ÃÂ¯ vaultApi.getKey ÃÂ¥ÃÂ·ÃÂ²ÃÂ§ÃÂ»ÃÂÃÂ¥ÃÂÃÂÃÂ¤ÃÂºÃÂ try/catch ÃÂ¥ÃÂ¤ÃÂÃÂ§ÃÂÃÂ 404, ÃÂ¤ÃÂ½ÃÂ 200 + null ÃÂ¦ÃÂÃÂ´ÃÂ¥ÃÂÃÂÃÂ¥ÃÂ¥ÃÂ½
    const items = await apiKeyVault.listPublic();
    const item = items.find((i) => i.id === providerId);
    return jsonResponse(200, { item: item || null });
  } catch (e: any) {
    logger.error('Vault', `get failed: ${e.message}`);
    return jsonResponse(500, { error: e.message });
  }
}

export async function handleVaultPut(providerId: string, body: any): Promise<VaultRouteResult> {
  if (!isValidId(providerId)) {
    return jsonResponse(400, { error: 'Invalid providerId' });
  }
  if (!body || typeof body !== 'object') {
    return jsonResponse(400, { error: 'Body must be a JSON object' });
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : '';
  if (!apiKey) {
    return jsonResponse(400, { error: 'apiKey is required' });
  }
  if (apiKey.length > 1024) {
    return jsonResponse(400, { error: 'apiKey too long (max 1024 chars)' });
  }
  if (baseUrl && baseUrl.length > 512) {
    return jsonResponse(400, { error: 'baseUrl too long' });
  }
  try {
    const item = await apiKeyVault.setKey(providerId, apiKey, baseUrl);
    logger.info('Vault', `set key for ${providerId} (${apiKey.length} chars, baseUrl=${baseUrl || '(empty)'}, source=${item.source})`);
    return jsonResponse(200, { item });
  } catch (e: any) {
    logger.error('Vault', `put failed for ${providerId}: ${e.message}`);
    return jsonResponse(500, { error: e.message });
  }
}

export async function handleVaultDelete(providerId: string): Promise<VaultRouteResult> {
  if (!isValidId(providerId)) {
    return jsonResponse(400, { error: 'Invalid providerId' });
  }
  try {
    // [2026-06-28 ÃÂ¤ÃÂ¿ÃÂ®ÃÂ¥ÃÂ¤ÃÂ] DELETE ÃÂ¥ÃÂºÃÂÃÂ¨ÃÂ¯ÃÂ¥ÃÂ¦ÃÂÃÂ¯ idempotent ÃÂ§ÃÂÃÂ ÃÂ¢ÃÂÃÂ key ÃÂ¤ÃÂ¸ÃÂÃÂ¥ÃÂ­ÃÂÃÂ¥ÃÂÃÂ¨ÃÂ¦ÃÂÃÂ¶ÃÂ¨ÃÂ¿ÃÂÃÂ¥ÃÂÃÂ 200, ÃÂ¤ÃÂ¸ÃÂÃÂ¨ÃÂ¦ÃÂ 404
    //   ÃÂ§ÃÂÃÂÃÂ§ÃÂÃÂ±: SettingsModal.persistProviders ÃÂ¥ÃÂÃÂ¨ÃÂ¥ÃÂÃÂ³ÃÂ©ÃÂÃÂ­ÃÂ¦ÃÂÃÂ¶ÃÂ¥ÃÂ¯ÃÂ¹ÃÂ¦ÃÂÃÂÃÂ¦ÃÂÃÂ provider ÃÂ¨ÃÂ°ÃÂ deleteKey
    //   "ÃÂ¦ÃÂ¸ÃÂÃÂ§ÃÂÃÂ"ÃÂ©ÃÂÃÂ£ÃÂ¤ÃÂºÃÂ apiKey ÃÂ¦ÃÂÃÂ¯ÃÂ§ÃÂ©ÃÂºÃÂ¥ÃÂ­ÃÂÃÂ§ÃÂ¬ÃÂ¦ÃÂ¤ÃÂ¸ÃÂ²ÃÂ§ÃÂÃÂ provider, ÃÂ¤ÃÂ½ÃÂÃÂ¥ÃÂ®ÃÂÃÂ©ÃÂÃÂÃÂ¤ÃÂ¸ÃÂÃÂ¥ÃÂ®ÃÂÃÂ¤ÃÂ»ÃÂ¬ÃÂ¤ÃÂ»ÃÂÃÂ¦ÃÂÃÂ¥ÃÂ¦ÃÂ²ÃÂ¡ÃÂ¥ÃÂ­ÃÂÃÂ¨ÃÂ¿ÃÂ key,
    //   ÃÂ¤ÃÂ¸ÃÂÃÂ¥ÃÂºÃÂÃÂ¨ÃÂ¯ÃÂ¥ÃÂ¨ÃÂ®ÃÂ© 404 ÃÂ¥ÃÂÃÂªÃÂ©ÃÂÃÂ³ÃÂ¦ÃÂ±ÃÂ¡ÃÂ¦ÃÂÃÂ dev console + ÃÂ©ÃÂÃÂ»ÃÂ¥ÃÂ¡ÃÂ await ÃÂ©ÃÂÃÂ¾ÃÂ¨ÃÂ·ÃÂ¯ÃÂ£ÃÂÃÂ
    //   ÃÂ§ÃÂ±ÃÂ»ÃÂ¤ÃÂ¼ÃÂ¼ HTTP DELETE ÃÂ¨ÃÂ¯ÃÂ­ÃÂ¤ÃÂ¹ÃÂ, ÃÂ¤ÃÂ¸ÃÂÃÂ¥ÃÂ­ÃÂÃÂ¥ÃÂÃÂ¨ÃÂ§ÃÂ­ÃÂÃÂ¥ÃÂÃÂÃÂ¤ÃÂºÃÂÃÂ¥ÃÂ·ÃÂ²ÃÂ¥ÃÂÃÂ ÃÂ©ÃÂÃÂ¤ÃÂ£ÃÂÃÂ
    const removed = await apiKeyVault.deleteKey(providerId);
    if (!removed) {
      // key ÃÂ¦ÃÂÃÂ¬ÃÂ¦ÃÂÃÂ¥ÃÂ¥ÃÂ°ÃÂ±ÃÂ¤ÃÂ¸ÃÂÃÂ¥ÃÂ­ÃÂÃÂ¥ÃÂÃÂ¨ ÃÂ¢ÃÂÃÂ ÃÂ§ÃÂ­ÃÂÃÂ¥ÃÂÃÂÃÂ¤ÃÂºÃÂÃÂ¥ÃÂ·ÃÂ²ÃÂ¥ÃÂÃÂ ÃÂ©ÃÂÃÂ¤, ÃÂ¨ÃÂ¿ÃÂÃÂ¥ÃÂÃÂ 200
      return jsonResponse(200, { id: providerId, removed: false, alreadyAbsent: true });
    }
    logger.info('Vault', `deleted key for ${providerId}`);
    return jsonResponse(200, { id: providerId, removed: true });
  } catch (e: any) {
    logger.error('Vault', `delete failed: ${e.message}`);
    return jsonResponse(500, { error: e.message });
  }
}

/**
 * ÃÂ¥ÃÂÃÂÃÂ©ÃÂÃÂ¨ÃÂ§ÃÂÃÂ¨: ÃÂ¨ÃÂ¿ÃÂÃÂ¥ÃÂÃÂÃÂ©ÃÂÃÂÃÂ¥ÃÂºÃÂÃÂ¤ÃÂ¸ÃÂ­ÃÂ§ÃÂÃÂÃÂ¦ÃÂÃÂÃÂ¦ÃÂÃÂ key + baseUrl
 *   - ÃÂ¤ÃÂ»ÃÂÃÂ¤ÃÂ¾ÃÂÃÂ¥ÃÂÃÂÃÂ¦ÃÂºÃÂ API ÃÂ¨ÃÂ°ÃÂÃÂ§ÃÂÃÂ¨, ÃÂ¤ÃÂ¸ÃÂÃÂ¨ÃÂ¿ÃÂÃÂ¥ÃÂÃÂÃÂ§ÃÂ»ÃÂÃÂ¥ÃÂÃÂÃÂ§ÃÂ«ÃÂ¯
 */
export async function handleVaultResolve(providerId: string): Promise<VaultRouteResult> {
  if (!isValidId(providerId)) {
    return jsonResponse(400, { error: 'Invalid providerId' });
  }
  try {
    const got = await apiKeyVault.getKey(providerId);
    if (!got) {
      return jsonResponse(404, { error: 'Key not found', id: providerId });
    }
    return jsonResponse(200, {
      id: providerId,
      hasKey: true,
      baseUrl: got.baseUrl,
      keyLength: got.apiKey.length,
      source: got.source,
    });
  } catch (e: any) {
    logger.error('Vault', `resolve failed: ${e.message}`);
    return jsonResponse(500, { error: e.message });
  }
}

/**
 * 返回明文 apiKey（仅本机 127.0.0.1 调用，供前端小眼睛显示/复制）
 * 安全前提：api-server 只绑定 127.0.0.1，外部网络访问不到
 */
export async function handleVaultReveal(providerId: string): Promise<VaultRouteResult> {
  if (!isValidId(providerId)) {
    return jsonResponse(400, { error: 'Invalid providerId' });
  }
  try {
    const got = await apiKeyVault.getKey(providerId);
    if (!got) {
      return jsonResponse(404, { error: 'Key not found', id: providerId });
    }
    return jsonResponse(200, {
      id: providerId,
      apiKey: got.apiKey,
      baseUrl: got.baseUrl,
      source: got.source,
    });
  } catch (e: any) {
    logger.error('Vault', `reveal failed: ${e.message}`);
    return jsonResponse(500, { error: e.message });
  }
}

/**
 * ÃÂ§ÃÂÃÂ¨ÃÂ©ÃÂÃÂÃÂ¥ÃÂºÃÂÃÂ¤ÃÂ¸ÃÂ­ÃÂ§ÃÂÃÂ key ÃÂ¦ÃÂµÃÂÃÂ¨ÃÂ¯ÃÂ provider ÃÂ¨ÃÂ¿ÃÂÃÂ©ÃÂÃÂÃÂ¦ÃÂÃÂ§
 * ÃÂ¤ÃÂ¼ÃÂÃÂ¥ÃÂÃÂÃÂ§ÃÂºÃÂ§: keychain ÃÂ¢ÃÂÃÂ env ÃÂ¢ÃÂÃÂ ÃÂ¥ÃÂ¤ÃÂ±ÃÂ¨ÃÂ´ÃÂ¥
 */
export async function handleVaultVerify(providerId: string): Promise<VaultRouteResult> {
  if (!isValidId(providerId)) {
    return jsonResponse(400, { error: 'Invalid providerId' });
  }
  const got = await apiKeyVault.getKey(providerId);
  if (!got) {
    return jsonResponse(404, { error: 'Key not found in keychain or env' });
  }
  const { apiKey, baseUrl } = got;
  if (!baseUrl) {
    return jsonResponse(400, { error: 'baseUrl is empty, please set it first' });
  }
  const url = baseUrl.replace(/\/$/, '') + '/models';
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await resp.text();
    const dur = Date.now() - t0;
    if (!resp.ok) {
      return jsonResponse(200, {
        ok: false,
        providerId,
        source: got.source,
        status: resp.status,
        message: `HTTP ${resp.status}`,
        bodyPreview: text.slice(0, 300),
        durationMs: dur,
      });
    }
    let modelCount = 0;
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j?.data)) modelCount = j.data.length;
      else if (Array.isArray(j?.models)) modelCount = j.models.length;
    } catch { /* ÃÂ©ÃÂÃÂ JSON ÃÂ¤ÃÂ¹ÃÂÃÂ§ÃÂ®ÃÂÃÂ©ÃÂÃÂ, ÃÂ¦ÃÂ¯ÃÂÃÂ¥ÃÂ¦ÃÂÃÂ¦ÃÂÃÂÃÂ¤ÃÂºÃÂÃÂ¥ÃÂ¹ÃÂ³ÃÂ¥ÃÂÃÂ°ÃÂ¨ÃÂ¿ÃÂÃÂ¥ÃÂÃÂÃÂ§ÃÂºÃÂ¯ÃÂ¦ÃÂÃÂÃÂ¦ÃÂÃÂ¬ */ }
    return jsonResponse(200, {
      ok: true,
      providerId,
      source: got.source,
      status: resp.status,
      modelCount,
      durationMs: dur,
    });
  } catch (e: any) {
    return jsonResponse(200, {
      ok: false,
      providerId,
      source: got.source,
      message: e.message || String(e),
      durationMs: Date.now() - t0,
    });
  }
}

// ============================================================
// Export / Import
// ============================================================

/**
 * POST /api/vault/export
 * body: { passphrase: string }
 * resp: { blob: string, summary: ExportSummary }
 */
export async function handleVaultExport(body: any): Promise<VaultRouteResult> {
  const passphrase = body?.passphrase;
  if (typeof passphrase !== 'string' || passphrase.length < 6) {
    return jsonResponse(400, { error: 'passphrase must be at least 6 characters' });
  }
  try {
    const { blob, summary } = await exportVault(passphrase);
    return jsonResponse(200, { blob, summary });
  } catch (e: any) {
    logger.error('VaultExport', `export failed: ${e.message}`);
    return jsonResponse(500, { error: e.message });
  }
}

/**
 * POST /api/vault/import
 * body: { passphrase: string, blob: string, mode?: 'replace' | 'merge' }
 */
export async function handleVaultImport(body: any): Promise<VaultRouteResult> {
  const passphrase = body?.passphrase;
  const blob = body?.blob;
  const mode = body?.mode === 'replace' ? 'replace' : 'merge';
  if (typeof passphrase !== 'string' || !passphrase) {
    return jsonResponse(400, { error: 'passphrase is required' });
  }
  if (typeof blob !== 'string' || !blob) {
    return jsonResponse(400, { error: 'blob is required (string)' });
  }
  try {
    const summary = await importVault(passphrase, blob, { mode });
    return jsonResponse(200, { summary });
  } catch (e: any) {
    logger.error('VaultExport', `import failed: ${e.message}`);
    return jsonResponse(400, { error: e.message });
  }
}

/**
 * POST /api/vault/verify-passphrase
 * body: { passphrase, blob }
 * resp: { ok: boolean }
 */
export async function handleVaultVerifyPassphrase(body: any): Promise<VaultRouteResult> {
  const passphrase = body?.passphrase;
  const blob = body?.blob;
  if (typeof passphrase !== 'string' || typeof blob !== 'string') {
    return jsonResponse(400, { error: 'passphrase and blob are required' });
  }
  const ok = await verifyPassphrase(passphrase, blob);
  return jsonResponse(200, { ok });
}