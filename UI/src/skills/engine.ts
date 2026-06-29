/**
 * Skill Engine — 注册中心
 * 多源聚合 + 按 id 去重(优先级 workspace > managed > bundled)
 * + 资源懒加载 + 热重载(file mtime 检测)
 */

import fs from 'fs';
import path from 'path';
import { SkillManifest, SkillResourceContent, SkillResourceRef } from './types';
import { loadSkillsFromDir } from './loader';

export interface EngineConfig {
  /** 内置技能目录(随项目发布) */
  bundledDir: string;
  /** 用户管理目录(全局,跨项目共享)— 可选 */
  managedDir?: string;
  /** 工作区目录(项目级)— 可选 */
  workspaceDir?: string;
  /** 是否启用热重载(默认 false) */
  hotReload?: boolean;
}

export interface EngineState {
  manifests: SkillManifest[];
  errors: Array<{ path: string; error: string }>;
  /** 源优先级顺序 */
  sourceOrder: Array<'bundled' | 'managed' | 'workspace'>;
  /** 最后一次刷新时间(epoch ms) */
  lastRefresh: number;
}

export class SkillEngine {
  private config: Required<EngineConfig>;
  private state: EngineState = {
    manifests: [],
    errors: [],
    sourceOrder: ['bundled', 'managed', 'workspace'],
    lastRefresh: 0,
  };
  /** id -> file mtime,用于热重载检测 */
  private mtimeMap = new Map<string, number>();

  constructor(config: EngineConfig) {
    this.config = {
      hotReload: false,
      managedDir: '',
      workspaceDir: '',
      ...config,
    };
  }

  /**
   * 初始化:扫描所有源,合并去重
   */
  public refresh(): EngineState {
    const allManifests: SkillManifest[] = [];
    const errors: Array<{ path: string; error: string }> = [];
    const mtimeMap = new Map<string, number>();
    const seenIds = new Set<string>();

    const sources: Array<{ dir: string; source: 'bundled' | 'managed' | 'workspace' }> = [
      { dir: this.config.bundledDir, source: 'bundled' },
    ];
    if (this.config.managedDir) sources.push({ dir: this.config.managedDir, source: 'managed' });
    if (this.config.workspaceDir) sources.push({ dir: this.config.workspaceDir, source: 'workspace' });

    // 按优先级: workspace > managed > bundled (后扫描的优先)
    for (let i = sources.length - 1; i >= 0; i--) {
      const { dir, source } = sources[i];
      const result = loadSkillsFromDir({ skillsDir: dir, source });
      for (const m of result.manifests) {
        if (seenIds.has(m.id)) continue; // 高优先级已存在,跳过
        seenIds.add(m.id);
        allManifests.push(m);
        try {
          const skillMdPath = path.join(m.path, 'SKILL.md');
          if (fs.existsSync(skillMdPath)) {
            mtimeMap.set(m.id, fs.statSync(skillMdPath).mtimeMs);
          }
        } catch {}
      }
      errors.push(...result.errors);
    }

    this.state = {
      manifests: allManifests,
      errors,
      sourceOrder: sources.map(s => s.source),
      lastRefresh: Date.now(),
    };
    this.mtimeMap = mtimeMap;
    return this.state;
  }

  /**
   * 检查文件是否变更(热重载)
   */
  public checkHotReload(): boolean {
    if (!this.config.hotReload) return false;
    let changed = false;
    for (const m of this.state.manifests) {
      const skillMdPath = path.join(m.path, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;
      try {
        const mtime = fs.statSync(skillMdPath).mtimeMs;
        if (this.mtimeMap.get(m.id) !== mtime) {
          changed = true;
          break;
        }
      } catch {}
    }
    return changed;
  }

  /**
   * 获取清单(只读)
   */
  public getManifests(): SkillManifest[] {
    return this.state.manifests;
  }

  /**
   * 获取指定 id 的 manifest
   */
  public getManifest(id: string): SkillManifest | null {
    return this.state.manifests.find(m => m.id === id) || null;
  }

  /**
   * 获取指定 id 的 SKILL.md 完整内容
   */
  public getSkillBody(id: string): string | null {
    const m = this.getManifest(id);
    return m ? m.body : null;
  }

  /**
   * 读取资源文件内容
   */
  public readResource(id: string, resourceName: string): SkillResourceContent | null {
    const m = this.getManifest(id);
    if (!m) return null;
    const ref = m.resources.find(r => r.name === resourceName);
    if (!ref) return null;

    const fullPath = path.join(m.path, ref.dir, ref.name);
    if (!fs.existsSync(fullPath)) return null;

    const isBinary = isLikelyBinary(fullPath);
    if (isBinary) {
      const buffer = fs.readFileSync(fullPath);
      return {
        skillId: id,
        resourceName,
        type: ref.type,
        encoding: 'base64',
        content: buffer.toString('base64'),
        size: buffer.length,
      };
    } else {
      const content = fs.readFileSync(fullPath, 'utf-8');
      return {
        skillId: id,
        resourceName,
        type: ref.type,
        encoding: 'utf-8',
        content,
        size: Buffer.byteLength(content, 'utf-8'),
      };
    }
  }

  /**
   * 列出资源
   */
  public listResources(id: string): SkillResourceRef[] {
    const m = this.getManifest(id);
    return m ? m.resources : [];
  }

  /**
   * 获取引擎状态(用于调试)
   */
  public getState(): EngineState {
    return this.state;
  }
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm',
  '.exe', '.dll', '.so', '.dylib',
]);

function isLikelyBinary(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXT.has(ext);
}
