// ─────────────────────────────────────────────────────────────────
// useChatStore.helpers.ts — handleSend 拆分出的纯逻辑 (P2-7)
//
// 目标: 把 useChatStore.handleSend 中可独立测试的逻辑抽出
//   1. classifyStreamError()      — LLM/网络错误分类 → 友好提示
//   2. validateWorkspaceAccess()  — 工作区越界检查 → allow/deny
//   3. detectPreviewTrigger()     — done 事件预览触发判定
//
// 这些函数无 Zustand 依赖, 可独立单测
// ─────────────────────────────────────────────────────────────────

/**
 * LLM/网络错误分类: 把后端原始错误文本转成用户可读的友好提示
 *
 * 覆盖场景:
 *   - HTTP 429 / rate limit / 429 Too Many → 速率限制
 *   - HTTP 401 / Unauthorized / 401 Unauthorized / API key → 认证失败
 *   - HTTP 404 / 404 Not Found → 模型/端点不存在
 *   - HTTP 500 / LLM_EXECUTION_FAILED / 500 Internal → 后端服务异常
 *   - fetch / NetworkError / ECONNREFUSED → 网络连接失败
 *   - Java Agent 不可达 → Java 服务未启动
 *   - 其他 → 原始错误 + 通用提示
 *
 * 错误来源格式兼容:
 *   - Node.js aiBackend: "HTTP 404 ..." (executeJavaPath 非 200 响应)
 *   - Spring WebClient: "404 Not Found from POST ..." (Java SSE error 事件)
 *   - Node.js RACER: "LLM HTTP 404: ..." (function-calling-client.ts)
 *   - Node.js LLM Proxy: "openaiStreamClient: HTTP 404 ..." (openaiStreamClient.ts)
 */
