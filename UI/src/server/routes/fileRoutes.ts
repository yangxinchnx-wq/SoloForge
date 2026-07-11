/**
 * fileRoutes.ts — 文件系统操作路由
 *
 * 路由:
 *   GET    /api/files/read?path=xxx   → 读取文件内容
 *   POST   /api/files/save            → 保存文件内容  { path, content }
 *   GET    /api/files/list?dir=xxx    → 列出目录内容
 *   POST   /api/files/create          → 创建文件/文件夹  { path, content?, isDir? }
 *   DELETE /api/files/delete?path=xxx → 删除文件/文件夹
 *   POST   /api/files/rename          → 重命名  { oldPath, newPath }
 *   GET    /api/files/stats           → 项目文件统计
 *
 * 安全:
 *   - 所有路径都被限制在项目根目录内 (path traversal 防护)
 *   - 不允许访问 .git / node_modules 内部 (防止意外破坏)
 *   - 文件大小限制 10MB (防止读取超大文件导致 OOM)
 */

import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { FileNode } from '../../shared/types/file';
import { authenticateToken } from '../middleware/auth';

// ── 项目根目录 (server.ts 的上两级 = SoloForge/) ──────────────────
// ESM 兼容: __dirname 在 ESM scope 下未定义, 用 fileURLToPath 手动构造
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// 安全黑名单: 这些目录不允许直接操作 (防止破坏依赖 / 版本控制)
const BLOCKED_DIRS = new Set(['.git', 'node_modules', '.soloforge']);

const MAX_READ_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * 将用户传入的相对路径解析为绝对路径, 同时防止 path traversal
 * - 输入可以是绝对路径 (必须在 REPO_ROOT 内) 或相对路径
 * - 解析后检查是否在 REPO_ROOT 内
 * - 返回 null 表示路径非法
 */
function safeResolve(userPath: string): string | null {
  if (!userPath || typeof userPath !== 'string') return null;
  if (userPath.length > 4096) return null;
  if (userPath.includes('\0')) return null;

  let resolved: string;
  try {
    if (path.isAbsolute(userPath)) {
      resolved = path.normalize(userPath);
    } else {
      resolved = path.normalize(path.join(REPO_ROOT, userPath));
    }
  } catch {
    return null;
  }

  if (!resolved.startsWith(REPO_ROOT + path.sep) && resolved !== REPO_ROOT) {
    return null;
  }

  if (/^\\\\/.test(resolved)) {
    return null;
  }

  let realResolved: string;
  try {
    realResolved = fs.realpathSync(resolved);
    if (!realResolved.startsWith(REPO_ROOT + path.sep) && realResolved !== REPO_ROOT) {
      return null;
    }
  } catch {
    realResolved = resolved;
  }

  const rel = path.relative(REPO_ROOT, realResolved);
  const topSegment = rel.split(path.sep)[0];
  if (BLOCKED_DIRS.has(topSegment)) {
    return null;
  }

  return realResolved;
}

/**
 * 递归扫描目录构建 FileNode 树 (最多 2 层深度, 避免大目录卡顿)
 */
function scanDir(dirPath: string, basePath: string, depth: number = 0, maxDepth: number = 2): FileNode[] {
  const nodes: FileNode[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  // 排除隐藏文件和黑名单目录
  const visible = entries.filter(e => !e.name.startsWith('.') && !BLOCKED_DIRS.has(e.name));

  for (const entry of visible) {
    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(basePath, fullPath);
    const node: FileNode = {
      name: entry.name,
      type: entry.isDirectory() ? 'folder' : 'file',
      path: relPath,
    };

    try {
      const stat = fs.statSync(fullPath);
      node.size = stat.size;
      node.mtime = stat.mtimeMs;
    } catch { /* ignore stat errors */ }

    if (entry.isDirectory() && depth < maxDepth) {
      node.children = scanDir(fullPath, basePath, depth + 1, maxDepth);
    }

    nodes.push(node);
  }

  // 文件夹优先, 然后按名称排序
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}

/**
 * 递归统计目录内的文件数 / 文件夹数 / 总大小
 */
function statsDir(dirPath: string): { totalFiles: number; totalFolders: number; totalSize: number } {
  let totalFiles = 0;
  let totalFolders = 0;
  let totalSize = 0;

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || BLOCKED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        totalFolders++;
        walk(fullPath);
      } else {
        totalFiles++;
        try {
          totalSize += fs.statSync(fullPath).size;
        } catch { /* ignore */ }
      }
    }
  }

  walk(dirPath);
  return { totalFiles, totalFolders, totalSize };
}

