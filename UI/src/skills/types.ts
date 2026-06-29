/**
 * SoloForge Skill Engine — 类型定义
 * 遵循 Anthropic Agent Skills 规范的三级渐进披露架构
 *
 * Level 1: Metadata (name + description + 触发短语) — 常驻 system prompt
 * Level 2: SKILL.md body — 触发时按需加载
 * Level 3: Resources (scripts/ references/ assets/) — 执行时按需加载
 */

export interface SkillFrontmatter {
  /** 唯一标识,kebab-case (lowercase letters, numbers, hyphens) */
  name: string;
  /** 何时使用 + 触发短语(≤1024 字符) */
  description: string;
  /** 可选:许可证 */
  license?: string;
  /** 可选:环境要求(1-500 字符) */
  compatibility?: string;
  /** 可选:自定义元数据 */
  metadata?: Record<string, string>;
  /** 可选:此 skill 允许调用的 tool 名称列表 */
  allowedTools?: string[];
  /** 可选:禁止的 tool */
  disallowedTools?: string[];
}

export interface SkillResourceRef {
  /** 资源名(相对 skill 目录) */
  name: string;
  /** 资源类型 */
  type: 'script' | 'reference' | 'asset';
  /** 资源子目录(默认为 scripts/ references/ assets/) */
  dir: string;
  /** 文件大小(bytes) */
  size: number;
}

export interface SkillManifest {
  /** 唯一 id(与 frontmatter.name 相同) */
  id: string;
  /** 显示名称(中文) */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 触发短语列表(从 description 中提取) */
  triggers: string[];
  /** 分组 */
  group: string;
  /** 允许的工具列表 */
  allowedTools: string[];
  /** 完整 SKILL.md 正文(去除 frontmatter 后) */
  body: string;
  /** 资源列表 */
  resources: SkillResourceRef[];
  /** 来源:bundled(内置)/ managed(用户管理)/ workspace(项目) */
  source: 'bundled' | 'managed' | 'workspace';
  /** 磁盘上的绝对路径 */
  path: string;
}

export interface SkillResourceContent {
  skillId: string;
  resourceName: string;
  type: 'script' | 'reference' | 'asset';
  /** 文本资源用 utf-8,二进制用 base64 */
  encoding: 'utf-8' | 'base64';
  content: string;
  size: number;
}

export interface SkillLoadResult {
  /** 是否成功 */
  ok: boolean;
  /** 错误信息 */
  error?: string;
  /** 成功时返回的 manifest */
  manifest?: SkillManifest;
  /** 成功时返回的 body */
  body?: string;
}
