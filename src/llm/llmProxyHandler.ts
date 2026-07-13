/**
 * llmProxyHandler.ts — /api/llm/stream HTTP 处理器
 *
 * 协议：
 *   POST /api/llm/stream
 *   Headers: Content-Type: application/json, X-SoloForge-Token: <token> (可选)
 *   Body: {
 *     providerId?: string,                // ← 新增: 从金库取 key/baseUrl
 *     systemPrompt?, userGoal, history?, model?, temperature?, maxTokens?, jsonMode?,
 *     baseUrl?: string,                   // ← 仅当 providerId 缺失且不走金库时使用
 *     apiKey?: string,                    // ← 不推荐, 但兼容旧版前端直接传
 *   }
 *
 *   Response: text/event-stream
 *     data: {"delta":"hello","done":false}\n\n
 *     data: {"delta":"","done":true}\n\n
 *     (or) data: {"error":"...","done":true}\n\n
 *
 * 优先级 (2026-06-27):
 *   1. providerId → 从 apiKeyVault 取 baseUrl + apiKey
 *   2. 顶层 baseUrl + apiKey (兼容老 path, 仍然能工作)
 *   3. 环境变量 SOLOFORGE_LLM_* (旧默认)
 *
 * 为什么这样设计：
 *   - 前端永远不持有 apiKey 明文 (走 providerId 分支)
 *   - SSE chunk 格式与 UI 端 OpenAICompatibleProvider 兼容
 *   - 简单的 token 校验（env 配了才校验）
 *   - 错误以 SSE 形式推回，前端能看到
 */

import type { ServerResponse } from 'http';
import { streamOpenAIChat } from './openaiStreamClient';
import { callOpenAIChat } from './openaiSyncClient';
import { getLLMProxyConfig, isLLMProxyReady, describeLLMProxyConfig } from './llmConfig';
import { apiKeyVault } from '../security/apiKeyVault';
import { logger } from '../core/logger';
import {
  llmStreamTotal,
  llmStreamLatency,
  llmActiveStreams,
  llmStreamChunks,
  llmStreamChars,
} from '../observability/metrics';
import { getDefaultSentry } from '../observability/sentryAdapter';
// Phase 4: OTel Span 埋点
import { withSpan } from '../observability/tracing';

export interface LLMProxyRequest {
  providerId?: string;
  systemPrompt?: string;
  userGoal: string;
  history?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  baseUrl?: string;
  apiKey?: string;
}

interface HandleResult {
  status: number;
  headers: Record<string, string>;
  body: any;
  /** 如果是 SSE 模式，此处会被 streamLLM 接管，handler 不会返回 body */
  stream?: true;
}

/**
 * 顶层处理器（ApiServer.route 调用）
 */
