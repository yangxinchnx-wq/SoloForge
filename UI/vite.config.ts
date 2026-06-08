import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // 将 /api 与 /ui 与 /metrics 反代到后端
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/metrics': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ui': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // WebSocket 通道(Vite 5 自动透传 Upgrade/Connection 头)
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    // P0-7: 拆包 — 解决单 chunk 1.8MB 警告,首屏更快,缓存粒度更细
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('react') || id.includes('scheduler')) {
            return 'vendor-react';
          }
          // 其他三方库集中到 vendor-misc
          return 'vendor-misc';
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
