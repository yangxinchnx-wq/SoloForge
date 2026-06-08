// ─────────────────────────────────────────────────────────────────
// 智能体剧场 — AgentTheater
// - 可视化展示多个 Agent 协作流程
// - 实时拓扑: 调度 → 决策 → 法庭 → 执行
// - 播放/暂停/快进
// - 事件日志
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Agent {
  id: string;
  name: string;
  type: 'planner' | 'coder' | 'reviewer' | 'tester' | 'judge' | 'tool';
  color: string;
  x: number;
  y: number;
  status: 'idle' | 'busy' | 'thinking' | 'speaking' | 'error';
  task?: string;
  progress: number;
}

interface Message {
  id: string;
  from: string;
  to: string;
  ts: number;
  text: string;
  type: 'task' | 'result' | 'question' | 'verdict';
}

interface SceneStep {
  id?: string;
  ts?: number;
  type: 'start' | 'task' | 'think' | 'speak' | 'vote' | 'verdict' | 'finish' | 'error';
  agent?: string;
  from?: string;
  to?: string;
  text: string;
}

const AGENT_COLORS = ['#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#3b82f6'];
const SCENES = [
  {
    name: '代码生成',
    steps: [
      { type: 'start',   agent: 'planner',  text: '接收任务:实现用户认证模块' },
      { type: 'task',    agent: 'planner',  text: '拆解为 4 个子任务' },
      { type: 'task',    from: 'planner', to: 'coder', text: '分发:编写 login API' },
      { type: 'think',   agent: 'coder',    text: '分析现有项目结构...' },
      { type: 'speak',   agent: 'coder',    text: '生成 auth.controller.ts (128 行)' },
      { type: 'task',    from: 'coder', to: 'tester', text: '提交测试' },
      { type: 'speak',   agent: 'tester',   text: '编写 8 个测试用例' },
      { type: 'task',    from: 'tester', to: 'reviewer', text: '提交审查' },
      { type: 'think',   agent: 'reviewer', text: '审查中... 发现 2 处改进' },
      { type: 'speak',   agent: 'reviewer', text: '建议:加 try/catch 边界' },
      { type: 'task',    from: 'reviewer', to: 'coder', text: '打回修复' },
      { type: 'speak',   agent: 'coder',    text: '应用建议,重新提交' },
      { type: 'speak',   agent: 'reviewer', text: '✓ 通过' },
      { type: 'verdict', agent: 'judge',    text: '🟢 准许合并' },
      { type: 'finish',  agent: 'planner',  text: '任务完成,耗时 23 秒' },
    ] as SceneStep[],
  },
  {
    name: 'Bug 调查',
    steps: [
      { type: 'start',   agent: 'planner',  text: 'Bug 报告:登录 500 错误' },
      { type: 'task',    agent: 'planner',  text: '分派给 judge 复现' },
      { type: 'think',   agent: 'judge',    text: '复现:输入特殊字符崩溃' },
      { type: 'speak',   agent: 'judge',    text: '锁定 stack overflow in escape()' },
      { type: 'task',    from: 'judge', to: 'coder', text: '修复 escape 函数' },
      { type: 'speak',   agent: 'coder',    text: '已修复 + 边界测试' },
      { type: 'verdict', agent: 'judge',    text: '🟢 复测通过' },
      { type: 'finish',  agent: 'planner',  text: 'Bug 关闭,耗时 11 秒' },
    ] as SceneStep[],
  },
  {
    name: '文档生成',
    steps: [
      { type: 'start',   agent: 'planner',  text: '需求:API 文档生成' },
      { type: 'task',    from: 'planner', to: 'tool', text: '扫描 23 个 controller' },
      { type: 'speak',   agent: 'tool',     text: '提取签名 23 个,示例 8 个' },
      { type: 'task',    from: 'tool', to: 'reviewer', text: '校对术语' },
      { type: 'speak',   agent: 'reviewer', text: '✓ 术语一致' },
      { type: 'task',    from: 'reviewer', to: 'tool', text: '输出 docs/api.md' },
      { type: 'finish',  agent: 'planner',  text: '文档完成' },
    ] as SceneStep[],
  },
];

const AGENT_TYPE_LABEL: Record<Agent['type'], { icon: string; label: string }> = {
  planner:  { icon: 'psychology', label: '规划者' },
  coder:    { icon: 'code',        label: '编码' },
  reviewer: { icon: 'rate_review', label: '审查' },
  tester:   { icon: 'science',     label: '测试' },
  judge:    { icon: 'gavel',       label: '裁决' },
  tool:     { icon: 'build',       label: '工具' },
};

