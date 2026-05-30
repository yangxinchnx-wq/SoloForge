// ─────────────────────────────────────────────────────────────────
// SoloForge Electron Dev Runner (ESM)
// 手动构建和运行 Electron
// ─────────────────────────────────────────────────────────────────

import { spawn, execSync } from 'child_process';
import { createServer, build } from 'vite';
import * as path from 'path';
import * as url from 'url';
import * as fs from 'fs';

const __filename = url.fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const desktopRoot = path.resolve(scriptDir, '..');
const projectRoot = path.resolve(desktopRoot, '../..');

console.log('='.repeat(60));
console.log('SoloForge Electron 开发服务器');
console.log('='.repeat(60));
console.log('Desktop:', desktopRoot);
console.log('Project:', projectRoot);

async function buildElectron() {
  console.log('\n[1/3] 构建 Electron 主进程...');

  // 清理旧文件
  const distElectron = path.join(desktopRoot, 'dist-electron');
  if (fs.existsSync(distElectron)) {
    fs.rmSync(distElectron, { recursive: true });
  }

  // 使用 esbuild 构建
  try {
    execSync(`npx esbuild src/main.ts src/preload.ts --bundle --platform=node --outdir=dist-electron --external:electron --external:@surrealdb/* --external:surrealdb --format=cjs`, {
      cwd: desktopRoot,
      stdio: 'inherit'
    });
    console.log('[OK] Electron 构建完成');
  } catch (e) {
    console.error('[ERROR] Electron 构建失败');
    throw e;
  }
}

async function startVite() {
  console.log('\n[2/3] 启动 Vite 开发服务器...');

  const server = await createServer({
    configFile: path.join(desktopRoot, 'vite.config.ts'),
    mode: 'development',
    root: desktopRoot
  });

  await server.listen();
  console.log('[OK] Vite 服务器 http://localhost:5173');
  return server;
}

function startElectron() {
  console.log('\n[3/3] 启动 Electron...');
  console.log('-'.repeat(40));

  const electronPath = path.join(desktopRoot, 'node_modules/electron/dist/electron.exe');
  const mainPath = path.join(desktopRoot, 'dist-electron/main.js');

  const electronProcess = spawn(electronPath, [mainPath], {
    cwd: desktopRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development'
    }
  });

  electronProcess.on('close', (code) => {
    console.log('\n' + '='.repeat(60));
    console.log('Electron 退出，代码:', code);
    console.log('='.repeat(60));
  });

  return electronProcess;
}

async function main() {
  try {
    // 1. 构建 Electron
    await buildElectron();

    // 2. 启动 Vite
    const server = await startVite();

    // 3. 启动 Electron
    const electronProcess = startElectron();

    // 处理关闭
    const cleanup = () => {
      electronProcess.kill();
      server.close();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

  } catch (e) {
    console.error('\n[ERROR]', e);
    process.exit(1);
  }
}

main();
