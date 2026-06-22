// ============================================================
// Browser-Use API 路由注册
// ============================================================
//
// 在 UI/server.ts 启动时调用:
//   import { registerBrowserUseRoutes } from '../src/core/browser-use/routes';
//   registerBrowserUseRoutes(app, repoRoot);
//
// 端点:
//   POST /api/browser-use/run            — 提交任务
//   GET  /api/browser-use/tasks          — 列出所有任务
//   GET  /api/browser-use/state/:id      — 查询单个
//   POST /api/browser-use/cancel/:id     — 取消
//   POST /api/browser-use/pause/:id      — 暂停
//   POST /api/browser-use/resume/:id     — 恢复
//   GET  /api/browser-use/stream/:id     — SSE 步进流
//   GET  /api/browser-use/health         — 探活

import type { Express } from 'express';
import { resolve } from 'node:path';
import { getOrchestrator } from './orchestrator';

export function registerBrowserUseRoutes(app: Express, repoRoot: string): void {
  const orch = getOrchestrator(repoRoot);

  // 探活
  app.get('/api/browser-use/health', async (_req, res) => {
    try {
      await orch.ensureReady();
      res.json({ success: true, ready: true });
    } catch (e: any) {
      res.json({ success: false, ready: false, error: e.message });
    }
  });

  // 提交任务
  app.post('/api/browser-use/run', async (req, res) => {
    try {
      const task = String(req.body?.task ?? '').trim();
      if (!task) {
        return res.status(400).json({ success: false, error: 'task is required' });
      }
      const record = await orch.runTask(task);
      res.json({ success: true, task: record });
    } catch (e: any) {
      console.error('[bu-api] run failed:', e);
      res.status(500).json({ success: false, error: e.message ?? String(e) });
    }
  });

  // 列出任务 (本地缓存)
  app.get('/api/browser-use/tasks', (_req, res) => {
    res.json({ success: true, tasks: orch.listLocalTasks() });
  });

  // 查询单个
  app.get('/api/browser-use/state/:id', async (req, res) => {
    try {
      const task = await orch.getTaskState(req.params.id);
      if (!task) {
        return res.status(404).json({ success: false, error: 'task not found' });
      }
      res.json({ success: true, task });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 取消
  app.post('/api/browser-use/cancel/:id', async (req, res) => {
    try {
      const ok = await orch.cancelTask(req.params.id);
      res.json({ success: true, cancelled: ok });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 暂停
  app.post('/api/browser-use/pause/:id', async (req, res) => {
    try {
      const ok = await orch.pauseTask(req.params.id);
      res.json({ success: true, paused: ok });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 恢复
  app.post('/api/browser-use/resume/:id', async (req, res) => {
    try {
      const ok = await orch.resumeTask(req.params.id);
      res.json({ success: true, resumed: ok });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // SSE 流
  app.get('/api/browser-use/stream/:id', (req, res) => {
    orch.streamTask(req.params.id, req, res);
  });
}
