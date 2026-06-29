#!/usr/bin/env node
/**
 * Git hooks 安装脚本
 *
 * 行为:
 *   - 把 .githooks/ 软链到 .git/hooks/ (如果 hooksPath 未设置)
 *   - 或打印提示让用户执行 `git config core.hooksPath .githooks`
 *   - macOS / Linux 友好; Windows 提示用 git config 方式
 *
 * 用法: node scripts/install-hooks.js
 */

import { existsSync, statSync, symlinkSync, unlinkSync, readlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const githooksDir = resolve(repoRoot, '.githooks');

if (!existsSync(githooksDir)) {
  console.error(`[install-hooks] 找不到 ${githooksDir}`);
  process.exit(1);
}

try {
  const current = execSync('git config --get core.hooksPath', { encoding: 'utf8', cwd: repoRoot }).trim();
  if (current === '.githooks') {
    console.log('[install-hooks] ✅ core.hooksPath 已配置为 .githooks/');
    process.exit(0);
  }
  console.log(`[install-hooks] core.hooksPath 当前为: "${current}"`);
  console.log('[install-hooks] 重新设置:');
  execSync('git config core.hooksPath .githooks', { stdio: 'inherit', cwd: repoRoot });
  console.log('[install-hooks] ✅ 已设置 core.hooksPath = .githooks/');
  process.exit(0);
} catch {
  // git config --get 失败 = 没设置过
}

const isWindows = process.platform === 'win32';
if (isWindows) {
  console.log('[install-hooks] Windows: 请手动执行:');
  console.log('  git config core.hooksPath .githooks');
  process.exit(0);
}

// POSIX: 尝试在 .git/hooks/ 软链
const gitHooksDir = resolve(repoRoot, '.git', 'hooks');
if (!existsSync(gitHooksDir)) {
  console.error('[install-hooks] 找不到 .git/hooks/');
  process.exit(1);
}

const hookFiles = ['pre-commit'];
for (const name of hookFiles) {
  const src = resolve(githooksDir, name);
  const dst = resolve(gitHooksDir, name);
  if (!existsSync(src)) continue;
  if (existsSync(dst) || (() => {
    try { statSync(dst); return true; } catch { return false; }
  })()) {
    try { unlinkSync(dst); } catch {}
  }
  try {
    symlinkSync(src, dst);
    console.log(`[install-hooks] ✅ 软链 .git/hooks/${name} -> .githooks/${name}`);
  } catch (e) {
    console.warn(`[install-hooks] ⚠️ 软链失败 (${e.message}), 请手动: git config core.hooksPath .githooks`);
  }
}
