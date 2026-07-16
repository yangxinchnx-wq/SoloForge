/**
 * Real-time Judge Stop — 实时裁判循环, 监听 worker_chunk 事件,
 * 当某个 worker 累积输出明显跑偏时主动调用 sendStopCommand 喊停。
 *
 * <p>触发策略:
 * <ul>
 *   <li>每个 worker 累积到 CHUNK_THRESHOLD 字符时, 用轻量 LLM 判断是否"明显跑偏"</li>
 *   <li>判断为跑偏时, 调用 JavaAgentTcpIntegration.sendStopCommand(dispatchId, workerIdx)</li>
 *   <li>每个 worker 最多触发 MIN_CHUNKS_BETWEEN_CHECKS 次, 避免频繁打断</li>
 *   <li>dispatch_done 时清理该 dispatch 的所有累积 buffer</li>
 * </ul>
 *
 * <p>注意: 这是"防御性喊停", 不是每次 dispatch 都跑的常规裁判。
 * 常规的多 worker 输出 LLM-as-judge 在 rtr-racer-engine.ts 的 winner 选择处做。
 */
import type { RuntimeComponent } from './runtime-component';
import type { RuntimeKernel, EventBusInterface } from './runtime-kernel';
import { logger } from '../core/logger';
import { callLLMWithTools, type LLMMessage } from '../core/agent/tools/function-calling-client';
import { getLLMProxyConfig } from '../llm/llmConfig';

const MODULE_NAME = 'RealtimeJudgeStop';

/** worker 累积多少字符后触发一次跑偏检测 */
const CHUNK_THRESHOLD = 600;
/** 同一 worker 两次检测之间最少间隔的 chunk 数 */
const MIN_CHUNKS_BETWEEN_CHECKS = 3;
/** 最多对同一 worker 触发检测的次数 */
const MAX_CHECKS_PER_WORKER = 2;

interface WorkerBuffer {
  content: string;
  chunkCount: number;
  checksRun: number;
  chunksSinceLastCheck: number;
  stopped: boolean;
}

class DispatchTracker {
  buffers = new Map<number, WorkerBuffer>();
  taskHint: string;

  constructor(taskHint: string) {
    this.taskHint = taskHint;
  }

  getOrCreate(workerIdx: number): WorkerBuffer {
    let buf = this.buffers.get(workerIdx);
    if (!buf) {
      buf = { content: '', chunkCount: 0, checksRun: 0, chunksSinceLastCheck: 0, stopped: false };
      this.buffers.set(workerIdx, buf);
    }
    return buf;
  }
}

export class RealtimeJudgeStopComponent implements RuntimeComponent {
  readonly name = 'realtime-judge-stop';
  private eventBus: EventBusInterface;
  private kernel: RuntimeKernel;
  private dispatches = new Map<string, DispatchTracker>();
  private handlersBound = false;

  constructor(kernel: RuntimeKernel, eventBus: EventBusInterface) {
    this.kernel = kernel;
    this.eventBus = eventBus;
  }

  async start(): Promise<void> {
    this.bindHandlers();
    logger.info(MODULE_NAME, 'Real-time judge stop component started');
  }

