/**
 * localModelName.ts — 本地 GGUF 模型友好名称生成
 *
 * GGUF 文件名通常很长: qwen2.5-0.5b-instruct-q4_k_m
 * 主模型选择器空间有限，需要缩短为: Qwen2.5 0.5B (本地 · Q4)
 *
 * 规则:
 *   1. 去掉 .gguf 扩展名
 *   2. 提取量化标签: Q4 / Q5 / Q8 / F16 等
 *   3. 去掉量化后缀: -q4_k_m, -Q4_K_M, -q8_0 等
 *   4. 去掉常见后缀: -instruct, -chat
 *   5. 连字符替换为空格
 *   6. 大小写归一化: 0.5b → 0.5B, 7b → 7B, gpt → GPT, t5 → T5
 *   7. 追加 (本地) 或 (本地 · Q4) 后缀
 */

/**
 * 从 GGUF 模型名中提取量化标签
 * q4_k_m → Q4
 * Q5_K_M → Q5
 * q8_0 → Q8
 * f16 → F16
 */
function extractQuantTag(name: string): string | null {
  // 匹配末尾的量化标记: -q4_k_m / -Q4_K_M / -q8_0 / -f16
  const match = name.match(/[-_](q\d+(?:_[a-z0-9]+)*|f\d+|bf\d+)$/i);
  if (!match) return null;
  const raw = match[1].toUpperCase();
  // Q4_K_M → Q4, F16 → F16
  return raw.split('_')[0];
}

/**
 * 去掉量化后缀和常见描述性后缀
 */
function stripSuffixes(name: string): string {
  let result = name;

  // 去掉量化后缀: -q4_k_m, -Q4_K_M, -q8_0, -f16
  result = result.replace(/[-_](q\d+(?:_[a-z0-9]+)*|f\d+|bf\d+)$/i, '');

  // 去掉 -instruct / -chat / -gguf (大小写不敏感)
  result = result.replace(/[-_](instruct|chat|gguf)$/i, '');

  return result;
}

/**
 * 大小写归一化
 * 0.5b → 0.5B, 7b → 7B
 * gpt → GPT, t5 → T5, qa → QA
 * qwen → Qwen, llama → Llama
 */
function normalizeCase(text: string): string {
  // 已知首字母缩写词 → 全大写
  const ACRONYMS = new Set(['gpt', 't5', 'qa', 'codellama', 'codet5']);
  // 已知品牌名 → 首字母大写
  const KNOWN = new Set(['qwen', 'llama', 'mistral', 'gemma', 'phi', 'yi', 'baichuan', 'chatglm', 'internlm']);

  return text
    .split(/(\s+)/) // 保留空格
    .map((word) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();

      // 处理带数字的品牌: qwen2.5 → Qwen2.5, llama3 → Llama3
      const brandMatch = lower.match(/^([a-z]+)(\d.*)?$/);
      if (brandMatch) {
        const brand = brandMatch[1];
        const rest = brandMatch[2] || '';
        if (KNOWN.has(brand)) {
          return brand.charAt(0).toUpperCase() + brand.slice(1) + rest.toUpperCase().replace(/B(?=\d|$)/g, 'b');
        }
      }

      // 大小写标记: 0.5b → 0.5B, 7b → 7B, 13b → 13B
      const sizeMatch = word.match(/^(\d+(?:\.\d+)?)(b)$/i);
      if (sizeMatch) return sizeMatch[1] + 'B';

      // 普通单词 → 首字母大写
      if (/^[a-z]/.test(word)) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      }
      return word;
    })
    .join('');
}

/**
 * 将 GGUF 模型文件名转换为友好的短显示名称
 *
 * @param modelPathOrName 模型文件名或路径 (如 "qwen2.5-0.5b-instruct-q4_k_m" 或 "C:/models/qwen.gguf")
 * @returns 友好名称 (如 "Qwen2.5 0.5B (本地 · Q4)")
 */
export function toLocalModelDisplayName(modelPathOrName: string): string {
  // 提取文件名 (去掉路径和 .gguf 扩展名)
  const filename = modelPathOrName
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.gguf$/i, '');

  const quantTag = extractQuantTag(filename);
  const baseName = stripSuffixes(filename);

  // 连字符替换为空格
  const spaced = baseName.replace(/[-_]/g, ' ').trim();
  const normalized = normalizeCase(spaced);

  // 组装最终名称
  if (quantTag) {
    return `${normalized} (本地 · ${quantTag})`;
  }
  return `${normalized} (本地)`;
}

/**
 * 生成用于 cherry_providers_v2 的 model id
 * 与 toLocalModelDisplayName 相同，因为 id 就是显示名
 */
export function toLocalModelId(modelPathOrName: string): string {
  return toLocalModelDisplayName(modelPathOrName);
}
