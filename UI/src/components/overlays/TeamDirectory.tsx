// ─────────────────────────────────────────────────────────────────
// 团队目录 — TeamDirectory
// - 成员档案
// - 组织架构图
// - 技能图谱
// - 工作负载
// - 联系/协作
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type MemberStatus = 'online' | 'away' | 'busy' | 'offline' | 'in_meeting';
type MemberRole = 'cto' | 'engineering_manager' | 'staff_engineer' | 'senior_engineer' | 'engineer' | 'designer' | 'pm' | 'data_scientist';

interface Member {
  id: string;
  name: string;
  role: MemberRole;
  title: string;
  team: string;
  email: string;
  avatar: string;
  status: MemberStatus;
  timezone: string;
  skills: string[];
  currentTask: string;
  workload: number;     // 0-100
  reports: string[];    // ids of direct reports
  manager?: string;     // id of manager
  joined: number;
  prsMerged: number;
  linesOfCode: number;
}

const MEMBERS: Member[] = [
  { id: 'm1', name: '陈明 (Alice Chen)',     role: 'cto',                title: 'CTO',                 team: 'Leadership',   email: 'alice@soloforge.dev',   avatar: 'AC', status: 'in_meeting', timezone: 'UTC+8 (北京)',  skills: ['架构', 'Rust', '分布式', '领导力'], currentTask: 'Q3 战略规划',            workload: 85, reports: ['m2', 'm3', 'm4', 'm5', 'm9'], joined: Date.now() - 86400000 * 365 * 5, prsMerged: 234, linesOfCode: 125000 },
  { id: 'm2', name: '王伟 (Bob Wang)',       role: 'engineering_manager',title: '工程经理',             team: 'Platform',     email: 'bob@soloforge.dev',     avatar: 'BW', status: 'online',      timezone: 'UTC+8 (北京)',  skills: ['Node.js', 'PostgreSQL', '领导力'], currentTask: 'Sprint 计划',            workload: 70, reports: ['m6', 'm7'], manager: 'm1', joined: Date.now() - 86400000 * 365 * 3, prsMerged: 156, linesOfCode: 89000 },
  { id: 'm3', name: '刘华 (Carol Liu)',      role: 'engineering_manager',title: '工程经理',             team: 'AI/ML',        email: 'carol@soloforge.dev',   avatar: 'CL', status: 'online',      timezone: 'UTC+8 (上海)',  skills: ['Python', 'PyTorch', 'MLOps'],         currentTask: '模型 v3 评审',           workload: 78, reports: ['m10', 'm11'], manager: 'm1', joined: Date.now() - 86400000 * 365 * 2, prsMerged: 89,  linesOfCode: 45000 },
  { id: 'm4', name: '张大伟 (David Zhang)',   role: 'staff_engineer',     title: '资深工程师',           team: 'Infrastructure', email: 'david@soloforge.dev', avatar: 'DZ', status: 'busy',        timezone: 'UTC+8 (深圳)',  skills: ['Kubernetes', 'Go', 'Terraform'],       currentTask: '生产事故响应',           workload: 92, reports: [], manager: 'm1', joined: Date.now() - 86400000 * 365 * 4, prsMerged: 312, linesOfCode: 198000 },
  { id: 'm5', name: 'Sarah Johnson',         role: 'pm',                 title: '产品经理',             team: 'Product',      email: 'sarah@soloforge.dev',   avatar: 'SJ', status: 'online',      timezone: 'UTC-5 (NYC)',  skills: ['产品规划', '数据分析', 'A/B 测试'],   currentTask: '用户调研',              workload: 65, reports: [], manager: 'm1', joined: Date.now() - 86400000 * 365 * 1, prsMerged: 12,  linesOfCode: 0 },
  { id: 'm6', name: '林涛 (Frank Lin)',       role: 'senior_engineer',    title: '高级工程师',           team: 'Platform',     email: 'frank@soloforge.dev',   avatar: 'FL', status: 'online',      timezone: 'UTC+8 (北京)',  skills: ['TypeScript', 'React', 'GraphQL'],       currentTask: '前端性能优化',           workload: 73, reports: [], manager: 'm2', joined: Date.now() - 86400000 * 365 * 2, prsMerged: 178, linesOfCode: 76000 },
  { id: 'm7', name: '赵敏 (Zhao Min)',        role: 'engineer',           title: '工程师',               team: 'Platform',     email: 'zhao@soloforge.dev',    avatar: 'ZM', status: 'away',        timezone: 'UTC+8 (北京)',  skills: ['Python', 'FastAPI', 'Docker'],           currentTask: 'API 文档',              workload: 58, reports: [], manager: 'm2', joined: Date.now() - 365 * 86400000, prsMerged: 67,  linesOfCode: 34000 },
  { id: 'm9', name: '李娜 (Grace Lee)',       role: 'designer',           title: '高级设计师',           team: 'Design',       email: 'grace@soloforge.dev',   avatar: 'GL', status: 'online',      timezone: 'UTC+8 (上海)',  skills: ['Figma', 'Design System', 'UI/UX'],        currentTask: '组件库 v2',            workload: 60, reports: [], manager: 'm1', joined: Date.now() - 86400000 * 365 * 2, prsMerged: 8, linesOfCode: 0 },
  { id: 'm10',name: 'Marcus Chen',           role: 'data_scientist',     title: '数据科学家',           team: 'AI/ML',        email: 'marcus@soloforge.dev',  avatar: 'MC', status: 'online',      timezone: 'UTC-8 (SF)',  skills: ['Python', 'PyTorch', 'NLP'],               currentTask: '训练 LLM 评估器',       workload: 88, reports: [], manager: 'm3', joined: Date.now() - 86400000 * 200, prsMerged: 45, linesOfCode: 28000 },
  { id: 'm11',name: 'Yuki Tanaka',           role: 'engineer',           title: '工程师',               team: 'AI/ML',        email: 'yuki@soloforge.dev',    avatar: 'YT', status: 'offline',     timezone: 'UTC+9 (东京)',  skills: ['Rust', 'WASM', 'CUDA'],                  currentTask: '推理引擎优化',          workload: 50, reports: [], manager: 'm3', joined: Date.now() - 86400000 * 150, prsMerged: 23, linesOfCode: 18000 },
];

