// ─────────────────────────────────────────────────────────────────
// SoloForge Vite + Electron Configuration
// ─────────────────────────────────────────────────────────────────

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// 检查是否是 web 模式或者没有 DISPLAY 环境变量（无图形界面）
const isWebMode = process.env.VITE_MODE === 'web' || !process.env.DISPLAY;

export default defineConfig({
  plugins: [
    react(),
    // 只有在非 web 模式才加载 electron 插件
    !isWebMode && (async () => {
      const electron = (await import('vite-plugin-electron')).default;
      const renderer = (await import('vite-plugin-electron-renderer')).default;

      return electron([
        {
          entry: 'src/main.ts',
          onstart(options) {
            options.startup();
          },
          vite: {
            build: {
              outDir: 'dist-electron',
              sourcemap: true,
              minify: false,
              rollupOptions: {
                external: ['electron', '@electron/rebuild']
              }
            }
          }
        },
        {
          entry: 'src/preload.ts',
          onstart(options) {
            options.reload();
          },
          vite: {
            build: {
              outDir: 'dist-electron',
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
      '@': resolve(__dirname, 'src')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5188,
    strictPort: false,
    host: true
  }
});
