// ─────────────────────────────────────────────────────────────────
// 首次启动引导 - 高亮关键 UI 区域
// ─────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { Button } from '../ui/Button';

interface Step {
  title: string;
  desc: string;
  icon: string;
  tip: string;
}

const STEPS: Step[] = [
  { title: '顶栏',   desc: '多模型混合 · 主题切换 · 全局状态',  icon: 'view_agenda',     tip: '点击 Logo 旁的项目名可以重命名' },
  { title: 'Activity', desc: '8 个视图快速切换',                 icon: 'apps',            tip: '每个图标对应左侧 Sidebar 不同面板' },
  { title: '资源+代码', desc: '分屏模式可同时浏览文件树与代码',   icon: 'code',            tip: '拖动中间分割条调整比例' },
  { title: '流送+对话', desc: '流送区显示 AI 思考过程，对话区发送消息', icon: 'forum',  tip: 'Ctrl+Enter 快速发送，/ 触发斜杠命令' },
  { title: '预览',     desc: '8 个 Tab 监控内核、数据库、事件',   icon: 'monitoring',     tip: '热力图展示一周资源分布' },
  { title: '终端',     desc: '内置 shell，可执行 help / status / trace', icon: 'terminal',   tip: 'Ctrl+` 快速打开' },
  { title: '快捷键',   desc: 'Ctrl+K 命令面板 · Ctrl+L 清流送',  icon: 'keyboard',       tip: '命令面板有 30+ 快捷命令' },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function FeatureTour({ open, onClose }: Props) {
  const [step, setStep] = useState(0);
  if (!open) return null;

  const s = STEPS[step];
  const progress = ((step + 1) / STEPS.length) * 100;

  return (
    <div className="fixed inset-0 z-[220] flex items-end justify-center pb-12 bg-black/40 backdrop-blur-sm animate-fade-in">
      <div className="w-[480px] bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden animate-slide-in-up">
        {/* 进度条 */}
        <div className="h-1 bg-surface-high">
          <div className="h-full bg-gradient-to-r from-primary to-accent transition-all" style={{ width: `${progress}%` }} />
        </div>

        <div className="p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="relative">
              <div className="absolute inset-0 blur-md bg-primary/30 rounded-full" />
              <div className="relative w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                <span className="material-symbols-outlined text-white filled">{s.icon}</span>
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-text-secondary">第 {step + 1} 步 / 共 {STEPS.length} 步</div>
              <h3 className="text-base font-display font-bold text-text">{s.title}</h3>
            </div>
            <button onClick={onClose} className="text-text-secondary hover:text-text">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>

          <p className="text-sm text-text-secondary mb-3">{s.desc}</p>

          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-primary/5 border border-primary/20">
            <span className="material-symbols-outlined text-sm text-primary">tips_and_updates</span>
            <p className="text-xs text-text">{s.tip}</p>
          </div>

          {/* 步骤指示 */}
          <div className="flex items-center justify-center gap-1.5 mt-4">
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? 'w-6 bg-primary' : 'w-1.5 bg-surface-high hover:bg-text-secondary/40'
                }`}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-bg-dim">
          <Button variant="ghost" size="sm" icon="skip_next" onClick={onClose}>跳过</Button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" icon="arrow_back" onClick={() => setStep(s => s - 1)}>上一步</Button>
            )}
            {step < STEPS.length - 1 ? (
              <Button variant="primary" size="sm" icon="arrow_forward" onClick={() => setStep(s => s + 1)}>下一步</Button>
            ) : (
              <Button variant="primary" size="sm" icon="check" onClick={onClose}>开始使用</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
