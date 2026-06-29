/**
 * useUniversalPreview.ts — Universal AST 流式预览顶层 Hook
 *
 * 职责：
 *   1. 管理 StreamState（confirmed payload + streaming chunks）
 *   2. 暴露 { ast, isStreaming, send, cancel, retry, errors, sourceCode }
 *   3. 集成 Canvas3DClient 的流式推送（feedASTChunk + flushAST）
 *   4. Garnet 缓存：相同 (language, promptHash) 命中缓存秒回
 *   5. 集成 LLMClient：send() 触发真实 LLM 流（无 client 时跳过）
 *
 * 状态分层（按 backend-patterns）：
 *   - confirmed : Zustand（已确认的最终 payload，组件可直接订阅）
 *   - streaming : useState + useRef（流中的临时数据，不需要全局）
 *   - cache     : Garnet 跨 session 共享（key: ast:{lang}:{promptHash}）
 *
 * 调用方不变：
 *   <PreviewPanel />
 *   const { ast, isStreaming, send, cancel } = useUniversalPreview({ sessionId });
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ASTParser } from '../services/canvas/ASTParser';
import { Canvas3DClient } from '../services/canvas/Canvas3DClient';
import { getAdapter, isSupported } from '../services/canvas/LanguageAdapters';
import { astCache, astKeyFor } from '../services/canvas/astCache';
import { LLMClient } from '../services/llm/LLMClient';
import type {
  PreviewPayload,
  StreamState,
  UniversalNode,
} from '../services/canvas/UniversalAST';

interface UseUniversalPreviewOptions {
  sessionId: string;
  deviceId?: string;
  /** 自定义 IPC client（测试时可注入 mock） */
  client?: Canvas3DClient;
  /** 自定义 LLM client（默认 LLMClient.fromEnv） */
  llmClient?: LLMClient;
  /** 缓存命中时是否自动推送 */
  autoFlushOnCacheHit?: boolean;
  /** LLM 调用的额外参数 */
  llmOptions?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    history?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  };
}

export interface UseUniversalPreviewReturn {
  /** 当前确认的 payload（流结束后稳定） */
  payload: PreviewPayload | null;
  /** 当前最佳 root（半成品 AST 也能拿到） */
  ast: UniversalNode | undefined;
  /** 是否正在流式 */
  isStreaming: boolean;
  /** 当前已接收的原始字节 */
  rawBytes: number;
  /** 解析错误（'parse-failed' / 'repaired-truncation' / 'empty-input'） */
  errors: string[];
  /** 当前 language（流中可被 LLM 修改，最终稳定） */
  language: string;
  /** 当前 source_code 估算（流中按比例截取） */
  sourceCode: string;

  // ── 控制 API ──
  /** 启动一次新的流（传入语言 + 用户目标） */
  send: (params: { language: string; userGoal: string }) => Promise<void>;
  /** 推一个 chunk（直接喂 LLM SSE 片段） */
  feedChunk: (chunk: string) => void;
  /** 标记流结束 */
  finish: () => Promise<void>;
  /** 取消流（不会推送已收到的部分） */
  cancel: () => void;
  /** 重试：用同样的语言和目标再发一次 */
  retry: () => Promise<void>;
}

/**
 * 顶层 Hook（业务侧只调这一个）
 *
 * 集成：
 *   - ASTParser：流式 JSON 解析
 *   - Canvas3DClient：流式 IPC 推送
 *   - astCache：Garnet 缓存层
 *   - LanguageAdapters：system prompt 生成
 */
