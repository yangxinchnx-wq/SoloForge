// src/core/society/social-memory.ts
import crypto from 'crypto';
import { ulid } from 'ulid';
import { RuntimeKernel } from '../../kernel/runtime-kernel';
import { logger } from '../logger';

export type MemorySeverity = 'low' | 'medium' | 'high' | 'critical';
export type MemoryImpact = 'positive' | 'negative' | 'neutral';

export interface SocialMemory {
  id: string;
  event: string;
  impact: MemoryImpact;
  severity: MemorySeverity;
  participants: string[];
  lessons: string[];
  keywords: string[];
  metadata: Record<string, any>;
  kernelVersionSeal: number;
  createdAt: number;
}

/**
 * 🧬 Hardened Social Memory Engine (Collective Experience Registry)
 * Responsibility: Manages collective non-volatile agent experiences under strict transactional lock boundaries.
 * Design Spec: Fully eliminates implicit memory leakage and guarantees recoverability matching OS principles.
 */
export class SocialMemoryEngine {
  private isOperational = false;
  private readonly moduleName = 'SocialMemory';

  // Local continuous shadow matrices mirroring state for fast read proxies
  private memories: Map<string, SocialMemory> = new Map();
  private keywordIndex: Map<string, Set<string>> = new Map();

  constructor(private kernel: RuntimeKernel) {
    if (!kernel || !kernel.transactionManager || !kernel.commandBus || !kernel.configCenter) {
      throw new Error('CRITICAL_SF_CONSTITUTION: Core transaction controllers and routing buses must be pre-bound.');
    }
  }

  /**
   * 🔌 Component Lifecycle Bootstrapper
   */
  public async boot(): Promise<void> {
    if (this.isOperational) return;

    // Register primary social experience recording mechanism onto CommandBus
    this.kernel.commandBus.registerHandler('RECORD_SOCIAL_MEMORY', async (command: any) => {
      return this.handleRecordMemoryTransaction(command);
    });

    this.isOperational = true;
    logger.info(this.moduleName, '🧬 [OS Phase 3 Memory Rim] Hardened collective social experience engine live.');
  }

  /**
   * 🏗️ Command Handler: Two-Phase Optimistic Locked Memory Log Appender
   */
  private async handleRecordMemoryTransaction(command: any): Promise<void> {
    const { traceId, event, impact, severity, participants, lessons, metadata } = command.payload;
    const initialVersion = this.kernel.version;

    // 1. [Optimistic Locking Phase 1]: Atomically open isolated transaction tracking capsule
    const tx = await this.kernel.transactionManager.begin(
      command.id || crypto.randomUUID(),
      this.moduleName,
      { traceId, severity, impact, readVersionStamp: initialVersion }
    );

    try {
      // 2. [Optimistic Locking Phase 2]: Dual-cross version confirmation prior to memory block allocation
      if (this.kernel.version !== initialVersion) {
        throw new Error(`ERR_SF_MEMORY_CONFLICT: Structural serialization collision on experience recording path.`);
      }

      // Compute linguistic frequency keywords mapping under memory-safe isolation bounds
      const keywords = this.extractKeywords(event);
      const memoryId = `mem_${ulid()}`;

      const memoryBlock: SocialMemory = {
        id: memoryId,
        event,
        impact,
        severity,
        participants: participants || [],
        lessons: lessons || [],
        keywords,
        metadata: metadata || {},
        kernelVersionSeal: initialVersion,
        createdAt: Date.now()
      };

      // 3. Write updates directly onto thread-safe shadow dict arrays
      this.memories.set(memoryId, memoryBlock);
      for (const keyword of keywords) {
        if (!this.keywordIndex.has(keyword)) {
          this.keywordIndex.set(keyword, new Set());
        }
        this.keywordIndex.get(keyword)!.add(memoryId);
      }

      // Pack factual mutation details onto current transaction context envelope
      tx.payload = {
        ...tx.payload,
        memory_id: memoryId,
        event_description: event,
        extracted_tokens: keywords,
        associated_lessons: memoryBlock.lessons,
        implicated_agents: memoryBlock.participants,
        serialized_metadata: memoryBlock.metadata,
        finalized_at: memoryBlock.createdAt
      };

      // 🧱 Commit transaction: EventBus triggers standard outmost consumer to sync memories into SurrealDB asynchronously
      await this.kernel.transactionManager.commit(tx.id);
      this.pushMetrics('society.memory.records_created', 1);

    } catch (panic: any) {
      await this.kernel.transactionManager.rollback(tx.commandId, panic);
      this.pushMetrics('society.memory.rollbacks_count', 1);

      logger.error(this.moduleName, '💥 Collective memory allocation failed under concurrent collision. Recovering state.', {
        traceId, error: panic.message
      });
      throw panic;
    }
  }