export function classifyStreamError(rawErr: string): string {
  if (!rawErr) return '未知错误。请检查 Java Agent 服务 (端口 8770) 是否在运行。';

  // ── Java Agent 服务不可达 (502/503) ──
  if (rawErr.includes('HTTP 502') || rawErr.includes('Java Agent service not started')
      || rawErr.includes('Java Agent 不可达') || rawErr.includes('Java Agent 服务不可达')) {
    return 'Java Agent 服务 (8770) 未启动。请在「设置」中确认 Java 后端已启动，或检查日志中的启动错误。';
  }

  // ── Java Agent 端点 404 (服务在运行但端点不存在/旧版本) ──
  // 匹配: "Java Agent 请求失败: HTTP 404"
  // 这是 Java Agent 本身返回的 404，不是 LLM 服务商返回的 404
  // 常见原因: jar 包是旧版本，不包含 ChatStreamController
  if (rawErr.includes('Java Agent 请求失败') && rawErr.includes('404')) {
    return `Java Agent 服务返回 **404 端点不存在**：服务在运行但 /api/chat/stream 端点未注册。\n\n常见原因:\n1. Java Agent jar 包是旧版本，需要重新打包 (mvn package)\n2. Java Agent 服务需要重启以加载新版 jar\n\n请重启 Java Agent 服务后再试。如果持续出现，请在 solo-forge-agent 目录执行 mvn package -DskipTests 重新打包。`;
  }

  // ── Java Agent 请求失败 (其他状态码) ──
  // 匹配: "Java Agent 请求失败: HTTP {code}"
  if (rawErr.includes('Java Agent 请求失败')) {
    const codeMatch = rawErr.match(/HTTP (\d+)/);
    const code = codeMatch ? codeMatch[1] : '';
    return `Java Agent 服务请求失败 (HTTP ${code})。请检查 Java Agent 服务 (端口 8770) 是否在运行，以及日志中是否有错误。`;
  }

  // ── 429 速率限制 ──
  // 匹配: "HTTP 429", "429 Too Many", "rate limit", "LLM HTTP 429"
  if (rawErr.includes('HTTP 429') || rawErr.includes('429 Too Many') || rawErr.includes('rate limit')) {
    return 'LLM 服务商返回 **429 速率限制**：免费额度已用尽或请求过于频繁。请稍后重试，或在「设置 → 模型」中更换/升级服务商。';
  }

  // ── 401 认证失败 ──
  // 匹配: "HTTP 401", "401 Unauthorized", "Unauthorized", "API key"
  if (rawErr.includes('HTTP 401') || rawErr.includes('401 Unauthorized')
      || rawErr.includes('Unauthorized') || rawErr.includes('API key')) {
    return 'LLM 服务商返回 **401 认证失败**：API Key 无效或已过期。请在「设置 → 模型」中重新输入正确的 API Key。';
  }

  // ── 404 未找到 ──
  // 匹配: "HTTP 404", "404 Not Found", "LLM HTTP 404"
  // Java OpenAiStreamClient 格式: "HTTP 404 from {url} [model={model}]: {errBody}"
  // Spring WebClient 格式: "404 Not Found from POST {url}"
  // Node.js RACER 格式: "LLM HTTP 404: {errBody}"
  if (rawErr.includes('HTTP 404') || rawErr.includes('404 Not Found')) {
    // 提取错误详情中的 URL 信息，帮助用户诊断
    // 支持两种格式: "from POST {url}" (Spring WebClient) 和 "from {url}" (Java OpenAiStreamClient)
    const urlMatch = rawErr.match(/from\s+(?:POST\s+)?(https?:\/\/\S+)/);
    const urlHint = urlMatch ? `\n\n请求的端点: ${urlMatch[1]}` : '';

    // 提取 model 信息 (Java OpenAiStreamClient 新格式: [model=xxx])
    const modelMatch = rawErr.match(/\[model=(\S+?)\]/);
    const modelHint = modelMatch ? `\n使用的模型 ID: ${modelMatch[1]}` : '';

    // 提取服务商返回的具体错误信息 (errBody)
    // Java 格式: "HTTP 404 from {url} [model={model}]: {errBody}"
    // 尝试从冒号后提取 errBody，并解析 JSON 中的 error.message
    let bodyHint = '';
    const bodyMatch = rawErr.match(/\]:\s*(.+)$/s) || rawErr.match(/(?:HTTP \d+|404 Not Found).*?:\s*(.+)$/s);
    if (bodyMatch) {
      const rawBody = bodyMatch[1].trim();
      // 尝试解析 JSON 并提取 error.message
      try {
        const parsed = JSON.parse(rawBody);
        const errMsg = parsed?.error?.message || parsed?.message || parsed?.error || null;
        if (errMsg && typeof errMsg === 'string') {
          bodyHint = `\n服务商返回: ${errMsg.slice(0, 300)}`;
        } else {
          bodyHint = `\n服务商响应: ${rawBody.slice(0, 300)}`;
        }
      } catch {
        // 非 JSON, 直接显示原始文本 (可能是 HTML 页面)
        if (rawBody.length > 0 && rawBody.length < 500) {
          bodyHint = `\n服务商响应: ${rawBody.slice(0, 300)}`;
        }
      }
    }

    return `LLM 服务商返回 **404 未找到**：请求的模型不存在或端点错误。请检查「设置 → 模型」中的模型 ID 和 Base URL。\n常见原因:\n1. 模型 ID 拼写错误 (如 gpt-4 应为 gpt-4o)\n2. Base URL 缺少 /v1 后缀 (如 https://api.openai.com 应为 https://api.openai.com/v1)\n3. 该服务商不支持 OpenAI 兼容的 /chat/completions 端点${modelHint}${urlHint}${bodyHint}`;
  }

  // ── 500 后端服务异常 ──
  if (rawErr.includes('HTTP 500') || rawErr.includes('500 Internal')
      || rawErr.includes('LLM_EXECUTION_FAILED') || rawErr.includes('LLM HTTP 5')) {
    // LLM_EXECUTION_FAILED 但内部是 429 等 → 已被上面的条件捕获
    // 真正的后端 500 → 后端服务异常
    if (rawErr.includes('LLM HTTP')) {
      const m = rawErr.match(/LLM HTTP (\d+)/);
      const code = m ? m[1] : '';
      return `LLM 调用失败 (HTTP ${code})。服务商可能暂时不可用，请稍后重试。`;
    }
    return '后端服务异常，请检查 Java Agent 服务 (端口 8770) 是否在运行。';
  }

  // ── 网络连接失败 ──
  if (rawErr.includes('fetch') || rawErr.includes('NetworkError')
      || rawErr.includes('Failed to fetch') || rawErr.includes('ECONNREFUSED')) {
    return '网络连接失败：无法连接到后端服务。请确认后端服务已启动且端口未被占用。';
  }

  return `${rawErr}\n\n如持续出现此错误，请检查 Java Agent 服务 (端口 8770) 是否在运行。`;
}

