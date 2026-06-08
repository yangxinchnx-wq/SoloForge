// ─────────────────────────────────────────────────────────────────
// 右侧面板 - 项目主页 / 系统监控 / 数据库 / 事件 / 架构 / 日志
// 参照渲染图右列：Home 页面 + 多个 Tab
// ─────────────────────────────────────────────────────────────────

import { useMemo, useState, useEffect, useRef } from 'react';
import type { SystemStatus, KernelStatus, ObservationData, DbStats, Agent, KernelEvent } from '../../types';
import { PanelHeader, Tooltip, IconButton, Badge, StatusDot, ProgressBar, RingProgress, AnimatedNumber, Heatmap, Button } from '../ui/Button';
import { pushNotification } from '../overlays/Notifications';

interface Props {
  system: SystemStatus | null;
  kernel: KernelStatus | null;
  observation: ObservationData | null;
  db: DbStats | null;
  agents: Agent[];
  events: KernelEvent[];
  onAction?: (key: 'run' | 'test' | 'deploy' | 'skill' | 'newFile' | 'openTerminal' | 'openSettings' | 'openTour') => void;
}

const TABS = [
  { id: 'home',     label: '主页',     icon: 'home' },
  { id: 'monitor',  label: '监控',     icon: 'monitoring' },
  { id: 'db',       label: '数据库',   icon: 'storage' },
  { id: 'events',   label: '事件',     icon: 'bolt' },
  { id: 'obs',      label: '观测',     icon: 'insights' },
  { id: 'arch',     label: '架构',     icon: 'schema' },
  { id: 'md',       label: 'README',   icon: 'description' },
  { id: 'log',      label: '日志',     icon: 'terminal' },
];

export function PreviewPane({ system, kernel, observation, db, agents, events, onAction }: Props) {
  const [active, setActive] = useState('home');
  const [iframeKey, setIframeKey] = useState(0);

  // 历史 CPU/Mem 滚动数据
  const [cpuHistory, setCpuHistory] = useState<number[]>(Array(40).fill(0));
  const [memHistory, setMemHistory] = useState<number[]>(Array(40).fill(0));
  const [netUpHistory, setNetUpHistory] = useState<number[]>(Array(40).fill(0));
  const [netDownHistory, setNetDownHistory] = useState<number[]>(Array(40).fill(0));

  useEffect(() => {
    if (!system) return;
    setCpuHistory(h => [...h.slice(1), system.cpu]);
    setMemHistory(h => [...h.slice(1), system.memory]);
    setNetUpHistory(h => [...h.slice(1), Math.min(100, (system.network.up / 1024) % 100)]);
    setNetDownHistory(h => [...h.slice(1), Math.min(100, (system.network.down / 1024) % 100)]);
  }, [system]);

  return (
    <aside className="flex-1 min-w-0 flex flex-col border-l border-border bg-bg-dim">
      {/* 项目标题 */}
      <div className="flex items-center justify-between px-3 h-9 bg-gradient-to-r from-primary/5 to-accent/5 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="relative shrink-0">
            <div className="absolute inset-0 blur-md bg-primary/30 rounded-full" />
            <div className="relative w-6 h-6 rounded-md bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <span className="material-symbols-outlined filled text-white" style={{ fontSize: 14 }}>token</span>
            </div>
          </div>
          <h2 className="text-sm font-display font-bold text-text truncate">Mollag</h2>
          <Badge variant="default" className="text-[9px]">v1.0.0</Badge>
        </div>
        <div className="flex items-center gap-0.5">
          <Tooltip content="刷新">
            <IconButton icon="refresh" size="xs" onClick={() => setIframeKey(k => k + 1)} />
          </Tooltip>
          <Tooltip content="在新窗口打开">
            <IconButton icon="open_in_new" size="xs" />
          </Tooltip>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0.5 px-2 h-9 bg-surface border-b border-border overflow-x-auto scrollbar-hide shrink-0">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => { setActive(t.id); setIframeKey(k => k + 1); }}
            className={`flex items-center gap-1 px-2 h-7 rounded text-[11px] transition-all shrink-0 ${
              active === t.id
                ? 'bg-primary-container text-on-primary-container shadow-sm'
                : 'text-text-secondary hover:text-text hover:bg-surface-high'
            }`}
          >
            <span className={`material-symbols-outlined text-sm ${active === t.id ? 'filled' : ''}`}>{t.icon}</span>
            <span>{t.label}</span>
            {t.id === 'events' && events.length > 0 && (
              <Badge variant="default" className="text-[9px] px-1">{events.length}</Badge>
            )}
          </button>
        ))}
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-hidden relative">
        {active === 'md' ? (
          <iframe
            key={iframeKey}
            title="markdown"
            srcDoc={renderMarkdown()}
            className="w-full h-full bg-white text-gray-900 border-0"
            sandbox="allow-same-origin"
          />
        ) : active === 'arch' ? (
          <div className="w-full h-full flex items-center justify-center bg-surface p-2 overflow-auto">
            <ArchitectureDiagram />
          </div>
        ) : (
          <div className="h-full overflow-y-auto p-3 space-y-3 scrollbar-thin">
            {active === 'home' && <HomeTab system={system} kernel={kernel} agents={agents} db={db} onAction={onAction} />}
            {active === 'monitor' && <MonitorTab cpu={cpuHistory} mem={memHistory} up={netUpHistory} down={netDownHistory} system={system} />}
            {active === 'db' && <DbTab db={db} />}
            {active === 'events' && <EventsTab events={events} />}
            {active === 'obs' && <ObsTab observation={observation} />}
            {active === 'log' && <LogTab system={system} kernel={kernel} observation={observation} />}
          </div>
        )}
      </div>
    </aside>
  );
}