export async function handleLLMStreamProxy(
  req: { headers: Record<string, string | string[] | undefined>; on?: any },
  res: ServerResponse,
  body: any,
): Promise<HandleResult> {
  // Phase 4: OTel Span — 包裹整个 LLM stream 请求
  return withSpan(
    'soloforge.llm.stream',
    async (span) => {
      span.setAttribute('llm.hasProviderId', !!body?.providerId);
      span.setAttribute('llm.model', body?.model || 'default');
  // 简易 token 校验 (优先, 即使 provider 未配置也要校验)
  const cfg = getLLMProxyConfig();
  if (cfg.apiToken.length > 0) {
    const provided = String(req.headers['x-soloforge-token'] ?? '');
    if (provided !== cfg.apiToken) {
      return { status: 401, headers: {}, body: { error: 'Invalid X-SoloForge-Token' } };
    }
  }

  // 参数校验
  const parsed = parseRequestBody(body);
  if ('error' in parsed) {
    return { status: 400, headers: {}, body: { error: parsed.error } };
  }

  // 解析 baseUrl / apiKey (三路优先级)
  let resolvedBaseUrl = '';
  let resolvedApiKey = '';
  let resolvedProvider = 'env';

  if (parsed.providerId) {
    const got = await apiKeyVault.getKey(parsed.providerId);
    if (!got) {
      return {
        status: 404,
        headers: {},
        body: {
          error: `provider '${parsed.providerId}' has no key in vault. ` +
                 `请在「设置 → 模型」中配置此 provider 的 API Key, 或设置环境变量 ` +
                 `${(parsed.providerId || '').toUpperCase().replace(/-/g, '_')}_API_KEY 后再试。`,
          providerId: parsed.providerId,
        },
      };
    }
    resolvedBaseUrl = got.baseUrl;
    resolvedApiKey = got.apiKey;
    resolvedProvider = `${got.source}:${parsed.providerId}`;
    if (!resolvedBaseUrl) {
      return {
        status: 400,
        headers: {},
        body: { error: `provider '${parsed.providerId}' has no baseUrl in vault` },
      };
    }
  } else if (parsed.baseUrl && parsed.apiKey) {
    // 兼容旧前端直接传
    resolvedBaseUrl = parsed.baseUrl;
    resolvedApiKey = parsed.apiKey;
    resolvedProvider = 'inline';
  } else if (isLLMProxyReady()) {
    resolvedBaseUrl = cfg.baseUrl;
    resolvedApiKey = cfg.apiKey;
    resolvedProvider = `env:${cfg.provider}`;
  } else {
    return {
      status: 503,
      headers: {},
      body: {
        error: 'LLM proxy not configured. Either provide {providerId} (recommended, uses vault), or {baseUrl+apiKey} inline, or set SOLOFORGE_LLM_API_KEY env var.',
        config: describeLLMProxyConfig(),
      },
    };
  }

  // 接管 SSE 写入
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`: SoloForge LLM proxy ok (${resolvedProvider})\n\n`);

  // 监听客户端断开（route 调用场景可能没有 req.on）
  let clientClosed = false;
  if (typeof req.on === 'function') {
    req.on('close', () => { clientClosed = true; });
  }

  // 准备消息列表
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (parsed.systemPrompt) messages.push({ role: 'system', content: parsed.systemPrompt });
  if (parsed.history) {
    for (const m of parsed.history) {
      if (m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system') && typeof m.content === 'string') {
        messages.push({ role: m.role, content: m.content });
      }
    }
  }
  messages.push({ role: 'user', content: parsed.userGoal });

  llmActiveStreams.inc({ provider: resolvedProvider });
  const t0 = Date.now();
  let result: 'success' | 'error' | 'cancelled' = 'success';

  try {
    let chunkCount = 0;
    let totalChars = 0;
    let lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number } | null = null;
    for await (const chunk of streamOpenAIChat({
      baseUrl: resolvedBaseUrl,
      apiKey: resolvedApiKey,
      model: parsed.model,
      messages,
      temperature: parsed.temperature,
      maxTokens: parsed.maxTokens,
      jsonMode: parsed.jsonMode,
    })) {
      if (clientClosed) {
        logger.info('LLMProxy', `client disconnected after ${chunkCount} chunks`);
        result = 'cancelled';
        break;
      }
      if (chunk.done) {
        // ★ done 帧合并 usage (如有)
        res.write(`data: ${JSON.stringify({ delta: '', done: true, ...(lastUsage ? { usage: lastUsage } : {}) })}\n\n`);
        break;
      }
      // ★ 捕获 usage 帧 (不写给前端, 等到 done 帧一起发)
      if (chunk.usage) {
        lastUsage = chunk.usage;
        continue;
      }
      chunkCount++;
      totalChars += chunk.delta.length;
      res.write(`data: ${JSON.stringify({ delta: chunk.delta, done: false })}\n\n`);
    }
    if (!clientClosed) {
      res.write(`: done ${chunkCount} chunks, ${totalChars} chars in ${Date.now() - t0}ms\n\n`);
      res.end();
    }
    logger.info('LLMProxy', `stream complete [${resolvedProvider}]: ${chunkCount} chunks, ${totalChars} chars, ${Date.now() - t0}ms`);
  } catch (err) {
    result = 'error';
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('LLMProxy', `stream error [${resolvedProvider}]: ${msg}`);
    getDefaultSentry().captureException(err instanceof Error ? err : new Error(msg), { endpoint: '/api/llm/stream', provider: resolvedProvider });
    if (!clientClosed) {
      try {
        res.write(`data: ${JSON.stringify({ error: msg, done: true })}\n\n`);
        res.end();
      } catch { /* connection lost */ }
    }
  } finally {
    // 观测埋点（P3）
    const dur = Date.now() - t0;
    llmStreamTotal.inc({ provider: resolvedProvider, result });
    llmStreamLatency.observe(dur, { provider: resolvedProvider, result });
    llmActiveStreams.dec({ provider: resolvedProvider });
  }
  return { status: 200, headers: {}, body: null, stream: true };
    },
  );
}

