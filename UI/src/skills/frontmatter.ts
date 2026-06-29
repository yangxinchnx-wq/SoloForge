/**
 * 极简 YAML frontmatter 解析器
 * 仅支持 Skill frontmatter 所需的子集:
 *   - 字符串: name: foo
 *   - 字符串列表(空格分隔): triggers: a b c / allowedTools: Read Grep Glob
 *   - 嵌套映射(仅 metadata): metadata:\n  author: x\n  version: 1.0
 *
 * 不追求完整 YAML 1.2 兼容 — Anthropic SKILL.md 的实际写法都是平铺或一级缩进。
 */

export interface ParsedFrontmatter {
  data: Record<string, any>;
  body: string;
  raw: string;
}

const VALID_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * 应当被解析为字符串数组的 frontmatter key
 * (YAML inline 列表形式: a b c)
 */
const INLINE_LIST_KEYS = new Set([
  'allowedTools',
  'disallowedTools',
  'triggers',
  'tags',
  'tools',
]);

export class FrontmatterParseError extends Error {
  constructor(message: string, public line?: number) {
    super(message);
    this.name = 'FrontmatterParseError';
  }
}

/**
 * 解析 SKILL.md 文件(必须是 --- 开头、--- 结尾的 frontmatter + markdown body)
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  // 统一换行符
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 校验:必须以 --- 开头(允许前导空白行,通常不允许)
  if (!normalized.startsWith('---')) {
    // 无 frontmatter 视为合法空 frontmatter
    return { data: {}, body: content, raw: '' };
  }

  const lines = normalized.split('\n');
  if (lines[0].trim() !== '---') {
    throw new FrontmatterParseError('首行必须是 --- 起始标记');
  }

  // 找到结束 --- (从第 2 行开始)
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new FrontmatterParseError('未找到结束标记 ---');
  }

  const rawFrontmatter = lines.slice(1, endIdx).join('\n');
  const body = lines.slice(endIdx + 1).join('\n').replace(/^\n+/, '');

  // 解析 YAML 子集
  const data: Record<string, any> = {};
  const stack: Array<{ indent: number; obj: Record<string, any>; key?: string }> = [
    { indent: -1, obj: data }
  ];

  for (let i = 0; i < lines.length - (lines.length - endIdx); i++) {
    const line = lines[i + 1] ?? '';
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    const content = line.slice(indent);

    // 弹出过深的栈
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];

    if (content.startsWith('- ')) {
      // 列表项 - 简化为空格分隔的 inline 列表
      continue;
    }

    const colonIdx = content.indexOf(':');
    if (colonIdx === -1) continue;

    const key = content.slice(0, colonIdx).trim();
    let value: any = content.slice(colonIdx + 1).trim();

    if (value === '' || value === '|' || value === '>') {
      // 嵌套对象开始
      const nested: Record<string, any> = {};
      top.obj[key] = nested;
      stack.push({ indent, obj: nested, key });
      continue;
    }

    // 去除引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // 数字
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      value = Number(value);
    }
    // 布尔
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    // inline 列表(空格分隔的 token) - 仅对 list 类型的 key
    // 同时匹配 kebab 和 camel 形式(因为可能在 normalizeKeys 之前)
    else if ((INLINE_LIST_KEYS.has(key) || INLINE_LIST_KEYS.has(toCamel(key))) && /^\S+(?:\s\S+)+$/.test(value)) {
      value = value.split(/\s+/).filter(Boolean);
    }

    top.obj[key] = value;
  }

  return { data: normalizeKeys(data), body, raw: rawFrontmatter };
}

/**
 * kebab-case → camelCase(单个 key)
 */
function toCamel(kebab: string): string {
  return kebab.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * 规范化 key:kebab-case → camelCase(处理嵌套对象)
 * 例如: allowed-tools → allowedTools
 */
function normalizeKeys(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const camel = toCamel(k);
    out[camel] = (v && typeof v === 'object' && !Array.isArray(v)) ? normalizeKeys(v) : v;
  }
  return out;
}

/**
 * 校验 frontmatter 数据是否符合 Anthropic Skills 规范
 */
export function validateFrontmatter(data: Record<string, any>, skillPath?: string): void {
  if (!data.name) {
    throw new FrontmatterParseError(`缺少必填字段 'name'${skillPath ? ` (${skillPath})` : ''}`);
  }
  if (typeof data.name !== 'string' || !VALID_NAME.test(data.name)) {
    throw new FrontmatterParseError(
      `name 必须是 kebab-case(小写字母/数字/连字符),实际: "${data.name}"`
    );
  }
  if (!data.description) {
    throw new FrontmatterParseError(`缺少必填字段 'description'`);
  }
  if (typeof data.description !== 'string') {
    throw new FrontmatterParseError(`description 必须是字符串`);
  }
  if (data.description.length > 1024) {
    throw new FrontmatterParseError(
      `description 不能超过 1024 字符(实际 ${data.description.length})`
    );
  }
  if (data.compatibility && (typeof data.compatibility !== 'string' || data.compatibility.length > 500)) {
    throw new FrontmatterParseError(`compatibility 必须是 1-500 字符的字符串`);
  }
  if (data.allowedTools && !Array.isArray(data.allowedTools)) {
    throw new FrontmatterParseError(`allowedTools 必须是字符串数组`);
  }
  if (data.disallowedTools && !Array.isArray(data.disallowedTools)) {
    throw new FrontmatterParseError(`disallowedTools 必须是字符串数组`);
  }
}

/**
 * 从 description 中启发式提取触发短语
 * 匹配 "Use when ..." / "Use this when ..." / "... triggers: ..." 等模式
 */
export function extractTriggers(description: string): string[] {
  const triggers: string[] = [];
  const lower = description.toLowerCase();

  // 提取 "Use when ..." 后的内容
  const useWhenMatch = description.match(/[Uu]se (?:this )?when\s+(?:the user |user )?(?:asks?|wants?|mentions?|requests?)?\s*["']?([^"'.\n]+)/);
  if (useWhenMatch) {
    triggers.push(...splitTriggerPhrase(useWhenMatch[1]));
  }

  // 提取 "Triggers include: ..."
  const triggersMatch = description.match(/[Tt]riggers? include:?\s*([^\n]+)/);
  if (triggersMatch) {
    const list = triggersMatch[1].split(/[,;]/).map(s => s.trim().replace(/^["']|["']$/g, ''));
    triggers.push(...list.filter(Boolean));
  }

  // 提取引号或方括号中的关键词
  const quoted = description.match(/["']([^"']{2,30})["']/g) || [];
  quoted.forEach(q => triggers.push(q.slice(1, -1)));

  // 去重 + 过滤太短/太长
  return Array.from(new Set(triggers
    .map(t => t.trim())
    .filter(t => t.length >= 2 && t.length <= 40)
  )).slice(0, 8);
}

function splitTriggerPhrase(phrase: string): string[] {
  // 按 "or" / "/" / 逗号 分割
  return phrase
    .split(/\s+or\s+|\s*\/\s*|,\s*/)
    .map(s => s.trim().replace(/^["']|["']$/g, ''))
    .filter(s => s.length >= 2 && s.length <= 40);
}