// ── 路由处理函数 ──────────────────────────────────────────────────

function handleRead(req: Request, res: Response): void {
  const userPath = String(req.query.path || '');
  const absPath = safeResolve(userPath);
  if (!absPath) {
    res.status(400).json({ success: false, error: '路径非法或不在项目目录内' });
    return;
  }
  try {
    if (!fs.existsSync(absPath)) {
      res.status(404).json({ success: false, error: '文件不存在' });
      return;
    }
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      res.status(400).json({ success: false, error: '路径是目录, 不是文件' });
      return;
    }
    if (stat.size > MAX_READ_SIZE) {
      res.status(413).json({ success: false, error: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB), 超过 10MB 限制` });
      return;
    }
    const content = fs.readFileSync(absPath, 'utf-8');
    res.json({ success: true, content, mtime: stat.mtimeMs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

function handleSave(req: Request, res: Response): void {
  const { path: userPath, content } = req.body || {};
  const absPath = safeResolve(userPath);
  if (!absPath) {
    res.status(400).json({ success: false, error: '路径非法或不在项目目录内' });
    return;
  }
  try {
    // 确保父目录存在
    const parent = path.dirname(absPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    fs.writeFileSync(absPath, content ?? '', 'utf-8');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

function handleList(req: Request, res: Response): void {
  const userDir = String(req.query.dir || '');
  const absPath = safeResolve(userDir) || REPO_ROOT;
  try {
    if (!fs.existsSync(absPath)) {
      res.status(404).json({ success: false, error: '目录不存在' });
      return;
    }
    if (!fs.statSync(absPath).isDirectory()) {
      res.status(400).json({ success: false, error: '路径不是目录' });
      return;
    }
    const files = scanDir(absPath, absPath, 0, 2);
    res.json({ success: true, files });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

function handleCreate(req: Request, res: Response): void {
  const { path: userPath, content, isDir } = req.body || {};
  const absPath = safeResolve(userPath);
  if (!absPath) {
    res.status(400).json({ success: false, error: '路径非法或不在项目目录内' });
    return;
  }
  try {
    if (fs.existsSync(absPath)) {
      res.status(409).json({ success: false, error: '文件或目录已存在' });
      return;
    }
    if (isDir) {
      fs.mkdirSync(absPath, { recursive: true });
    } else {
      const parent = path.dirname(absPath);
      if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }
      fs.writeFileSync(absPath, content ?? '', 'utf-8');
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

function handleDelete(req: Request, res: Response): void {
  const userPath = String(req.query.path || '');
  const absPath = safeResolve(userPath);
  if (!absPath) {
    res.status(400).json({ success: false, error: '路径非法或不在项目目录内' });
    return;
  }
  try {
    if (!fs.existsSync(absPath)) {
      res.json({ success: true }); // 幂等: 不存在也视为删除成功
      return;
    }
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      fs.rmSync(absPath, { recursive: true });
    } else {
      fs.unlinkSync(absPath);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

function handleRename(req: Request, res: Response): void {
  const { oldPath, newPath } = req.body || {};
  const absOld = safeResolve(oldPath);
  const absNew = safeResolve(newPath);
  if (!absOld || !absNew) {
    res.status(400).json({ success: false, error: '路径非法或不在项目目录内' });
    return;
  }
  try {
    if (!fs.existsSync(absOld)) {
      res.status(404).json({ success: false, error: '源文件不存在' });
      return;
    }
    if (fs.existsSync(absNew)) {
      res.status(409).json({ success: false, error: '目标路径已存在' });
      return;
    }
    // 确保目标父目录存在
    const parent = path.dirname(absNew);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    fs.renameSync(absOld, absNew);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

function handleStats(_req: Request, res: Response): void {
  try {
    const stats = statsDir(REPO_ROOT);
    res.json({ success: true, stats });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 路由注册
 */
export function registerFileRoutes(app: import('express').Express): void {
  app.get('/api/files/read', authenticateToken, handleRead);
  app.post('/api/files/save', authenticateToken, handleSave);
  app.get('/api/files/list', authenticateToken, handleList);
  app.post('/api/files/create', authenticateToken, handleCreate);
  app.delete('/api/files/delete', authenticateToken, handleDelete);
  app.post('/api/files/rename', authenticateToken, handleRename);
  app.get('/api/files/stats', authenticateToken, handleStats);
}
