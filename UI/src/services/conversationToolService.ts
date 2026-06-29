/**
 * conversationToolService — 对话级工具/技能/知识库隔离
 * 每个对话独立配置，未启用不可调用，按对话切换时自动切换
 * 存储：localStorage（同步） + server 镜像（setLocal，自动 PUT）
 */
import { getDefaultStore } from '../state/settings';

const STORAGE_KEY = 'soloforge_conversation_tools';

export interface ConversationToolConfig {
  tools: Set<string>;       // 已启用的工具 ID
  skills: Set<string>;      // 已启用的技能 ID
  knowledge: Set<string>;   // 已启用的知识库 ID
  suggestedTools: Set<string>; // 已建议过的工具（避免重复建议）
}

interface SerializedConfig {
  tools: string[];
  skills: string[];
  knowledge: string[];
  suggestedTools: string[];
}

function serialize(config: ConversationToolConfig): SerializedConfig {
  return {
    tools: [...config.tools],
    skills: [...config.skills],
    knowledge: [...config.knowledge],
    suggestedTools: [...config.suggestedTools],
  };
}

function deserialize(data: SerializedConfig): ConversationToolConfig {
  return {
    tools: new Set(data.tools),
    skills: new Set(data.skills),
    knowledge: new Set(data.knowledge),
    suggestedTools: new Set(data.suggestedTools ?? []),
  };
}

/** 加载所有对话的工具配置 */
export function loadToolConfigs(): Record<string, ConversationToolConfig> {
  const parsed = getDefaultStore().get<Record<string, SerializedConfig>>(STORAGE_KEY);
  if (!parsed) return {};
  const result: Record<string, ConversationToolConfig> = {};
  for (const [chatId, config] of Object.entries(parsed)) {
    result[chatId] = deserialize(config);
  }
  return result;
}

/** 保存所有对话的工具配置 */
function saveToolConfigs(data: Record<string, ConversationToolConfig>): void {
  const serialized: Record<string, SerializedConfig> = {};
  for (const [chatId, config] of Object.entries(data)) {
    serialized[chatId] = serialize(config);
  }
  getDefaultStore().set(STORAGE_KEY, serialized);
}

/** 获取对话的工具配置 */
export function getToolConfig(chatId: string): ConversationToolConfig {
  const all = loadToolConfigs();
  return all[chatId] ?? {
    tools: new Set(),
    skills: new Set(),
    knowledge: new Set(),
    suggestedTools: new Set(),
  };
}

/** 启用工具 */
export function enableTool(chatId: string, toolId: string): void {
  const all = loadToolConfigs();
  const config = all[chatId] ?? getToolConfig(chatId);
  config.tools.add(toolId);
  all[chatId] = config;
  saveToolConfigs(all);
}

/** 启用技能 */
export function enableSkill(chatId: string, skillId: string): void {
  const all = loadToolConfigs();
  const config = all[chatId] ?? getToolConfig(chatId);
  config.skills.add(skillId);
  all[chatId] = config;
  saveToolConfigs(all);
}

/** 启用知识库 */
export function enableKnowledge(chatId: string, knowledgeId: string): void {
  const all = loadToolConfigs();
  const config = all[chatId] ?? getToolConfig(chatId);
  config.knowledge.add(knowledgeId);
  all[chatId] = config;
  saveToolConfigs(all);
}

/** 检查工具是否已启用 */
export function isToolEnabled(chatId: string, toolId: string): boolean {
  return getToolConfig(chatId).tools.has(toolId);
}

/** 检查是否应该建议该工具 */
export function shouldSuggestTool(chatId: string, toolId: string): boolean {
  const config = getToolConfig(chatId);
  return !config.tools.has(toolId) && !config.suggestedTools.has(toolId);
}

/** 标记工具已建议 */
export function markToolSuggested(chatId: string, toolId: string): void {
  const all = loadToolConfigs();
  const config = all[chatId] ?? getToolConfig(chatId);
  config.suggestedTools.add(toolId);
  all[chatId] = config;
  saveToolConfigs(all);
}

/** 删除对话的工具配置 */
export function deleteToolConfig(chatId: string): void {
  const all = loadToolConfigs();
  delete all[chatId];
  saveToolConfigs(all);
}

/** 获取启用的工具数量 */
export function getEnabledCount(chatId: string): { tools: number; skills: number; knowledge: number } {
  const config = getToolConfig(chatId);
  return {
    tools: config.tools.size,
    skills: config.skills.size,
    knowledge: config.knowledge.size,
  };
}