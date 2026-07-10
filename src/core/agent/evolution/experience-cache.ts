/**
 * experience-cache.ts — Agent 经验缓存（"不断进化"的核心）
 *
 * 用户原话: "这次的agent解决了问题，下次就不请求那么多次了，直接把经验翻出来让llm照着做就行了"
 *
 * 工作原理:
 *   1. 第一次解决问题 → 保存 {问题指纹, 成功工具序列, 最终答案, token消耗}
 *   2. 下次遇到相同/相似问题 → 命中缓存 → 走"经验路径"
 *   3. 经验路径: 1 次 LLM 调用 (把经验作为上下文, 让 LLM 直接生成答案, 不调工具)
 *   4. 持久化到磁盘 (data/agent-experience.jsonl), 重启不丢失
 *
 * 请求量对比:
 *   无经验: Agent Loop 多轮 (12次 LLM 调用 + 工具 IO) → 44k tokens
 *   有经验: 1 次 LLM 调用 (经验注入) → ~2k tokens (省 95%+)
 *
 * 指纹算法:
 *   归一化: 去空格/标点/大小写 + 数字归一化(版本号/行号忽略)
 *   精确匹配: 归一化后 hash 相同
 *   模糊匹配: 归一化后前 64 字符相同 (相似问题复用)
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../../logger/index';

/** 单条经验记录 */
export interface ExperienceRecord {
  /** 问题指纹 (归一化后 sha256 前 16 字符) */
  fingerprint: string;
  /** 归一化后的问题文本 (用于模糊匹配) */
  normalizedPrompt: string;
  /** 原始问题 (截断 200 字符) */
  originalPrompt: string;
  /** 来源类型: racer_agent_loop = RACER 多轮, direct_llm_qa = 简单问答缓存 */
  sourceType?: 'racer_agent_loop' | 'direct_llm_qa';
  /** 成功的工具调用序列 [{tool, args, result摘要}] */
  toolSteps: Array<{
    tool: string;
    args: string;
    resultSummary: string;
  }>;
  /** 最终答案 (截断 2000 字符) */
  finalAnswer: string;
  /** 当时消耗的 token */
  tokenCost: number;
  /** 耗时 ms */
  durationMs: number;
  /** 被复用次数 */
  reuseCount: number;
  /** 成功率 (0-1, 每次复用后更新) */
  successRate: number;
  createdAt: number;
  lastUsedAt: number;
}

/** 经验查询结果 */
export interface ExperienceLookup {
  record: ExperienceRecord;
  matchType: 'exact' | 'similar';
  similarity: number; // 0-1
}

export class ExperienceCache {
  private readonly cache = new Map<string, ExperienceRecord>();
  private readonly filePath: string;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    const dir = dirname(dataDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = join(dataDir, 'agent-experience.jsonl');
    this.load();
  }

  /** 归一化问题文本: 去空格/标点/大小写 + 数字归一化 */
  static normalize(prompt: string): string {
    return prompt
      .toLowerCase()
      .replace(/\s+/g, ' ')           // 合并空白
      .replace(/[^\w\s\u4e00-\u9fff]/g, '') // 去标点(保留字母数字中文)
      .replace(/\b\d+(\.\d+)+\b/g, 'V')    // 版本号 v1.2.3 → V
      .replace(/\b\d+\b/g, 'N')            // 行号/数字 → N
      .trim();
  }

