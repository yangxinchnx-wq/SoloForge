/**
 * Skill Loader — 扫描目录、解析 SKILL.md、构建 SkillManifest
 * 支持多源加载:bundled / managed / workspace
 */

import fs from 'fs';
import path from 'path';
import { SkillManifest, SkillResourceRef, SkillFrontmatter } from './types';
import { parseFrontmatter, validateFrontmatter, extractTriggers } from './frontmatter';

export interface LoaderOptions {
  /** 技能目录根路径 */
  skillsDir: string;
  /** 来源标签 */
  source: 'bundled' | 'managed' | 'workspace';
  /** 扫描深度(默认 3) */
  maxDepth?: number;
  /** 是否跳过解析失败的文件(默认 true,记录到 errors) */
  skipOnError?: boolean;
}

export interface LoadResult {
  manifests: SkillManifest[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * 扫描指定目录,加载所有 SKILL.md
 */
export function loadSkillsFromDir(options: LoaderOptions): LoadResult {
  const { skillsDir, source, maxDepth = 3, skipOnError = true } = options;
  const result: LoadResult = { manifests: [], errors: [] };

  if (!fs.existsSync(skillsDir)) {
    return result;
  }

  const stat = fs.statSync(skillsDir);
  if (!stat.isDirectory()) {
    return result;
  }

  walk(skillsDir, 0, maxDepth, (skillDir) => {
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) return;

    try {
      const manifest = parseSkillFile(skillMdPath, skillDir, source);
      if (manifest) {
        result.manifests.push(manifest);
      }
    } catch (err: any) {
      const error = `${err.message}`;
      if (skipOnError) {
        result.errors.push({ path: skillMdPath, error });
      } else {
        throw err;
      }
    }
  });

  return result;
}

function walk(dir: string, depth: number, maxDepth: number, onSkillDir: (dir: string) => void): void {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const sub = path.join(dir, entry.name);
    onSkillDir(sub);
    walk(sub, depth + 1, maxDepth, onSkillDir);
  }
}

/**
 * 解析单个 SKILL.md 文件,返回 SkillManifest
 */
export function parseSkillFile(skillMdPath: string, skillDir: string, source: SkillManifest['source']): SkillManifest | null {
  const content = fs.readFileSync(skillMdPath, 'utf-8');
  const { data, body } = parseFrontmatter(content);
  validateFrontmatter(data, skillMdPath);

  const fm = data as SkillFrontmatter;
  const triggers = extractTriggers(fm.description);
  const resources = scanResources(skillDir);

  // group: 优先 metadata.group,否则从目录名推断
  const group = (fm.metadata?.group as string) || inferGroupFromPath(skillDir);

  // 中文名: 优先 metadata.name-zh (normalizeKeys 已转为 nameZh),否则用 name
  const name = (fm.metadata?.nameZh as string) || humanizeName(fm.name);

  return {
    id: fm.name,
    name,
    description: fm.description,
    triggers,
    group,
    allowedTools: fm.allowedTools || [],
    body,
    resources,
    source,
    path: skillDir,
  };
}

function scanResources(skillDir: string): SkillResourceRef[] {
  const refs: SkillResourceRef[] = [];
  const dirs: Array<{ dir: string; type: SkillResourceRef['type'] }> = [
    { dir: 'scripts', type: 'script' },
    { dir: 'references', type: 'reference' },
    { dir: 'assets', type: 'asset' },
  ];

  for (const { dir, type } of dirs) {
    const fullDir = path.join(skillDir, dir);
    if (!fs.existsSync(fullDir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(fullDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const fullPath = path.join(fullDir, name);
      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        continue;
      }
      refs.push({ name, type, dir, size });
    }
  }
  return refs;
}

function inferGroupFromPath(skillDir: string): string {
  // 如果父目录是分组(如 skills/programming/code-review → group: programming)
  const parent = path.basename(path.dirname(skillDir));
  if (parent && parent !== 'skills' && parent !== 'bundled' && parent !== 'managed' && parent !== 'workspace') {
    return parent;
  }
  return '通用';
}

function humanizeName(kebab: string): string {
  // kebab-case → 中文 fallback
  return kebab.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
}
