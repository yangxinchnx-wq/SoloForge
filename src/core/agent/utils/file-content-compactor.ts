// ─────────────────────────────────────────────────────────────────
// 文件内容增量压缩 (P4: 替换 slice(0, 4000) 硬截断)
// Path: src/core/agent/utils/file-content-compactor.ts
//
// 目标: 智能截断长文件, 保留关键信息 (头尾 + 函数签名)
// 策略:
//   1. 短文件 (≤4000 字符): 原样返回
//   2. 长文件: 头部 1500 + 尾部 1000 + 中间函数/类签名
//
// 对比 slice(0, 4000):
//   - 原方案: 只看头部, 丢失 export/return 等关键尾部信息
//   - 新方案: 保留头尾 + 提取结构, LLM 能理解完整文件骨架
// ─────────────────────────────────────────────────────────────────

/** 压缩配置 */
interface CompactConfig {
  /** 总预算 (字符数) */
  budget: number;
  /** 头部保留比例 */
  headRatio: number;
  /** 尾部保留比例 */
  tailRatio: number;
  /** 中间签名提取比例 */
  signatureRatio: number;
}

/** 默认配置: 4000 字符预算 */
const DEFAULT_CONFIG: CompactConfig = {
  budget: 4000,
  headRatio: 0.375,  // 1500 字符
  tailRatio: 0.25,   // 1000 字符
  signatureRatio: 0.375, // 1500 字符 (用于签名)
};

/**
 * 提取代码结构签名 (函数/类/导出)
 * 轻量级正则匹配, 不做完整 AST 解析
 */
function extractSignatures(content: string, budget: number): string {
  const signatures: string[] = [];

  // 匹配模式 (按优先级):
  // 1. export default function/class
  // 2. export function/class/const
  // 3. function/class 声明
  // 4. interface/type 声明
  const patterns = [
    /export\s+default\s+(?:async\s+)?function\s+\w+/g,
    /export\s+default\s+class\s+\w+/g,
    /export\s+(?:async\s+)?function\s+\w+/g,
    /export\s+class\s+\w+/g,
    /export\s+const\s+\w+\s*=/g,
    /(?:async\s+)?function\s+\w+/g,
    /class\s+\w+/g,
    /interface\s+\w+/g,
    /type\s+\w+\s*=/g,
  ];

  const seen = new Set<string>();
  let totalLen = 0;

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(content)) !== null) {
      const sig = match[0];
      if (seen.has(sig)) continue;
      seen.add(sig);

      // 提取该行 (包含参数和返回类型)
      const lineEnd = content.indexOf('\n', match.index);
      const line = lineEnd > 0
        ? content.slice(match.index, lineEnd).trim()
        : sig;

      if (totalLen + line.length + 1 > budget) break;
      signatures.push(line);
      totalLen += line.length + 1;
    }
    if (totalLen >= budget) break;
  }

  return signatures.join('\n');
}

/**
 * 智能截断文件内容
 *
 * @param content 文件完整内容
 * @param fileName 文件名 (用于日志)
 * @param config 压缩配置
 * @returns 压缩后的内容 (带省略标记)
 */
export function compactFileContent(
  content: string,
  _fileName?: string,
  config: CompactConfig = DEFAULT_CONFIG,
): string {
  // 短文件: 原样返回
  if (content.length <= config.budget) {
    return content;
  }

  const headBudget = Math.floor(config.budget * config.headRatio);
  const tailBudget = Math.floor(config.budget * config.tailRatio);
  const sigBudget = Math.floor(config.budget * config.signatureRatio);

  const head = content.slice(0, headBudget);
  const tail = content.slice(content.length - tailBudget);
  const signatures = extractSignatures(content, sigBudget);

  const parts: string[] = [head];

  if (signatures.length > 0) {
    parts.push(`\n// ... [签名提取] ...\n${signatures}`);
  }

  parts.push(`\n// ... [省略 ${content.length - headBudget - tailBudget} 字符] ...\n`);
  parts.push(tail);

  return parts.join('');
}

/**
 * 按文件类型选择预算
 * (代码文件需要更多上下文, 配置文件可以更紧凑)
 */
export function getBudgetForFile(fileName: string): number {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';

  // 代码文件: 标准 4000 预算
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'cs'].includes(ext)) {
    return 4000;
  }

  // 配置文件: 2000 预算 (通常结构简单)
  if (['json', 'yaml', 'yml', 'toml', 'ini', 'env'].includes(ext)) {
    return 2000;
  }

  // 样式文件: 3000 预算
  if (['css', 'scss', 'less', 'html', 'vue', 'svelte'].includes(ext)) {
    return 3000;
  }

  // 文档: 2000 预算
  if (['md', 'txt', 'rst'].includes(ext)) {
    return 2000;
  }

  return 4000;
}