  async stop(): Promise<void> {
    this.unbindHandlers();
    this.dispatches.clear();
    logger.info(MODULE_NAME, 'Real-time judge stop component stopped');
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  private bindHandlers(): void {
    if (this.handlersBound) return;
    this.eventBus.on('worker_chunk', this.onWorkerChunk);
    this.eventBus.on('worker_done', this.onWorkerDone);
    this.eventBus.on('worker_failed', this.onWorkerFailed);
    this.eventBus.on('dispatch_done', this.onDispatchDone);
    this.handlersBound = true;
  }

  private unbindHandlers(): void {
    if (!this.handlersBound) return;
    this.eventBus.off('worker_chunk', this.onWorkerChunk);
    this.eventBus.off('worker_done', this.onWorkerDone);
    this.eventBus.off('worker_failed', this.onWorkerFailed);
    this.eventBus.off('dispatch_done', this.onDispatchDone);
    this.handlersBound = false;
  }

  private onWorkerChunk = (payload: any): void => {
    const dispatchId = payload?.dispatchId;
    const workerIdx = payload?.workerIdx;
    const content = payload?.content;
    if (!dispatchId || typeof workerIdx !== 'number' || typeof content !== 'string') return;

    const tracker = this.dispatches.get(dispatchId);
    if (!tracker) return; // 没 taskHint 的 dispatch 不做实时判断

    const buf = tracker.getOrCreate(workerIdx);
    if (buf.stopped) return;
    buf.content += content;
    buf.chunkCount++;
    buf.chunksSinceLastCheck++;

    if (buf.content.length < CHUNK_THRESHOLD) return;
    if (buf.chunksSinceLastCheck < MIN_CHUNKS_BETWEEN_CHECKS) return;
    if (buf.checksRun >= MAX_CHECKS_PER_WORKER) return;

    logger.info(MODULE_NAME, `Triggering off-track check: dispatchId=${dispatchId}, workerIdx=${workerIdx}, contentLen=${buf.content.length}, chunkCount=${buf.chunkCount}, checksRun=${buf.checksRun}`);
    buf.chunksSinceLastCheck = 0;
    buf.checksRun++;
    this.runOffTrackCheck(dispatchId, workerIdx, buf, tracker.taskHint).catch(err => {
      logger.warn(MODULE_NAME, `Off-track check failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  private onWorkerDone = (payload: any): void => {
    const dispatchId = payload?.dispatchId;
    if (!dispatchId) return;
    const tracker = this.dispatches.get(dispatchId);
    if (!tracker) return;
    const workerIdx = payload?.workerIdx;
    if (typeof workerIdx === 'number') {
      const buf = tracker.buffers.get(workerIdx);
      if (buf) buf.stopped = true;
    }
  };

  private onWorkerFailed = (payload: any): void => {
    const dispatchId = payload?.dispatchId;
    if (!dispatchId) return;
    const tracker = this.dispatches.get(dispatchId);
    if (!tracker) return;
    const workerIdx = payload?.workerIdx;
    if (typeof workerIdx === 'number') {
      const buf = tracker.buffers.get(workerIdx);
      if (buf) buf.stopped = true;
    }
  };

  private onDispatchDone = (payload: any): void => {
    const dispatchId = payload?.dispatchId;
    if (!dispatchId) return;
    this.dispatches.delete(dispatchId);
  };

  /**
   * 用轻量 LLM 判断 worker 是否明显跑偏。
   * 返回 true 表示应该喊停。
   */
  private async runOffTrackCheck(
    dispatchId: string,
    workerIdx: number,
    buf: WorkerBuffer,
    taskHint: string,
  ): Promise<boolean> {
    try {
      const cfg = getLLMProxyConfig();
      const recentContent = buf.content.slice(-1200);

      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: `You are a real-time quality monitor for an AI assistant worker.
Given the task and a snippet of the worker's ongoing output, decide if the worker is clearly off-track, hallucinating badly, or producing garbage.
Respond in EXACTLY this JSON format:
{"off_track": true/false, "reason": "<brief>"}

Only mark off_track=true if the output is clearly useless. Minor imperfections should be false.`,
        },
        {
          role: 'user',
          content: `Task: ${taskHint.slice(0, 400)}\n\nWorker output so far:\n${recentContent}`,
        },
      ];

      const result = await callLLMWithTools({
        messages,
        tools: [],
        model: cfg.defaultModel,
        temperature: 0.2,
        maxTokens: 1024,
        maxRounds: 1,
      });

      const raw = result.finalMessage.content ?? '';
      logger.info(MODULE_NAME, `Off-track check raw response (worker ${workerIdx}): ${raw.slice(0, 200)}`);
      const jsonMatch = raw.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        logger.info(MODULE_NAME, `Off-track check returned no JSON, assuming on-track`);
        return false;
      }
      const parsed = JSON.parse(jsonMatch[0]);
      const offTrack = Boolean(parsed.off_track);

      if (offTrack) {
        logger.warn(MODULE_NAME, `Worker ${workerIdx} judged off-track: ${parsed.reason ?? ''}, sending STOP`);
        buf.stopped = true;
        await this.sendStop(dispatchId, workerIdx);
        this.eventBus.emit('worker_stopped_by_judge', {
          dispatchId, workerIdx, reason: parsed.reason ?? 'off-track',
        });
        return true;
      }
      logger.info(MODULE_NAME, `Worker ${workerIdx} on-track (check ${buf.checksRun}): ${parsed.reason ?? ''}`);
      return false;
    } catch (err) {
      logger.warn(MODULE_NAME, `Off-track check error (assuming on-track): ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async sendStop(dispatchId: string, workerIdx: number): Promise<void> {
    const tcp = (this.kernel as any)?.javaAgentTcp?.getIntegration?.();
    if (!tcp || typeof tcp.sendStopCommand !== 'function') {
      logger.warn(MODULE_NAME, `Cannot send STOP: Java Agent TCP integration not available`);
      return;
    }
    await tcp.sendStopCommand(dispatchId, workerIdx);
  }

  /**
   * Register a dispatch for real-time monitoring with its task hint.
   * Called by the orchestrator when a dispatch starts.
   */
  registerDispatch(dispatchId: string, taskHint: string): void {
    if (!taskHint) return;
    this.dispatches.set(dispatchId, new DispatchTracker(taskHint));
    logger.debug(MODULE_NAME, `Registered dispatch ${dispatchId} for monitoring`);
  }

  /**
   * Unregister a dispatch (e.g. on early termination).
   */
  unregisterDispatch(dispatchId: string): void {
    this.dispatches.delete(dispatchId);
  }
}