function parseRequestBody(body: any): LLMProxyRequest | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Body must be a JSON object' };
  }
  if (typeof body.userGoal !== 'string' || body.userGoal.length === 0) {
    return { error: 'userGoal is required (string)' };
  }
  return {
    providerId: typeof body.providerId === 'string' ? body.providerId : undefined,
    systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined,
    userGoal: body.userGoal,
    history: Array.isArray(body.history) ? body.history : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
    jsonMode: body.jsonMode === true,
    baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
  };
}

/**
 * GET /api/llm/config — 返回脱敏配置（供前端判断走哪个 provider）
 */
export function handleLLMConfigGet(): HandleResult {
  return { status: 200, headers: {}, body: describeLLMProxyConfig() };
}

/**
 * GET /api/llm/health — 探测下游 LLM 端点真实可达性
 *
 * 用途:
 *   - /admin 诊断页 "Test connection" 按钮
 *   - CI 烟测后端 LLM 通路是否通(走 Node fetch,避开 Windows schannel OCSP 墙)
 *   - 三路优先级与 /api/llm/stream 一致: providerId → 内联 baseUrl/apiKey → env
 *
 * 响应:
 *   200 { ok: true,  model, content, usage, provider, latencyMs }
 *   400 { ok: false, error }                 参数问题
 *   503 { ok: false, error, config }         proxy 未配置
 *   502 { ok: false, error, provider }       下游 LLM 调用失败
 *
 * **故意不缓存**：此路由每次都真打一发 1-token 补全,
 * 命中失败时返回错误体,不会污染生产 LLM 配额(只发 max_tokens=1)。
 */
export async function handleLLMHealth(req: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<HandleResult> {
  const cfg = getLLMProxyConfig();

  // 同样接受 token 校验
  if (cfg.apiToken.length > 0) {
    const provided = String(req.headers['x-soloforge-token'] ?? '');
    if (provided !== cfg.apiToken) {
      return { status: 401, headers: {}, body: { error: 'Invalid X-SoloForge-Token' } };
    }
  }

  const providerId =
    typeof req.headers['x-soloforge-provider-id'] === 'string'
      ? String(req.headers['x-soloforge-provider-id'])
      : undefined;

  let resolvedBaseUrl = '';
  let resolvedApiKey = '';
  let resolvedProvider = 'env';
  let resolvedModel = '';

  if (providerId) {
    const got = await apiKeyVault.getKey(providerId);
    if (!got) {
      return {
        status: 404,
        headers: {},
        body: { ok: false, error: `provider '${providerId}' not in vault` },
      };
    }
    resolvedBaseUrl = got.baseUrl;
    resolvedApiKey = got.apiKey;
    resolvedProvider = `${got.source}:${providerId}`;
    resolvedModel = got.defaultModel ?? '';
  } else if (isLLMProxyReady()) {
    resolvedBaseUrl = cfg.baseUrl;
    resolvedApiKey = cfg.apiKey;
    resolvedProvider = `env:${cfg.provider}`;
    resolvedModel = cfg.defaultModel;
  } else {
    return {
      status: 503,
      headers: {},
      body: { ok: false, error: 'LLM proxy not configured', config: describeLLMProxyConfig() },
    };
  }

  const t0 = Date.now();
  try {
    const result = await callOpenAIChat({
      baseUrl: resolvedBaseUrl,
      apiKey: resolvedApiKey,
      model: resolvedModel || undefined,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
      timeoutMs: 15_000,
    });
    return {
      status: 200,
      headers: {},
      body: {
        ok: true,
        provider: resolvedProvider,
        model: result.model,
        content: result.content,
        usage: result.usage,
        latencyMs: Date.now() - t0,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('LLMHealth', `health probe failed [${resolvedProvider}]: ${msg}`);
    return {
      status: 502,
      headers: {},
      body: { ok: false, error: msg, provider: resolvedProvider },
    };
  }
}
