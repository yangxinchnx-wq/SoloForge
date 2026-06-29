/**
 * IPCAdapter.ts — 预览 IPC 统一入口（仅 LLM pipeline）
 *
 * 设计动机：
 *   - 旧 DSL pipeline 已废弃，本文件只做 LLM pipeline 的薄封装
 *   - 保留 IPCAdapter 这个名字是为了不破坏既有引用点
 *   - 内部直接转发到 streamPreviewForChat
 *
 * 用法：
 *   await IPCAdapter.preview({ sessionId, deviceId, chatId, language, userGoal });
 *
 * 必需参数：sessionId、chatId、language、userGoal
 * 可选参数：deviceId、llmClient、canvasClient
 */

import type { Canvas3DClient } from './Canvas3DClient';
import { pipelineConfig } from './pipelineConfig';
import { streamPreviewForChat, type StreamPreviewHandle } from '../chatStreamOrchestrator';
import { LLMClient } from '../llm/LLMClient';

export interface PreviewOptions {
  sessionId: string;
  deviceId?: string;
  chatId: string;
  /** 新 LLM pipeline 用 */
  language: string;
  userGoal: string;
  /** 客户端注入（测试用） */
  canvasClient?: Canvas3DClient;
  llmClient?: LLMClient;
}

export type PreviewHandle = StreamPreviewHandle;

/**
 * 预览入口
 * LLM streaming → parser → IPC → canvas
 */
export function preview(opts: PreviewOptions): PreviewHandle {
  if (!opts.language || !opts.userGoal) {
    throw new Error('IPCAdapter.preview: language + userGoal required');
  }
  if (!opts.chatId) {
    throw new Error('IPCAdapter.preview: chatId required');
  }
  return streamPreviewForChat({
    chatId: opts.chatId,
    language: opts.language,
    userGoal: opts.userGoal,
    deviceId: opts.deviceId,
    llmClient: opts.llmClient,
    canvasClient: opts.canvasClient,
    pushIntervalMs: pipelineConfig.pushIntervalMs,
  });
}

/** 顶层 facade（保持与早期 API 调用点兼容） */
export const IPCAdapter = {
  preview,
};
