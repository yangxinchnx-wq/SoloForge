import React, { useState } from 'react';
import { Compass, FileText } from '../../utils/icons';

// 06. 预置智能规则
export default function SkillsRulesTab({ onClose, permissionMode = 'normal' }: { onClose: () => void; permissionMode?: 'normal' | 'performance' | 'ultimate' | 'expert' }) {
  const [skillsList, setSkillsList] = useState([
    { name: 'core-system-prompt.txt', time: '5分钟前', size: '1.8 KB' },
    { name: 'agent-custom-actions.txt', time: '10分钟前', size: '2.5 KB' }
  ]);
  const [newSkillName, setNewSkillName] = useState('');
  const [complianceChecked, setComplianceChecked] = useState(true);

  const getRuleTabIcon = () => {
    switch (permissionMode) {
      case 'performance':
      case 'expert':
      case 'ultimate':
      case 'normal':
      default:
        return null;
    }
  };

  const uploadSkillMock = () => {
    if (!newSkillName) return;
    setSkillsList([...skillsList, { name: `${newSkillName}.txt`, time: '刚刚上传', size: '1.2 KB' }]);
    setNewSkillName('');
    // Trigger compliance alert simulation
    setComplianceChecked(false);
    setTimeout(() => setComplianceChecked(true), 3000);
  };

  return (
    <div className="space-y-6 animate-fadeIn">

      <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl flex items-center justify-between">
        <div className="flex items-center gap-3">
          {(() => {
            const ComplianceIcon = getRuleTabIcon();
            return ComplianceIcon ? <ComplianceIcon className={`w-5 h-5 ${complianceChecked ? 'text-[var(--color-primary)]' : 'text-red-400 animate-spin'}`} /> : null;
          })()}
          <div>
            <span className="text-sm font-bold text-[var(--color-on-surface)]">本地内容风控合规校验</span>
            <p className="text-xs text-on-surface/50 mt-0.5">自动阻断危险脚本和代码逻辑并提供行为留痕</p>
          </div>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded border font-mono font-bold ${
          complianceChecked
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          {complianceChecked ? '● SAFETY PASSED' : '● AUDITING STATUS'}
        </span>
      </div>

      {/* Grid section for the 4 interactive operational modes rules */}
      <div className="space-y-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--color-primary)] font-mono font-semibold">运行模式决策控制规约 (Multi-Mode Safety Rules)</span>
          <span className="text-[10px] text-on-surface/40 font-mono">规则存放端: BlogSystem/rules/</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {/* Mode 1 - Normal Mode */}
          <div className="p-4 rounded-xl border border-outline/10 bg-surface/[0.02] flex flex-col justify-between hover:border-outline/25 transition-all gap-3.5 group">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[var(--color-on-surface)]">普通模式 (安全常态)</span>
              </div>
              <p className="text-[11px] text-on-surface/50 leading-relaxed">
                采用高强度权限沙盒机制。所有关键命令强制要求人工确认。默认阻止未受信域的网络 API 请求与物理路径重置。
              </p>
            </div>
            <button
              onClick={() => {
                onClose();
                try {
                  const channel = new BroadcastChannel('soloforge-editor-sync-channel');
                  channel.postMessage({
                    type: 'FILE_SELECT',
                    file: 'BlogSystem/rules/normal_rules.md',
                    content: `# 普通模式控制规则 (Normal Mode Rules)\n\n## 📌 基础定义与权限沙盒\n普通模式是 SoloForge 平台预设的基础运行模式。此状态下的一切代码执行、AI 生成都以「安全、合规」为绝对优先级。\n\n## 🔒 核心控制限制\n1. **指令阻断**：所有涉敏、可能修改系统内核、注册表的脚本会在底层自动丢弃。\n2. **沙盒防御**：网络端口、外部链接请求需要用户确认或由虚拟代理接管。\n3. **用户手动确认**：自动执行开关关闭，所有命令均需点击确认，确保完全受控。`
                  });
                  channel.postMessage({
                    type: 'JUMP_TO_EXPLORER',
                    toast: '📂 已为您快速打开普通模式规则文件: BlogSystem/rules/normal_rules.md'
                  });
                  channel.close();
                } catch (e) {
                  console.warn(e);
                }
              }}
              className="w-full py-2 flex items-center justify-center gap-1.5 rounded-lg text-[10.5px] font-bold border border-outline/20 text-on-surface bg-surface/5 hover:bg-surface/10 transition-colors cursor-pointer shrink-0"
            >
              <Compass className="w-3.5 h-3.5 transition-transform group-hover:rotate-45" />
              创建并快速打开规则文件
            </button>
          </div>

          {/* Mode 2 - Performance Mode */}
          <div className="p-4 rounded-xl border border-outline/10 bg-surface/[0.02] flex flex-col justify-between hover:border-outline/25 transition-all gap-3.5 group">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[var(--color-on-surface)]">性能模式 (半自动)</span>
              </div>
              <p className="text-[11px] text-on-surface/50 leading-relaxed">
                降低流式缓存上下文的时效审计。启用极速后台线程增量更新机制。最大化保留富文本 UI 框架首屏计算效能。
              </p>
            </div>
            <button
              onClick={() => {
                onClose();
                try {
                  const channel = new BroadcastChannel('soloforge-editor-sync-channel');
                  channel.postMessage({
                    type: 'FILE_SELECT',
                    file: 'BlogSystem/rules/performance_rules.md',
                    content: `# 性能模式控制规则 (Performance Mode Rules)\n\n## 📌 基础定义与性能对齐\n性能模式致力于通过低时延开销、增量式解析来满足极高强度的开发体验。\n\n## ⚡ 核心控制限制\n1. **流式缓存**：启用全流式输入/输出过滤，去除冗余的上下文留痕与全量标记校验。\n2. **多线程并发**：在后台线程中预处理文件更改，对常规静态资源开启惰性加载机制。\n3. **内存压缩**：对 10 轮前的历史交互信息执行有损向量切片压缩，节省内存开销。`
                  });
                  channel.postMessage({
                    type: 'JUMP_TO_EXPLORER',
                    toast: '📂 已为您快速打开性能模式规则文件: BlogSystem/rules/performance_rules.md'
                  });
                  channel.close();
                } catch (e) {
                  console.warn(e);
                }
              }}
              className="w-full py-2 flex items-center justify-center gap-1.5 rounded-lg text-[10.5px] font-bold border border-outline/20 text-on-surface bg-surface/5 hover:bg-surface/10 transition-colors cursor-pointer shrink-0"
            >
              <Compass className="w-3.5 h-3.5 transition-transform group-hover:rotate-45" />
              创建并快速打开规则文件
            </button>
          </div>

          {/* Mode 3 - Ultimate Mode */}
          <div className="p-4 rounded-xl border border-outline/10 bg-surface/[0.02] flex flex-col justify-between hover:border-outline/25 transition-all gap-3.5 group">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[var(--color-on-surface)]">极致模式 (全域自动)</span>
              </div>
              <p className="text-[11px] text-on-surface/50 leading-relaxed">
                完全松开 CPU 并发限制，保障最高等级重试，多路调用并启用全局跨资产 RAG 重组注入。
              </p>
            </div>
            <button
              onClick={() => {
                onClose();
                try {
                  const channel = new BroadcastChannel('soloforge-editor-sync-channel');
                  channel.postMessage({
                    type: 'FILE_SELECT',
                    file: 'BlogSystem/rules/ultimate_rules.md',
                    content: `# 极致模式控制规则 (Ultimate Mode Rules)\n\n## 📌 基础定义与火力无限\n解开全部 CPU、GPU 算力限制，实现 100% 全自动专家决策与重试回路。\n\n## 🔥 核心控制限制\n1. **全力并发计算**：开启 CPU 超线程任务管线与本地并行 GPU 加速渲染对齐。\n2. **自我纠错重试**：当后台编译报错或测试未通过时，允许 AI 在不干扰前台的前提下自主回溯并重试最多 5 次。\n3. **无缝混合大上下文**：开启跨多向量库全量召回检索，提供 100% RAG 全景记忆注入。\n4. **极致发烧狂热**：针对编写的所有基础文件施加最优算法，极光代码即刻生成。`
                  });
                  channel.postMessage({
                    type: 'JUMP_TO_EXPLORER',
                    toast: '📂 已为您快速打开极致模式规则文件: BlogSystem/rules/ultimate_rules.md'
                  });
                  channel.close();
                } catch (e) {
                  console.warn(e);
                }
              }}
              className="w-full py-2 flex items-center justify-center gap-1.5 rounded-lg text-[10.5px] font-bold border border-outline/20 text-on-surface bg-surface/5 hover:bg-surface/10 transition-colors cursor-pointer shrink-0"
            >
              <Compass className="w-3.5 h-3.5 transition-transform group-hover:rotate-45" />
              创建并快速打开规则文件
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <span className="text-xs text-[var(--color-primary)] font-mono font-semibold block">上传外部控制规则/约束脚本 (.txt)</span>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="外部脚本名称"
            value={newSkillName}
            onChange={(e) => setNewSkillName(e.target.value)}
            className="flex-1 text-sm px-3.5 py-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-xl text-[var(--color-on-surface)] outline-none focus:border-[var(--color-primary)]"
          />
          <button
            onClick={uploadSkillMock}
            className="bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-bg)] font-extrabold text-xs px-4 py-2 rounded-xl transition-all cursor-pointer"
          >
            导入规则
          </button>
        </div>
      </div>

      <div className="space-y-2 pt-2">
        <span className="text-xs text-on-surface/50 font-mono block">当前已加载的自动化脚本</span>
        {skillsList.map((skill, idx) => (
          <div key={idx} className="p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="w-3.5 h-3.5 text-on-surface/40" />
              <span className="text-xs font-semibold text-[var(--color-on-surface)]">{skill.name}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-on-surface/50 font-mono">{skill.size}</span>
              <span className="text-xs text-[var(--color-primary)]/70 font-mono">{skill.time}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
