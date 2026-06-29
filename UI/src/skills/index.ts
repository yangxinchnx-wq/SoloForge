/**
 * SoloForge Skill Engine — 入口(UI 端)
 *
 * 默认路径(相对 cwd = UI/):
 *   bundledDir   = resources/skills/         (与 resources/tools/manifest.json 同级,用户拖拽即用)
 *   managedDir   = ~/.soloforge/skills/      (跨项目共享,用户安装的 skill)
 *   workspaceDir = ./.soloforge/skills/      (项目级临时 skill)
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { SkillEngine } from './engine';
import type { EngineConfig, EngineState } from './engine';
import type { SkillManifest, SkillResourceContent, SkillLoadResult } from './types';

export { SkillEngine };
export type { EngineConfig, EngineState, SkillManifest, SkillResourceContent, SkillLoadResult };
export { parseFrontmatter, validateFrontmatter, extractTriggers, FrontmatterParseError } from './frontmatter';
export { loadSkillsFromDir, parseSkillFile } from './loader';
export type { LoaderOptions, LoadResult } from './loader';

/**
 * 全局单例(惰性创建)
 */
let _engine: SkillEngine | null = null;
let _engineConfig: EngineConfig | null = null;

export interface CreateEngineOptions {
  /** 强制重建(忽略单例) */
  force?: boolean;
  /** 自定义 bundledDir(默认 resources/skills/) */
  bundledDir?: string;
  /** 自定义 managedDir(默认 ~/.soloforge/skills) */
  managedDir?: string;
  /** 自定义 workspaceDir(默认 cwd/.soloforge/skills) */
  workspaceDir?: string;
  /** 是否启用热重载(默认 true — 文件拖入即可生效) */
  hotReload?: boolean;
}

export function getSkillEngine(opts: CreateEngineOptions = {}): SkillEngine {
  if (_engine && !opts.force) return _engine;

  const projectRoot = path.resolve(process.cwd());
  const config: EngineConfig = {
    bundledDir: opts.bundledDir || path.join(projectRoot, 'resources', 'skills'),
    managedDir: opts.managedDir || path.join(os.homedir(), '.soloforge', 'skills'),
    workspaceDir: opts.workspaceDir || path.join(projectRoot, '.soloforge', 'skills'),
    hotReload: opts.hotReload ?? true,
  };

  // 确保 managed/workspace 目录存在
  for (const dir of [config.managedDir, config.workspaceDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }

  _engine = new SkillEngine(config);
  _engineConfig = config;
  _engine.refresh();
  return _engine;
}

export function getEngineConfig(): EngineConfig | null {
  return _engineConfig;
}

export function resetSkillEngine(): void {
  _engine = null;
  _engineConfig = null;
}
