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
 *   - HTTP 429 / rate limit → 速率限制
 *   - HTTP 401 / Unauthorized / API key → 认证失败
 *   - HTTP 404 → 模型/端点不存在
 *   - HTTP 500 / LLM_EXECUTION_FAILED → 后端服务异常
 *   - fetch / NetworkError → 网络连接失败
 *   - 其他 → 原始错误 + 通用提示
 */
export function classifyStreamError(rawErr: string): string {
  if (!rawErr) return '未知错误。请检查后端 /api/agents/dispatch 是否在运行。';

  if (rawErr.includes('HTTP 429') || rawErr.includes('rate limit')) {
    return 'LLM 服务商返回 **429 速率限制**：免费额度已用尽或请求过于频繁。请稍后重试，或在「设置 → 模型」中更换/升级服务商。';
  }

  if (rawErr.includes('HTTP 401') || rawErr.includes('Unauthorized') || rawErr.includes('API key')) {
    return 'LLM 服务商返回 **401 认证失败**：API Key 无效或已过期。请在「设置 → 模型」中重新输入正确的 API Key。';
  }

  if (rawErr.includes('HTTP 404')) {
    return 'LLM 服务商返回 **404 未找到**：请求的模型不存在或端点错误。请检查「设置 → 模型」中的模型 ID 和 Base URL。';
  }

  if (rawErr.includes('HTTP 500') || rawErr.includes('LLM_EXECUTION_FAILED')) {
    // LLM_EXECUTION_FAILED 但内部是 429 等 → 已被上面的条件捕获
    // 真正的后端 500 → 后端服务异常
    if (rawErr.includes('LLM HTTP')) {
      const m = rawErr.match(/LLM HTTP (\d+)/);
      const code = m ? m[1] : '';
      return `LLM 调用失败 (HTTP ${code})。服务商可能暂时不可用，请稍后重试。`;
    }
    return '后端服务异常，请检查 /api/agents/dispatch 是否在运行。';
  }

  if (rawErr.includes('fetch') || rawErr.includes('NetworkError') || rawErr.includes('Failed to fetch')) {
    return '网络连接失败：无法连接到后端服务。请确认后端服务已启动且端口未被占用。';
  }

  return `${rawErr}\n\n如持续出现此错误，请检查后端 /api/agents/dispatch 是否在运行。`;
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
