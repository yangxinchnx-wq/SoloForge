/**
 * chatWorkdirService — 路径校验 / 归一 / 落盘
 *
 * 设计目标:
 *   - 纯函数为主 (validate / normalize / sameRealPath), 方便单测
 *   - IO 操作 (mkdir) 集中隔离, 失败 fallback 到 tmpdir
 *   - 系统目录硬拦截, 防 AI / 误操作触及 OS 关键路径
 *
 * ⚠️ 本模块通过 require 方式使用 Node 'path' / 'os' / 'fs',
 *    在浏览器环境 (没有 nodejs) 时所有 fallback 走 path string 数学,
 *    不报硬错.
 */

type NodeModules = typeof import('path') | null;
type FsModules = typeof import('fs') | null;
type OsModules = typeof import('os') | null;

function tryRequire<T>(mod: 'path' | 'fs' | 'os'): T | null {
  const req = (globalThis as any).require;
  if (typeof req !== 'function') return null;
  try {
    const m = req(mod);
    if (m && typeof m === 'object') {
      if ('default' in m && m.default) return m.default as T;
      return m as T;
    }
    return m as T;
  } catch {
    return null;
  }
}

const pathMod = tryRequire<NodeModules>('path');
const fsMod = tryRequire<FsModules>('fs');
const osMod = tryRequire<OsModules>('os');

const SYSTEM_BLOCKLIST_WIN = [
  'C:\\Windows',
  'C:\\Windows\\System32',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
];

const SYSTEM_BLOCKLIST_UNIX = [
  '/bin',
  '/sbin',
  '/etc',
  '/usr',
  '/var',
  '/boot',
  '/root',
];

/**
 * 校验路径是否合法 & 安全
 * - 拒绝 .. 越权
 * - 拒绝绝对系统目录 (Windows & *nix)
 * - 拒绝 UNC \\?\ 或远程 \\server\share
 */
export function validateWorkdir(input: string): { ok: boolean; reason?: string } {
  if (!input || typeof input !== 'string') return { ok: false, reason: 'empty path' };
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty path' };

  if (trimmed.includes('..')) return { ok: false, reason: 'path traversal not allowed (..)' };

  // UNC / 远程
  if (/^\\\\/.test(trimmed)) return { ok: false, reason: 'UNC / remote paths are not allowed' };

  // 系统目录 (大小写不敏感)
  const low = trimmed.toLowerCase();
  const isWin = /^[a-z]:\\/i.test(trimmed);
  const list = isWin ? SYSTEM_BLOCKLIST_WIN : SYSTEM_BLOCKLIST_UNIX;
  for (const blocked of list) {
    if (low === blocked.toLowerCase() || low.startsWith(blocked.toLowerCase() + (isWin ? '\\' : '/'))) {
      return { ok: false, reason: `system directory blocked: ${blocked}` };
    }
  }

  return { ok: true };
}

/**
 * 路径归一 (realpath 用, Windows 大小写不敏感 → 小写)
 * - 调用 fs.realpathSync.native 时 collapse 短名 (FOO~1)
 * - 失败时 fallback 到 path.resolve
 */
