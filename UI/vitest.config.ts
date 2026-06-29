import { defineConfig } from 'vitest/config';
import path from 'node:path';

const root = path.resolve(__dirname);

export default defineConfig({
  root,
  test: {
    include: [
      'src/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
      'electron/**/*.test.cjs',
      'electron/**/*.test.js',
    ],
    exclude: [
      'node_modules/**',
      'dist/**',
      // 预存在的自定义 runner 测试脚本（不是 vitest 测试）
      'tests/skills.test.ts',
      'tests/sessionStore.test.ts',
      'tests/validators.test.ts',
    ],
    environment: 'node',
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@tests': path.resolve(__dirname, 'tests'),
    },
  },
});
