/**
 * useLLMStreamMutation.ts — TanStack Query 风格的 LLM 流式 mutation
 *
 * 整合 LLMClient + StreamingASTParser + Cache，
 * 用 useMutation 模式暴露：
 *   - mutate({ language, userGoal }) 触发流
 *   - onChunk 回调每次 chunk 到达时调用
 *   - onSuccess / onError 标准 mutation 生命周期
 *   - 自动写入 queryClient cache（key: ['ast', lang, promptHash]）
 *
 * 用法（替代 useUniversalPreview 的 LLM 部分）：
 *   const mutation = useLLMStreamMutation({
 *     sessionId,
 *     onChunk: (chunk, state) => updateUI(chunk, state),
 *     onSuccess: (payload) => console.log('done', payload),
 *   });
 *   mutation.mutate({ language: 'python', userGoal: 'login screen' });
 */

import { useCallback, useMemo, useRef } from 'react';
import { LLMClient } from '../llm/LLMClient';
import { ASTParser } from '../canvas/ASTParser';
import { astCache, astKeyFor } from '../canvas/astCache';
import { getAdapter, isSupported } from '../canvas/LanguageAdapters';
import type { PreviewPayload, StreamState } from '../canvas/UniversalAST';
import { bestEffortRoot } from '../canvas/StreamingASTParser';
import { useMutation } from './hooks';
import { getQueryClient } from './queryClient';

export interface LLMStreamVars {
  language: string;
  userGoal: string;
  /** 历史消息 */
  history?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** 模型覆盖 */
  model?: string;
}

export interface LLMStreamResult {
  payload: PreviewPayload | null;
  /** 流的 raw 字节数 */
  bytes: number;
  /** 最终 stream state */
  streamState: StreamState;
}

export interface UseLLMStreamMutationOptions {
  sessionId: string;
  /** 自定义 LLM 客户端 */
  client?: LLMClient;
  /** 每次 chunk 到达 */
  onChunk?: (chunk: string, state: StreamState) => void;
  /** 拿到 partial root 时（用于实时渲染） */
  onPartialRoot?: (root: any, state: StreamState) => void;
  /** mutation 成功（payload 已确认） */
  onSuccess?: (result: LLMStreamResult) => void;
}

export function useLLMStreamMutation(opts: UseLLMStreamMutationOptions) {
  const queryClient = getQueryClient();
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const mutationFn = useCallback(async (vars: LLMStreamVars): Promise<LLMStreamResult> => {
    const client = optsRef.current.client ?? LLMClient.fromEnv();
    const parser = new ASTParser();
    const safeLang = isSupported(vars.language) ? vars.language.toLowerCase() : 'typescript';

    // 缓存检查
    const cacheKey = astKeyFor(safeLang, vars.userGoal);
    const cached = astCache.get(cacheKey);
    if (cached) {
      return {
        payload: cached,
        bytes: 0,
        streamState: { raw: '', payload: cached, errors: [], done: true },
      };
    }

    // 调用 LLM
    const adapter = getAdapter(safeLang);
    const systemPrompt = adapter.buildSystemPrompt(vars.userGoal);
    const handle = client.stream({
      systemPrompt,
      userGoal: vars.userGoal,
      history: vars.history,
      model: vars.model,
    });

    // 流式消费
    let state = parser.createStream();
    for await (const chunk of handle) {
      state = parser.feedChunk(state, chunk);
      optsRef.current.onChunk?.(chunk, state);

      // partial root callback（实时渲染）
      const partialRoot = bestEffortRoot(state.payload);
      if (partialRoot) {
        optsRef.current.onPartialRoot?.(partialRoot, state);
      }
    }

    // 流结束：标记 done + 校验
    state = parser.endStream(state);
    const payload = state.payload as PreviewPayload | null;

    // 写 query cache + ast cache
    if (payload) {
      queryClient.setQueryData(['ast', safeLang, vars.userGoal], payload);
      astCache.setByPrompt(safeLang, vars.userGoal, payload);
    }

    return {
      payload,
      bytes: state.raw.length,
      streamState: state,
    };
  }, [queryClient]);

  const mutation = useMutation<LLMStreamVars, LLMStreamResult>({
    mutationFn,
    onSuccess: (result) => optsRef.current.onSuccess?.(result),
  });

  // 暴露 cache invalidate 便捷方法
  const invalidateCache = useCallback((language: string, userGoal: string) => {
    const safeLang = isSupported(language) ? language.toLowerCase() : 'typescript';
    queryClient.invalidateQueries(['ast', safeLang, userGoal]);
    astCache.invalidate(astKeyFor(safeLang, userGoal));
  }, [queryClient]);

  return useMemo(
    () => ({
      ...mutation,
      invalidateCache,
    }),
    [mutation, invalidateCache],
  );
}
