// ─────────────────────────────────────────────────────────────────
// 智能体编排器 — AgentOrchestrator
// - 多 Agent 拓扑图 (编排/路由/并行/串行)
// - 工作流 DAG 可视化
// - 任务队列与执行状态
// - 资源调度 (CPU/GPU/Memory)
// - Agent 通信 (消息总线)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type AgentStatus = 'idle' | 'running' | 'waiting' | 'error' | 'paused' | 'completed';
type TopologyType = 'orchestrator' | 'pipeline' | 'parallel' | 'consensus' | 'reflection';

interface Agent {
  id: string;
  name: string;
  type: 'orchestrator' | 'worker' | 'specialist' | 'reviewer' | 'router';
  status: AgentStatus;
  model: string;
  cpu: number;
  memory: number;
  gpu: number;
  tasksCompleted: number;
  avgLatency: number;
  currentTask?: string;
}

interface Task {
  id: string;
  name: string;
  agentId: string;
  status: AgentStatus;
  progress: number;       // 0-100
  started: number;
  duration?: number;
  inputs: number;
  outputs: number;
  dependsOn: string[];
}

interface Message {
  id: string;
  from: string;
  to: string;
  topic: string;
  payload: string;
  ts: number;
  size: number;
}

const AGENTS: Agent[] = [
  { id: 'a1', name: 'Orchestrator',   type: 'orchestrator', status: 'running',   model: 'claude-opus-4.7',  cpu: 45, memory: 62, gpu: 30, tasksCompleted: 1247, avgLatency: 2340, currentTask: '分解用户查询' },
  { id: 'a2', name: 'Coder',          type: 'worker',      status: 'running',   model: 'claude-sonnet-4.5',cpu: 78, memory: 84, gpu: 0,  tasksCompleted: 892,  avgLatency: 1850, currentTask: '实现用户认证' },
  { id: 'a3', name: 'Researcher',     type: 'specialist',  status: 'running',   model: 'claude-opus-4.7',  cpu: 56, memory: 71, gpu: 0,  tasksCompleted: 432,  avgLatency: 3120, currentTask: '搜索相关技术栈' },
  { id: 'a4', name: 'Reviewer',       type: 'reviewer',    status: 'waiting',   model: 'claude-opus-4.7',  cpu: 12, memory: 24, gpu: 0,  tasksCompleted: 1567, avgLatency: 980,  currentTask: '等待 Coder 输出' },
  { id: 'a5', name: 'Tester',         type: 'specialist',  status: 'idle',      model: 'gpt-4o',           cpu: 0,  memory: 8,  gpu: 0,  tasksCompleted: 234,  avgLatency: 1500 },
  { id: 'a6', name: 'Router',         type: 'router',      status: 'running',   model: 'claude-haiku',     cpu: 23, memory: 18, gpu: 0,  tasksCompleted: 5621, avgLatency: 120 },
  { id: 'a7', name: 'Summarizer',     type: 'worker',      status: 'idle',      model: 'claude-sonnet-4.5',cpu: 0,  memory: 4,  gpu: 0,  tasksCompleted: 891,  avgLatency: 720 },
  { id: 'a8', name: 'VisionAnalyst',  type: 'specialist',  status: 'error',     model: 'gemini-2.0-pro',   cpu: 0,  memory: 12, gpu: 0,  tasksCompleted: 67,   avgLatency: 2100 },
];

