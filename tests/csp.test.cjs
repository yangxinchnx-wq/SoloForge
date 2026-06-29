// 验证 main.cjs 的 CSP 配置正确, 不会再次出现 Canvas3DClient CSP 错误
//
// 历史 bug (2026-06-28):
//   Canvas3DClient 硬编码 http://127.0.0.1:${port}, CSP connect-src 只允许 localhost:*
//   触发: "Refused to connect because it violates the document's Content Security Policy"
//
// 跑法: node tests/csp.test.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const MAIN_CJS = path.join(__dirname, '..', 'UI', 'electron', 'main.cjs');
const source = fs.readFileSync(MAIN_CJS, 'utf8');

// 提取 setupCsp 函数体内的 csp 字符串
// (简单文本匹配 — 用 evaluate 模式)
const cspMatch = source.match(/const csp = \[([\s\S]*?)\]\.join\('; '\);/);
assert(cspMatch, 'main.cjs 中找不到 csp 字符串定义');
const cspDirectives = cspMatch[1]
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('//'));

// 解析每条 directive
const directives = {};
for (const line of cspDirectives) {
  const m = line.match(/^"([\w-]+)\s+([^"]+)"\s*,?$/);
  assert(m, `无法解析 CSP directive: ${line.slice(0, 80)}`);
  directives[m[1]] = m[2];
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('connect-src 存在', () => {
  assert(directives['connect-src'], '缺少 connect-src');
});

test('connect-src 包含 http://127.0.0.1:*', () => {
  assert(directives['connect-src'].includes('http://127.0.0.1:*'),
    'connect-src 缺少 http://127.0.0.1:* (Canvas3DClient 会触发 CSP 拒绝)');
});

test('connect-src 包含 ws://127.0.0.1:*', () => {
  assert(directives['connect-src'].includes('ws://127.0.0.1:*'),
    'connect-src 缺少 ws://127.0.0.1:* (Flutter canvas WebSocket 在 127.0.0.1)');
});

test('connect-src 仍保留 localhost (Vite dev server)', () => {
  assert(directives['connect-src'].includes('http://localhost:3000'),
    'connect-src 缺少 localhost:3000 (Vite dev server)');
});

test('img-src 包含 127.0.0.1:* (canvas 截图 base64/127.0.0.1 资源)', () => {
  assert(directives['img-src'].includes('http://127.0.0.1:*'),
    'img-src 缺少 http://127.0.0.1:*');
});

test('default-src 兜底允许 127.0.0.1:*', () => {
  assert(directives['default-src'].includes('http://127.0.0.1:*'),
    'default-src 缺少 http://127.0.0.1:* 兜底');
});

test('script-src 不使用 unsafe-eval', () => {
  assert(!directives['script-src'].includes("'unsafe-eval'"),
    'script-src 包含 unsafe-eval, Electron 会警告');
});

test('object-src 为 none', () => {
  assert(directives['object-src'] === "'none'",
    "object-src 应为 'none' (防 Flash/plugin 注入)");
});

test('frame-ancestors 为 none (防 clickjacking)', () => {
  assert(directives['frame-ancestors'] === "'none'",
    "frame-ancestors 应为 'none'");
});

let passed = 0, failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
    passed++;
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
    console.log(`      ${e.message}`);
    failed++;
  }
}

console.log('');
console.log(`CSP 测试: ${passed} 通过, ${failed} 失败`);
console.log('connect-src 实际值:');
console.log(`  ${directives['connect-src']}`);

process.exit(failed > 0 ? 1 : 0);
