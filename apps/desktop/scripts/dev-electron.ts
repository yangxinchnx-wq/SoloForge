// ─────────────────────────────────────────────────────────────────
// SoloForge Electron Dev Runner
// 先启动 Vite，再启动 Electron
// ─────────────────────────────────────────────────────────────────

import { spawn } from 'child_process';
import { createServer } from 'vite';
import * as path from 'path';
import * as url from 'url';

// ESM __dirname 兼容
const __filename = url.fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);

async function startDev() {
  // scripts/ 目录是 apps/desktop/scripts/
  const desktopRoot = path.resolve(scriptDir, '..');
  const projectRoot = path.resolve(desktopRoot, '../..');

  console.log('[Dev] Desktop 目录:', desktopRoot);
  console.log('[Dev] 项目根目录:', projectRoot);

  console.log('\n[1/2] 启动 Vite 开发服务器...');

  // 启动 Vite 开发服务器
  const server = await createServer({
    configFile: path.join(desktopRoot, 'vite.config.ts'),
    mode: 'development',
    root: desktopRoot
  });
  await server.listen();
  console.log('[Dev] Vite 服务器已启动 http://localhost:5173');

  console.log('\n[2/2] 启动 Electron 主进程...');
  console.log('[Dev] 注意: Electron 需要单独编译 TypeScript 文件');
  console.log('[Dev] 请使用 npm run build:electron 来构建并运行\n');

  // 先构建 electron 文件
  console.log('[Dev] 构建 Electron 主进程...');
  const buildProcess = spawn(
    'npx',
    ['tsc', '-p', path.join(desktopRoot, 'tsconfig.electron.json')],
    {
      cwd: desktopRoot,
      stdio: 'inherit',
      shell: true
    }
  );

  await new Promise<void>((resolve) => {
    buildProcess.on('close', (code) => {
      if (code === 0) {
        console.log('[Dev] Electron 构建完成');
      }
      resolve();
    });
  });

  console.log('[Dev] 启动 Electron...');
  // 运行 electron
  const electronProcess = spawn(
    'npx',
    ['electron', path.join(desktopRoot, 'dist-electron/main.js')],
    {
      cwd: desktopRoot,
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        NODE_ENV: 'development'
      }
    }
  );

  electronProcess.on('close', (code) => {
    console.log('[Dev] Electron 进程退出，代码:', code);
    server.close();
    process.exit(code || 0);
  });

  // 处理 Ctrl+C
  process.on('SIGINT', () => {
    electronProcess.kill();
    server.close();
    process.exit(0);
  });
}

startDev().catch(console.error);
