/**
 * Conversation API 路由处理器 (Node-only)
 *
 * 路由:
 *   GET    /api/conversations                    → 获取所有对话消息 + 配置
 *   PUT    /api/conversations                    → 全量替换所有对话消息
 *   GET    /api/conversations/:chatId            → 获取单个对话消息
 *   PUT    /api/conversations/:chatId            → 替换单个对话消息
 *   DELETE /api/conversations/:chatId            → 删除单个对话消息
 *   GET    /api/conversations/:chatId/config     → 获取单个对话配置
 *   PUT    /api/conversations/:chatId/config     → 替换单个对话配置
 *   DELETE /api/conversations/:chatId/config     → 删除单个对话配置
 *
 * 错误格式: { success: false, error: string }
 * 成功格式: { success: true, ...payload }
 */

import type { Request, Response } from 'express';
import { getConversationStore, type ChatMessage, type ChatSettingsItem } from '../services/chat/ConversationStore';

function err(res: Response, status: number, message: string): Response {
  return res.status(status).json({ success: false, error: message });
}

function ok(res: Response, payload?: Record<string, unknown>): Response {
  return res.json(payload === undefined ? { success: true } : { success: true, ...payload });
}

/**
 * GET /api/conversations
 * 返回所有对话消息 + 配置 (前端启动时一次性加载)
 */
export function handleGetAllConversations(_req: Request, res: Response): Response {
  const store = getConversationStore();
  return ok(res, {
    conversations: store.getAllConversations(),
    configs: store.getAllConfigs(),
  });
}

/**
 * PUT /api/conversations
 * body: { conversations: Record<string, ChatMessage[]>, configs?: Record<string, ChatSettingsItem> }
 * 全量替换 (前端防抖同步)
 */
export function handlePutAllConversations(req: Request, res: Response): Response {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  if (!body.conversations || typeof body.conversations !== 'object') {
    return err(res, 400, 'conversations (object) required');
  }
  const store = getConversationStore();
  store.setAllConversations(body.conversations);
  if (body.configs && typeof body.configs === 'object') {
    store.setAllConfigs(body.configs);
  }
  return ok(res);
}

/**
 * GET /api/conversations/:chatId
 */
export function handleGetConversation(req: Request, res: Response): Response {
  const chatId = String(req.params.chatId || '');
  if (!chatId) return err(res, 400, 'chatId required');
  const store = getConversationStore();
  const messages = store.getConversation(chatId);
  return ok(res, { messages: messages ?? [] });
}

/**
 * PUT /api/conversations/:chatId
 * body: { messages: ChatMessage[] }
 */
export function handlePutConversation(req: Request, res: Response): Response {
  const chatId = String(req.params.chatId || '');
  if (!chatId) return err(res, 400, 'chatId required');
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  if (!Array.isArray(body.messages)) {
    return err(res, 400, 'messages (array) required');
  }
  const store = getConversationStore();
  store.setConversation(chatId, body.messages as ChatMessage[]);
  return ok(res);
}

/**
 * DELETE /api/conversations/:chatId
 * 级联删除消息 + 配置
 */
export function handleDeleteConversation(req: Request, res: Response): Response {
  const chatId = String(req.params.chatId || '');
  if (!chatId) return err(res, 400, 'chatId required');
  const store = getConversationStore();
  const result = store.deleteAllForChat(chatId);
  return ok(res, result);
}

/**
 * GET /api/conversations/:chatId/config
 */
export function handleGetConfig(req: Request, res: Response): Response {
  const chatId = String(req.params.chatId || '');
  if (!chatId) return err(res, 400, 'chatId required');
  const store = getConversationStore();
  const config = store.getConfig(chatId);
  return ok(res, { config });
}

/**
 * PUT /api/conversations/:chatId/config
 * body: ChatSettingsItem
 */
export function handlePutConfig(req: Request, res: Response): Response {
  const chatId = String(req.params.chatId || '');
  if (!chatId) return err(res, 400, 'chatId required');
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  if (typeof body.enabledSkills !== 'object' || typeof body.contextSize !== 'number') {
    return err(res, 400, 'invalid ChatSettingsItem body');
  }
  const store = getConversationStore();
  store.setConfig(chatId, body as ChatSettingsItem);
  return ok(res);
}

/**
 * DELETE /api/conversations/:chatId/config
 */
export function handleDeleteConfig(req: Request, res: Response): Response {
  const chatId = String(req.params.chatId || '');
  if (!chatId) return err(res, 400, 'chatId required');
  const store = getConversationStore();
  store.deleteConfig(chatId);
  return ok(res);
}

/**
 * 路由注册
 *
 * 注意: /api/conversations/:chatId/config 是静态子路径, 必须在 /:chatId 之前注册
 * 注意: 必须在 3001 代理之前注册
 */
export function registerConversationRoutes(app: import('express').Express): void {
  // 批量端点 (无 :chatId)
  app.get('/api/conversations', handleGetAllConversations);
  app.put('/api/conversations', handlePutAllConversations);
  // 单个对话配置端点 (静态子路径, 必须在 :chatId 前)
  app.get('/api/conversations/:chatId/config', handleGetConfig);
  app.put('/api/conversations/:chatId/config', handlePutConfig);
  app.delete('/api/conversations/:chatId/config', handleDeleteConfig);
  // 单个对话消息端点
  app.get('/api/conversations/:chatId', handleGetConversation);
  app.put('/api/conversations/:chatId', handlePutConversation);
  app.delete('/api/conversations/:chatId', handleDeleteConversation);
  console.log('[conversations] /api/conversations/* 路由已注册 (8 endpoints)');
}

/**
 * 优雅退出: 进程退出时同步 flush 到磁盘
 */
export function flushConversationStore(): void {
  try {
    getConversationStore().flushNow();
  } catch (e) {
    console.warn('[conversations] flushConversationStore failed:', (e as Error).message);
  }
}
