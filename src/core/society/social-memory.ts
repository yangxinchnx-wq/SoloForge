// ─────────────────────────────────────────────────────────────────
// SoloForge AI Society Layer: Social Memory (社会记忆)
// Path: src/core/society/social-memory.ts
// Description: 集体经历的共同记忆，防止群体重复踩坑
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';

export type MemorySeverity = 'low' | 'medium' | 'high' | 'critical';
export type MemoryImpact = 'positive' | 'negative' | 'neutral';

/**
 * 社会记忆记录
 */
export interface SocialMemory {
  id: string;
  event: string;                    // 事件描述
  impact: MemoryImpact;             // 影响类型
  severity: MemorySeverity;         // 严重度
  participants: string[];           // 参与的 Agent
  lessons: string[];               // 经验教训
  keywords: string[];              // 关键词（用于检索）
  metadata: Record<string, any>;   // 扩展元数据
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/**
 * 社会记忆管理器
 */
export class SocialMemoryManager {
  private memories: Map<string, SocialMemory> = new Map();
  private keywordIndex: Map<string, Set<string>> = new Map();  // 关键词 -> 记忆ID集合

  constructor() {}

  /**
   * 创建记忆
   */
  public create(data: {
    event: string;
    impact: MemoryImpact;
    severity: MemorySeverity;
    participants?: string[];
    lessons?: string[];
    metadata?: Record<string, any>;
  }): SocialMemory {
    const id = `mem_${ulid()}`;
    const now = Date.now();

    // 提取关键词
    const keywords = this.extractKeywords(data.event);

    const memory: SocialMemory = {
      id,
      event: data.event,
      impact: data.impact,
      severity: data.severity,
      participants: data.participants || [],
      lessons: data.lessons || [],
      keywords,
      metadata: data.metadata || {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };

    this.memories.set(id, memory);

    // 更新关键词索引
    for (const keyword of keywords) {
      if (!this.keywordIndex.has(keyword)) {
        this.keywordIndex.set(keyword, new Set());
      }
      this.keywordIndex.get(keyword)!.add(id);
    }

    console.log(`[SocialMemory] 创建记忆: ${id} - ${data.event.substring(0, 50)}...`);

    return memory;
  }

  /**
   * 从关键词提取记忆
   */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      '的', '了', '是', '在', '和', '与', '或', '但', '也', '这', '那', '有', '被',
      'the', 'a', 'an', 'is', 'was', 'were', 'and', 'or', 'but', 'in', 'on', 'at',
      'to', 'for', 'of', 'with', 'by', 'from'
    ]);

    // 处理中文字符：按每个字符分割
    const allWords: string[] = [];

    // 提取英文单词
    const englishPart = text.replace(/[\u4e00-\u9fff]/g, ' ');
    const englishWords = englishPart
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !stopWords.has(w));
    allWords.push(...englishWords);

    // 提取中文词（每2-4个字符作为一个词）
    const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
    for (let i = 0; i < chineseChars.length; i++) {
      // 2字词
      if (i + 1 < chineseChars.length) {
        const word2 = chineseChars[i] + chineseChars[i + 1];
        if (!stopWords.has(word2)) allWords.push(word2);
      }
      // 3字词
      if (i + 2 < chineseChars.length) {
        const word3 = chineseChars[i] + chineseChars[i + 1] + chineseChars[i + 2];
        if (!stopWords.has(word3)) allWords.push(word3);
      }
    }

    // 统计词频
    const freq: Record<string, number> = {};
    for (const w of allWords) {
      freq[w] = (freq[w] || 0) + 1;
    }

    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([w]) => w);
  }

  /**
   * 获取记忆
   */
  public get(id: string): SocialMemory | undefined {
    const mem = this.memories.get(id);
    if (mem && !mem.deletedAt) return mem;
    return undefined;
  }

  /**
   * 搜索相似记忆
   */
  public search(query: string, options?: {
    topK?: number;
    severity?: MemorySeverity[];
    impact?: MemoryImpact[];
  }): Array<{ memory: SocialMemory; relevance: number }> {
    const queryKeywords = this.extractKeywords(query);
    const results: Array<{ memory: SocialMemory; relevance: number }> = [];

    for (const mem of this.memories.values()) {
      if (mem.deletedAt) continue;

      // 过滤条件
      if (options?.severity && !options.severity.includes(mem.severity)) continue;
      if (options?.impact && !options.impact.includes(mem.impact)) continue;

      // 计算相关性（基于关键词重叠）
      let matchCount = 0;
      for (const qk of queryKeywords) {
        if (mem.keywords.includes(qk) || mem.event.toLowerCase().includes(qk)) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        const relevance = matchCount / Math.max(queryKeywords.length, mem.keywords.length);
        results.push({ memory: mem, relevance });
      }
    }

    // 按相关性排序
    results.sort((a, b) => b.relevance - a.relevance);

    return results.slice(0, options?.topK || 10);
  }

  /**
   * 按严重度查询
   */
  public getBySeverity(severity: MemorySeverity): SocialMemory[] {
    return Array.from(this.memories.values())
      .filter(m => !m.deletedAt && m.severity === severity)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 按参与者查询
   */
  public getByParticipant(participant: string): SocialMemory[] {
    return Array.from(this.memories.values())
      .filter(m => !m.deletedAt && m.participants.includes(participant))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 获取负面经验教训
   */
  public getNegativeLessons(): string[] {
    const lessons: string[] = [];
    for (const mem of this.memories.values()) {
      if (!mem.deletedAt && mem.impact === 'negative') {
        lessons.push(...mem.lessons);
      }
    }
    return lessons;
  }

  /**
   * 更新记忆
   */
  public update(id: string, updates: Partial<SocialMemory>): SocialMemory | undefined {
    const mem = this.memories.get(id);
    if (!mem || mem.deletedAt) return undefined;

    const updated: SocialMemory = {
      ...mem,
      ...updates,
      id: mem.id,
      createdAt: mem.createdAt,
      updatedAt: Date.now()
    };

    this.memories.set(id, updated);
    return updated;
  }

  /**
   * 删除记忆
   */
  public delete(id: string): boolean {
    const mem = this.memories.get(id);
    if (!mem || mem.deletedAt) return false;

    mem.deletedAt = Date.now();
    return true;
  }

  /**
   * 获取统计
   */
  public stats(): {
    total: number;
    bySeverity: Record<string, number>;
    byImpact: Record<string, number>;
    totalLessons: number;
  } {
    const all = Array.from(this.memories.values()).filter(m => !m.deletedAt);
    const bySeverity: Record<string, number> = {};
    const byImpact: Record<string, number> = {};
    let totalLessons = 0;

    for (const mem of all) {
      bySeverity[mem.severity] = (bySeverity[mem.severity] || 0) + 1;
      byImpact[mem.impact] = (byImpact[mem.impact] || 0) + 1;
      totalLessons += mem.lessons.length;
    }

    return {
      total: all.length,
      bySeverity,
      byImpact,
      totalLessons
    };
  }

  /**
   * 获取所有有效记忆
   */
  public getAll(): SocialMemory[] {
    return Array.from(this.memories.values()).filter(m => !m.deletedAt);
  }
}

// 导出单例
export const socialMemoryManager = new SocialMemoryManager();
export default socialMemoryManager;