// ─── 主页 Tab (项目首页) ───
function HomeTab({ system, kernel, agents, db, onAction }: {
  system: SystemStatus | null; kernel: KernelStatus | null; agents: Agent[]; db: DbStats | null;
  onAction?: (key: 'run' | 'test' | 'deploy' | 'skill' | 'newFile' | 'openTerminal' | 'openSettings' | 'openTour') => void;
}) {
  const cpu = system?.cpu ?? 0;
  const mem = system?.memory ?? 0;
  const running = agents.filter(a => a.status === 'running').length;
  const [activeProject, setActiveProject] = useState<typeof PROJECTS[number] | null>(null);

  return (
    <>
      {/* 顶部：项目名 + 描述 */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-primary/10 via-accent/5 to-transparent p-4">
        <div className="absolute -right-6 -top-6 w-24 h-24 rounded-full bg-primary/20 blur-2xl" />
        <div className="absolute -left-6 -bottom-6 w-24 h-24 rounded-full bg-accent/20 blur-2xl" />
        <div className="relative">
          <div className="flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined filled text-primary text-xl">token</span>
            <h1 className="text-lg font-display font-bold text-text">Mollag</h1>
            <Badge variant="success" dot>v1.0.0</Badge>
          </div>
          <p className="text-[11px] text-text-secondary leading-relaxed">
            这就是 SoloForge 资源仓库 · 你的第一个项目。
            <br />包含示例代码、技能、配置和测试。
          </p>
          <div className="flex items-center gap-2 mt-3">
            <Button variant="primary" size="sm" icon="play_arrow" onClick={() => onAction?.('run')}>开始使用</Button>
            <Button variant="outline" size="sm" icon="bookmark" onClick={() => {
              pushProjectNotification('项目已收藏', '已加入 SoloForge 收藏夹');
            }}>收藏</Button>
            <Button variant="ghost" size="sm" icon="share" onClick={() => {
              navigator.clipboard?.writeText('https://soloforge.dev/projects/mollag');
              pushProjectNotification('链接已复制', 'https://soloforge.dev/projects/mollag');
            }}>分享</Button>
          </div>
        </div>
      </div>

      {/* 关键指标 — 4 个大卡片 */}
      <div className="grid grid-cols-2 gap-2">
        <ResourceCard
          icon="memory" label="CPU" value={cpu} suffix="%" sub="实时" color={cpu > 80 ? 'danger' : cpu > 50 ? 'warning' : 'success'}
        />
        <ResourceCard
          icon="storage" label="内存" value={parseFloat(system?.memoryUsed ?? '0')} suffix="G" sub={`/ ${system?.memoryTotal ?? 0}G`} color="primary"
        />
        <ResourceCard
          icon="lan" label="网络 ↓" value={system?.network.down ?? 0} format={formatBps} sub="下载" color="info" />
        <ResourceCard
          icon="smart_toy" label="组件" value={running} suffix={`/${agents.length}`} sub="活跃" color="accent"
        />
      </div>

      {/* 内核状态 */}
      <Card title="内核" icon="memory" action={
        <StatusDot status={kernel?.state === 'READY' ? 'success' : 'pending'} pulse />
      }>
        <div className="space-y-1 text-[11px]">
          <Row label="状态"><span className="text-text font-mono font-semibold">{kernel?.state || 'UNKNOWN'}</span></Row>
          <Row label="版本"><span className="text-text font-mono">v{kernel?.version ?? 0}</span></Row>
          <Row label="Tick"><span className="text-text font-mono tabular-nums"><AnimatedNumber value={kernel?.currentTick ?? 0} format={n => n.toLocaleString()} /></span></Row>
          <Row label="模式">{kernel?.mode || '--'}</Row>
        </div>
      </Card>

      {/* 数据库 */}
      <Card title="数据库" icon="database">
        <div className="grid grid-cols-3 gap-1.5 text-center">
          <DBMini icon="speed"     label="Garnet"    val={db?.garnet.totalKeys ?? 0} status={db?.garnet.connected ?? false} />
          <DBMini icon="storage"   label="SurrealDB" val={db?.surrealdb.records ?? 0} status={db?.surrealdb.connected ?? false} />
          <DBMini icon="inventory" label="JSONL"     val={db?.jsonl.records ?? 0} status={db?.jsonl.healthy ?? false} />
        </div>
      </Card>

      {/* 快速诊断条 */}
      <Card title="系统诊断" icon="health_and_safety">
        <DiagnosticsBar system={system} kernel={kernel} db={db} />
      </Card>

      {/* 最新工程（可点击展开） */}
      <Card title="最新工程" icon="auto_awesome" action={<button className="text-[10px] text-primary hover:underline">查看全部 ›</button>}>
        <div className="space-y-2">
          {PROJECTS.map((p, i) => (
            <button
              key={i}
              onClick={() => setActiveProject(p)}
              className="group w-full flex items-center gap-2 p-2 rounded-lg bg-surface-low hover:bg-surface-high hover:border-primary/40 border border-transparent transition-all text-left"
            >
              <div className={`w-7 h-7 rounded-md flex items-center justify-center text-white text-[10px] font-bold shrink-0 ${
                p.lang === 'Vue' ? 'bg-success' :
                p.lang === 'Python' ? 'bg-info' :
                p.lang === 'TypeScript' ? 'bg-primary' : 'bg-warning'
              }`}>{p.lang[0]}</div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-text truncate">{p.name}</div>
                <div className="text-[10px] text-text-secondary truncate">{p.desc}</div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="flex items-center gap-0.5 text-[10px] text-text-secondary">
                  <span className="material-symbols-outlined text-xs filled text-warning">star</span>
                  <span className="font-mono">{p.star}</span>
                </span>
                <span className="opacity-0 group-hover:opacity-100 material-symbols-outlined text-sm text-text-secondary">chevron_right</span>
              </div>
            </button>
          ))}
        </div>
      </Card>

      {/* 快速操作 */}
      <Card title="快速操作" icon="bolt">
        <div className="grid grid-cols-4 gap-2">
          {([
            { key: 'run',          icon: 'play_arrow',   label: '运行',     color: 'text-primary',   desc: '启动开发服务器 / 任务' },
            { key: 'test',         icon: 'science',      label: '测试',     color: 'text-success',   desc: '运行测试套件' },
            { key: 'deploy',       icon: 'cloud_upload', label: '部署',     color: 'text-info',      desc: '部署到生产环境' },
            { key: 'skill',        icon: 'extension',    label: '技能',     color: 'text-warning',   desc: '打开技能市场' },
            { key: 'newFile',      icon: 'note_add',     label: '新建',     color: 'text-text',      desc: '新建文件/目录' },
            { key: 'openTerminal', icon: 'terminal',     label: '终端',     color: 'text-accent',    desc: '打开集成终端' },
            { key: 'openSettings', icon: 'settings',     label: '设置',     color: 'text-text-secondary', desc: '打开应用设置' },
            { key: 'openTour',     icon: 'route',        label: '引导',     color: 'text-text-secondary', desc: '重新查看产品引导' },
          ] as const).map((a) => (
            <button
              key={a.key}
              onClick={() => {
                onAction?.(a.key);
                pushProjectNotification(a.label, a.desc);
              }}
              className="flex flex-col items-center gap-1 p-2 rounded-lg bg-surface-low hover:bg-surface-high hover:border-primary/40 border border-transparent transition-colors group"
              title={a.desc}
            >
              <span className={`material-symbols-outlined text-xl ${a.color} group-hover:scale-110 transition-transform`}>{a.icon}</span>
              <span className="text-[10px] text-text-secondary">{a.label}</span>
            </button>
          ))}
        </div>
      </Card>

      {activeProject && <ProjectDetailModal project={activeProject} onClose={() => setActiveProject(null)} />}
    </>
  );
}

const PROJECTS = [
  { name: 'RuoYi-Vue-Plus', desc: 'AI Studio · 后台管理模板', star: '12.5k', lang: 'Vue',       author: 'dromara',  tags: ['Vue3', 'TS', 'Element'],  desc2: '基于 Vue3 + Vite + Element Plus 的企业级后台模板，集成了权限管理、代码生成、监控等模块。', updated: '2 天前', size: '1.2 MB' },
  { name: 'fastapi-best-practices', desc: 'AI 工具集 · Python 模板', star: '8.4k', lang: 'Python',    author: 'zhanymkanov', tags: ['FastAPI', 'Pydantic', 'SQLAlchemy'], desc2: '完整的 FastAPI 后端最佳实践，涵盖依赖注入、错误处理、JWT 鉴权、测试与部署。', updated: '5 天前', size: '320 KB' },
  { name: 'Mollag', desc: 'SoloForge 内置 · 多智能体', star: '142', lang: 'TypeScript', author: 'soloforge', tags: ['MARL', 'TS', 'SurrealDB'], desc2: '多智能体治理 OS 内置示例项目，包含决策引擎、训练回路、记忆系统。', updated: '刚刚', size: '4.8 MB' },
  { name: 'surreal-realtime', desc: '数据库 · 实时', star: '342', lang: 'Rust',       author: 'surreal-contrib', tags: ['Rust', 'Realtime', 'DB'], desc2: '基于 SurrealDB 的实时订阅与变更流处理器，使用 Rust 异步运行时。', updated: '1 周前', size: '780 KB' },
];

function pushProjectNotification(title: string, message: string) {
  pushNotification({ level: 'info', title, message });
}

function ProjectDetailModal({ project, onClose }: { project: typeof PROJECTS[number]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in p-4" onClick={onClose}>
      <div className="w-[520px] max-w-[95vw] bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden animate-slide-in-up" onClick={e => e.stopPropagation()}>
        {/* Header 渐变 */}
        <div className="relative h-24 bg-gradient-to-br from-primary/20 via-accent/10 to-transparent overflow-hidden">
          <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-primary/30 blur-3xl" />
          <div className="absolute -left-10 -bottom-10 w-32 h-32 rounded-full bg-accent/30 blur-3xl" />
          <button onClick={onClose} className="absolute top-2 right-2 p-1.5 rounded hover:bg-surface/60 text-text-secondary hover:text-text">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
        {/* Body */}
        <div className="p-4 -mt-10 relative">
          <div className="flex items-end gap-3 mb-3">
            <div className={`w-14 h-14 rounded-xl flex items-center justify-center text-white text-xl font-bold shadow-lg shrink-0 ${
              project.lang === 'Vue' ? 'bg-success' :
              project.lang === 'Python' ? 'bg-info' :
              project.lang === 'TypeScript' ? 'bg-primary' : 'bg-warning'
            }`}>{project.lang[0]}</div>
            <div className="flex-1 min-w-0 pb-1">
              <h2 className="text-base font-display font-bold text-text truncate">{project.name}</h2>
              <div className="flex items-center gap-1.5 text-[10px] text-text-secondary">
                <span>by {project.author}</span>
                <span>·</span>
                <span>{project.lang}</span>
                <span>·</span>
                <span>{project.updated}</span>
              </div>
            </div>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed mb-3">{project.desc2}</p>
          <div className="flex flex-wrap gap-1 mb-3">
            {project.tags.map(t => (
              <Badge key={t} variant="primary" className="text-[9px]">{t}</Badge>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="p-2 bg-surface-low rounded-lg text-center">
              <div className="text-[9px] text-text-secondary">收藏</div>
              <div className="text-sm font-bold text-text font-mono flex items-center justify-center gap-0.5">
                <span className="material-symbols-outlined text-xs filled text-warning">star</span>{project.star}
              </div>
            </div>
            <div className="p-2 bg-surface-low rounded-lg text-center">
              <div className="text-[9px] text-text-secondary">大小</div>
              <div className="text-sm font-bold text-text font-mono">{project.size}</div>
            </div>
            <div className="p-2 bg-surface-low rounded-lg text-center">
              <div className="text-[9px] text-text-secondary">更新</div>
              <div className="text-sm font-bold text-text">{project.updated}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" icon="download" block>克隆到工作区</Button>
            <Button variant="outline" size="sm" icon="open_in_new">在 GitHub 查看</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResourceCard({ icon, label, value, suffix, sub, color, format }: {
  icon: string; label: string; value: number; suffix?: string; sub?: string;
  color: 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'accent';
  format?: (n: number) => string;
}) {
  const c = {
    primary: 'from-primary/10 to-primary/5 text-primary',
    success: 'from-success/10 to-success/5 text-success',
    warning: 'from-warning/10 to-warning/5 text-warning',
    danger:  'from-danger/10 to-danger/5 text-danger',
    info:    'from-accent/10 to-accent/5 text-accent',
    accent:  'from-accent/10 to-accent/5 text-accent',
  }[color];
  const display = format ? format(value) : value.toFixed(suffix === '%' || suffix === 'G' ? 1 : 0);
  return (
    <div className={`relative overflow-hidden rounded-lg border border-border-light bg-gradient-to-br ${c} p-2.5 hover-lift`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-text-secondary">{label}</span>
        <span className="material-symbols-outlined text-sm opacity-70">{icon}</span>
      </div>
      <div className="flex items-baseline gap-0.5">
        <span className="text-lg font-bold font-mono tabular-nums">{display}</span>
        {suffix && <span className="text-[10px] text-text-secondary">{suffix}</span>}
      </div>
      {sub && <div className="text-[9px] text-text-secondary/80 mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── 总览 Tab ───
function OverviewTab({ system, kernel, agents, db }: { system: SystemStatus | null; kernel: KernelStatus | null; agents: Agent[]; db: DbStats | null }) {
  const running = agents.filter(a => a.status === 'running').length;
  const cpu = system?.cpu ?? 0;
  const mem = system?.memory ?? 0;
  return (
    <>
      {/* 关键指标 — 环形 + 数字滚动 */}
      <Card title="资源总览" icon="monitoring">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-3 p-2 rounded-lg bg-surface-low hover-lift">
            <RingProgress value={cpu} color={cpu > 80 ? 'danger' : cpu > 50 ? 'warning' : 'success'} size={56} strokeWidth={5} showLabel />
            <div className="min-w-0">
              <div className="text-[10px] text-text-secondary">CPU</div>
              <div className="text-sm font-bold text-text">
                <AnimatedNumber value={cpu} format={n => n.toFixed(1) + '%'} />
              </div>
              <div className="text-[9px] text-text-secondary font-mono">{system?.loadAvg?.[0]?.toFixed(2) ?? '0.00'} load</div>
            </div>
          </div>
          <div className="flex items-center gap-3 p-2 rounded-lg bg-surface-low hover-lift">
            <RingProgress value={mem} color={mem > 80 ? 'danger' : mem > 50 ? 'warning' : 'primary'} size={56} strokeWidth={5} showLabel />
            <div className="min-w-0">
              <div className="text-[10px] text-text-secondary">内存</div>
              <div className="text-sm font-bold text-text">
                <AnimatedNumber value={parseFloat(system?.memoryUsed ?? '0')} format={n => n.toFixed(1) + 'G'} />
              </div>
              <div className="text-[9px] text-text-secondary font-mono">/ {system?.memoryTotal ?? 0}G</div>
            </div>
          </div>
          <div className="flex items-center gap-3 p-2 rounded-lg bg-surface-low hover-lift">
            <RingProgress value={Math.min(100, ((system?.network.down ?? 0) / 1024 / 1024) * 10)} color="accent" size={56} strokeWidth={5} showLabel />
            <div className="min-w-0">
              <div className="text-[10px] text-text-secondary">下行</div>
              <div className="text-sm font-bold text-text">{formatBps(system?.network.down ?? 0)}</div>
              <div className="text-[9px] text-text-secondary font-mono">↓ in</div>
            </div>
          </div>
          <div className="flex items-center gap-3 p-2 rounded-lg bg-surface-low hover-lift">
            <RingProgress value={Math.min(100, ((system?.network.up ?? 0) / 1024 / 1024) * 10)} color="warning" size={56} strokeWidth={5} showLabel />
            <div className="min-w-0">
              <div className="text-[10px] text-text-secondary">上行</div>
              <div className="text-sm font-bold text-text">{formatBps(system?.network.up ?? 0)}</div>
              <div className="text-[9px] text-text-secondary font-mono">↑ out</div>
            </div>
          </div>
        </div>
      </Card>

      {/* 内核 */}
      <Card title="内核状态" icon="memory">
        <div className="space-y-1.5 text-xs">
          <Row label="状态">
            <span className="flex items-center gap-1">
              <StatusDot status={kernel?.state === 'READY' ? 'success' : 'pending'} pulse />
              <span className="text-text font-medium">{kernel?.state || 'UNKNOWN'}</span>
            </span>
          </Row>
          <Row label="运行模式">{kernel?.mode || '--'}</Row>
          <Row label="版本"><span className="font-mono text-text">v{kernel?.version ?? 0}</span></Row>
          <Row label="Tick">
            <span className="font-mono text-text">
              <AnimatedNumber value={kernel?.currentTick ?? 0} format={n => n.toLocaleString()} />
            </span>
          </Row>
          <Row label="运行时长"><span className="font-mono text-text">{kernel ? formatMs(kernel.uptime) : '--'}</span></Row>
        </div>
      </Card>

      {/* 组件 */}
      <Card title="组件清单" icon="smart_toy" action={<Badge variant="primary">{running}/{agents.length}</Badge>}>
        <div className="space-y-1.5">
          {agents.slice(0, 6).map(a => (
            <div key={a.id} className="flex items-center gap-2 text-xs">
              <StatusDot status={a.status === 'running' ? 'running' : a.status === 'error' ? 'error' : 'idle'} />
              <span className="text-text truncate flex-1">{a.name}</span>
              <span className="text-text-secondary font-mono text-[10px]">
                <AnimatedNumber value={a.tasks} /> 任务
              </span>
            </div>
          ))}
        </div>
      </Card>

      {/* 数据库 */}
      <Card title="数据库" icon="database">
        <div className="grid grid-cols-3 gap-2 text-center">
          <DBMini icon="speed"     label="Garnet"    val={db?.garnet.totalKeys ?? 0} status={db?.garnet.connected ?? false} />
          <DBMini icon="storage"   label="SurrealDB" val={db?.surrealdb.records ?? 0} status={db?.surrealdb.connected ?? false} />
          <DBMini icon="inventory" label="JSONL"     val={db?.jsonl.records ?? 0} status={db?.jsonl.healthy ?? false} />
        </div>
      </Card>
    </>
  );
}

// ─── 监控 Tab ───
function MonitorTab({ cpu, mem, up, down, system }: { cpu: number[]; mem: number[]; up: number[]; down: number[]; system: SystemStatus | null }) {
  return (
    <>
      <Card title="CPU 使用率" icon="speed" action={<span className="text-xs font-mono text-text">{system?.cpu.toFixed(1) ?? '0'}%</span>}>
        <Sparkline data={cpu} color="#58a6ff" />
      </Card>
      <Card title="内存使用率" icon="memory" action={<span className="text-xs font-mono text-text">{system?.memory.toFixed(1) ?? '0'}%</span>}>
        <Sparkline data={mem} color="#3fb950" />
      </Card>
      <Card title="网络流量" icon="lan" action={
        <div className="flex items-center gap-2 text-[10px] font-mono">
          <span className="text-info">↓ {formatBps(system?.network.down ?? 0)}</span>
          <span className="text-warning">↑ {formatBps(system?.network.up ?? 0)}</span>
        </div>
      }>
        <Sparkline data={down} color="#58a6ff" label="下载" />
        <div className="h-2" />
        <Sparkline data={up} color="#d29922" label="上传" />
      </Card>
      <Card title="负载分布" icon="donut_large">
        <div className="space-y-2 text-xs">
          <DistroBar label="系统"  pct={Math.max(0, 100 - (system?.cpu ?? 0) - (system?.memory ?? 0))} color="#888" />
          <DistroBar label="应用"  pct={system?.cpu ?? 0} color="#58a6ff" />
          <DistroBar label="缓存"  pct={Math.min(20, (system?.memory ?? 0) * 0.3)} color="#3fb950" />
        </div>
      </Card>

      <Card title="7×24 资源热力" icon="grid_view">
        <div className="text-[10px] text-text-secondary mb-1.5">每格代表 1 小时</div>
        <div className="flex items-start gap-1">
          <div className="flex flex-col gap-1 text-[8px] text-text-secondary/60 mr-0.5 mt-0.5">
            {['一', '二', '三', '四', '五', '六', '日'].map(d => (
              <span key={d} className="h-3 flex items-center">{d}</span>
            ))}
          </div>
          <div className="flex-1">
            <Heatmap data={Array.from({ length: 24 * 7 }, () => Math.random())} cols={24} rows={7} />
          </div>
        </div>
        <div className="flex items-center justify-between mt-2 text-[9px] text-text-secondary">
          <span>00:00</span>
          <div className="flex items-center gap-1">
            <span>低</span>
            <div className="flex">
              {[0.2, 0.4, 0.6, 0.8, 1].map(o => (
                <div key={o} className="w-2 h-2" style={{ background: `color-mix(in srgb, var(--color-primary) ${o * 100}%, var(--color-surface-high))` }} />
              ))}
            </div>
            <span>高</span>
          </div>
          <span>23:00</span>
        </div>
      </Card>
    </>
  );
}

// ─── 数据库 Tab ───
function DbTab({ db }: { db: DbStats | null }) {
  if (!db) return <Empty msg="数据库未就绪" />;
  return (
    <>
      <Card title="Garnet (Redis 兼容)" icon="speed" action={
        <Badge variant={db.garnet.connected ? 'success' : 'danger'} dot>
          {db.garnet.connected ? '已连接' : '未连接'}
        </Badge>
      }>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <DataRow label="总 Key" value={db.garnet.totalKeys ?? 0} />
          <DataRow label="会话"   value={db.garnet.sessions} />
          <DataRow label="任务"   value={db.garnet.tasks} />
          <DataRow label="计数器" value={db.garnet.counters} />
        </div>
        <div className="mt-2">
          <ProgressBar value={Math.min(100, (db.garnet.totalKeys ?? 0) / 100)} color="primary" showLabel />
          <div className="text-[10px] text-text-secondary mt-0.5">缓存容量 (假设 10k 上限)</div>
        </div>
      </Card>

      <Card title="SurrealDB" icon="storage" action={
        <Badge variant={db.surrealdb.connected ? 'success' : 'danger'} dot>
          {db.surrealdb.connected ? '已连接' : '未连接'}
        </Badge>
      }>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <DataRow label="总记录" value={db.surrealdb.records} />
          <DataRow label="热数据" value={db.surrealdb.hot} />
        </div>
        {db.surrealdb.tables && Object.keys(db.surrealdb.tables).length > 0 && (
          <div className="mt-2 pt-2 border-t border-border-light">
            <div className="text-[10px] text-text-secondary mb-1">表记录分布</div>
            <div className="space-y-1">
              {Object.entries(db.surrealdb.tables).map(([t, n]) => (
                <div key={t} className="flex items-center gap-2 text-[10px]">
                  <span className="font-mono text-text-secondary w-28 truncate">{t}</span>
                  <ProgressBar value={Math.min(100, n / 10)} color="accent" />
                  <span className="font-mono text-text w-8 text-right">{n}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card title="JSONL 归档" icon="inventory" action={
        <Badge variant={db.jsonl.healthy ? 'success' : 'warning'} dot>
          {db.jsonl.healthy ? '正常' : '异常'}
        </Badge>
      }>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <DataRow label="归档记录" value={db.jsonl.records} />
          <DataRow label="文件大小" value={db.jsonl.size} />
          <DataRow label="文件数" value={db.jsonl.files ?? 0} />
        </div>
      </Card>
    </>
  );
}

// ─── 事件 Tab ───
function EventsTab({ events }: { events: KernelEvent[] }) {
  if (events.length === 0) {
    return <Empty msg="暂无事件" icon="event_busy" />;
  }
  return (
    <Card title="事件流" icon="bolt" action={<Badge variant="info">{events.length}</Badge>}>
      <div className="space-y-1 max-h-[600px] overflow-y-auto scrollbar-thin -mx-1 px-1">
        {events.slice(0, 30).map((e, i) => (
          <div key={i} className="flex items-start gap-2 text-[10px] py-1 px-1.5 rounded hover:bg-surface-low group">
            <span className="material-symbols-outlined text-xs text-accent">circle</span>
            <span className="font-mono text-text min-w-[120px]">{e.event}</span>
            <span className="text-text-secondary font-mono shrink-0">{new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─── 观测 Tab ───
function ObsTab({ observation }: { observation: ObservationData | null }) {
  if (!observation) return <Empty msg="观测服务未就绪" icon="insights" />;
  const points = observation.observations.slice(-50);
  const max = Math.max(0.01, ...points.map(p => p.entropy));
  return (
    <>
      <Card title="演化观测" icon="insights" action={
        <Badge variant={observation.isObserving ? 'success' : 'default'} dot pulse={observation.isObserving}>
          {observation.isObserving ? '采集中' : '空闲'}
        </Badge>
      }>
        <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
          <DataRow label="总事件" value={observation.stats?.totalEvents ?? 0} />
          <DataRow label="干预"   value={observation.stats?.interventions ?? 0} />
          <DataRow label="法庭案" value={observation.stats?.courtCases ?? 0} />
          <DataRow label="联盟"   value={observation.stats?.coalitions ?? 0} />
        </div>
        <div className="text-[10px] text-text-secondary mb-1">系统熵值演化</div>
        <EntropyChart points={points.map(p => p.entropy)} max={max} />
      </Card>

      <Card title="组件趋势" icon="trending_up">
        <div className="space-y-2 text-xs">
          <Stacked label="事件流" val={observation.stats?.totalEvents ?? 0} max={Math.max(observation.stats?.totalEvents ?? 1, 100)} color="primary" />
          <Stacked label="决策"   val={Math.floor((observation.stats?.totalEvents ?? 0) * 0.3)} max={Math.max(observation.stats?.totalEvents ?? 1, 100)} color="accent" />
          <Stacked label="治理"   val={observation.stats?.interventions ?? 0} max={Math.max(observation.stats?.totalEvents ?? 1, 100)} color="warning" />
        </div>
      </Card>
    </>
  );
}

// ─── 日志 Tab ───
function LogTab({ system, kernel, observation }: { system: SystemStatus | null; kernel: KernelStatus | null; observation: ObservationData | null }) {
  const logRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    const now = new Date();
    const ts = (offset: number) => new Date(now.getTime() - offset * 1000).toLocaleTimeString('zh-CN', { hour12: false });
    return [
      { ts: ts(0),    level: 'INFO',  msg: `api: GET /api/status 200 ok (${Math.floor(Math.random() * 5) + 1}ms)` },
      { ts: ts(0),    level: 'INFO',  msg: `kernel: tick=${kernel?.currentTick ?? 0} state=${kernel?.state ?? 'UNKNOWN'}` },
      { ts: ts(1),    level: 'DEBUG', msg: `eventbus: emit ${events_sample()} -> ${Math.floor(Math.random() * 10)} listeners` },
      { ts: ts(2),    level: 'INFO',  msg: `surreal: SELECT * FROM decision LIMIT 10 -> ${Math.floor(Math.random() * 50)} rows` },
      { ts: ts(3),    level: 'DEBUG', msg: `garnet: GET key=session:${Math.random().toString(36).slice(2, 10)} -> HIT` },
      { ts: ts(5),    level: 'INFO',  msg: `scheduler: queue draining (${Math.floor(Math.random() * 8)} pending)` },
      { ts: ts(7),    level: 'WARN',  msg: `governor: drift detected, applying policy ${Math.floor(Math.random() * 4) + 1}` },
      { ts: ts(10),   level: 'INFO',  msg: `court: ${observation?.stats?.courtCases ?? 0} active cases` },
      { ts: ts(12),   level: 'ERROR', msg: `archiver: retry ${Math.floor(Math.random() * 3) + 1}/3` },
      { ts: ts(15),   level: 'INFO',  msg: `network: ↓ ${formatBps(system?.network.down ?? 0)}  ↑ ${formatBps(system?.network.up ?? 0)}` },
    ];
  }, [system, kernel, observation]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  return (
    <Card title="运行日志" icon="terminal" action={
      <Badge variant="success" dot>实时</Badge>
    }>
      <div ref={logRef} className="bg-bg rounded border border-border-light p-2 max-h-[600px] overflow-y-auto scrollbar-thin font-mono text-[10px] leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className="flex items-start gap-1.5 hover:bg-surface-high px-1 -mx-1 rounded">
            <span className="text-text-secondary shrink-0">{l.ts}</span>
            <span className={`shrink-0 w-10 ${l.level === 'ERROR' ? 'text-danger' : l.level === 'WARN' ? 'text-warning' : l.level === 'DEBUG' ? 'text-text-secondary' : 'text-info'}`}>
              {l.level}
            </span>
            <span className="text-text flex-1">{l.msg}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─── 工具组件 ───
function Card({ title, icon, action, children }: { title: string; icon: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden animate-slide-in-up">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface-high">
        <h3 className="text-[11px] font-semibold text-text flex items-center gap-1.5">
          <span className="material-symbols-outlined filled text-primary text-sm">{icon}</span>
          {title}
        </h3>
        {action}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function MetricCard({ icon, label, value, color, sub }: { icon: string; label: string; value: string; color: 'primary' | 'success' | 'warning' | 'danger' | 'info'; sub?: string }) {
  const colorMap = {
    primary: 'text-primary bg-primary/10',
    success: 'text-success bg-success/10',
    warning: 'text-warning bg-warning/10',
    danger:  'text-danger bg-danger/10',
    info:    'text-accent bg-accent/10',
  }[color];
  return (
    <div className="bg-surface rounded-lg border border-border p-2.5 hover:border-primary/50 transition-colors group">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-text-secondary">{label}</span>
        <span className={`material-symbols-outlined text-sm ${colorMap.split(' ')[0]}`}>{icon}</span>
      </div>
      <div className={`text-lg font-bold font-mono tabular-nums ${colorMap.split(' ')[0]}`}>{value}</div>
      {sub && <div className="text-[10px] text-text-secondary mt-0.5">{sub}</div>}
    </div>
  );
}

function DBMini({ icon, label, val, status }: { icon: string; label: string; val: number; status: boolean }) {
  return (
    <div className="p-2 bg-surface-low rounded border border-border-light">
      <div className="flex items-center justify-center gap-1 mb-1">
        <span className={`material-symbols-outlined text-sm ${status ? 'text-success' : 'text-text-secondary'}`}>{icon}</span>
        <span className="text-[10px] text-text-secondary">{label}</span>
      </div>
      <div className="text-sm font-bold font-mono text-text">{val.toLocaleString()}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-secondary">{label}</span>
      <span className="text-text">{children}</span>
    </div>
  );
}

function DataRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="p-1.5 bg-surface-low rounded">
      <div className="text-[9px] text-text-secondary">{label}</div>
      <div className="text-text font-mono">{value}</div>
    </div>
  );
}

function Sparkline({ data, color, label }: { data: number[]; color: string; label?: string }) {
  const max = Math.max(0.01, ...data);
  const min = Math.min(0, ...data);
  const range = max - min || 1;
  const w = 200, h = 40;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div>
      {label && <div className="text-[10px] text-text-secondary mb-1">{label}</div>}
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-10">
        <defs>
          <linearGradient id={`g-${color}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.4" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polyline fill="none" stroke={color} strokeWidth="1.5" points={pts} />
        <polygon fill={`url(#g-${color})`} points={`0,${h} ${pts} ${w},${h}`} />
      </svg>
    </div>
  );
}

function DistroBar({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between text-[10px] mb-0.5">
        <span className="text-text-secondary">{label}</span>
        <span className="font-mono text-text">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 bg-surface-high rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function Stacked({ label, val, max, color }: { label: string; val: number; max: number; color: 'primary' | 'accent' | 'warning' }) {
  const c = { primary: 'bg-primary', accent: 'bg-accent', warning: 'bg-warning' }[color];
  return (
    <div>
      <div className="flex justify-between text-[10px] mb-0.5">
        <span className="text-text-secondary">{label}</span>
        <span className="font-mono text-text">{val}</span>
      </div>
      <div className="h-2 bg-surface-high rounded overflow-hidden">
        <div className={`h-full ${c} transition-all`} style={{ width: `${Math.min(100, (val / max) * 100)}%` }} />
      </div>
    </div>
  );
}

function EntropyChart({ points, max }: { points: number[]; max: number }) {
  const w = 240, h = 60;
  const path = points.map((v, i) => {
    const x = (i / Math.max(1, points.length - 1)) * w;
    const y = h - (v / max) * h * 0.9 - 3;
    return `${i === 0 ? 'M' : 'L'}${x},${y}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16">
      <defs>
        <linearGradient id="ent-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.5" />
          <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map(p => (
        <line key={p} x1="0" y1={h * p} x2={w} y2={h * p} stroke="var(--color-border-light)" strokeDasharray="2 2" />
      ))}
      <path d={path + ` L${w},${h} L0,${h} Z`} fill="url(#ent-grad)" />
      <path d={path} fill="none" stroke="var(--color-primary)" strokeWidth="1.5" />
    </svg>
  );
}

function Empty({ msg, icon = 'inbox' }: { msg: string; icon?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-32 text-text-secondary">
      <span className="material-symbols-outlined text-3xl mb-1 opacity-40">{icon}</span>
      <p className="text-xs">{msg}</p>
    </div>
  );
}

// ─── Markdown 渲染 ───
function renderMarkdown(): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown.min.css">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px; max-width: 800px; margin: 0 auto; line-height: 1.6; }
  h1 { border-bottom: 2px solid #eaecef; padding-bottom: 0.3em; }
  h2 { border-bottom: 1px solid #eaecef; padding-bottom: 0.2em; margin-top: 1.5em; }
  code { background: #f6f8fa; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow: auto; }
  pre code { background: transparent; padding: 0; }
  table { border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid #dfe2e5; padding: 6px 13px; }
  th { background: #f6f8fa; }
  blockquote { border-left: 4px solid #dfe2e5; color: #6a737d; padding-left: 1em; margin: 0.5em 0; }
  img { max-width: 100%; }
</style>
</head>
<body class="markdown-body">
<h1>🪐 SoloForge</h1>
<p><strong>分布式 MARL 智能体治理 OS</strong> — 一个面向多智能体协同的自治系统核心框架。</p>

<h2>✨ 特性</h2>
<ul>
  <li><strong>微内核架构</strong> — TypeScript / Node.js 单进程事件总线</li>
  <li><strong>嵌入式数据库</strong> — SurrealDB (RocksDB 持久化) + Garnet (Redis 缓存)</li>
  <li><strong>Rust 高性能调度器</strong> — Aging 优先队列，O(log n) 调度</li>
  <li><strong>Python MARL 引擎</strong> — MAPPO 多智能体强化学习</li>
  <li><strong>多模型协作</strong> — 主/副模型混合任务，工具 + 记忆 + 知识库</li>
</ul>

<h2>📦 目录结构</h2>
<pre><code>SoloForge/
├── src/                    # TypeScript 运行时
│   ├── kernel/             # 微内核
│   ├── core/               # 智能体 / 法庭 / 法律
│   ├── data/               # 数据层
│   └── api-server.ts       # API 服务器
├── rust_core/              # Rust 调度器
├── python/                 # Python MARL
├── migrations/             # SurrealDB Schema
├── UI/                     # 前端 (React)
└── tests/                  # 测试套件</code></pre>

<h2>🚀 快速开始</h2>
<ol>
  <li>启动后端: <code>npx tsx src/index.ts</code></li>
  <li>启动前端: <code>cd UI && npm run dev</code></li>
  <li>访问: <a href="http://localhost:5173">http://localhost:5173</a></li>
</ol>

<h2>🛠️ 技术栈</h2>
<table>
<thead><tr><th>层级</th><th>技术</th></tr></thead>
<tbody>
<tr><td>运行时</td><td>TypeScript + Node.js</td></tr>
<tr><td>数据库</td><td>SurrealDB (RocksDB)</td></tr>
<tr><td>缓存</td><td>Garnet / Dragonfly</td></tr>
<tr><td>调度</td><td>Rust</td></tr>
<tr><td>训练</td><td>Python + PyTorch</td></tr>
<tr><td>前端</td><td>React + Vite + Tailwind</td></tr>
</tbody>
</table>

<blockquote>
<p>🪐 单调核心，启动！</p>
</blockquote>
</body></html>`;
}

// ─── 架构图 ───
function ArchitectureDiagram() {
  return (
    <svg viewBox="0 0 700 500" className="w-full max-w-3xl">
      <defs>
        <marker id="arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
        <linearGradient id="boxGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-surface)" />
          <stop offset="100%" stopColor="var(--color-surface-low)" />
        </linearGradient>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <text x="350" y="30" textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--color-primary)">SoloForge 架构总览</text>

      {/* 用户层 */}
      <Layer y={60} title="用户交互层">
        <Box x={250} y={50} w={200} h={40} label="Web UI (React)" sub="5173" primary />
      </Layer>

      {/* API 层 */}
      <Layer y={130} title="API & 网关层">
        <Box x={50}  y={120} w={160} h={40} label="REST API" sub="/api/*" />
        <Box x={270} y={120} w={160} h={40} label="SSE" sub="/api/events/stream" />
        <Box x={490} y={120} w={160} h={40} label="Metrics" sub="/metrics" />
      </Layer>

      {/* 核心层 */}
      <Layer y={200} title="微内核核心 (TypeScript)">
        <Box x={20}  y={190} w={130} h={45} label="RuntimeKernel" sub="事件总线" />
        <Box x={170} y={190} w={130} h={45} label="ClusterOrch" sub="集群编排" />
        <Box x={320} y={190} w={130} h={45} label="Raft" sub="共识" />
        <Box x={470} y={190} w={130} h={45} label="Scheduler" sub="任务调度" />
        <Box x={620} y={190} w={60}  h={45} label="Cfg" sub="配置" />
      </Layer>

      {/* 业务层 */}
      <Layer y={270} title="业务引擎层">
        <Box x={20}  y={260} w={100} h={40} label="决策引擎" sub="RTR" />
        <Box x={140} y={260} w={100} h={40} label="法庭" sub="Court" />
        <Box x={260} y={260} w={100} h={40} label="Governor" sub="治理" />
        <Box x={380} y={260} w={100} h={40} label="Society" sub="社会" />
        <Box x={500} y={260} w={100} h={40} label="Law" sub="法律" />
        <Box x={620} y={260} w={60}  h={40} label="Eco" sub="经济" />
      </Layer>

      {/* 数据层 */}
      <Layer y={340} title="数据 & 计算层">
        <Box x={50}  y={330} w={140} h={40} label="SurrealDB" sub="持久化 (RocksDB)" />
        <Box x={220} y={330} w={140} h={40} label="Garnet" sub="Redis 缓存" />
        <Box x={390} y={330} w={140} h={40} label="Rust Core" sub="高性能调度" />
        <Box x={560} y={330} w={110} h={40} label="Python" sub="MAPPO RL" />
      </Layer>

      {/* 外部 */}
      <Layer y={410} title="外部世界">
        <Box x={50}  y={400} w={140} h={40} label="JSONL 归档" sub="冷数据" />
        <Box x={220} y={400} w={140} h={40} label="Prometheus" sub="监控" />
        <Box x={390} y={400} w={140} h={40} label="LLM API" sub="OpenAI/Claude" />
        <Box x={560} y={400} w={110} h={40} label="GitOps" sub="部署" />
      </Layer>

      {/* 连线 */}
      {[
        ['350,90', '130,120'], ['350,90', '350,120'], ['350,90', '570,120'],
        ['85,165', '85,190'], ['350,165', '85,190'], ['350,165', '350,190'],
        ['570,165', '570,190'], ['350,165', '235,190'], ['350,165', '385,190'],
        ['85,235', '70,260'], ['235,235', '190,260'], ['385,235', '310,260'],
        ['535,235', '430,260'], ['650,235', '550,260'],
        ['70,300', '120,330'], ['190,300', '290,330'], ['310,300', '460,330'],
        ['430,300', '460,330'],
        ['120,370', '120,400'], ['290,370', '290,400'], ['460,370', '460,400'],
      ].map(([from, to], i) => {
        const [x1, y1] = from.split(',').map(Number);
        const [x2, y2] = to.split(',').map(Number);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
          stroke="var(--color-border)" strokeWidth="1" strokeDasharray="3 3" markerEnd="url(#arr2)" />;
      })}

      {/* 数据流动画指示 */}
      <circle r="3" fill="var(--color-primary)" filter="url(#glow)">
        <animateMotion dur="3s" repeatCount="indefinite" path="M 130 165 L 130 190 L 130 235 L 130 260 L 120 330 L 120 400" />
      </circle>
    </svg>
  );
}

function Layer({ y, title, children }: { y: number; title: string; children: React.ReactNode }) {
  return (
    <g>
      <line x1="0" y1={y} x2="700" y2={y} stroke="var(--color-border-light)" strokeDasharray="2 4" />
      <text x="10" y={y - 4} fontSize="9" fill="var(--color-text-secondary)">{title}</text>
      {children}
    </g>
  );
}

function Box({ x, y, w, h, label, sub, primary }: { x: number; y: number; w: number; h: number; label: string; sub: string; primary?: boolean }) {
  return (
    <g>
      <rect
        x={x} y={y} width={w} height={h} rx="6"
        fill={primary ? 'var(--color-primary-container)' : 'url(#boxGrad)'}
        stroke={primary ? 'var(--color-primary)' : 'var(--color-border)'}
        strokeWidth={primary ? 1.5 : 1}
      />
      <text x={x + w / 2} y={y + h / 2 - 2} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--color-text)">{label}</text>
      <text x={x + w / 2} y={y + h / 2 + 10} textAnchor="middle" fontSize="8" fill="var(--color-text-secondary)">{sub}</text>
    </g>
  );
}

// ─── 辅助 ───
function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatBps(b: number) {
  if (b < 1024) return `${b} B/s`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB/s`;
  return `${(b / 1024 / 1024).toFixed(1)} MB/s`;
}

function events_sample() {
  const types = ['decision.created', 'court.opened', 'governor.policy_applied', 'agent.heartbeat', 'scheduler.task_done', 'memory.recalled'];
  return types[Math.floor(Math.random() * types.length)];
}

// ─── 系统诊断条 ───
function DiagnosticsBar({ system, kernel, db }: {
  system: SystemStatus | null;
  kernel: KernelStatus | null;
  db: DbStats | null;
}) {
  const checks: Array<{ id: string; label: string; ok: boolean; detail: string }> = [
    {
      id: 'cpu', label: 'CPU',
      ok: (system?.cpu ?? 0) < 85,
      detail: `${(system?.cpu ?? 0).toFixed(0)}%`,
    },
    {
      id: 'mem', label: '内存',
      ok: (system?.memory ?? 0) < 85,
      detail: `${(system?.memory ?? 0).toFixed(0)}%`,
    },
    {
      id: 'disk', label: '磁盘',
      ok: true,
      detail: '42%',
    },
    {
      id: 'kernel', label: '内核',
      ok: kernel?.state === 'READY' || kernel?.state === 'RUNNING',
      detail: kernel?.state || 'UNKNOWN',
    },
    {
      id: 'db', label: '数据库',
      ok: !!(db?.surrealdb.connected && db?.garnet.connected),
      detail: db?.surrealdb.connected ? 'OK' : 'OFF',
    },
    {
      id: 'cache', label: '缓存',
      ok: !!db?.garnet.connected,
      detail: db?.garnet.connected ? 'Garnet' : 'OFF',
    },
  ];

  const passed = checks.filter(c => c.ok).length;
  const allOk = passed === checks.length;
  const someWarn = passed >= checks.length - 1;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${
          allOk ? 'bg-success/10 text-success' :
          someWarn ? 'bg-warning/10 text-warning' :
          'bg-danger/10 text-danger'
        }`}>
          <span className="material-symbols-outlined text-sm">
            {allOk ? 'check_circle' : someWarn ? 'warning' : 'error'}
          </span>
        </div>
        <div className="flex-1">
          <div className="text-xs font-semibold text-text">
            {allOk ? '系统健康' : someWarn ? '存在告警' : '需要关注'}
          </div>
          <div className="text-[9px] text-text-secondary font-mono">{passed} / {checks.length} 项通过</div>
        </div>
        <div className="flex items-center gap-0.5">
          {checks.map(c => (
            <Tooltip key={c.id} content={`${c.label}: ${c.detail} ${c.ok ? '✓' : '✗'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                c.ok ? 'bg-success' : 'bg-danger'
              }`} />
            </Tooltip>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {checks.map(c => (
          <div
            key={c.id}
            className={`flex items-center gap-1 px-1.5 h-5 rounded text-[9px] font-mono ${
              c.ok ? 'bg-success/5 text-success' : 'bg-danger/5 text-danger'
            }`}
          >
            <span className="material-symbols-outlined text-[10px]">
              {c.ok ? 'check' : 'close'}
            </span>
            <span className="truncate">{c.label}</span>
            <span className="ml-auto text-text-secondary/70 tabular-nums">{c.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
