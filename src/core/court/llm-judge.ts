/**
 * LLM-as-Judge — 对多个 worker 的并行输出做语义级裁判评分。
 *
 * <p>使用场景: {@link RtrRacerEngine.coordinateRacerFlow} 中, 多路并行 worker 执行完毕后,
 * 用 LLM 对各 worker 的输出做 pairwise / listwise 评分, 选出真正的 winner。
 * 之前的占位 heuristic 是比 output.length (谁长谁赢), 现在替换为 LLM 语义评分。
 *
 * <p>失败回退: 如果 LLM 调用失败或 JSON 解析失败, 回退到 output.length 启发式,
 * 保持原有行为不变。
 *
 * <p>参考实现: {@link LlmEscalationRoom} (llm_escalation.ts) 的 LLM 法官范式。
 */
import { callLLMWithTools, type LLMMessage } from '../agent/tools/function-calling-client';
import { getLLMProxyConfig } from '../../llm/llmConfig';
import { logger } from '../logger';
import type { WorkerExecResult } from '../decision/rtr-racer-engine';

export interface JudgeVerdict {
  /** 0-based winner index in the input array */
  winnerIdx: number;
  /** per-worker scores, 0..10 */
  scores: number[];
  /** brief reason from the judge */
  reason: string;
}

const MODULE_NAME = 'LLMJudge';

/**
 * 用 LLM 对多个 worker 的输出做评分, 选出 winner。
 *
 * @param outputs worker 输出列表 (与 workerResults 同序)
 * @param task 可选的原始任务描述, 有则让 judge 知道目标
 * @returns JudgeVerdict 包含 winnerIdx / scores / reason
 */
export async function judgeWorkerOutputs(
  outputs: WorkerExecResult[],
  task?: string,
): Promise<JudgeVerdict> {
  const n = outputs.length;
  if (n === 0) {
    return { winnerIdx: 0, scores: [], reason: 'empty' };
  }
  if (n === 1) {
    return { winnerIdx: 0, scores: [10], reason: 'single worker' };
  }

  try {
    const cfg = getLLMProxyConfig();

    // 构造候选输出列表 (截断到 2000 字符避免 token 爆炸)
    const candidateList = outputs.map((r, i) => {
      const text = r.output.startsWith('[WORKER_ERROR]') ? `[ERROR] ${r.output.slice(0, 200)}` : r.output.slice(0, 2000);
      return `--- Candidate ${i} ---\n${text}`;
    }).join('\n\n');

    const taskLine = task ? `Task: ${task.slice(0, 500)}\n\n` : '';

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are an impartial judge evaluating multiple AI assistant responses.
Score each candidate response from 0 to 10 based on:
- Helpfulness and relevance to the task
- Accuracy and factual correctness
- Clarity, coherence, and completeness
- Conciseness (avoid verbosity without value)

Respond in EXACTLY this JSON format, nothing else:
{"scores": [n0, n1, ...], "winner": <index>, "reason": "<brief>"}

Penalize [ERROR] candidates heavily.`,
      },
      {
        role: 'user',
        content: `${taskLine}Candidates:\n${candidateList}`,
      },
    ];

    const llmResult = await callLLMWithTools({
      messages,
      tools: [],
      model: cfg.defaultModel,
      temperature: 0.2,
      maxTokens: 1024,
      maxRounds: 1,
    });

    const rawOutput = llmResult.finalMessage.content ?? '';
    const jsonMatch = rawOutput.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const scores: number[] = Array.isArray(parsed.scores) ? parsed.scores.map((s: any) => Number(s) || 0) : [];
      let winnerIdx = typeof parsed.winner === 'number' ? parsed.winner : 0;
      // 校验 winnerIdx 范围
      if (winnerIdx < 0 || winnerIdx >= n) winnerIdx = 0;
      // 如果 scores 长度不匹配, fallback 到 argmax
      if (scores.length !== n) {
        scores.length = 0;
        for (let i = 0; i < n; i++) scores.push(0);
        scores[winnerIdx] = 10;
      } else {
        // 用 scores 重新算 winnerIdx (防止 LLM 给的 winner 与 scores 不一致)
        let maxScore = -1;
        for (let i = 0; i < n; i++) {
          if (scores[i] > maxScore) { maxScore = scores[i]; winnerIdx = i; }
        }
      }
      const reason = typeof parsed.reason === 'string' ? parsed.reason : 'LLM judge verdict';
      logger.info(MODULE_NAME, `Judge verdict: winnerIdx=${winnerIdx}, scores=${JSON.stringify(scores)}, reason=${reason}`);
      return { winnerIdx, scores, reason };
    }
    logger.warn(MODULE_NAME, `LLM returned no JSON, falling back to length heuristic`);
    return lengthHeuristicFallback(outputs);
  } catch (err) {
    logger.warn(MODULE_NAME, `LLM judge failed, falling back to length heuristic: ${err instanceof Error ? err.message : String(err)}`);
    return lengthHeuristicFallback(outputs);
  }
}

/**
 * 回退: 用 output.length 启发式 (原有逻辑) 选 winner。
 * 排除 [WORKER_ERROR] 开头的输出, 剩余中选最长的。
 */
function lengthHeuristicFallback(outputs: WorkerExecResult[]): JudgeVerdict {
  const scores: number[] = [];
  let winnerIdx = 0;
  let maxLen = -1;
  for (let i = 0; i < outputs.length; i++) {
    const isError = outputs[i].output.startsWith('[WORKER_ERROR]');
    const len = isError ? 0 : outputs[i].output.length;
    scores.push(isError ? 0 : Math.min(10, Math.ceil(len / 200)));
    if (len > maxLen) { maxLen = len; winnerIdx = i; }
  }
  return { winnerIdx, scores, reason: 'length heuristic fallback' };
}
