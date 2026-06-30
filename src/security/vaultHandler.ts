/**
 * vaultHandler.ts — /api/vault/* HTTP 处理器 (2026-06-28 重构)
 *
 * 路由:
 *   GET    /api/vault/keys                      列出所有 provider (keychain + env, 脱敏)
 *   GET    /api/vault/keys/:id                  单个 provider 元信息
 *   PUT    /api/vault/keys/:id                  写入/更新 apiKey + baseUrl → 操作系统钥匙串
 *   DELETE /api/vault/keys/:id                  从钥匙串删除
 *   POST   /api/vault/keys/:id/verify           测试连通性 (拉 /models)
 *   POST   /api/vault/export                    导出所有 key 为加密 blob (passphrase)
 *   POST   /api/vault/import                    从加密 blob 恢复 (passphrase + mode)
 *   POST   /api/vault/verify-passphrase         验证 passphrase 是否正确 (不导入)
 *
 * 安全:
 *   - 只绑定 127.0.0.1 (api-server 已限制)
 *   - GET 不返回 apiKey 明文 (PublicKeyInfo 不含 apiKey)
 *   - PUT 接受明文 (因为是同源 HTTP, 已经能拿到), 写盘前交给 OS 钥匙串
 *   - 导出文件本身用用户 passphrase 二次加密, OS 钥匙串被拷走也打不开
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
    // [2026-06-28 修复] key 不存在时返回 200 + null, 而不是 404
    //   理由:
    //   - 前端 SettingsModal 的 VaultStatusBadge 是"探测式"调用, 想看某个 id 有没有 key
    //     (类似 GET /api/settings/:key 找不到时也是返回 { value: null })
    //   - 404 会让 dev console 污染 (用户看到一堆红色 404 觉得是 bug)
    //   - 前端 vaultApi.getKey 已经写了 try/catch 处理 404, 但 200 + null 更友好
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
    // [2026-06-28 修复] DELETE 应该是 idempotent 的 — key 不存在时返回 200, 不要 404
    //   理由: SettingsModal.persistProviders 在关闭时对所有 provider 调 deleteKey
    //   "清理"那些 apiKey 是空字符串的 provider, 但实际上它们从来没存过 key,
    //   不应该让 404 噪音污染 dev console + 阻塞 await 链路。
    //   类似 HTTP DELETE 语义, 不存在等同于已删除。
    const removed = await apiKeyVault.deleteKey(providerId);
    if (!removed) {
      // key 本来就不存在 — 等同于已删除, 返回 200
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
 * 内部用: 返回金库中的 key 元信息 (不含明文 apiKey)
 *   - 仅供同源 API 调用, 不返回给前端
 *   - 仅返回 key 是否存在、长度、来源、baseUrl 等元数据
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
 * 用金库中的 key 测试 provider 连通性
 * 优先级: keychain → env → 失败
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
    } catch { /* 非 JSON 也算通, 比如有些平台返回纯文本 */ }
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