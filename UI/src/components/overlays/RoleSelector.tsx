// ─────────────────────────────────────────────────────────────────
// AI 角色选择器 (浮层)
// 不同角色有不同的人设和工具集
// ─────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { Tooltip, Button, Badge } from '../ui/Button';

export type AgentRole = 'assistant' | 'coder' | 'analyst' | 'planner' | 'reviewer' | 'teacher';

interface Role {
  id: AgentRole;
  name: string;
  description: string;
  icon: string;
  color: string;
  capabilities: string[];
  systemPrompt: string;
}

export const ROLES: Role[] = [
  {
    id: 'assistant', name: '通用助手', icon: 'token', color: 'text-primary',
    description: '全能型助手，回答问题、写文档、做总结',
    capabilities: ['对话', '写作', '总结', '翻译'],
    systemPrompt: '你是 SoloForge 的 AI 助手',
  },
  {
    id: 'coder', name: '代码工程师', icon: 'code', color: 'text-accent',
    description: '专注于代码生成、调试、重构',
    capabilities: ['代码生成', '调试', '重构', '测试'],
    systemPrompt: '你是一位资深工程师，擅长 TS/Rust/Python',
  },
  {
    id: 'analyst', name: '数据分析师', icon: 'analytics', color: 'text-success',
    description: '处理数据、生成报告、画图表',
    capabilities: ['数据分析', 'SQL', '可视化', '统计'],
    systemPrompt: '你是一位数据分析师，擅长 SQL 和可视化',
  },
  {
    id: 'planner', name: '项目规划师', icon: 'route', color: 'text-warning',
    description: '拆解任务、规划路径、给出里程碑',
    capabilities: ['任务拆解', '规划', '里程碑', '风险评估'],
    systemPrompt: '你是项目规划专家，擅长拆解复杂任务',
  },
  {
    id: 'reviewer', name: '代码审查员', icon: 'rate_review', color: 'text-danger',
    description: '审查代码质量、安全、性能',
    capabilities: ['代码审查', '安全审计', '性能分析'],
    systemPrompt: '你是代码审查专家，关注安全与性能',
  },
  {
    id: 'teacher', name: '导师模式', icon: 'school', color: 'text-text',
    description: '耐心教学，由浅入深',
    capabilities: ['教学', '示例', '类比', '练习'],
    systemPrompt: '你是一位耐心的导师，擅长用例子讲解',
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
  current: AgentRole;
  onSelect: (r: AgentRole) => void;
}

export function RoleSelector({ open, onClose, current, onSelect }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div
        className="w-[640px] max-w-[92vw] max-h-[80vh] bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 h-12 bg-surface-high border-b border-border">
          <div>
            <h3 className="font-display font-bold text-text">选择 AI 角色</h3>
            <p className="text-[10px] text-text-secondary">不同角色具有不同人设和工具集</p>
          </div>
          <button onClick={onClose} className="material-symbols-outlined text-text-secondary hover:text-text w-7 h-7 flex items-center justify-center rounded hover:bg-surface">close</button>
        </div>
        <div className="p-4 grid grid-cols-2 gap-3">
          {ROLES.map(r => (
            <button
              key={r.id}
              onClick={() => { onSelect(r.id); onClose(); }}
              className={`group p-3 rounded-xl border-2 text-left transition-all hover:scale-[1.02] ${
                current === r.id ? 'border-primary bg-primary/5' : 'border-border bg-bg-dim hover:border-primary/50'
              }`}
            >
              <div className="flex items-start gap-3 mb-2">
                <div className={`w-10 h-10 rounded-lg bg-gradient-to-br from-primary/30 to-accent/30 flex items-center justify-center ${r.color}`}>
                  <span className="material-symbols-outlined filled text-lg">{r.icon}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-text text-sm">{r.name}</span>
                    {current === r.id && <Badge variant="primary" dot>使用中</Badge>}
                  </div>
                  <div className="text-[10px] text-text-secondary mt-0.5 line-clamp-2">{r.description}</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1 mb-2">
                {r.capabilities.map(c => (
                  <span key={c} className="text-[9px] px-1.5 py-0.5 rounded bg-surface-high text-text-secondary">
                    {c}
                  </span>
                ))}
              </div>
              <div className="text-[10px] text-text-secondary/70 font-mono truncate">
                {r.systemPrompt}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
