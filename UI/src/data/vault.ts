/**
 * vault.ts — 前端 API Key 金库客户端 (2026-06-28 重构)
 *
 * 设计目标: 前端永远不接触 API Key 明文, 也永远不需要在 localStorage 里"记得"有 key
 *
 * 调用方式 (走 HTTP /api/vault/*):
 *   - vaultApi.listKeys()              — 列出所有已知 provider (keychain + env), 脱敏
 *   - vaultApi.putKey(id, key, base)   — 用户在 Settings 里填的 key 直接走 PUT → OS 钥匙串
 *   - vaultApi.deleteKey(id)           — 从 OS 钥匙串删除
 *   - vaultApi.verifyKey(id)           — 测试连通性 (拉 /models)
 *   - vaultApi.streamChat(...)         — LLM 调用走后端代理, 自动用钥匙串里的 key
 *   - vaultApi.exportVault(passphrase) — 加密导出 (PBKDF2+AES-GCM, 后端实现)
 *   - vaultApi.importVault(passphrase, blob, mode)
 *   - vaultApi.verifyPassphrase(passphrase, blob)
 *
 * 历史包袱清理:
 *   - 删除 enc:v1: 前端加密 + 设备指纹派生 (跨设备/UA 变化即丢)
 *   - 删除 __VAULT__ 哨兵 (哨兵本身就是泄露元信息的妥协, 既然 vault 自己能 list 就不需要)
 *   - 不再用 localStorage 持久化任何 API Key 字段
 *
 * 持久化层级 (新的):
 *   1. 操作系统钥匙串 (keytar) — API Key 明文, 唯一可信源
 *   2. 进程环境变量 — fallback, 见 src/security/envKeyResolver.ts
 *   3. localStorage / Electron settings.json — 只存"非敏感元信息"
 *      (provider 名称 / baseUrl / 启用状态 / 模型列表 / 主题…)
 */

const API_BASE: string = '/api/vault';

// ============================================================
// 类型定义
// ============================================================

export type VaultSource = 'keychain' | 'memory' | 'env';

export interface PublicKeyInfo {
  id: string;
  baseUrl: string;
  hasKey: true;
  source: VaultSource;
  createdAt: number;
  updatedAt: number;
}

export interface VerifyResult {
  ok: boolean;
  providerId: string;
  source: VaultSource;
  status?: number;
  modelCount?: number;
  message?: string;
  bodyPreview?: string;
  durationMs: number;
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

// ============================================================
// HTTP helpers
// ============================================================

async function getJson<T>(path: string): Promise<T> {
  const resp = await fetch(API_BASE + path);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GET ${path} -> HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function sendJson<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: any): Promise<T> {
  const resp = await fetch(API_BASE + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let errMsg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.error) errMsg = j.error;
    } catch { /* keep status code */ }
    throw new Error(`${method} ${path} -> ${errMsg}`);
  }
  return resp.json();
}

// ============================================================
// 运行时模式检测
// ============================================================
//   - Electron: window.soloforge.vault IPC 直通后端, 同源, OS 钥匙串
//   - 浏览器 (vite dev / preview): 通过 Vite proxy /api/* → 3001 后端, 仍是 OS 钥匙串
//     (只是跨了 1 个进程边界, 127.0.0.1 同机)
//   - 浏览器 (生产部署到外部域名): 仍然走 /api/* HTTP,
//     此时 OS 钥匙串在远端服务器, 不在本机, 仍然安全 (走 HTTPS + 后端鉴权)
//
// 不管哪种模式, API Key 都只活在后端进程的内存或 OS 钥匙串里, 永远不进 localStorage
// ============================================================

const IS_ELECTRON: boolean = typeof window !== 'undefined'
  && !!(window as any).soloforge?.isElectron;

if (typeof window !== 'undefined') {
  (window as any).__soloforgeVault = {
    isElectron: IS_ELECTRON,
    apiBase: API_BASE,
  };
}