/**
 * 工作区越界检测: 判断用户消息是否提到需要在工作区文件夹外操作
 *
 * @param finalContent 用户消息文本
 * @returns true 如果提到越界操作
 */
export function mentionsOutsideWorkspace(finalContent: string): boolean {
  const boundaryKeywords = [
    '文件夹外', '目录外', '工作区外', '外面做', '外部操作',
    'outside folder', 'outside the folder', 'outside workspace',
    'outside directory', 'not in folder',
  ];
  const lower = finalContent.toLowerCase();
  return boundaryKeywords.some(kw => lower.includes(kw.toLowerCase()));
}

/**
 * 预览触发检测结果
 */
export interface PreviewTriggerResult {
  shouldPreview: boolean;
  previewLang: string;
  cleanText: string;
  /** 本地翻译已成功推送到画布, 不需要再触发 LLM 预览流 */
  localHandled: boolean;
}

/**
 * 解析 done 事件中累积文本的预览标记
 *
 * 注意: 本函数只做"是否需要预览"的判定与文本清理,
 *       本地翻译 (tryLocalTranslateAndPush) 由调用方负责,
 *       因为它依赖画布/翻译器等运行时上下文
 *
 * @param accumulatedText LLM 完整回复文本
 * @param localPushed 本地翻译是否已成功推送 (由调用方先尝试)
 */
export function detectPreviewTrigger(
  accumulatedText: string,
  localPushed: boolean,
  detectPreviewFromResponse: (text: string) => string | null,
): PreviewTriggerResult {
  const previewMatch = accumulatedText.match(/<<<PREVIEW_NEEDED:(\w+)>>>/);

  // 本地翻译成功 → 不再触发 LLM 预览流
  if (localPushed) {
    const cleanText = previewMatch
      ? accumulatedText.replace(/\n*<<<PREVIEW_NEEDED:\w+>>>\s*$/, '')
      : accumulatedText;
    return { shouldPreview: false, previewLang: '', cleanText, localHandled: true };
  }

  // 层1: LLM 自标记
  if (previewMatch) {
    const cleanText = accumulatedText.replace(/\n*<<<PREVIEW_NEEDED:\w+>>>\s*$/, '');
    return { shouldPreview: true, previewLang: previewMatch[1], cleanText, localHandled: false };
  }

  // 层2: 强制代码块检测 — 不依赖 LLM 自觉
  const forcedLang = detectPreviewFromResponse(accumulatedText);
  if (forcedLang) {
    return { shouldPreview: true, previewLang: forcedLang, cleanText: accumulatedText, localHandled: false };
  }

  return { shouldPreview: false, previewLang: '', cleanText: accumulatedText, localHandled: false };
}

// ── HMR: 纯函数模块,自接受热更新,不触发 full page reload ──
// 引用此模块的组件自行决定是否刷新 (组件文件改动走 Fast Refresh)。
if (import.meta.hot) import.meta.hot.accept();