function statusVariant(s: MemberStatus): 'success' | 'warning' | 'danger' | 'default' | 'info' {
  return s === 'online' ? 'success' : s === 'busy' ? 'danger' : s === 'in_meeting' ? 'info' : s === 'away' ? 'warning' : 'default';
}
function statusLabel(s: MemberStatus): string { return { online: '在线', away: '离开', busy: '忙碌', offline: '离线', in_meeting: '会议中' }[s]; }
function roleLabel(r: MemberRole): string { return { cto: 'CTO', engineering_manager: '工程经理', staff_engineer: '资深工程师', senior_engineer: '高级工程师', engineer: '工程师', designer: '设计师', pm: '产品经理', data_scientist: '数据科学家' }[r]; }

export function TeamDirectory({ open, onClose }: Props) {
  const [tab, setTab] = useState<'directory' | 'orgchart' | 'workload' | 'profile'>('directory');
  const [activeId, setActiveId] = useState<string>(MEMBERS[0].id);
  const [teamFilter, setTeamFilter] = useState<string>('all');
  const activeMember = MEMBERS.find(m => m.id === activeId) || MEMBERS[0];

  const teams = Array.from(new Set(MEMBERS.map(m => m.team)));
  const filtered = teamFilter === 'all' ? MEMBERS : MEMBERS.filter(m => m.team === teamFilter);
  const onlineCount = MEMBERS.filter(m => m.status === 'online' || m.status === 'busy').length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">groups</span>
          <h2 className="text-sm font-semibold text-text">团队目录</h2>
          <Badge variant="info">{MEMBERS.length} 成员</Badge>
          <Badge variant="success">{onlineCount} 在线</Badge>
          <Badge variant="info">{teams.length} 团队</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="person_add">邀请成员</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'directory', l: `目录 (${MEMBERS.length})` },
            { k: 'orgchart',  l: '组织架构' },
            { k: 'workload',  l: '工作负载' },
            { k: 'profile',   l: '个人档案' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-72 border-r border-border bg-bg overflow-y-auto">
            <div className="px-3 py-2 border-b border-border-light">
              <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} className="w-full bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                <option value="all">所有团队</option>
                {teams.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {filtered.map(m => (
              <div key={m.id} onClick={() => { setActiveId(m.id); setTab('profile'); }}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeId === m.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <div className="w-8 h-8 rounded-full bg-accent text-white text-xs flex items-center justify-center font-semibold">{m.avatar}</div>
                    <span className={'absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-bg ' + (
                      m.status === 'online' ? 'bg-success' : m.status === 'busy' ? 'bg-danger' : m.status === 'away' ? 'bg-warning' : m.status === 'in_meeting' ? 'bg-info' : 'bg-text-secondary'
                    )}></span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-medium text-text truncate">{m.name}</p>
                    <p className="text-[10px] text-text-secondary truncate">{roleLabel(m.role)} · {m.team}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'directory' && (
              <div className="grid grid-cols-3 gap-3">
                {MEMBERS.map(m => (
                  <div key={m.id} onClick={() => { setActiveId(m.id); setTab('profile'); }} className="bg-bg border border-border-light rounded-lg p-3 cursor-pointer hover:border-accent">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="relative shrink-0">
                        <div className="w-12 h-12 rounded-full bg-accent text-white text-base flex items-center justify-center font-semibold">{m.avatar}</div>
                        <span className={'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-bg ' + (
                          m.status === 'online' ? 'bg-success' : m.status === 'busy' ? 'bg-danger' : m.status === 'away' ? 'bg-warning' : m.status === 'in_meeting' ? 'bg-info' : 'bg-text-secondary'
                        )}></span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-text truncate">{m.name}</p>
                        <p className="text-[10px] text-text-secondary">{m.title}</p>
                        <Badge variant="default">{m.team}</Badge>
                      </div>
                    </div>
                    <p className="text-[10px] text-text-secondary truncate">📍 {m.timezone}</p>
                    <p className="text-[10px] text-text truncate mt-1">📋 {m.currentTask}</p>
                    <div className="mt-2">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-text-secondary">负载</span>
                        <span className="text-text font-mono">{m.workload}%</span>
                      </div>
                      <div className="h-1 bg-surface-high rounded-full overflow-hidden mt-0.5">
                        <div className={'h-full ' + (m.workload > 85 ? 'bg-danger' : m.workload > 65 ? 'bg-warning' : 'bg-success')} style={{ width: `${m.workload}%` }}></div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'orgchart' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-3">组织架构图</h3>
                <svg viewBox="0 0 800 400" className="w-full bg-surface-high rounded" style={{ minHeight: 400 }}>
                  {/* Levels */}
                  {(() => {
                    const byId = Object.fromEntries(MEMBERS.map(m => [m.id, m]));
                    const levelOf = (id: string): number => {
                      let lvl = 0;
                      let cur = byId[id];
                      while (cur?.manager) { lvl++; cur = byId[cur.manager]; }
                      return lvl;
                    };
                    const positioned = MEMBERS.map(m => ({ ...m, level: levelOf(m.id) }));
                    const levels = [0, 1, 2];
                    const byLevel = levels.map(l => positioned.filter(p => p.level === l));
                    const positions: Record<string, { x: number; y: number }> = {};
                    byLevel.forEach((group, li) => {
                      group.forEach((m, i) => {
                        const x = ((i + 0.5) / group.length) * 800;
                        const y = 60 + li * 130;
                        positions[m.id] = { x, y };
                      });
                    });
                    return (
                      <>
                        {/* Connections */}
                        {MEMBERS.filter(m => m.manager).map(m => {
                          const from = positions[m.manager!];
                          const to = positions[m.id];
                          if (!from || !to) return null;
                          return <line key={`l-${m.id}`} x1={from.x} y1={from.y + 25} x2={to.x} y2={to.y - 25} stroke="#9ca3af" strokeWidth="1.5" />;
                        })}
                        {/* Nodes */}
                        {MEMBERS.map(m => {
                          const p = positions[m.id];
                          if (!p) return null;
                          const colors: Record<string, string> = { cto: '#a855f7', engineering_manager: '#3b82f6', staff_engineer: '#16a34a', senior_engineer: '#10b981', engineer: '#9ca3af', designer: '#ec4899', pm: '#eab308', data_scientist: '#06b6d4' };
                          const c = colors[m.role];
                          return (
                            <g key={m.id}>
                              <circle cx={p.x} cy={p.y} r="22" fill={c} fillOpacity="0.2" stroke={c} strokeWidth="2" />
                              <text x={p.x} y={p.y + 4} fontSize="11" fill={c} textAnchor="middle" fontWeight="700">{m.avatar}</text>
                              <text x={p.x} y={p.y + 40} fontSize="10" fill="#1f2937" textAnchor="middle" fontWeight="600">{m.name.split(' (')[0]}</text>
                              <text x={p.x} y={p.y + 53} fontSize="8" fill="#6b7280" textAnchor="middle">{roleLabel(m.role)}</text>
                            </g>
                          );
                        })}
                      </>
                    );
                  })()}
                </svg>
              </div>
            )}

            {tab === 'workload' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">团队工作负载</h3>
                <div className="space-y-1.5">
                  {MEMBERS.slice().sort((a, b) => b.workload - a.workload).map(m => (
                    <div key={m.id} className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-accent text-white text-[10px] flex items-center justify-center font-semibold shrink-0">{m.avatar}</div>
                      <span className="text-[11px] text-text w-32 truncate">{m.name.split(' (')[0]}</span>
                      <Badge variant="default">{m.team}</Badge>
                      <div className="flex-1 h-3 bg-surface-high rounded-full overflow-hidden">
                        <div className={'h-full ' + (m.workload > 85 ? 'bg-danger' : m.workload > 65 ? 'bg-warning' : 'bg-success')} style={{ width: `${m.workload}%` }}></div>
                      </div>
                      <span className="text-[10px] text-text font-mono w-10 text-right">{m.workload}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'profile' && activeMember && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-start gap-3">
                    <div className="relative shrink-0">
                      <div className="w-16 h-16 rounded-full bg-accent text-white text-xl flex items-center justify-center font-bold">{activeMember.avatar}</div>
                      <span className={'absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full border-2 border-bg ' + (
                        activeMember.status === 'online' ? 'bg-success' : activeMember.status === 'busy' ? 'bg-danger' : activeMember.status === 'away' ? 'bg-warning' : activeMember.status === 'in_meeting' ? 'bg-info' : 'bg-text-secondary'
                      )}></span>
                    </div>
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-text">{activeMember.name}</h3>
                      <p className="text-[11px] text-text-secondary">{activeMember.title} · {activeMember.team}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant={statusVariant(activeMember.status)}>{statusLabel(activeMember.status)}</Badge>
                        <span className="text-[10px] text-text-secondary">📍 {activeMember.timezone}</span>
                        <span className="text-[10px] text-text-secondary">✉️ {activeMember.email}</span>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <Button size="sm" icon="chat">消息</Button>
                      <Button size="sm" icon="video_call">视频</Button>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">当前任务</h3>
                    <p className="text-[11px] text-text">{activeMember.currentTask}</p>
                    <div className="mt-2">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-text-secondary">负载</span>
                        <span className="text-text font-mono">{activeMember.workload}%</span>
                      </div>
                      <div className="h-2 bg-surface-high rounded-full overflow-hidden mt-0.5">
                        <div className={'h-full ' + (activeMember.workload > 85 ? 'bg-danger' : activeMember.workload > 65 ? 'bg-warning' : 'bg-success')} style={{ width: `${activeMember.workload}%` }}></div>
                      </div>
                    </div>
                  </div>
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">统计</h3>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-surface-high rounded p-2 text-center">
                        <p className="text-[10px] text-text-secondary">PR 合并</p>
                        <p className="text-lg font-bold text-text font-mono">{activeMember.prsMerged}</p>
                      </div>
                      <div className="bg-surface-high rounded p-2 text-center">
                        <p className="text-[10px] text-text-secondary">代码行数</p>
                        <p className="text-lg font-bold text-text font-mono">{(activeMember.linesOfCode / 1000).toFixed(0)}K</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">技能图谱</h3>
                  <div className="space-y-1.5">
                    {activeMember.skills.map(s => {
                      const lvl = 60 + Math.random() * 35;
                      return (
                        <div key={s} className="flex items-center gap-2">
                          <span className="text-[11px] text-text w-24">{s}</span>
                          <div className="flex-1 h-2 bg-surface-high rounded-full overflow-hidden">
                            <div className="h-full bg-accent" style={{ width: `${lvl}%` }}></div>
                          </div>
                          <span className="text-[10px] text-text font-mono w-10 text-right">{lvl.toFixed(0)}%</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {activeMember.reports.length > 0 && (
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">直接下属 ({activeMember.reports.length})</h3>
                    <div className="space-y-1.5">
                      {activeMember.reports.map(rid => {
                        const r = MEMBERS.find(m => m.id === rid);
                        if (!r) return null;
                        return (
                          <div key={rid} onClick={() => setActiveId(rid)} className="bg-surface-high rounded p-2 flex items-center gap-2 cursor-pointer">
                            <div className="w-7 h-7 rounded-full bg-accent text-white text-[10px] flex items-center justify-center font-semibold">{r.avatar}</div>
                            <span className="text-[11px] text-text flex-1">{r.name}</span>
                            <Badge variant="default">{roleLabel(r.role)}</Badge>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