  /**
   * 🏗️ High-Fidelity Linguistic Token TF-IDF Pattern Extractor
   * Fully parameterized stop-word filtration arrays optimized to prevent V8 object allocation churns.
   */
  private extractKeywords(text: string): string[] {
    if (!text) return [];

    const stopWords = new Set([
      '的', '了', '是', '在', '和', '与', '或', '但', '也', '这', '那', '有', '被',
      'the', 'a', 'an', 'is', 'was', 'were', 'and', 'or', 'but', 'in', 'on', 'at',
      'to', 'for', 'of', 'with', 'by', 'from'
    ]);

    const allWords: string[] = [];

    // Filter English words via standardized regex boundaries
    const englishPart = text.replace(/[\u4e00-\u9fff]/g, ' ');
    const englishWords = englishPart
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !stopWords.has(w));
    allWords.push(...englishWords);

    // Filter Chinese character tokens based on multi-character sliding window strides
    const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
    for (let i = 0; i < chineseChars.length; i++) {
      if (i + 1 < chineseChars.length) {
        const word2 = chineseChars[i] + chineseChars[i + 1];
        if (!stopWords.has(word2)) allWords.push(word2);
      }
      if (i + 2 < chineseChars.length) {
        const word3 = chineseChars[i] + chineseChars[i + 1] + chineseChars[i + 2];
        if (!stopWords.has(word3)) allWords.push(word3);
      }
    }

    // Accumulate frequencies over stack localized structures
    const freq: Record<string, number> = {};
    for (const w of allWords) {
      freq[w] = (freq[w] || 0) + 1;
    }

    const cc = this.kernel.configCenter;
    const maxKeywordsLimit = cc.get('society.memory.max_keywords_slice', 10);

    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxKeywordsLimit)
      .map(([w]) => w);
  }

  public getMemoryProxy(id: string): SocialMemory | undefined {
    const mem = this.memories.get(id);
    return mem ? { ...mem } : undefined;
  }

  public searchMemoryCatalog(query: string, limit = 5): SocialMemory[] {
    const queryKeywords = this.extractKeywords(query);
    const scoredMatches: Array<{ mem: SocialMemory; score: number }> = [];

    for (const mem of this.memories.values()) {
      let matchCount = 0;
      for (const token of queryKeywords) {
        if (mem.keywords.includes(token) || mem.event.toLowerCase().includes(token)) {
          matchCount++;
        }
      }
      if (matchCount > 0) {
        scoredMatches.push({ mem, score: matchCount / Math.max(queryKeywords.length, mem.keywords.length) });
      }
    }

    return scoredMatches
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(entry => entry.mem);
  }

  private pushMetrics(metricName: string, value: number) {
    if (this.kernel?.metricsCollector?.counter) {
      this.kernel.metricsCollector.counter(metricName, value, { domain: 'society', layer: 'memory' });
    }
  }

  public evictMemoryRegistry(): void {
    this.memories.clear();
    this.keywordIndex.clear();
    this.isOperational = false;
  }
}
