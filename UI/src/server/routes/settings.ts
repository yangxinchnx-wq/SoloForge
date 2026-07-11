/**
 * 通用 Settings 路由 — 前端 localStorage 的服务端镜像
 *
 * 路由:
 *   GET    /api/settings                  → 返回整个 settings 对象 (合并默认值)
 *   GET    /api/settings/:key             → 返回单个 key 值
 *   PUT    /api/settings/:key             → 写入单个 key 值 (覆盖)
 *   PATCH  /api/settings                  → 批量合并更新 (推荐,减少请求)
 *   DELETE /api/settings/:key             → 删除 key
 *
 * 存储路径:
 * - Electron 模式: <userData>/.soloforge_settings.json (由 Electron 主进程通过
 *   SOLOFORGE_USER_DATA_DIR 环境变量注入), 跟 settings-store.json 同目录, 不飘移
 * - 浏览器模式 (纯 vite dev / preview): 退化到 process.cwd() (开发态可接受)
 * - 内存缓存 + 异步写盘(不阻塞 HTTP 响应)
 * - debounce 100ms 合并连续写入(高频改动时减少 IO)
 * - 文件不存在时返回默认 {}
 * - 服务端权威 — 前端刷新页面/重启 IDE 后仍能加载所有用户偏好
 */

import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { authenticateToken } from '../middleware/auth';

// [2026-06-28 修复路径飘移]
//   之前固定用 process.cwd(), 用户从不同目录启动时镜像写到不同位置, 造成
//   "启动目录改了 → 设置好像没同步过来" 的诡异 bug.
//   现在优先用 Electron 主进程注入的 SOLOFORGE_USER_DATA_DIR (跟 settings-store.json 同位置),
//   没有时退化到 process.cwd() (浏览器模式 / 直接 npm run dev)。
function resolveSettingsFile(): string {
  const userDataDir = process.env.SOLOFORGE_USER_DATA_DIR;
  if (userDataDir && typeof userDataDir === 'string' && userDataDir.trim()) {
    return path.join(userDataDir, '.soloforge_settings.json');
  }
  // 浏览器模式 / 裸启动: cwd 仍是最合理的临时位置
  return path.join(process.cwd(), '.soloforge_settings.json');
}

const SETTINGS_FILE = resolveSettingsFile();

// 简单的内存缓存(避免每次请求都读文件)
let _cache: Record<string, unknown> | null = null;
let _loaded = false;

// 异步写盘:debounce 100ms 合并多次 commit
// 避免高频 PUT(如设置面板拖动)时 fs.writeFileSync 阻塞事件循环导致卡顿
let _writeTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingWrite: Record<string, unknown> | null = null;
let _writing = false;
const FLUSH_DEBOUNCE_MS = 100;

function loadFromDisk(): Record<string, unknown> {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    const text = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    if (!text.trim()) return {};
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // 启动时归一化:历史 bug 可能让磁盘上有嵌套 stringify 的值,自动解套一次
    let normalized = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const cleaned = normalizeForStorage(k, v);
      if (cleaned !== v) normalized = true;
      out[k] = cleaned;
    }
    if (normalized) {
      console.log('[settings] startup normalization applied to .soloforge_settings.json');
      // 触发一次写盘(异步,fire-and-forget)
      _pendingWrite = out;
      if (!_writeTimer) {
        _writeTimer = setTimeout(() => {
          _writeTimer = null;
          const toWrite = _pendingWrite;
          _pendingWrite = null;
          if (toWrite) doWrite(toWrite);
        }, FLUSH_DEBOUNCE_MS);
      }
    }
    return out;
  } catch (e) {
    console.warn('[settings] load failed:', (e as Error).message);
    return {};
  }
}

function writeToDiskAsync(data: Record<string, unknown>): void {
  // 合并到 pending;若已有 timer 则只更新数据
  _pendingWrite = data;
  if (_writeTimer) return;

  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    const toWrite = _pendingWrite;
    _pendingWrite = null;
    if (!toWrite) return;
    doWrite(toWrite);
  }, FLUSH_DEBOUNCE_MS);
}

function doWrite(data: Record<string, unknown>): void {
  if (_writing) {
    // 上一次写还没完,排到队列尾(理论上不会发生,因为我们 fs.writeFile + rename 都很快)
    setTimeout(() => doWrite(data), 10);
    return;
  }
  _writing = true;
  const tmp = SETTINGS_FILE + '.tmp';
  const text = JSON.stringify(data, null, 2);

  fs.writeFile(tmp, text, 'utf-8', (err) => {
    if (err) {
      _writing = false;
      console.error('[settings] writeFile failed:', err.message);
      return;
    }
    fs.rename(tmp, SETTINGS_FILE, (err2) => {
      _writing = false;
      if (err2) {
        // Windows 上偶发:目标文件被占用,短暂重试
        setTimeout(() => doWrite(data), 50);
      }
    });
  });
}