export function AgentTheater({ open, onClose }: Props) {
  const [sceneIdx, setSceneIdx] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1.0);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [autoLoop, setAutoLoop] = useState(true);

  // 初始化 agent 拓扑
  useEffect(() => {
    if (!open) return;
    const types: Agent['type'][] = ['planner', 'coder', 'reviewer', 'tester', 'judge', 'tool'];
    const layout: { x: number; y: number }[] = [
      { x: 400, y: 80 },   // planner
      { x: 200, y: 220 },  // coder
      { x: 600, y: 220 },  // reviewer
      { x: 100, y: 360 },  // tester
      { x: 700, y: 360 },  // judge
      { x: 400, y: 360 },  // tool
    ];
    setAgents(types.map((t, i) => ({
      id: t,
      name: AGENT_TYPE_LABEL[t].label + ' Agent',
      type: t,
      color: AGENT_COLORS[i],
      x: layout[i].x,
      y: layout[i].y,
      status: 'idle',
      progress: 0,
    })));
    setStepIdx(0);
    setMessages([]);
  }, [open, sceneIdx]);

  // 播放
  useEffect(() => {
    if (!open || !playing) return;
    const t = setTimeout(() => {
      const scene = SCENES[sceneIdx];
      if (stepIdx >= scene.steps.length) {
        if (autoLoop) {
          setStepIdx(0);
        } else {
          setPlaying(false);
        }
        return;
      }
      const step = scene.steps[stepIdx];
      // 状态更新
      setAgents(prev => prev.map(a => {
        if (a.id === step.agent) {
          if (step.type === 'task' || step.type === 'start') return { ...a, status: 'busy', task: step.text, progress: 0 };
          if (step.type === 'think') return { ...a, status: 'thinking', task: step.text, progress: 30 };
          if (step.type === 'speak') return { ...a, status: 'speaking', task: step.text, progress: 100 };
          if (step.type === 'verdict') return { ...a, status: 'speaking', task: step.text, progress: 100 };
          if (step.type === 'finish') return { ...a, status: 'idle', task: undefined, progress: 0 };
        }
        if (step.type === 'task' && 'to' in step && step.to === a.id) {
          return { ...a, status: 'busy' };
        }
        if (step.type === 'finish' || step.type === 'verdict') {
          return { ...a, status: 'idle', task: undefined, progress: 0 };
        }
        return a;
      }));
      // 消息
      if ('from' in step && 'to' in step) {
        const msg: Message = {
          id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          from: step.from || '',
          to: step.to || '',
          ts: Date.now(),
          text: step.text,
          type: 'task',
        };
        setMessages(prev => [...prev, msg].slice(-30));
      }
      setStepIdx(i => i + 1);
    }, 1200 / speed);
    return () => clearTimeout(t);
  }, [open, playing, stepIdx, sceneIdx, speed, autoLoop]);

  const scene = SCENES[sceneIdx];
  const currentStep = stepIdx < scene.steps.length ? scene.steps[stepIdx] : null;
  const progress = (stepIdx / scene.steps.length) * 100;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">theaters</span>
          <h2 className="text-sm font-semibold text-text">智能体剧场</h2>
          <Badge variant="primary">{scene.name}</Badge>
          <span className="text-xs text-text-secondary">步骤 {stepIdx}/{scene.steps.length} · {progress.toFixed(0)}%</span>
          <div className="ml-auto flex items-center gap-1">
            <select value={sceneIdx} onChange={(e) => { setSceneIdx(+e.target.value); setStepIdx(0); setPlaying(false); }}
              className="bg-bg border border-border-light rounded px-2 h-7 text-xs text-text">
              {SCENES.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
            </select>
            <Tooltip content="快退"><IconButton icon="skip_previous" onClick={() => setStepIdx(0)} /></Tooltip>
            <Tooltip content={playing ? '暂停' : '播放'}>
              <IconButton icon={playing ? 'pause' : 'play_arrow'} onClick={() => setPlaying(p => !p)} active={playing} />
            </Tooltip>
            <Tooltip content="单步"><IconButton icon="skip_next" onClick={() => setStepIdx(i => i + 1)} /></Tooltip>
            <Tooltip content="循环"><IconButton icon="repeat" onClick={() => setAutoLoop(p => !p)} active={autoLoop} /></Tooltip>
            <select value={speed} onChange={(e) => setSpeed(+e.target.value)}
              className="bg-bg border border-border-light rounded px-2 h-7 text-xs text-text">
              <option value={0.5}>0.5x</option>
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={4}>4x</option>
            </select>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 grid grid-cols-4 gap-0 overflow-hidden">
          {/* 舞台 */}
          <div className="col-span-3 relative bg-gradient-to-br from-bg via-surface to-bg overflow-hidden">
            {/* SVG 连线 */}
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 800 480" preserveAspectRatio="xMidYMid meet">
              {agents.flatMap((a, i) => agents.slice(i + 1).map((b) => {
                const active = messages.some(m => (m.from === a.id && m.to === b.id) || (m.from === b.id && m.to === a.id));
                return (
                  <line
                    key={`${a.id}-${b.id}`}
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={active ? 'var(--color-accent)' : 'var(--color-border)'}
                    strokeWidth={active ? 2 : 1}
                    strokeDasharray={active ? '4 2' : '0'}
                    className={active ? 'animate-pulse' : ''}
                  />
                );
              }))}
              {/* 当前活跃消息动画线 */}
              {messages.slice(-3).map((m, i) => {
                const from = agents.find(a => a.id === m.from);
                const to = agents.find(a => a.id === m.to);
                if (!from || !to) return null;
                const t = (Date.now() % 1000) / 1000;
                const x = from.x + (to.x - from.x) * t;
                const y = from.y + (to.y - from.y) * t;
                return <circle key={m.id} cx={x} cy={y} r={4} fill="var(--color-accent)" opacity={0.7 - i * 0.2} />;
              })}
            </svg>

            {/* Agent 节点 */}
            {agents.map(a => {
              const status = a.status;
              const ringColor = status === 'busy' ? 'ring-warning' : status === 'thinking' ? 'ring-accent' : status === 'speaking' ? 'ring-success' : status === 'error' ? 'ring-danger' : 'ring-border';
              return (
                <div
                  key={a.id}
                  className="absolute transition-all"
                  style={{ left: a.x - 60, top: a.y - 36, width: 120 }}
                >
                  <div className={`bg-surface border-2 ${ringColor} rounded-xl p-2 shadow-lg transition-all`}>
                    <div className="flex items-center gap-1.5">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-white shrink-0"
                        style={{ background: a.color }}
                      >
                        <span className="material-symbols-outlined text-base">{AGENT_TYPE_LABEL[a.type].icon}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] font-semibold text-text truncate">{AGENT_TYPE_LABEL[a.type].label}</div>
                        <div className="text-[9px] text-text-secondary truncate">
                          {status === 'thinking' ? '思考中...' : status === 'speaking' ? '发言中' : status === 'busy' ? '执行中' : status === 'error' ? '错误' : '待命'}
                        </div>
                      </div>
                    </div>
                    {(a.task || currentStep?.agent === a.id) && (
                      <div className="mt-1.5 text-[9px] text-text bg-bg rounded p-1 max-h-12 overflow-hidden">
                        {a.task || currentStep?.text}
                      </div>
                    )}
                    {status === 'thinking' && (
                      <div className="mt-1 h-1 bg-surface-high rounded-full overflow-hidden">
                        <div className="h-full bg-accent animate-pulse" style={{ width: '60%' }} />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* 当前步骤高亮 */}
            {currentStep && (
              <div className="absolute bottom-3 left-3 right-3 bg-bg/80 backdrop-blur border border-border rounded-lg p-2.5">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant={
                    currentStep.type === 'verdict' ? 'success' :
                    currentStep.type === 'error' ? 'danger' :
                    currentStep.type === 'finish' ? 'info' : 'primary'
                  }>{currentStep.type}</Badge>
                  <span className="text-[10px] text-text-secondary">{AGENT_TYPE_LABEL[currentStep.agent as Agent['type']]?.label || currentStep.agent}</span>
                </div>
                <div className="text-xs text-text">{currentStep.text}</div>
              </div>
            )}

            {/* 进度条 */}
            <div className="absolute top-2 left-2 right-2 h-1 bg-surface-high rounded-full overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>

          {/* 右侧:消息流 + 步骤列表 */}
          <div className="border-l border-border flex flex-col overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light bg-bg">消息流</div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {messages.slice().reverse().map(m => {
                const from = agents.find(a => a.id === m.from);
                const to = agents.find(a => a.id === m.to);
                return (
                  <div key={m.id} className="bg-bg border border-border rounded p-1.5 text-[10px]">
                    <div className="flex items-center gap-1 text-text-secondary">
                      <span className="w-2 h-2 rounded-full" style={{ background: from?.color }} />
                      <span className="font-mono">{from?.id || m.from}</span>
                      <span>→</span>
                      <span className="w-2 h-2 rounded-full" style={{ background: to?.color }} />
                      <span className="font-mono">{to?.id || m.to}</span>
                      <span className="ml-auto text-text-secondary">{new Date(m.ts).toLocaleTimeString().slice(0, 8)}</span>
                    </div>
                    <div className="text-text mt-0.5 line-clamp-2">{m.text}</div>
                  </div>
                );
              })}
              {messages.length === 0 && <div className="text-center text-text-secondary py-8 text-[11px]">点击播放开始剧场</div>}
            </div>
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-y border-border-light bg-bg">剧本步骤</div>
            <div className="h-40 overflow-y-auto p-2 space-y-0.5">
              {scene.steps.map((s, i) => (
                <div
                  key={i}
                  onClick={() => setStepIdx(i)}
                  className={'px-1.5 py-1 rounded text-[10px] flex items-center gap-1 cursor-pointer ' + (i === stepIdx ? 'bg-accent/15 text-accent' : 'hover:bg-surface-high text-text-secondary')}
                >
                  <span className="font-mono w-4 text-right">{i + 1}.</span>
                  <span className="font-mono">{s.type}</span>
                  <span className="truncate flex-1">{s.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
