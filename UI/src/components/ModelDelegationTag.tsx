/**
 * ModelDelegationTag — 副模型调用 agent 的委派标签
 * 显示「副模型 → 💻 agent名 → 任务」
 *
 * 2026-07-11: 改为副模型驱动架构
 *   fromModel = 副模型名 (调用者)
 *   agentName + agentAvatar = 被调用的 Java agent
 *   task = 任务描述
 */
import React from 'react';
import { ArrowRight, Bot } from '../utils/icons';

interface ModelDelegationTagProps {
  fromModel: string;        // 副模型名 (调用者)
  task: string;
  agentName?: string;       // Agent 名字（由调用方从 agentsMap 实时查询传入）
  agentAvatar?: string;     // Agent 头像 (emoji 或图片 URL)
  className?: string;
}

/** 渲染 agent 头像: emoji 文本 / 图片 URL / 默认 Bot 图标 */
function AgentAvatar({ avatar, className = '' }: { avatar?: string; className?: string }) {
  if (!avatar) return <Bot className={`w-3 h-3 text-primary/60 ${className}`} />;
  // 图片 URL (http/https/相对路径)
  if (avatar.startsWith('http') || avatar.startsWith('/') || avatar.startsWith('data:')) {
    return <img src={avatar} alt="" className={`w-3.5 h-3.5 rounded-full object-cover ${className}`} />;
  }
  // emoji 文本
  return <span className={`text-xs leading-none ${className}`}>{avatar}</span>;
}

export function ModelDelegationTag({ fromModel, task, agentName, agentAvatar, className = '' }: ModelDelegationTagProps) {
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/5 border border-primary/15 text-[10px] ${className}`}>
      <span className="text-primary font-bold">{fromModel}</span>
      <ArrowRight className="w-3 h-3 text-on-surface/30" />
      <AgentAvatar avatar={agentAvatar} />
      {agentName && (
        <span className="text-primary font-bold">{agentName}</span>
      )}
      <ArrowRight className="w-3 h-3 text-on-surface/30" />
      <span className="text-on-surface/70 font-medium truncate max-w-[120px]">{task}</span>
    </div>
  );
}
