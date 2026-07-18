/**
 * sseStream — 统一的 SSE (Server-Sent Events) 流解析器
 *
 * 替代原 ChatPanel 内嵌的 SSE 解析 + handleAcceptEnable 里的 streamSse 函数两套实现。
 * 行为对齐到一个严格的"宽松 + 兼容"实现:
 *   - 接受 'data:' 和 'data: ' 两种前缀 (后端实现不一致时仍能解析)
 *   - 接受 LF / CRLF 行终止
 *   - '[DONE]' 哨兵跳过
 *   - 非 JSON 行仅警告一次, 不抛错 (避免一颗老鼠屎毁一锅汤)
 *   - buffer 跨 chunk 保留, 处理多字节字符在 chunk 边界被截断的情况
 *
 * 用法:
 *   const reader = res.body!.getReader();
 *   await parseSseStream(reader, (evt) => onSseEvent(evt));
 */
export interface SseStreamOptions {
  /**
   * 收到无法解析的 JSON 行时是否 console.warn
   * 默认 true, 方便调试后端脏数据
   */
  warnOnParseError?: boolean;
}

/**
 * 从 ReadableStreamDefaultReader 持续读取字节并按 SSE 协议解码为 JSON 对象
 * @param reader 已经 getReader() 过的流
 * @param onEvent 每个解出的 JSON 对象都会被调用一次
 * @param opts.warnOnParseError 默认 true
 * @returns 在流自然结束 (done) 时 resolve
 */
export async function parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (evt: unknown) => void,
  opts: SseStreamOptions = {},
): Promise<void> {
  const { warnOnParseError = true } = opts;
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let parseErrorReported = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // 按 LF 切行, 但保留最后一段 (可能不完整) 在 buffer
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const raw of lines) {
      const line = raw.replace(/\r$/, '').trim();
      if (!line) continue;
      // 同时接受 'data:' (无空格) 和 'data: ' (有空格) 两种格式
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        onEvent(JSON.parse(payload));
      } catch (e) {
        if (warnOnParseError && !parseErrorReported) {
          console.warn('[parseSseStream] 非 JSON 行已忽略:', payload.slice(0, 80), e);
          parseErrorReported = true; // 避免刷屏
        }
      }
    }
  }

  // 流关闭后清空 buffer 里残余的最后一段 (不带换行符)
  const tail = buffer.replace(/\r$/, '').trim();
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim();
    if (payload && payload !== '[DONE]') {
      try {
        onEvent(JSON.parse(payload));
      } catch { /* 忽略 */ }
    }
  }
}

/**
 * 便捷封装: 从 ReadableStream 一次性拿 reader 并解析
 */
export async function parseSseFromStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (evt: unknown) => void,
  opts?: SseStreamOptions,
): Promise<void> {
  const reader = body.getReader();
  return parseSseStream(reader, onEvent, opts);
}

// ── HMR: 纯函数模块,自接受热更新,不触发 full page reload ──
if (import.meta.hot) import.meta.hot.accept();
