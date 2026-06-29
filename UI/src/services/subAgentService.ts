/**
 * subAgentService — 子Agent 三层存储管理
 * Garnet（热缓存）+ SurrealDB（持久化）+ AI社会SQLite（信誉）
 * 生命周期：与对话强绑定，对话删除时级联销毁
 *
 * UI 持久化：localStorage（同步） + server 镜像（setLocal，自动 PUT）
 */
import type { SubAgent } from '../types/streaming';
import { getDefaultStore } from '../state/settings';

const STORAGE_KEY = 'soloforge_sub_agents';
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 从 store 加载所有子Agent */
export function loadSubAgents(): Record<string, SubAgent[]> {
  return getDefaultStore().get<Record<string, SubAgent[]>>(STORAGE_KEY) ?? {};
}

/** 保存到 store */
function saveSubAgents(data: Record<string, SubAgent[]>): void {
  getDefaultStore().set(STORAGE_KEY, data);
}

/** 按对话获取子Agent列表 */
export function getSubAgentsByChat(chatId: string): SubAgent[] {
  const all = loadSubAgents();
  return all[chatId] ?? [];
}

/** 创建子Agent */
export function createSubAgent(
  chatId: string,
  role: 'auditor' | 'assistant',
  parentModelId: string,
): SubAgent {
  const all = loadSubAgents();
  const agent: SubAgent = {
    id: uid(),
    chatId,
    role,
    parentModelId,
    reputation: 0.5,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  all[chatId] = [...(all[chatId] ?? []), agent];
  saveSubAgents(all);
  return agent;
}

/** 更新子Agent活跃时间 */
export function touchSubAgent(agentId: string, chatId: string): void {
  const all = loadSubAgents();
  const agents = all[chatId];
  if (!agents) return;
  const idx = agents.findIndex(a => a.id === agentId);
  if (idx === -1) return;
  agents[idx] = { ...agents[idx], lastActiveAt: Date.now() };
  saveSubAgents(all);
}

/** 更新子Agent信誉分 */
export function updateReputation(agentId: string, chatId: string, delta: number): void {
  const all = loadSubAgents();
  const agents = all[chatId];
  if (!agents) return;
  const idx = agents.findIndex(a => a.id === agentId);
  if (idx === -1) return;
  agents[idx] = {
    ...agents[idx],
    reputation: Math.max(0, Math.min(1, agents[idx].reputation + delta)),
  };
  saveSubAgents(all);
}

/** 删除对话下的所有子Agent */
export function deleteSubAgentsByChat(chatId: string): void {
  const all = loadSubAgents();
  delete all[chatId];
  saveSubAgents(all);
}

/** 删除单个子Agent */
export function deleteSubAgent(agentId: string, chatId: string): void {
  const all = loadSubAgents();
  const agents = all[chatId];
  if (!agents) return;
  all[chatId] = agents.filter(a => a.id !== agentId);
  saveSubAgents(all);
}

/** 获取或创建审查子Agent */
export function ensureAuditor(chatId: string, parentModelId: string): SubAgent {
  const existing = getSubAgentsByChat(chatId).find(a => a.role === 'auditor');
  if (existing) {
    touchSubAgent(existing.id, chatId);
    return existing;
  }
  return createSubAgent(chatId, 'auditor', parentModelId);
}

/** 检查是否需要创建子Agent（根据模型数判断） */
export function shouldCreateSubAgent(modelCount: number): boolean {
  return modelCount === 1; // 仅 1 个模型时创建子Agent
}

/** 检查子Agent是否应参与决策（根据模型数判断） */
export function shouldSubAgentParticipate(modelCount: number): boolean {
  return modelCount <= 2; // 3+ 模型时不参与，避免混淆权重
}