// ─────────────────────────────────────────────────────────────────
// SoloForge UI 烟雾测试 (P0-8)
// - 验证后端 API 可达
// - 验证构建产物存在
// - 验证关键模块路径在 dist 中
// 用法: node smoke.mjs
// 前提: 后端在 :3001, 之前已 npm run build
// ─────────────────────────────────────────────────────────────────

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, 'dist');
const API = process.env.API_BASE || 'http://localhost:3001';

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = '') {
  const status = ok ? '✅' : '❌';
  results.push({ name, ok, detail });
  if (ok) pass++; else fail++;
  console.log(`${status} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log('=== SoloForge UI Smoke Test ===\n');

  // 1. 后端健康
  try {
    const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    check('后端 /api/health 可达', r.ok, `status=${j?.status || '?'} uptime=${j?.uptime ?? '?'}`);
  } catch (e) {
    check('后端 /api/health 可达', false, `无法连接 ${API} (${e.message})`);
  }

  // 2. 内核状态
  try {
    const r = await fetch(`${API}/api/kernel/status`, { signal: AbortSignal.timeout(3000) });
    check('后端 /api/kernel/status 可达', r.ok);
  } catch (e) {
    check('后端 /api/kernel/status 可达', false, e.message);
  }

  // 3. 构建产物
  const htmlPath = join(distDir, 'index.html');
  check('dist/index.html 存在', existsSync(htmlPath));
  if (existsSync(htmlPath)) {
    const html = readFileSync(htmlPath, 'utf8');
    check('index.html 引用 vendor-react', html.includes('vendor-react'), '');
    check('index.html 引用主入口', /assets\/index-.*\.js/.test(html), '');
  }

  // 4. 拆包验证
  const vendorReact = join(distDir, 'assets', 'vendor-react-');
  const distAssets = existsSync(distDir + '/assets')
    ? readFileSync(join(distDir, 'index.html'), 'utf8').match(/assets\/[\w-]+\.js/g) || []
    : [];
  check('vendor-react 拆包成功', distAssets.some((p) => p.includes('vendor-react')), `${distAssets.length} chunks`);

  // 5. 关键类型文件
  const critical = [
    'src/types/api.ts',
    'src/hooks/useApi.ts',
    'src/hooks/usePersistedState.ts',
    'src/hooks/useI18n.ts',
    'src/components/ui/States.tsx',
  ];
  for (const f of critical) {
    check(`${f} 存在`, existsSync(join(__dirname, f)));
  }

  // 6. bundle 体积
  const htmlSize = existsSync(htmlPath) ? statSync(htmlPath).size : 0;
  check('index.html 体积合理 (< 5KB)', htmlSize > 0 && htmlSize < 5 * 1024, `${htmlSize} bytes`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(2);
});
