/**
 * E2B Sandbox Service — 管理每个对话的独立云沙箱
 *
 * 架构：
 *  - 每个 chatId 持有一个 E2B Sandbox 实例
 *  - 沙箱在首次工具调用时自动创建，对话删除时销毁
 *  - 命令执行通过后端 API 代理（避免前端直接持有 E2B API Key）
 *
 * 流程：
 *  LLM 发起 tool_call: sandbox.execute
 *  → 后端 /api/e2b/execute 代理执行
 *  → SSE 流式返回 stdout/stderr
 *  → ChatPanel 渲染 SandboxTerminalCard
 *
 * UI 持久化：localStorage（同步） + server 镜像（setLocal，自动 PUT）
 */
import { getDefaultStore } from '../../state/settings';

export interface SandboxState {
  sandboxId: string;
  chatId: string;
  status: 'creating' | 'ready' | 'error' | 'destroyed';
  createdAt: number;
  lastActiveAt: number;
  error?: string;
}

export interface SandboxExecuteResult {
  sandboxId: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTime: number;
}

export interface SandboxExecuteCall {
  id: string;
  kind: 'sandbox.execute';
  status: 'running' | 'success' | 'error';
  command: string;
  sandboxId: string;
  chatId: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  executionTime?: number;
  errorCode?: string;
  timestamp: number;
}

// ==================== 沙箱生命周期管理 ====================

const STORAGE_KEY = 'soloforge_e2b_sandboxes';

function loadSandboxes(): Record<string, SandboxState> {
  return getDefaultStore().get<Record<string, SandboxState>>(STORAGE_KEY) ?? {};
}

function saveSandboxes(data: Record<string, SandboxState>): void {
  getDefaultStore().set(STORAGE_KEY, data);
}

/** 获取对话的沙箱状态 */
export function getSandbox(chatId: string): SandboxState | null {
  return loadSandboxes()[chatId] ?? null;
}

/** 创建沙箱（调用后端 API） */
export async function createSandbox(chatId: string, modelId: string = 'default'): Promise<SandboxState> {
  const existing = getSandbox(chatId);
  if (existing && existing.status === 'ready') return existing;

  // 标记为 creating 状态
  const creating: SandboxState = {
    sandboxId: '',
    chatId,
    status: 'creating',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  const all = loadSandboxes();
  all[chatId] = creating;
  saveSandboxes(all);

  try {
    const res = await fetch('/api/e2b/sandbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, model_id: modelId }),
    });
    if (!res.ok) throw new Error(`创建沙箱失败: ${res.status}`);
    const data = await res.json();

    const ready: SandboxState = {
      sandboxId: data.sandbox_id,
      chatId,
      status: 'ready',
      createdAt: data.created_at * 1000,
      lastActiveAt: Date.now(),
    };
    const all2 = loadSandboxes();
    all2[chatId] = ready;
    saveSandboxes(all2);
    return ready;
  } catch (err: any) {
    const error: SandboxState = {
      sandboxId: '',
      chatId,
      status: 'error',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      error: err.message,
    };
    const all3 = loadSandboxes();
    all3[chatId] = error;
    saveSandboxes(all3);
    throw err;
  }
}

/** 在沙箱中执行命令（调用后端 API） */
export async function executeSandboxCommand(
  sandboxId: string,
  command: string,
  cwd?: string,
  timeout?: number,
): Promise<SandboxExecuteResult> {
  const res = await fetch(`/api/e2b/sandbox/${sandboxId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, cwd, timeout }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'unknown error' }));
    throw new Error(err.detail || `执行失败: ${res.status}`);
  }
  const data = await res.json();
  return {
    sandboxId: data.sandbox_id,
    command: data.command,
    stdout: data.stdout,
    stderr: data.stderr,
    exitCode: data.exit_code,
    executionTime: data.execution_time_ms,
  };
}

/** 销毁对话的沙箱 */
export async function destroySandbox(chatId: string): Promise<void> {
  const sandbox = getSandbox(chatId);
  if (!sandbox || sandbox.status === 'destroyed') return;

  try {
    if (sandbox.sandboxId) {
      await fetch(`/api/e2b/sandbox/${sandbox.sandboxId}`, { method: 'DELETE' });
    }
  } catch { /* ignore */ }

  const all = loadSandboxes();
  if (all[chatId]) {
    all[chatId] = { ...all[chatId], status: 'destroyed' };
    saveSandboxes(all);
  }
}

/** 确保沙箱存在（不存在则创建） */
export async function ensureSandbox(chatId: string, modelId?: string): Promise<SandboxState> {
  const existing = getSandbox(chatId);
  if (existing && existing.status === 'ready') return existing;
  return createSandbox(chatId, modelId);
}

/** 更新沙箱最后活跃时间 */
export function touchSandbox(chatId: string): void {
  const all = loadSandboxes();
  if (all[chatId]) {
    all[chatId].lastActiveAt = Date.now();
    saveSandboxes(all);
  }
}