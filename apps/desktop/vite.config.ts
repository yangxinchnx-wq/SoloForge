// ─────────────────────────────────────────────────────────────────
// SoloForge Vite + Electron Configuration
//
// 架构说明：
//   - Vite root 指向项目根目录，入口 HTML 为 UI/index.html
//   - UI/index.html → UI/themes/default-dark/app/index.tsx → 真实 UI 组件
//   - Electron 主进程: apps/desktop/src/main.ts + preload.ts
//   - 构建产物: apps/desktop/dist-electron/ (electron) + apps/desktop/dist/ (renderer)
// ─────────────────────────────────────────────────────────────────

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// 路径定义
const desktopDir = __dirname;                  // apps/desktop/
const projectRoot = resolve(desktopDir, '../..'); // SoloForge/
const uiDir = resolve(projectRoot, 'UI');         // SoloForge/UI/

// 检查是否是 web 模式或者没有 DISPLAY 环境变量（无图形界面）
const isWebMode = process.env.VITE_MODE === 'web' || !process.env.DISPLAY;

export default defineConfig({
  // Vite 的 root 指向 UI/ 目录，UI/index.html 作为入口 HTML
  root: uiDir,

  plugins: [
    react(),
    // 只有在非 web 模式才加载 electron 插件
    !isWebMode && (async () => {
      const electron = (await import('vite-plugin-electron')).default;
      const renderer = (await import('vite-plugin-electron-renderer')).default;

      return electron([
        {
          // Electron 主进程入口（绝对路径，避免 root 指向 UI/ 后路径错误）
          entry: resolve(desktopDir, 'src/main.ts'),
          onstart(options) {
            options.startup();
          },
          vite: {
            build: {
              outDir: resolve(desktopDir, 'dist-electron'),
              sourcemap: true,
              minify: false,
              rollupOptions: {
                external: ['electron', '@electron/rebuild']
              }
            }
          }
        },
        {
          // Electron preload 入口
          entry: resolve(desktopDir, 'src/preload.ts'),
          onstart(options) {
            options.reload();
          },
          vite: {
            build: {
              outDir: resolve(desktopDir, 'dist-electron'),
              sourcemap: true,
              minify: false,
              rollupOptions: {
                external: ['electron']
              }
            }
          }
        }
      ]);
    })()
  ].filter(Boolean),
  resolve: {
    alias: {
      '@': resolve(desktopDir, 'src'),
      '@ui': uiDir
    }
  },
  build: {
    // renderer 构建产物输出到 apps/desktop/dist/
    outDir: resolve(desktopDir, 'dist'),
    emptyOutDir: true
  },
  server: {
    port: 5188,
    strictPort: false,
    host: true
  }
});
