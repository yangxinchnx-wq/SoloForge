/**
 * ChatPanel 类型定义 + 配置格式化函数
 *
 * 2026-07-03 阶段3.1.A 从 ChatPanel.tsx 抽出，统一所有 chat 相关类型入口。
 * ChatMessage / ChatSettingsItem / getSettingsSummary 均不再在 ChatPanel.tsx 内定义。
 */

import type { ToolCall } from '../types';

export interface ChatMessage {
  sender: 'user' | 'assistant';
  content: string;
  time: string;
  avatar: string;
  attachment?: {
    fileName: string;
    text: string;
  };
  toolCalls?: ToolCall[];
  /** 经验路径指纹 (仅 experience 策略有值, 供 👍/👎 反馈定位经验) */
  experienceFingerprint?: string;
}

export interface ChatSettingsItem {
  enabledSkills: string[];
  contextSize: number;
  personality: 'professional' | 'sarcastic' | 'zen' | 'geek';
  tone: 'detailed' | 'concise' | 'humorous';
  emojiEnabled: boolean;
  emojiType: 'standard' | 'kaomoji' | 'mixed';
  /** Phase 4: Agent ID (手动选择, 默认 code_agent, 由 Java 服务 AgentOrchestrator 路由) */
  agentId?: string;
}

export interface ChatPanelProps {
  permissionMode?: 'normal' | 'performance' | 'ultimate' | 'expert';
  setPermissionMode?: (mode: 'normal' | 'performance' | 'ultimate' | 'expert') => void;
  primaryColorTargets?: {
    activityBar: boolean;
    skillBar: boolean;
    header: boolean;
    chatPanel: boolean;
    editorAndExplorer: boolean;
  };
  selectedChatId?: string;
  mainModel?: string;
  secModels?: any[];
  mixedTasks?: boolean;
  selectedFile?: string;
  editorContent?: string;
  modelProviderMap?: Record<string, {
    baseUrl: string;
    apiKey: string;
    model: string;
    providerName: string;
    enabledInSettings: boolean;
  }>;
}

/**
 * ChatSettingsItem → 中文短串 formatter
 * 例: "code_agent | 专业 | 详尽 | 32k 窗口 | 表情开 (2 SK)"
 */
export function getSettingsSummary(s: ChatSettingsItem): string {
  const pMap = { professional: '专业', sarcastic: '毒舌', zen: '禅意', geek: '极客' };
  const tMap = { detailed: '详尽', concise: '简短', humorous: '幽默' };
  const em = s.emojiEnabled ? '表情开' : '表情关';
  const ctxStr = s.contextSize >= 132000 ? '无限制' : `${s.contextSize / 1000}k`;
  const agent = s.agentId || 'code_agent';
  return `${agent} | ${pMap[s.personality]} | ${tMap[s.tone]} | ${ctxStr} 窗口 | ${em} (${s.enabledSkills.length} SK)`;
}
