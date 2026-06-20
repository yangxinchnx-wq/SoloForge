/**
 * mxc-guard.ts — 工具执行前的安全拦截层
 *
 * 流程：
 *   1. 检查当前模式（normal/performance/expert/ultimate）
 *   2. 检查白名单
 *   3. normal 模式 → 发 pending_approval 等待用户决策
 *   4. performance 模式 → 首次弹窗，同类型自动放行
 *   5. expert/ultimate 模式 → 直接放行
 */

import * as fs from 'fs';
import * as path from 'path';

export type PermissionMode = 'normal' | 'performance' | 'expert' | 'ultimate';

export interface ToolCallRequest {
  tool: string;
  command: string;
  context?: Record<string, any>;
}

export interface MxcGuardOptions {
  mode: PermissionMode;
  whitelist: string[];
  sendSse: (event: string, data: any) => void;
  waitForDecision: (approval: {
    id: string;
    command: string;
    reason: string;
    consequences: string[];
    source: string;
  }) => Promise<string>;
  onWhitelistUpdate?: (command: string) => void;
}

const sessionApproved = new Set<string>();

export async function checkToolPermission(
  request: ToolCallRequest,
  options: MxcGuardOptions
): Promise<{ allowed: boolean; reason?: string }> {
  const { mode, whitelist, sendSse, waitForDecision, onWhitelistUpdate } = options;

  if (mode === 'expert' || mode === 'ultimate') {
    return { allowed: true };
  }

  const isWhitelisted = whitelist.some(w =>
    request.command === w || request.command.startsWith(w + ' ')
  );
  if (isWhitelisted) return { allowed: true };

  if (mode === 'performance') {
    const cacheKey = `${request.tool}:${request.command}`;
    if (sessionApproved.has(cacheKey)) return { allowed: true };
  }

  const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const consequences = estimateConsequences(request);

  sendSse('pending_approval', {
    id: approvalId,
    command: request.command,
    reason: `「${request.tool}」请求执行此操作，当前模式需要确认`,
    consequences,
    source: request.tool,
  });

  const decision = await waitForDecision({
    id: approvalId,
    command: request.command,
    reason: `「${request.tool}」请求执行此操作`,
    consequences,
    source: request.tool,
  });

  if (decision === 'reject') return { allowed: false, reason: '用户拒绝了此操作' };
  if (decision === 'whitelist') onWhitelistUpdate?.(request.command);

  if (mode === 'performance') {
    sessionApproved.add(`${request.tool}:${request.command}`);
  }

  return { allowed: true };
}

function estimateConsequences(request: ToolCallRequest): string[] {
  const cmd = request.command.toLowerCase();
  const consequences: string[] = [];

  // 精确匹配危险命令(空格前后或行首行尾),避免误伤 farm / remote / format 等
  const words = cmd.split(/\s+/);
  if (words.includes('rm') || words.includes('del') || words.includes('delete') || cmd.startsWith('rm ')) {
    consequences.push('文件/目录将被永久删除');
  }
  if (words.includes('edit') || words.includes('replace') || words.includes('write')) consequences.push('文件内容将被修改');
  if (words.includes('install') || words.includes('npm') || words.includes('pip')) consequences.push('将下载并安装新的依赖包');
  if (words.includes('push')) consequences.push('代码将被推送到远程仓库');
  if (words.includes('curl') || words.includes('wget') || words.includes('fetch')) consequences.push('将发起网络请求');
  if (words.includes('exec') || words.includes('eval')) consequences.push('将执行代码或命令');

  if (consequences.length === 0) consequences.push('将执行工具操作');
  return consequences;
}

/** 默认白名单文件路径（进程 cwd/data/mxc_whitelist.json） */
export const MXC_WHITELIST_PATH = path.join(process.cwd(), 'data', 'mxc_whitelist.json');

export function loadWhitelist(filePath?: string): string[] {
  const target = filePath ?? MXC_WHITELIST_PATH;
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch { return []; }
}

export function saveWhitelist(filePath: string, list: string[]): void {
  try { fs.writeFileSync(filePath, JSON.stringify(list, null, 2)); } catch (err) { console.error('[MXC] 白名单保存失败:', err); }
}