  /** 计算指纹: sha256 前 16 字符 */
  static fingerprint(normalized: string): string {
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  /** 加载持久化经验 (启动时) */
  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const lines = readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean);
      let count = 0;
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as ExperienceRecord;
          // 只加载最近 30 天的经验 (衰减旧经验)
          const ageDays = (Date.now() - rec.createdAt) / 86400000;
          if (ageDays > 30) continue;
          this.cache.set(rec.fingerprint, rec);
          count++;
        } catch { /* 跳过损坏行 */ }
      }
      if (count > 0) {
        logger.info('ExperienceCache', `已加载 ${count} 条经验`);
      }
    } catch (e) {
      logger.warn('ExperienceCache', `加载失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 异步落盘 (防抖 2s, 避免频繁写盘) */
  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 2000);
  }

  /** 立即落盘 */
  flush(): void {
    if (!this.dirty) return;
    try {
      // 全量重写 (经验量不大, 全量写比追加+合并简单可靠)
      const lines = [...this.cache.values()].map(r => JSON.stringify(r));
      writeFileSync(this.filePath, lines.join('\n') + '\n', 'utf-8');
      this.dirty = false;
      this.flushTimer = null;
    } catch (e) {
      logger.warn('ExperienceCache', `落盘失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * 查询经验
   * 优先精确匹配 (RACER 与 DirectLLM QA 两种指纹), 其次模糊匹配 (前 64 字符相同)
   */
  lookup(prompt: string): ExperienceLookup | null {
    const normalized = ExperienceCache.normalize(prompt);
    const fp = ExperienceCache.fingerprint(normalized);

    // 1) 精确匹配: RACER 经验 (无前缀)
    const exact = this.cache.get(fp);
    if (exact) {
      return { record: exact, matchType: 'exact', similarity: 1.0 };
    }

    // 1b) 精确匹配: DirectLLM QA 经验 (qa_ 前缀)
    const qaExact = this.cache.get(`qa_${fp}`);
    if (qaExact) {
      return { record: qaExact, matchType: 'exact', similarity: 1.0 };
    }

    // 2) 模糊匹配: 归一化后前 64 字符相同 (相似问题复用)
    //    例如 "读取 package.json 说明依赖" 和 "读取 package.json 并分析依赖" 前缀相同
    const prefix = normalized.slice(0, 64);
    if (prefix.length < 10) return null; // 太短不模糊匹配

    let bestMatch: ExperienceRecord | null = null;
    let bestSim = 0;
    for (const rec of this.cache.values()) {
      if (rec.normalizedPrompt.slice(0, 64) === prefix) {
        // 计算整体相似度 (Jaccard on words)
        const sim = this.jaccardSimilarity(normalized, rec.normalizedPrompt);
        if (sim > bestSim && sim >= 0.6) {
          bestSim = sim;
          bestMatch = rec;
        }
      }
    }

    if (bestMatch) {
      return { record: bestMatch, matchType: 'similar', similarity: bestSim };
    }
    return null;
  }

  /** Jaccard 相似度 (词级) */
  private jaccardSimilarity(a: string, b: string): number {
    const sa = new Set(a.split(' '));
    const sb = new Set(b.split(' '));
    const inter = [...sa].filter(x => sb.has(x)).length;
    const union = new Set([...sa, ...sb]).size;
    return union === 0 ? 0 : inter / union;
  }

  /**
   * 保存经验 (Agent Loop 成功后调用)
   * 如果已存在相同指纹, 更新 (取更好的答案); 否则新增
   */
  record(entry: Omit<ExperienceRecord, 'fingerprint' | 'normalizedPrompt' | 'reuseCount' | 'successRate' | 'createdAt' | 'lastUsedAt'> & { prompt: string }): void {
    const normalized = ExperienceCache.normalize(entry.prompt);
    const fp = ExperienceCache.fingerprint(normalized);
    const existing = this.cache.get(fp);

    if (existing) {
      // 已存在: 只在新答案 token 更省或成功率更高时更新
      if (entry.tokenCost < existing.tokenCost * 0.8 || entry.finalAnswer.length > existing.finalAnswer.length * 1.2) {
        existing.toolSteps = entry.toolSteps;
        existing.finalAnswer = entry.finalAnswer;
        existing.tokenCost = entry.tokenCost;
        existing.durationMs = entry.durationMs;
        existing.lastUsedAt = Date.now();
      }
    } else {
      const rec: ExperienceRecord = {
        fingerprint: fp,
        normalizedPrompt: normalized,
        originalPrompt: entry.prompt.slice(0, 200),
        sourceType: 'racer_agent_loop',
        toolSteps: entry.toolSteps,
        finalAnswer: entry.finalAnswer.slice(0, 2000),
        tokenCost: entry.tokenCost,
        durationMs: entry.durationMs,
        reuseCount: 0,
        successRate: 1.0, // 新经验默认成功
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      };
      this.cache.set(fp, rec);
      logger.info('ExperienceCache', `保存经验 [${fp}] reuseCount=0 tokens=${entry.tokenCost}`);
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  /**
   * 保存 DirectLLM 简单问答结果到轻量级 QA 缓存
   *
   * 设计原则:
   * - 只缓存短 prompt (<200 字符), 避免复杂任务误入
   * - 默认置信度 0.8 (低于 RACER 的 1.0), 保守复用
   * - 截断答案长度 (1500 字符), 节省存储
   * - 加 qa_ 前缀的指纹, 区分 RACER 与 DirectLLM 来源
   *
   * @param prompt 用户原始输入
   * @param answer LLM 回复内容
   * @param tokenCost 消耗的 token 数
   * @param durationMs 耗时 (毫秒)
   */
  saveDirectLLMQA(
    prompt: string,
    answer: string,
    tokenCost: number,
    durationMs: number,
  ): void {
    const normalized = ExperienceCache.normalize(prompt);

    // 过滤: 只缓存短问答 (2-200 字符)
    if (normalized.length > 200 || normalized.length < 2) {
      return;
    }

    const fp = `qa_${ExperienceCache.fingerprint(normalized)}`;
    const existing = this.cache.get(fp);

    if (existing) {
      // 已有记录 → 更新答案 + 增加复用计数
      existing.finalAnswer = answer.slice(0, 1500);
      existing.reuseCount += 1;
      existing.lastUsedAt = Date.now();
    } else {
      // 新记录
      const qaRecord: ExperienceRecord = {
        fingerprint: fp,
        normalizedPrompt: normalized,
        originalPrompt: prompt.slice(0, 200),
        sourceType: 'direct_llm_qa',
        toolSteps: [],
        finalAnswer: answer.slice(0, 1500),
        tokenCost,
        durationMs,
        reuseCount: 0,
        successRate: 0.8, // QA 默认置信度低于 RACER
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      };
      this.cache.set(fp, qaRecord);
    }

    this.dirty = true;
    this.scheduleFlush();
  }

  /** 记录经验被复用 (复用后调用, 更新使用统计) */
  recordReuse(fingerprint: string, success: boolean): void {
    const rec = this.cache.get(fingerprint);
    if (!rec) return;
    rec.reuseCount++;
    rec.lastUsedAt = Date.now();
    // 滑动窗口更新成功率 (👎 显著拉低, 多次 👍 缓慢提升)
    rec.successRate = rec.successRate * 0.85 + (success ? 0.15 : 0);
    this.dirty = true;

    // ── 降级失效: 解决"LLM 回答错误仍保存记忆, 越做越错"的弊端 ──
    // 用户 👎 反馈 → successRate 持续下降 → 低于 0.3 自动删除
    // 删除后下次该问题会重新走 RACER Agent Loop, 重新解决并保存新经验
    if (rec.successRate < 0.3) {
      this.cache.delete(fingerprint);
      logger.warn('ExperienceCache', `经验 [${fingerprint}] 因 successRate=${rec.successRate.toFixed(2)} < 0.3 已失效删除 (避免越做越错)`);
    } else {
      logger.info('ExperienceCache', `经验 [${fingerprint}] 反馈 success=${success} → successRate=${rec.successRate.toFixed(2)} reuse=${rec.reuseCount}`);
    }
    this.scheduleFlush();
  }

  /**
   * 直接对经验打分 (不增加 reuseCount, 仅调整 successRate)
   * 用于用户对"首次保存的经验"本身打 👍/👎
   * 返回 true 表示经验仍有效, false 表示已失效删除
   */
  rateExperience(fingerprint: string, positive: boolean): boolean {
    const rec = this.cache.get(fingerprint);
    if (!rec) return false;
    // 👍: 向 1.0 靠拢; 👎: 向 0.0 靠拢 (步长 0.25, 3-4 次 👎 即可淘汰)
    const delta = positive ? 0.25 : -0.25;
    rec.successRate = Math.max(0, Math.min(1, rec.successRate + delta));
    rec.lastUsedAt = Date.now();
    this.dirty = true;

    if (rec.successRate < 0.3) {
      this.cache.delete(fingerprint);
      logger.warn('ExperienceCache', `经验 [${fingerprint}] 用户 👎 → successRate=${rec.successRate.toFixed(2)} < 0.3 已失效删除`);
      this.scheduleFlush();
      return false;
    }
    logger.info('ExperienceCache', `经验 [${fingerprint}] 用户 ${positive ? '👍' : '👎'} → successRate=${rec.successRate.toFixed(2)}`);
    this.scheduleFlush();
    return true;
  }

  /** 根据问题文本查找 fingerprint (供前端反馈时定位经验) */
  findFingerprint(prompt: string): string | null {
    const normalized = ExperienceCache.normalize(prompt);
    const fp = ExperienceCache.fingerprint(normalized);
    if (this.cache.has(fp)) return fp;
    // DirectLLM QA 经验 (qa_ 前缀)
    const qaFp = `qa_${fp}`;
    if (this.cache.has(qaFp)) return qaFp;
    // 模糊查找
    const lookup = this.lookup(prompt);
    return lookup ? lookup.record.fingerprint : null;
  }

  /** 获取缓存大小 */
  size(): number {
    return this.cache.size;
  }

  /** 获取所有经验 (用于统计/调试) */
  getAll(): ExperienceRecord[] {
    return [...this.cache.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }
}
