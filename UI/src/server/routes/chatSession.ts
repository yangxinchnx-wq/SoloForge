/**
 * Chat Session API 路由处理器 (Node-only)
 *
 * 路由 (与前端 chatsStore.ts API 契约对齐):
 *   GET    /api/chats/list              → 列出所有对话 + 选中ID + liveStates
 *   POST   /api/chats                   → 创建新对话
 *   PATCH  /api/chats/:id               → 更新对话 (title/tag/permission/lastMessagePreview)
 *   DELETE /api/chats/:id               → 删除对话 (级联删除画布)
 *   POST   /api/chats/reorder           → 重排对话顺序
 *   POST   /api/chats/select            → 设置当前选中对话
 *   POST   /api/chats/:id/state         → 上报实时流式状态
 *   DELETE /api/chats/:id/state         → 清除实时流式状态
 *
 * 错误格式: { success: false, error: string }
 * 成功格式: { success: true, ...payload }
 */

import type { Request, Response } from 'express';
import { getChatStore, type ChatPermission, type ChatTag, type ChatLiveState, TAG_STYLES } from '../services/chat/ChatStore';

function err(res: Response, status: number, message: string): Response {
  return res.status(status).json({ success: false, error: message });
}

function ok(res: Response, payload?: Record<string, unknown>): Response {
  return res.json(payload === undefined ? { success: true } : { success: true, ...payload });
}

const VALID_TAGS: ChatTag[] = ['VUE', 'AUTH', 'AI', 'DB', 'PAY', 'HELP', 'NEW', 'WINDOWS', 'HARMONY'];
const VALID_PERMS: ChatPermission[] = ['normal', 'performance', 'ultimate', 'expert'];

/**
 * GET /api/chats/list
 */
export function handleListChats(_req: Request, res: Response): Response {
  const store = getChatStore();
  const { chats, selectedId, liveStates } = store.list();
  return ok(res, { chats, selectedId, liveStates });
}

/**
* POST /api/chats
* body: { title?: string, permission?: ChatPermission, workspaceFolder?: string }
*/
export function handleCreateChat(req: Request, res: Response): Response {
const body = (req.body && typeof req.body === 'object') ? req.body : {};
const title = typeof body.title === 'string' ? body.title : undefined;
const permission: ChatPermission = VALID_PERMS.includes(body.permission) ? body.permission : 'normal';
const workspaceFolder = typeof body.workspaceFolder === 'string' ? body.workspaceFolder : undefined;
const store = getChatStore();
const chat = store.createChat(title, permission, workspaceFolder);
return ok(res, { chat, selectedId: store.getSelectedId() });
}

/**
 * PATCH /api/chats/:id
 * body: { title?, tag?, permission?, lastMessagePreview? }
 */
export function handleUpdateChat(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'chat id required');
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const patch: Record<string, unknown> = {};
  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.tag === 'string' && VALID_TAGS.includes(body.tag as ChatTag)) patch.tag = body.tag;
  if (typeof body.permission === 'string' && VALID_PERMS.includes(body.permission as ChatPermission)) patch.permission = body.permission;
  if (typeof body.lastMessagePreview === 'string') patch.lastMessagePreview = body.lastMessagePreview;
if (typeof body.workspaceFolder === 'string') patch.workspaceFolder = body.workspaceFolder;
  if (Object.keys(patch).length === 0) return err(res, 400, 'no valid fields to update');
  const store = getChatStore();
  const updated = store.updateChat(id, patch as any);
  if (!updated) return err(res, 404, 'chat not found');
  return ok(res, { chat: updated });
}

/**
 * DELETE /api/chats/:id
 * 级联删除: 同时删除该 chat 拥有的所有画布
 */
