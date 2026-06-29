/**
 * Skill Engine 单元测试(UI 端)
 *
 * 覆盖:
 *   - frontmatter 解析/校验
 *   - loader 多源扫描
 *   - engine 聚合 + 优先级
 *   - 与 bundled/ 真实文件集成
 *
 * 运行:
 *   cd UI && ./node_modules/.bin/tsx tests/skills.test.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  parseFrontmatter,
  validateFrontmatter,
  extractTriggers,
  FrontmatterParseError,
} from '../src/skills/frontmatter';
import { loadSkillsFromDir } from '../src/skills/loader';
import { SkillEngine } from '../src/skills/engine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, name: string): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ============================================================
// 前置:创建临时 skill 目录(避免污染仓库)
// ============================================================
const tmpDir = path.join(os.tmpdir(), `soloforge-ui-skills-${Date.now()}`);

function makeSkill(dir: string, name: string, description: string, group?: string): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const groupLine = group ? `\nmetadata:\n  group: ${group}` : '';
  const content = `---
name: ${name}
description: ${description}${groupLine}
allowed-tools: Read Grep
---

# ${name} Body`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
}

fs.mkdirSync(tmpDir, { recursive: true });
makeSkill(tmpDir, 'alpha', 'Test skill. Use when needed.', '编程');
makeSkill(tmpDir, 'beta', 'Another skill. Use when reviewing.', '工程');

// ============================================================
// 测试
// ============================================================

section('frontmatter parser');

const fm = parseFrontmatter(`---
name: foo-bar
description: A test skill. Use when testing.
allowed-tools: Read Grep Glob
---

# Body`);
assert(fm.data.name === 'foo-bar', 'name parsed');
assert(fm.data.description.includes('test'), 'description parsed');
assert(Array.isArray(fm.data.allowedTools), 'allowedTools parsed as array');
assert(fm.data.allowedTools.includes('Read'), 'allowedTools contains Read');
assert(fm.data.allowedTools.includes('Grep'), 'allowedTools contains Grep');
assert(fm.data.allowedTools.includes('Glob'), 'allowedTools contains Glob');
assert(fm.body.trim() === '# Body', 'body parsed');

section('frontmatter validator');

function throws(fn: () => void): boolean {
  try { fn(); return false; } catch { return true; }
}

assert(!throws(() => validateFrontmatter({ name: 'valid-name', description: 'd' })), 'valid frontmatter passes');
assert(throws(() => validateFrontmatter({ description: 'd' })), 'missing name throws');
assert(throws(() => validateFrontmatter({ name: 'InvalidName', description: 'd' })), 'uppercase name throws');
assert(throws(() => validateFrontmatter({ name: 'a'.repeat(100), description: 'd' })), 'name > 64 chars throws');
assert(throws(() => validateFrontmatter({ name: 'valid-name', description: 'a'.repeat(1025) })), 'description > 1024 chars throws');

section('trigger extractor');

const triggers = extractTriggers('Use when user asks to refactor code or clean up this code.');
assert(triggers.some((t: string) => t.includes('refactor') || t.includes('clean up')), 'extracts Use-when phrases');

const quotedTriggers = extractTriggers('Use this for "code review" or "PR check".');
assert(quotedTriggers.includes('code review'), 'extracts quoted phrases');
assert(quotedTriggers.includes('PR check'), 'extracts second quoted phrase');

section('skill loader');

const loaded = loadSkillsFromDir({ skillsDir: tmpDir, source: 'bundled' });
assert(loaded.manifests.length === 2, `loads 2 skills from tmpDir (got ${loaded.manifests.length})`);
assert(loaded.errors.length === 0, 'no parse errors');
const alpha = loaded.manifests.find((m: any) => m.id === 'alpha');
assert(!!alpha, 'alpha loaded');
assert(alpha?.group === '编程', `alpha.group === '编程' (got '${alpha?.group}')`);
assert(alpha?.allowedTools.includes('Read'), 'alpha.allowedTools includes Read');

const empty = loadSkillsFromDir({
  skillsDir: path.join(tmpDir, 'non-existent'),
  source: 'bundled',
});
assert(empty.manifests.length === 0, 'non-existent dir returns empty');

section('skill engine - multi-source priority');

const priorityDir = path.join(os.tmpdir(), `soloforge-priority-${Date.now()}`);
const bundledDir = path.join(priorityDir, 'bundled');
const managedDir = path.join(priorityDir, 'managed');
const workspaceDir = path.join(priorityDir, 'workspace');

makeSkill(bundledDir, 'shared', 'from bundled', 'B');
makeSkill(managedDir, 'shared', 'from managed', 'M');
makeSkill(workspaceDir, 'shared', 'from workspace', 'W');

const engine = new SkillEngine({ bundledDir, managedDir, workspaceDir });
engine.refresh();
const shared = engine.getManifest('shared');
assert(!!shared, 'shared skill found');
assert(shared?.source === 'workspace', `shared wins workspace priority (got ${shared?.source})`);
assert(shared?.group === 'W', `shared.group reflects workspace (got ${shared?.group})`);

section('skill engine - bundled integration');

const projectRoot = path.resolve(__dirname, '..');
const uiSkillsDir = path.join(projectRoot, 'resources', 'skills');
const engine2 = new SkillEngine({ bundledDir: uiSkillsDir });
engine2.refresh();
const manifests = engine2.getManifests();
assert(manifests.length >= 6, `bundled skills count >= 6 (got ${manifests.length})`);
const ids = manifests.map((m: any) => m.id);
assert(ids.includes('bug-fix'), 'bundled has bug-fix');
assert(ids.includes('code-review'), 'bundled has code-review');
assert(ids.includes('refactor'), 'bundled has refactor');
assert(ids.includes('test-coverage'), 'bundled has test-coverage');
assert(ids.includes('doc-write'), 'bundled has doc-write');
assert(ids.includes('feature-implement'), 'bundled has feature-implement');

section('skill engine - getManifest unknown');

assert(engine2.getManifest('does-not-exist') === null, 'unknown skill returns null');

section('skill engine - getSkillBody');

const body = engine2.getSkillBody('bug-fix');
assert(typeof body === 'string', 'body is string');
assert(body.length > 0, 'body non-empty');
assert(body.includes('Bug') || body.includes('修复'), 'body contains expected content');

// ============================================================
// 清理 + 总结
// ============================================================
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
try { fs.rmSync(priorityDir, { recursive: true, force: true }); } catch {}

console.log(`\n--- Test Summary ---`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  console.log(`\nFailures:`);
  failures.forEach((f: string) => console.log(`  - ${f}`));
  process.exit(1);
}

console.log(`\nAll tests passed.`);
process.exit(0);