export const vaultApi = {
  /** 列出所有 provider (keychain + env 合并, 不返回明文) */
  async listKeys(): Promise<PublicKeyInfo[]> {
    const j = await getJson<{ items: PublicKeyInfo[]; count: number }>('/keys');
    return j.items || [];
  },

  /** 单个 provider 元信息 */
  async getKey(id: string): Promise<PublicKeyInfo | null> {
    try {
      const j = await getJson<{ item: PublicKeyInfo }>(`/keys/${encodeURIComponent(id)}`);
      return j.item || null;
    } catch (e: any) {
      if (/HTTP 404/.test(e?.message)) return null;
      throw e;
    }
  },

  /**
   * 写入/更新 apiKey → OS 钥匙串
   * 注意: 这里传明文, 因为我们走的是 127.0.0.1 同源 HTTP, 已经是"最弱的安全边界"
   *       真正的安全边界在 OS 钥匙串本身 (TPM / DPAPI / Keychain / libsecret)
   */
  async putKey(id: string, apiKey: string, baseUrl: string): Promise<PublicKeyInfo> {
    const j = await sendJson<{ item: PublicKeyInfo }>('PUT', `/keys/${encodeURIComponent(id)}`, { apiKey, baseUrl });
    return j.item;
  },

  async deleteKey(id: string): Promise<void> {
    // [2026-06-28 修复] DELETE 是 idempotent 的, 后端对不存在的 key 也返回 200.
    //   但万一后端版本不一致或 404 短暂发生, 也静默吞掉, 不污染上层 await 链.
    try {
      await sendJson('DELETE', `/keys/${encodeURIComponent(id)}`);
    } catch (e: any) {
      if (/HTTP 404/.test(e?.message)) {
        // key 本来就不存在, 视为成功 (idempotent)
        return;
      }
      throw e;
    }
  },

  async verifyKey(id: string): Promise<VerifyResult> {
    const j = await sendJson<VerifyResult>('POST', `/keys/${encodeURIComponent(id)}/verify`);
    return j;
  },

  // ── Export / Import ──

  async exportVault(passphrase: string): Promise<{ blob: string; summary: ExportSummary }> {
    return sendJson('POST', '/export', { passphrase });
  },

  async importVault(passphrase: string, blob: string, mode: 'replace' | 'merge' = 'merge'): Promise<ImportSummary> {
    const j = await sendJson<{ summary: ImportSummary }>('POST', '/import', { passphrase, blob, mode });
    return j.summary;
  },

  async verifyPassphrase(passphrase: string, blob: string): Promise<boolean> {
    const j = await sendJson<{ ok: boolean }>('POST', '/verify-passphrase', { passphrase, blob });
    return !!j.ok;
  },

  // ── LLM streaming via backend proxy ──
  // 前端永不携带 apiKey; 后端从钥匙串里取

  /**
   * 流式调用 LLM, 走 /api/llm/stream
   * @param onDelta 文本片段回调
   * @param onDone   完成回调 (usage 摘要等)
   * @param signal   AbortSignal 中断
   */
  async streamChat(opts: {
    providerId: string;
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature?: number;
    maxTokens?: number;
    onDelta: (delta: string) => void;
    onDone?: (info: { durationMs: number; usage?: any }) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const t0 = Date.now();
    const resp = await fetch(API_BASE.replace('/vault', '/llm') + '/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: opts.providerId,
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
      }),
      signal: opts.signal,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`streamChat HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE: data: ... \n\n
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const delta = obj?.choices?.[0]?.delta?.content
                       || obj?.choices?.[0]?.text
                       || obj?.delta
                       || '';
            if (delta) opts.onDelta(delta);
          } catch {
            // 非 JSON, 当作纯文本片段
            opts.onDelta(payload);
          }
        }
      }
    }
    opts.onDone?.({ durationMs: Date.now() - t0 });
  },
};

// ============================================================
// 兼容旧代码: 让 modelProviderMap.ts 还能正常工作
// 旧 ProviderEntry 里有 apiKey 字段, 现在用 hasKey 替代
// ============================================================

/**
 * 把 PublicKeyInfo 转成老 ProviderEntry 形状 (不带 apiKey 字段)
 * 老代码仍然可以读 .id / .baseUrl / .hasKey
 */
export function publicKeyToLegacy(entry: PublicKeyInfo): {
  id: string;
  baseUrl: string;
  hasKey: boolean;
  source: VaultSource;
} {
  return {
    id: entry.id,
    baseUrl: entry.baseUrl,
    hasKey: !!entry.hasKey,
    source: entry.source,
  };
}

/** 老代码兼容: 当 vault 列出来的 provider 在 localStorage 没记录时, 给个空壳 */
export function legacyEmptyEntry(id: string): { id: string; baseUrl: string; hasKey: false; source: 'memory' } {
  return { id, baseUrl: '', hasKey: false, source: 'memory' };
}