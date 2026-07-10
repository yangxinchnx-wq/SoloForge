// ─────────────────────────────────────────────────────────────────
// 对话历史智能裁剪 (P3: 替换固定 slice(-10) 为相关性评分)
// Path: src/core/agent/utils/history-selector.ts
//
// 目标: 基于相关性动态选择历史条目, 保留更多有效上下文
// 策略: 最近 3 条 (保证连续性) + 评分最高的 N 条 (相关性驱动)
// 上限: 10 条 (token 预算控制)
// 下限: 3 条 (即使全部不相关也保留最近 3 条)
//
// 评分维度 (轻量级, 不依赖 embedding):
//   - 实质内容 (>50 字符): +0.3
//   - 关键词重叠 (与当前 prompt): +0.4
//   - 时间新鲜度 (5 分钟内): +0.2
//   - assistant 回复 (通常更有价值): +0.1
// ─────────────────────────────────────────────────────────────────

/** 历史消息条目 */
export interface HistoryEntry {
  /** 发送方 (宽松类型, 兼容现有 history 数据结构) */
  sender: string;
  content: string;
  timestamp?: number;
}

/** 选中条目 (带评分, 用于调试) */
export interface ScoredEntry {
  entry: HistoryEntry;
  score: number;
  reason: string;
}

/** 默认配置 */
const DEFAULT_CONFIG = {
  /** 最近 N 条必保 (保证连续性) */
  recentKeep: 3,
  /** 总条目上限 */
  maxEntries: 10,
  /** 新鲜度阈值 (ms), 默认 5 分钟 */
  freshThresholdMs: 5 * 60 * 1000,
  /** 实质内容最小长度 */
  minContentLength: 50,
};

/**
 * 提取文本关键词 (简单的分词 + 去停用词)
 * 不依赖外部库, 使用空格/标点分词
 */
function extractKeywords(text: string): Set<string> {
  // 中文按字符, 英文按单词
  const words = new Set<string>();

  // 英文单词 (≥3 字符)
  const englishWords = text.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  for (const w of englishWords) {
    words.add(w);
  }

  // 中文关键词 (2-4 字符的连续中文)
  const chinesePhrases = text.match(/[\u4e00-\u9fa5]{2,4}/g) ?? [];
  for (const p of chinesePhrases) {
    words.add(p);
  }

  // 文件名/路径 (含扩展名)
  const filePaths = text.match(/\b[\w-]+\.\w{1,5}\b/g) ?? [];
  for (const f of filePaths) {
    words.add(f.toLowerCase());
  }

  return words;
}

/**
 * 计算两个关键词集合的 Jaccard 相似度
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * 对单条历史消息评分
 */
function scoreEntry(
  entry: HistoryEntry,
  promptKeywords: Set<string>,
  now: number,
  config = DEFAULT_CONFIG,
): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  // 维度 1: 实质内容 (>50 字符)
  if (entry.content.length > config.minContentLength) {
    score += 0.3;
    reasons.push('content');
  }

  // 维度 2: 关键词重叠
  const entryKeywords = extractKeywords(entry.content);
  const similarity = jaccardSimilarity(promptKeywords, entryKeywords);
  if (similarity > 0) {
    score += similarity * 0.4;
    reasons.push(`kw(${similarity.toFixed(2)})`);
  }

  // 维度 3: 时间新鲜度 (5 分钟内)
  if (entry.timestamp && (now - entry.timestamp) < config.freshThresholdMs) {
    score += 0.2;
    reasons.push('fresh');
  }

  // 维度 4: assistant 回复 (通常更有价值)
  if (entry.sender === 'assistant' || entry.sender === 'system') {
    score += 0.1;
    reasons.push(entry.sender);
  }

  return { score, reason: reasons.join('+') };
}

/**
 * 智能选择历史消息
 *
 * 策略:
 *   1. 保留最近 N 条 (保证对话连续性)
 *   2. 从剩余历史中按评分选最高的 M 条
 *   3. 总数不超过 maxEntries
 *
 * @param history 完整历史 (按时间顺序)
 * @param currentPrompt 当前用户输入
 * @param config 可选配置
 * @returns 选中的历史条目 (按原始时间顺序)
 */
export function selectRelevantHistory(
  history: HistoryEntry[],
  currentPrompt: string,
  config = DEFAULT_CONFIG,
): HistoryEntry[] {
  if (history.length <= config.recentKeep) {
    return history;
  }

  const now = Date.now();
  const promptKeywords = extractKeywords(currentPrompt);

  // 分割: 最近 N 条 + 候选池
  const recent = history.slice(-config.recentKeep);
  const candidates = history.slice(0, -config.recentKeep);

  // 对候选池评分
  const scored: ScoredEntry[] = candidates.map(entry => {
    const { score, reason } = scoreEntry(entry, promptKeywords, now, config);
    return { entry, score, reason };
  });

  // 按评分降序, 取前 (maxEntries - recentKeep) 条
  const remainingSlots = config.maxEntries - config.recentKeep;
  const topScored = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, remainingSlots));

  // 合并 recent + topScored, 按原始顺序排序
  const selected = [...recent, ...topScored.map(s => s.entry)];

  // 恢复原始时间顺序 (recent 在末尾, 但 topScored 需要插入正确位置)
  // 简单做法: 按在原 history 中的索引排序
  const selectedIndex = new Map<HistoryEntry, number>();
  history.forEach((entry, idx) => selectedIndex.set(entry, idx));
  selected.sort((a, b) => (selectedIndex.get(a) ?? 0) - (selectedIndex.get(b) ?? 0));

  return selected;
}

/**
 * 格式化历史消息为 system message 内容
 * (与现有 executeDirectLLM 中的格式保持一致)
 */
export function formatHistoryAsText(history: HistoryEntry[]): string {
  return history
    .map(h => `[${h.sender}]: ${h.content}`)
    .join('\n');
}