export async function handleDeleteChat(req: Request, res: Response): Promise<Response> {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'chat id required');
  const store = getChatStore();
  const result = store.deleteChat(id);
  if (!result.deleted) return err(res, 404, 'chat not found');

  // 级联删除画布 (复用已有的 SessionStore 逻辑)
  try {
    const { getSessionStore } = await import('../services/session/SessionStore');
    const deletedCanvases = await getSessionStore().deleteCanvasesByOwner(id);
    console.log(`[chats] DELETE chat=${id} cascaded delete canvases:`, deletedCanvases);
  } catch (e) {
    console.warn(`[chats] DELETE chat=${id} cascade delete canvases failed:`, (e as Error).message);
  }

  // 级联删除对话消息 + 配置
  try {
    const { getConversationStore } = await import('../services/chat/ConversationStore');
    const deleted = await getConversationStore().deleteAllForChat(id);
    console.log(`[chats] DELETE chat=${id} cascaded delete conversations:`, deleted);
  } catch (e) {
    console.warn(`[chats] DELETE chat=${id} cascade delete conversations failed:`, (e as Error).message);
  }

  return ok(res, { selectedId: result.nextSelectedId });
}

/**
 * POST /api/chats/reorder
 * body: { order: string[] }
 */
export function handleReorderChats(req: Request, res: Response): Response {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  if (!Array.isArray(body.order) || !body.order.every((x: unknown) => typeof x === 'string')) {
    return err(res, 400, 'order (string[]) required');
  }
  const store = getChatStore();
  store.reorder(body.order as string[]);
  return ok(res);
}

/**
 * POST /api/chats/select
 * body: { id: string | null }
 */
export function handleSelectChat(req: Request, res: Response): Response {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const id = body.id === null ? null : (typeof body.id === 'string' ? body.id : undefined);
  if (id === undefined) return err(res, 400, 'id (string | null) required');
  const store = getChatStore();
  if (id !== null && !store.getChat(id)) return err(res, 404, 'chat not found');
  store.selectChat(id);
  return ok(res);
}

/**
 * POST /api/chats/:id/state
 * body: ChatLiveState
 */
export function handleSetLiveState(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'chat id required');
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  if (typeof body.isStreaming !== 'boolean') return err(res, 400, 'isStreaming (boolean) required');
  const state: ChatLiveState = {
    chatId: id,
    isStreaming: body.isStreaming,
    phase: typeof body.phase === 'string' ? body.phase : undefined,
    progress: typeof body.progress === 'number' ? body.progress : undefined,
    modelName: typeof body.modelName === 'string' ? body.modelName : undefined,
    tokens: typeof body.tokens === 'number' ? body.tokens : undefined,
    lastActivityAt: typeof body.lastActivityAt === 'number' ? body.lastActivityAt : Date.now(),
  };
  const store = getChatStore();
  store.setLiveState(state);
  return ok(res);
}

/**
 * DELETE /api/chats/:id/state
 */
export function handleClearLiveState(req: Request, res: Response): Response {
  const id = String(req.params.id || '');
  if (!id) return err(res, 400, 'chat id required');
  const store = getChatStore();
  store.clearLiveState(id);
  return ok(res);
}

/**
 * 路由注册 (挂到 Express app)
 *
 * 注意: 必须在 3001 代理之前注册, 否则 /api/chats/* 会被代理转发到 3001 命中 404
 * 注意: /list, /reorder, /select 是静态路径, 必须在 /:id 之前注册
 */
export function registerChatSessionRoutes(app: import('express').Express): void {
  app.get('/api/chats/list', handleListChats);
  app.post('/api/chats', handleCreateChat);
  app.post('/api/chats/reorder', handleReorderChats);
  app.post('/api/chats/select', handleSelectChat);
  app.patch('/api/chats/:id', handleUpdateChat);
  app.delete('/api/chats/:id', handleDeleteChat);
  app.post('/api/chats/:id/state', handleSetLiveState);
  app.delete('/api/chats/:id/state', handleClearLiveState);
  console.log('[chats] /api/chats/* 路由已注册 (8 endpoints)');
}

/**
 * 优雅退出: 进程退出时 flush 到热+温存储
 */
export function flushChatStore(): void {
  try {
    void getChatStore().flushNow();
  } catch (e) {
    console.warn('[chats] flushChatStore failed:', (e as Error).message);
  }
}