export function normalizeForIndex(input: string): string {
  let resolved = input;
  if (pathMod) {
    try { resolved = pathMod.resolve(input); } catch { /* ignore */ }
  }
  // Windows: 大小写不敏感 + 路径分隔符统一
  const isWin = /^[a-z]:[\\/]/i.test(resolved);
  const out = isWin ? resolved.toLowerCase().replace(/\//g, '\\') : resolved.replace(/\\/g, '/');
  return out.replace(/[\\/]+$/, '');
}

/** 比较两个路径是否指向同一真实位置 */
export function isSameRealPath(a: string, b: string): boolean {
  return normalizeForIndex(a) === normalizeForIndex(b);
}

/**
 * 确保目录存在 (mkdir -p); 越权 / 系统目录 → 抛错
 * 返回最终 workdir 的归一键 (realpath 原值 or 原值)
 */
export async function ensureDirExistsAsync(workdir: string): Promise<void> {
  const v = validateWorkdir(workdir);
  if (!v.ok) throw new Error(`[workdir] ${v.reason}: ${workdir}`);

  if (!fsMod) {
    try {
      const m = await import('fs');
      m.mkdirSync(workdir, { recursive: true });
      return;
    } catch (err) {
      throw new Error(`mkdir failed for ${workdir}: ${(err as Error).message}`);
    }
  }
  try {
    fsMod.mkdirSync(workdir, { recursive: true });
  } catch (err: any) {
    const code = err?.code;
    if (code !== 'EEXIST') throw err;
  }
}

export function ensureDirExists(workdir: string): string {
  const v = validateWorkdir(workdir);
  if (!v.ok) throw new Error(`[workdir] ${v.reason}: ${workdir}`);

  if (!fsMod) {
    void ensureDirExistsAsync(workdir).catch(() => { /* fire-and-forget; caller may not await */ });
    return normalizeForIndex(workdir);
  }
  try {
    fsMod.mkdirSync(workdir, { recursive: true });
  } catch (err: any) {
    // EACCES / ENOSPC / EPERM → fallback 到 tmpdir
    if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'ENOSPC')) {
      if (!osMod) throw err;
      const fallback = osMod.join(osMod.tmpdir(), 'soloforge_workdir');
      const stamp = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 8);
      const fb = osMod.join(fallback, `chat-${stamp}`);
      fsMod.mkdirSync(fb, { recursive: true });
      if (typeof console !== 'undefined') {
        console.warn(`[workdir] fallback to tmpdir: ${workdir} -> ${fb} (${err.code})`);
      }
      return fb;
    }
    throw err;
  }
  return normalizeForIndex(workdir);
}

/**
 * 派生默认目录: 用于新 chat, 还没有 workdir 时调用
 * 规则 (按顺序, 任一命中即返回):
 *   1. inheritFromSibling=true 且 pathIndex 中 path 仍活跃 (<7d) → 复用最新兄弟的 workdir
 *   2. 返回 workspaceRoot/chat-<末 8 位>
 */
export function deriveDefaultWorkdir(opts: {
  chatId: string;
  workspaceRoot: string;
  siblings?: Array<{ chatId: string; workdir: string; updatedAt: number }>;
  activeWindowMs?: number;
  inheritFromSibling?: boolean;
}): string {
  const windowMs = opts.activeWindowMs ?? 7 * 24 * 60 * 60 * 1000;
  if (opts.inheritFromSibling !== false && opts.siblings && opts.siblings.length > 0) {
    const now = Date.now();
    const recent = opts.siblings
      .filter(s => normalizeForIndex(s.workdir).startsWith(normalizeForIndex(opts.workspaceRoot)))
      .filter(s => now - s.updatedAt < windowMs)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent) return recent.workdir;
  }
  const tail = opts.chatId.slice(-8);
  return joinPath(opts.workspaceRoot, `chat-${tail}`);
}

/** 简单 path.join 替身 (避免在浏览器端硬 require path) */
export function joinPath(...parts: string[]): string {
  if (pathMod) return pathMod.join(...parts);
  const isWin = parts.some(p => /^[a-z]:[\\/]/i.test(p));
  const sep = isWin ? '\\' : '/';
  return parts
    .filter(Boolean)
    .map((p, i) => i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))
    .filter(Boolean)
    .join(sep);
}

/** 默认 workspaceRoot — 优先用环境变量 / localStorage, 否则 ~/SoloForge */
export function defaultWorkspaceRoot(): string {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem('soloforge_workspaceRoot');
    if (saved) return saved;
  }
  if (osMod && typeof osMod.homedir === 'function') {
    return osMod.join(osMod.homedir(), 'SoloForge');
  }
  return '~/SoloForge';
}
