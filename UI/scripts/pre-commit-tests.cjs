#!/usr/bin/env node
/**
 * Pre-commit hook 入口 (UI)
 *
 * 触发条件: git commit 时自动执行 `npm run pre-commit`
 * 行为: 找出本次 commit 修改到的 *.test.ts / *.ts / *.tsx 文件,
 *       仅跑这些文件相关的测试, 而不是全量跑。
 *       目的: 单测反馈循环从"等 5 秒全量"压到"几秒" 级别。
 *
 * 设计原则:
 *   - 零依赖 (用 Node 内置 child_process + path, 不引 husky / lint-staged)
 *   - 失败即阻塞 commit (非零退出码)
 *   - 找不到相关文件时直接通过, 不强制全量跑
 *
 * 启用方法 (任选其一):
 *   A) 自动: 在 repo 根 .git/hooks/pre-commit 末尾加:
 *        cd UI && npm run pre-commit
 *   B) 手动: git 客户端已配置 core.hooksPath 指向 .githooks/, 此时
 *      把本文件软链或复制到 .githooks/pre-commit 即可。
 */

const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// 1. 找出本次 commit staged 的 .ts/.tsx 文件
//    支持 STAGED_FILES 环境变量用于 dry-run 测试
let staged;
try {
  if (process.env.STAGED_FILES) {
    staged = process.env.STAGED_FILES;
  } else {
    staged = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      encoding: 'utf8',
      cwd: path.resolve(__dirname, '..'),
    });
  }
} catch (e) {
  console.error('[pre-commit] 无法读取 git staged files:', e.message);
  process.exit(1);
}

const allFiles = staged.split(/\r?\n/).filter(Boolean);

// 2. 过滤出 UI 源码 / 测试文件
const uiFiles = allFiles.filter(
  (f) => /^(src|tests)\//.test(f) && /\.(ts|tsx|cjs)$/.test(f) && !f.includes('node_modules'),
);

if (uiFiles.length === 0) {
  console.log('[pre-commit] 本次 commit 不涉及 UI 源码/测试, 跳过测试运行。');
  process.exit(0);
}

// 3. 找测试文件: 直接改 *.test.ts → 跑它; 改源码 → 跑同目录所有 *.test.ts
const testSet = new Set();
for (const f of uiFiles) {
  if (/\.test\.(ts|tsx|cjs)$/.test(f)) {
    testSet.add(f);
  } else {
    // 递归找 src / tests 目录下所有 *.test.ts(x|cjs)
    // 覆盖两种 layout: *.test.ts 同目录 / __tests__/*.test.ts
    const roots = [
      path.dirname(f),
      path.join(path.dirname(f), '__tests__'),
    ];
    for (const dir of roots) {
      try {
        const dirContents = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of dirContents) {
          if (ent.isFile() && /\.test\.(ts|tsx|cjs)$/.test(ent.name)) {
            testSet.add(path.join(dir, ent.name));
          }
        }
      } catch {
        /* 目录不存在, 跳过 */
      }
    }
  }
}

if (testSet.size === 0) {
  console.log('[pre-commit] 没有找到相关测试文件, 跳过。');
  process.exit(0);
}

const tests = Array.from(testSet);
console.log(`[pre-commit] 准备运行 ${tests.length} 个测试文件:`);
for (const t of tests) console.log('  - ' + t);

// 4. 调用 vitest
try {
  execSync(`npx vitest run ${tests.map((t) => `"${t}"`).join(' ')}`, {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  console.log('[pre-commit] ✅ 测试通过');
} catch (e) {
  console.error('[pre-commit] ❌ 测试失败, 请修复后再 commit。');
  process.exit(1);
}