function getAll(): Record<string, unknown> {
  if (!_loaded || _cache === null) {
    _cache = loadFromDisk();
    _loaded = true;
  }
  return _cache;
}

/**
 * 检测 value 是否已经是 JSON 字面量字符串(被 stringify 过)
 * 如果是,说明 client 端做了"防御性存原值",server 端直接存原值
 * 否则,正常存(JS 对象/字符串等)
 */
function normalizeForStorage(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (
    !(trimmed.startsWith('"') && trimmed.endsWith('"')) &&
    !(trimmed.startsWith('[') && trimmed.endsWith(']')) &&
    !(trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    return value;
  }
  try {
    const parsed = JSON.parse(trimmed);
    // 解析回原值,但只在"解析后再 stringify 等于原字符串"时 — 即 value 已经是 JSON 编码
    if (JSON.stringify(parsed) === trimmed) {
      console.warn(`[settings] detected pre-stringified value for key '${key}', unwrapping`);
      return parsed;
    }
    return value;
  } catch {
    return value;
  }
}

/**
 * 同步读取所有 settings(供 server.ts 在 SSR / index.html 注入时使用)
 * 返回 _cache 副本,不会触发磁盘读
 */
export function getAllSettingsSync(): Record<string, unknown> {
  if (!_loaded || _cache === null) {
    _cache = loadFromDisk();
    _loaded = true;
  }
  return { ..._cache };
}

function commit(next: Record<string, unknown>): void {
  _cache = next;
  _loaded = true;
  // 写盘异步化(不阻塞 HTTP 响应)
  writeToDiskAsync(next);
}

/**
 * 强制 flush — 用于 SIGINT/SIGTERM/beforeExit 优雅关闭时确保数据落盘
 */
export function flushSettingsToDiskSync(): void {
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  if (!_pendingWrite) return;
  // 同步写,确保进程退出前数据落盘
  const data = _pendingWrite;
  _pendingWrite = null;
  const tmp = SETTINGS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (e) {
    console.error('[settings] flush failed:', (e as Error).message);
  }
}

function reload(): void {
  _cache = loadFromDisk();
  _loaded = true;
}

/**
 * GET /api/settings
 */
export function handleGetAll(_req: Request, res: Response): Response {
  return res.json({ success: true, settings: getAll() });
}

/**
 * GET /api/settings/:key
 */
export function handleGet(req: Request, res: Response): Response {
  const key = String(req.params.key || '');
  if (!key) return res.status(400).json({ success: false, error: 'key required' });
  const all = getAll();
  if (!(key in all)) return res.json({ success: true, key, value: null });
  return res.json({ success: true, key, value: all[key] });
}

/**
 * PUT /api/settings/:key
 * body: { value: any }
 */
export function handlePut(req: Request, res: Response): Response {
  const key = String(req.params.key || '');
  if (!key) return res.status(400).json({ success: false, error: 'key required' });
  if (!('value' in (req.body || {}))) {
    return res.status(400).json({ success: false, error: 'body.value required' });
  }
  const all = { ...getAll() };
  all[key] = normalizeForStorage(key, req.body.value);
  commit(all);
  return res.json({ success: true, key, value: all[key] });
}

/**
 * PATCH /api/settings
 * body: { <key>: <value>, ... }
 * 批量合并(浅合并),不存在的字段自动添加
 */
export function handlePatch(req: Request, res: Response): Response {
  const patch = req.body;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(400).json({ success: false, error: 'body must be object' });
  }
  const normalizedPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    normalizedPatch[k] = normalizeForStorage(k, v);
  }
  const all = { ...getAll(), ...normalizedPatch };
  commit(all);
  return res.json({ success: true, settings: all });
}

/**
 * DELETE /api/settings/:key
 */
export function handleDelete(req: Request, res: Response): Response {
  const key = String(req.params.key || '');
  if (!key) return res.status(400).json({ success: false, error: 'key required' });
  const all = { ...getAll() };
  if (!(key in all)) {
    return res.json({ success: true }); // 幂等: key 不存在也视为删除成功
  }
  delete all[key];
  commit(all);
  return res.json({ success: true });
}

/**
 * 路由注册
 */
export function registerSettingsRoutes(app: import('express').Express): void {
  app.get('/api/settings', authenticateToken, handleGetAll);
  app.get('/api/settings/:key', authenticateToken, handleGet);
  app.put('/api/settings/:key', authenticateToken, handlePut);
  app.patch('/api/settings', authenticateToken, handlePatch);
  app.delete('/api/settings/:key', authenticateToken, handleDelete);
}

// 测试/管理:重置内存缓存(用于开发模式 HMR 时刷新)
export function _resetSettingsCache(): void {
  _cache = null;
  _loaded = false;
}

// 调试用
export function _reloadSettings(): void {
  reload();
}