const TASKS: Task[] = [
  { id: 't1', name: '解析用户查询',         agentId: 'a1', status: 'completed', progress: 100, started: Date.now() - 120000, duration: 800,  inputs: 1, outputs: 3, dependsOn: [] },
  { id: 't2', name: '搜索认证方案',         agentId: 'a3', status: 'completed', progress: 100, started: Date.now() - 110000, duration: 3500, inputs: 1, outputs: 5, dependsOn: ['t1'] },
  { id: 't3', name: '实现 JWT 中间件',      agentId: 'a2', status: 'running',   progress: 65,  started: Date.now() - 90000,  inputs: 1, outputs: 1, dependsOn: ['t2'] },
  { id: 't4', name: '代码审查',            agentId: 'a4', status: 'waiting',   progress: 0,   started: 0,                    inputs: 1, outputs: 0, dependsOn: ['t3'] },
  { id: 't5', name: '编写测试',            agentId: 'a5', status: 'idle',      progress: 0,   started: 0,                    inputs: 1, outputs: 0, dependsOn: ['t3'] },
  { id: 't6', name: '图像 OCR 处理',        agentId: 'a8', status: 'error',     progress: 30,  started: Date.now() - 60000,  duration: 1200, inputs: 1, outputs: 0, dependsOn: [] },
];

const MESSAGES: Message[] = [
  { id: 'm1', from: 'a1', to: 'a3', topic: 'task.assign',  payload: '{ task: "搜索认证方案", priority: "high" }', ts: Date.now() - 110000, size: 156 },
  { id: 'm2', from: 'a3', to: 'a2', topic: 'knowledge.share', payload: '{ docs: ["oauth2.md", "jwt-best-practices.md"] }', ts: Date.now() - 100000, size: 2304 },
  { id: 'm3', from: 'a1', to: 'a2', topic: 'task.assign',  payload: '{ task: "实现 JWT 中间件", spec: "..." }', ts: Date.now() - 90000, size: 1850 },
  { id: 'm4', from: 'a2', to: 'a1', topic: 'task.progress',payload: '{ progress: 0.65, current: "编写 verify() 函数" }', ts: Date.now() - 30000, size: 312 },
  { id: 'm5', from: 'a1', to: 'a4', topic: 'task.queue',   payload: '{ task: "代码审查", waitFor: "a2.t3" }', ts: Date.now() - 20000, size: 245 },
  { id: 'm6', from: 'a8', to: 'a1', topic: 'task.error',   payload: '{ error: "Model overloaded", retry: 2 }', ts: Date.now() - 15000, size: 89 },
];

const TOPOLOGIES: { id: TopologyType; name: string; desc: string; agentCount: number }[] = [
  { id: 'orchestrator', name: '编排模式',  desc: '中心化协调,适合复杂多步任务',  agentCount: 8 },
  { id: 'pipeline',     name: '流水线',   desc: '串行处理,适合数据 ETL',     agentCount: 5 },
  { id: 'parallel',     name: '并行处理',  desc: 'Map-Reduce 风格并发',       agentCount: 6 },
  { id: 'consensus',    name: '共识投票',  desc: '多 Agent 投票决策',          agentCount: 4 },
  { id: 'reflection',   name: '反思优化',  desc: '自我评估与改进',             agentCount: 3 },
];

function statusColor(s: AgentStatus): 'success' | 'info' | 'warning' | 'danger' | 'default' {
  return s === 'running' ? 'info' : s === 'completed' ? 'success' : s === 'waiting' || s === 'paused' ? 'warning' : s === 'error' ? 'danger' : 'default';
}
function statusLabel(s: AgentStatus): string {
  return { idle: '空闲', running: '运行中', waiting: '等待', error: '错误', paused: '暂停', completed: '完成' }[s];
}