export function useUniversalPreview(opts: UseUniversalPreviewOptions): UseUniversalPreviewReturn {
  const { sessionId, deviceId, autoFlushOnCacheHit = true, llmOptions } = opts;

  // 依赖注入：默认从 PortManager 取客户端；测试时可传 mock
  const clientRef = useRef<Canvas3DClient>(
    opts.client ?? new Canvas3DClient(0), // port 在外部 setPort() 注入
  );
  const parserRef = useRef<ASTParser>(new ASTParser());
  const llmRef = useRef<LLMClient>(opts.llmClient ?? LLMClient.fromEnv());

  // ── 状态（confirmed vs streaming 分层） ──
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [streamState, setStreamState] = useState<StreamState>(() => parserRef.current.createStream());
  const [language, setLanguage] = useState<string>('typescript');
  const [lastGoal, setLastGoal] = useState<string>('');

  const isStreaming = !streamState.done && streamState.raw.length > 0;

  // ── 缓存命中自动推送 ──
  useEffect(() => {
    if (!autoFlushOnCacheHit || !lastGoal) return;
    const key = astKeyFor(language, lastGoal);
    const cached = astCache.get(key);
    if (cached && !payload) {
      setPayload(cached);
      // 命中缓存时直接推送最终态（不走 streaming）
      clientRef.current.pushUniversalPreview(sessionId, cached, deviceId).catch(() => {});
    }
  }, [language, lastGoal, autoFlushOnCacheHit, payload, sessionId, deviceId]);

  // ── send：启动一次新的流 ──
  const send = useCallback(
    async ({ language: lang, userGoal }: { language: string; userGoal: string }) => {
      const safeLang = isSupported(lang) ? lang.toLowerCase() : 'typescript';
      setLanguage(safeLang);
      setLastGoal(userGoal);
      setPayload(null);

      // 缓存检查
      const key = astKeyFor(safeLang, userGoal);
      const cached = astCache.get(key);
      if (cached) {
        setPayload(cached);
        await clientRef.current.pushUniversalPreview(sessionId, cached, deviceId);
        return;
      }

      // 重置流
      setStreamState(parserRef.current.createStream());

      // 调用 LLM 流式接口
      try {
        const adapter = getAdapter(safeLang);
        const systemPrompt = adapter.buildSystemPrompt(userGoal);
        const handle = llmRef.current.stream({
          systemPrompt,
          userGoal,
          model: llmOptions?.model,
          temperature: llmOptions?.temperature,
          maxTokens: llmOptions?.maxTokens,
          history: llmOptions?.history,
        });

        for await (const chunk of handle) {
          feedChunk(chunk);
        }
        await finish();
      } catch (e) {
        // LLM 调用失败：保持空流，让调用方选择 retry
        // eslint-disable-next-line no-console
        console.error('LLM stream error:', e);
      }
    },
    [sessionId, deviceId, llmOptions, feedChunk, finish],
  );

  // ── feedChunk：推一个 chunk 进入流 ──
  const feedChunk = useCallback(
    (chunk: string) => {
      if (streamState.done) return;
      const next = parserRef.current.feedChunk(streamState, chunk);
      setStreamState(next);

      // 同步 language（一旦 LLM 输出语言标记就更新）
      const langFromPayload = (next.payload as any)?.language;
      if (typeof langFromPayload === 'string' && langFromPayload !== language) {
        setLanguage(langFromPayload);
      }

      // 推送到 Flutter（节流：每 50ms 最多一次）
      throttledPush(next);
    },
    [streamState, language],
  );

  // ── finish：流结束，校验 + 推送最终态 ──
  const finish = useCallback(async () => {
    const final = parserRef.current.endStream(streamState);
    setStreamState(final);

    const confirmedPayload = final.payload as PreviewPayload | null;
    if (!confirmedPayload) {
      // 流结束时还没完整 JSON，记错
      return;
    }

    setPayload(confirmedPayload);

    // 写缓存
    if (lastGoal) {
      astCache.setByPrompt(confirmedPayload.language, lastGoal, confirmedPayload);
    }

    // 推送最终态 + flush
    await clientRef.current.pushUniversalPreview(sessionId, confirmedPayload, deviceId);
    await clientRef.current.flushAST(sessionId, deviceId);
  }, [streamState, sessionId, deviceId, lastGoal]);

  // ── cancel：取消流（已收到的部分不推送） ──
  const cancel = useCallback(() => {
    setStreamState(parserRef.current.resetStream());
  }, []);

  // ── retry：用同样参数重发 ──
  const retry = useCallback(async () => {
    if (!lastGoal) return;
    await send({ language, userGoal: lastGoal });
  }, [send, language, lastGoal]);

  // ── 派生：ast（半成品也行） ──
  const ast = parserRef.current.bestEffortRoot(streamState);

  // ── 派生：sourceCode 估算（流中按比例截取最终 source_code） ──
  const sourceCode = (() => {
    if (payload) return payload.source_code;
    if (!streamState.payload) return '';
    // 流中还没完整 source_code：从 raw 估算
    return streamState.raw.slice(0, Math.floor(streamState.raw.length * 0.6));
  })();

  // ── 节流推送辅助 ──
  const lastPushTsRef = useRef<number>(0);
  const pendingPushRef = useRef<boolean>(false);
  const throttledPush = useCallback(
    (next: StreamState) => {
      const now = Date.now();
      if (now - lastPushTsRef.current >= 50) {
        lastPushTsRef.current = now;
        const partialRoot = parserRef.current.bestEffortRoot(next);
        if (partialRoot) {
          clientRef.current
            .feedASTChunk(
              sessionId,
              partialRoot,
              { deviceId, isPartial: true, language: (next.payload as any)?.language },
            )
            .catch(() => {});
        }
      } else {
        if (!pendingPushRef.current) {
          pendingPushRef.current = true;
          setTimeout(() => {
            pendingPushRef.current = false;
            const partialRoot = parserRef.current.bestEffortRoot(streamState);
            if (partialRoot) {
              clientRef.current
                .feedASTChunk(sessionId, partialRoot, {
                  deviceId,
                  isPartial: true,
                  language: (streamState.payload as any)?.language,
                })
                .catch(() => {});
            }
          }, 60);
        }
      }
    },
    [sessionId, deviceId, streamState],
  );

  return {
    payload,
    ast,
    isStreaming,
    rawBytes: streamState.raw.length,
    errors: streamState.errors,
    language,
    sourceCode,
    send,
    feedChunk,
    finish,
    cancel,
    retry,
  };
}