export function AgentOrchestrator({ open, onClose }: Props) {
  const [tab, setTab] = useState<'topology' | 'agents' | 'tasks' | 'messages' | 'resources'>('topology');
  const [topology, setTopology] = useState<TopologyType>('orchestrator');
  const [activeAgentId, setActiveAgentId] = useState<string>(AGENTS[0].id);
  const activeAgent = AGENTS.find(a => a.id === activeAgentId) || AGENTS[0];

  const totalCpu = AGENTS.reduce((s, a) => s + a.cpu, 0);
  const totalMem = AGENTS.reduce((s, a) => s + a.memory, 0);
  const totalGpu = AGENTS.reduce((s, a) => s + a.gpu, 0);
  const runningCount = AGENTS.filter(a => a.status === 'running').length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">hub</span>
          <h2 className="text-sm font-semibold text-text">智能体编排器</h2>
          <Badge variant="info">{AGENTS.length} Agents</Badge>
          <Badge variant="success">{runningCount} 运行中</Badge>
          <Badge variant="warning">CPU {totalCpu}%</Badge>
          <Badge variant="warning">MEM {totalMem}%</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="play_arrow" variant="primary">启动拓扑</Button>
            <Button size="sm" icon="pause">暂停</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'topology',  l: '拓扑图' },
            { k: 'agents',    l: `Agents (${AGENTS.length})` },
            { k: 'tasks',     l: `任务 (${TASKS.length})` },
            { k: 'messages',  l: `消息总线 (${MESSAGES.length})` },
            { k: 'resources', l: '资源' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-64 border-r border-border bg-bg overflow-y-auto p-2">
            {tab === 'topology' && (
              <>
                <p className="text-[10px] text-text-secondary px-1 mb-1">拓扑模式</p>
                {TOPOLOGIES.map(t => (
                  <div key={t.id} onClick={() => setTopology(t.id)}
                    className={'p-2 rounded cursor-pointer mb-1 ' + (topology === t.id ? 'bg-accent/15 border border-accent/30' : 'hover:bg-surface-high border border-transparent')}>
                    <div className="flex items-center gap-1">
                      <Badge variant="info">{t.id}</Badge>
                      <span className="text-[11px] text-text font-medium">{t.name}</span>
                    </div>
                    <p className="text-[10px] text-text-secondary mt-0.5">{t.desc}</p>
                    <p className="text-[10px] text-text-secondary mt-0.5">{t.agentCount} agents</p>
                  </div>
                ))}
                <p className="text-[10px] text-text-secondary px-1 mb-1 mt-3">Agents</p>
                {AGENTS.map(a => (
                  <div key={a.id} onClick={() => setActiveAgentId(a.id)}
                    className={'p-1.5 rounded cursor-pointer mb-0.5 ' + (activeAgentId === a.id ? 'bg-accent/10' : 'hover:bg-surface-high')}>
                    <div className="flex items-center gap-1">
                      <Badge variant={statusColor(a.status)}>{statusLabel(a.status)}</Badge>
                      <span className="text-[11px] text-text">{a.name}</span>
                    </div>
                    <p className="text-[10px] text-text-secondary mt-0.5 truncate">{a.currentTask || '-'}</p>
                  </div>
                ))}
              </>
            )}
            {tab === 'agents' && (
              <>
                <p className="text-[10px] text-text-secondary px-1 mb-1">Agent 列表</p>
                {AGENTS.map(a => (
                  <div key={a.id} onClick={() => setActiveAgentId(a.id)}
                    className={'p-2 rounded cursor-pointer mb-1 ' + (activeAgentId === a.id ? 'bg-accent/15' : 'hover:bg-surface-high')}>
                    <div className="flex items-center gap-1">
                      <Badge variant={statusColor(a.status)}>{statusLabel(a.status)}</Badge>
                      <span className="text-[11px] text-text font-medium">{a.name}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-text-secondary">
                      <p>类型: {a.type}</p>
                      <p>模型: {a.model}</p>
                      <p>完成: {a.tasksCompleted}</p>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'topology' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">编排拓扑 ({TOPOLOGIES.find(t => t.id === topology)?.name})</h3>
                <svg viewBox="0 0 800 380" className="w-full bg-surface-high rounded" style={{ minHeight: 380 }}>
                  {/* Connections */}
                  <line x1="400" y1="190" x2="200" y2="80"  stroke="#6b7280" strokeWidth="1.5" strokeDasharray="3 3" />
                  <line x1="400" y1="190" x2="200" y2="190" stroke="#a855f7" strokeWidth="2" />
                  <line x1="400" y1="190" x2="200" y2="300" stroke="#3b82f6" strokeWidth="2" />
                  <line x1="400" y1="190" x2="600" y2="80"  stroke="#eab308" strokeWidth="2" />
                  <line x1="400" y1="190" x2="600" y2="190" stroke="#a855f7" strokeWidth="2" />
                  <line x1="400" y1="190" x2="600" y2="300" stroke="#16a34a" strokeWidth="2" />
                  <line x1="200" y1="190" x2="600" y2="190" stroke="#6b7280" strokeWidth="1" strokeDasharray="2 4" />

                  {/* Central Orchestrator */}
                  <g>
                    <circle cx="400" cy="190" r="40" fill="rgba(168,85,247,0.3)" stroke="#a855f7" strokeWidth="2" />
                    <text x="400" y="186" fontSize="11" fill="#1f2937" textAnchor="middle" fontWeight="600">Orchestrator</text>
                    <text x="400" y="200" fontSize="9" fill="#6b7280" textAnchor="middle">opus-4.7</text>
                    <text x="400" y="213" fontSize="8" fill="#a855f7" textAnchor="middle">● running</text>
                  </g>

                  {/* Surrounding agents */}
                  {[
                    { x: 200, y: 80,  name: 'Router',        type: 'router',     status: 'running' },
                    { x: 200, y: 190, name: 'Coder',         type: 'worker',     status: 'running' },
                    { x: 200, y: 300, name: 'Researcher',    type: 'specialist', status: 'running' },
                    { x: 600, y: 80,  name: 'VisionAnalyst', type: 'specialist', status: 'error' },
                    { x: 600, y: 190, name: 'Reviewer',      type: 'reviewer',   status: 'waiting' },
                    { x: 600, y: 300, name: 'Tester',        type: 'specialist', status: 'idle' },
                  ].map((a, i) => {
                    const colors: Record<string, string> = { running: '#3b82f6', waiting: '#eab308', error: '#dc2626', idle: '#9ca3af' };
                    return (
                      <g key={i}>
                        <rect x={a.x - 50} y={a.y - 22} width="100" height="44" rx="6"
                          fill="white" stroke={colors[a.status]} strokeWidth="2" />
                        <circle cx={a.x - 38} cy={a.y} r="4" fill={colors[a.status]} />
                        <text x={a.x + 4} y={a.y - 5} fontSize="10" fill="#1f2937" textAnchor="middle" fontWeight="500">{a.name}</text>
                        <text x={a.x + 4} y={a.y + 8} fontSize="8" fill="#6b7280" textAnchor="middle">{a.type}</text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            )}

            {tab === 'agents' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">{activeAgent.name} ({activeAgent.id})</h3>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <p className="text-[10px] text-text-secondary mb-1">类型</p>
                    <Badge variant="info">{activeAgent.type}</Badge>
                  </div>
                  <div>
                    <p className="text-[10px] text-text-secondary mb-1">模型</p>
                    <code className="text-[11px] font-mono text-text">{activeAgent.model}</code>
                  </div>
                  <div>
                    <p className="text-[10px] text-text-secondary mb-1">状态</p>
                    <Badge variant={statusColor(activeAgent.status)}>{statusLabel(activeAgent.status)}</Badge>
                  </div>
                  <div>
                    <p className="text-[10px] text-text-secondary mb-1">当前任务</p>
                    <span className="text-[11px] text-text">{activeAgent.currentTask || '空闲'}</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[10px] text-text-secondary">CPU</span>
                      <span className="text-[10px] text-text font-mono">{activeAgent.cpu}%</span>
                    </div>
                    <div className="h-1.5 bg-surface-high rounded-full overflow-hidden">
                      <div className="h-full bg-accent" style={{ width: `${activeAgent.cpu}%` }}></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[10px] text-text-secondary">Memory</span>
                      <span className="text-[10px] text-text font-mono">{activeAgent.memory}%</span>
                    </div>
                    <div className="h-1.5 bg-surface-high rounded-full overflow-hidden">
                      <div className="h-full bg-info" style={{ width: `${activeAgent.memory}%` }}></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[10px] text-text-secondary">GPU</span>
                      <span className="text-[10px] text-text font-mono">{activeAgent.gpu}%</span>
                    </div>
                    <div className="h-1.5 bg-surface-high rounded-full overflow-hidden">
                      <div className="h-full bg-warning" style={{ width: `${activeAgent.gpu}%` }}></div>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-3">
                  <div className="bg-surface-high rounded p-2 text-center">
                    <p className="text-[10px] text-text-secondary">完成任务</p>
                    <p className="text-base font-bold text-text font-mono">{activeAgent.tasksCompleted}</p>
                  </div>
                  <div className="bg-surface-high rounded p-2 text-center">
                    <p className="text-[10px] text-text-secondary">平均延迟</p>
                    <p className="text-base font-bold text-text font-mono">{activeAgent.avgLatency}ms</p>
                  </div>
                  <div className="bg-surface-high rounded p-2 text-center">
                    <p className="text-[10px] text-text-secondary">成功率</p>
                    <p className="text-base font-bold text-success font-mono">98.4%</p>
                  </div>
                </div>
              </div>
            )}

            {tab === 'tasks' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">任务队列</h3>
                <div className="space-y-1.5">
                  {TASKS.map(t => {
                    const agent = AGENTS.find(a => a.id === t.agentId);
                    return (
                      <div key={t.id} className="bg-surface-high rounded p-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={statusColor(t.status)}>{statusLabel(t.status)}</Badge>
                          <span className="text-[11px] font-medium text-text">{t.name}</span>
                          <span className="text-[10px] text-text-secondary ml-auto">→ {agent?.name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-bg rounded-full overflow-hidden">
                            <div className="h-full bg-accent" style={{ width: `${t.progress}%` }}></div>
                          </div>
                          <span className="text-[10px] text-text font-mono w-8 text-right">{t.progress}%</span>
                        </div>
                        {t.dependsOn.length > 0 && (
                          <p className="text-[10px] text-text-secondary mt-1">依赖: {t.dependsOn.join(', ')}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {tab === 'messages' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">Agent 消息总线</h3>
                <div className="space-y-1.5">
                  {MESSAGES.map(m => {
                    const from = AGENTS.find(a => a.id === m.from);
                    const to = AGENTS.find(a => a.id === m.to);
                    return (
                      <div key={m.id} className="bg-surface-high rounded p-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="info">{m.topic}</Badge>
                          <span className="text-[11px] text-text">{from?.name} → {to?.name}</span>
                          <span className="text-[10px] text-text-secondary ml-auto">{m.size}B · {new Date(m.ts).toLocaleTimeString()}</span>
                        </div>
                        <pre className="text-[10px] font-mono text-text-secondary bg-bg p-1.5 rounded mt-1 overflow-x-auto">{m.payload}</pre>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {tab === 'resources' && (
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">CPU 使用率</h3>
                  <p className="text-2xl font-bold text-text font-mono">{totalCpu / AGENTS.length}%</p>
                  <p className="text-[10px] text-text-secondary mt-1">{totalCpu} / {AGENTS.length * 100} 核心</p>
                  <div className="h-1.5 bg-surface-high rounded-full overflow-hidden mt-2">
                    <div className="h-full bg-accent" style={{ width: `${totalCpu / AGENTS.length}%` }}></div>
                  </div>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">内存使用</h3>
                  <p className="text-2xl font-bold text-text font-mono">{totalMem / AGENTS.length}%</p>
                  <p className="text-[10px] text-text-secondary mt-1">{(totalMem * 0.32).toFixed(1)} GB / 32 GB</p>
                  <div className="h-1.5 bg-surface-high rounded-full overflow-hidden mt-2">
                    <div className="h-full bg-info" style={{ width: `${totalMem / AGENTS.length}%` }}></div>
                  </div>
                </div>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">GPU 占用</h3>
                  <p className="text-2xl font-bold text-text font-mono">{totalGpu / 100}%</p>
                  <p className="text-[10px] text-text-secondary mt-1">{AGENTS.filter(a => a.gpu > 0).length} agents 使用 GPU</p>
                  <div className="h-1.5 bg-surface-high rounded-full overflow-hidden mt-2">
                    <div className="h-full bg-warning" style={{ width: `${totalGpu}%` }}></div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
