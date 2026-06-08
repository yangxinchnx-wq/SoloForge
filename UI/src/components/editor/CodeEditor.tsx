// ─────────────────────────────────────────────────────────────────
// 代码编辑器
// - 多 Tab (含 modified 状态)
// - 行号 + 语法高亮 (TS / RS / PY / SQL / JSON / MD / TOML)
// - 简易 minimap
// - 命令面板 (Ctrl+K)
// - 主题色匹配
// ─────────────────────────────────────────────────────────────────

import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import type { useResources } from '../../hooks/useResources';
import { PanelHeader, Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  resources: ReturnType<typeof useResources>;
}

const SAMPLE_LARGE_CONTENT = `// SoloForge 微内核 - 高度自治的多智能体治理系统
// ================================================================
// 此文件由代码生成器维护，禁止手动修改
// Generated: 2026-06-03 14:23:11 | Build: #4208-stable
// ================================================================

import { RuntimeKernel } from './kernel/runtime-kernel';
import { RoleEvolutionEngine } from './core/society/role-evolution';
import { CoalitionEngine } from './core/society/coalition';
import { SocialMemoryEngine } from './core/society/social-memory';
import { LawEngine } from './core/law/law-engine';
import { SocialReputationEngine } from './core/society/reputation';
import { InstitutionEngine } from './core/society/institution';
import { GovernancePolicyEngine } from './core/society/governance';
import { ConsensAgentCourtRoom } from './core/court/consensagent';
import { LlmEscalationRoom } from './core/court/llm_escalation';
import { DistributedProtocolBroker } from './kernel/orchestration/distributed-broker';
import { TelemetryMetricExporter } from './kernel/observability/telemetry-exporter';
import { ClusterRuntimeOrchestrator } from './kernel/orchestration/cluster-runtime-orchestrator';
import { RaftConsensusNode } from './kernel/consensus/raft-consensus-node';
import { SurrealPersistence } from './data/surreal_persistence';

/**
 * SoloForge 分布式 MARL 智能体治理 OS
 * 职责：执行冷启动容器注入，启动单调时钟触发器
 */
async function mainSystemIgnitionEngine(): Promise<void> {
  console.warn('SYSTEM_MAIN', '🏁 [Inception Mode] Bootstrapping hardened micro-kernel...');

  try {
    // Step 1: 实例化裸金属无状态微内核核心节点
    const kernel = new RuntimeKernel({
      mode: 'PRODUCTION',
      tickInterval: 50,
      maxConcurrentTasks: 256,
      enableAging: true,
    });

    // Pre-step: 初始化 Garnet 热数据层
    await garnetConnect();
    kernel.setGarnetClient(getClient());

    // Step 1.5: 初始化核心总线连接
    const commandBus = new CommandBus();
    const transactionManager = new TransactionManager();
    const projectionManager = new ProjectionManager();
    const snapshotManager = new SnapshotManager();
    const scheduler = new AgingPriorityScheduler();

    kernel.bootstrapCoreLinkages({
      commandBus,
      transactionManager,
      projectionManager,
      snapshotManager,
      scheduler,
    });

    // Step 2: 初始化非阻塞异步存储消费者
    initializeSocietyEvolutionConsumer(kernel);
    initializeSocialMemoryConsumer(kernel);
    initializeLawComplianceConsumer(kernel);
    initializeReputationAnalyticsConsumer(kernel);
    initializeCourtAdjudicationConsumer(kernel);
    initializeTelemetryAggregationConsumer(kernel);
    initializeConsensusAuditConsumer(kernel);

    // Step 3: 实例化所有 Phase 3, 4, 5 域卡子系统
    const roleEvolution = new RoleEvolutionEngine(kernel);
    const coalitionEngine = new CoalitionEngine(kernel);
    const socialMemory = new SocialMemoryEngine(kernel);
    const lawEngine = new LawEngine(kernel);
    const reputationEngine = new SocialReputationEngine(kernel);
    const institutionEngine = new InstitutionEngine(kernel);
    const governancePolicyEngine = new GovernancePolicyEngine(kernel);
    const primaryCourt = new ConsensAgentCourtRoom(kernel);
    const supremeCourt = new LlmEscalationRoom(kernel, surrealPersistence);

    const distributedBroker = new DistributedProtocolBroker(kernel);
    const telemetryExporter = new TelemetryMetricExporter(kernel);

    initializeTelemetryAggregationConsumer(kernel, telemetryExporter);
    initializeConsensusAuditConsumer(kernel);

    // Step 4: 同步线性冷启动激活
    await roleEvolution.boot();
    await coalitionEngine.boot();
    await socialMemory.boot();
    await lawEngine.boot();
    await reputationEngine.boot();
    await institutionEngine.boot();
    await governancePolicyEngine.bootGovernanceEngine();
    await primaryCourt.bootCourtRoom();
    await supremeCourt.initializeSupremeTribunal();

    await telemetryExporter.initializeExporterNode();

    // Step 5: 快速套接字网络传输通道
    await distributedBroker.connectMarlServiceGateway();
    (kernel as any).distributedBrokerProxy = distributedBroker;

    // Step 6: 实例化主时钟监督器
    const masterOrchestrator = new ClusterRuntimeOrchestrator(
      kernel,
      lawEngine,
      reputationEngine,
      sandboxEngine,
      telemetryExporter
    );

    process.on('SIGTERM', async () => {
      await masterOrchestrator.shutdownOrchestrationUniverse();
      await kernel.disconnectGarnet();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      await masterOrchestrator.shutdownOrchestrationUniverse();
      await kernel.disconnectGarnet();
      process.exit(0);
    });

    // 🪐 单调核心启动！
    await masterOrchestrator.igniteSystemOrchestrationUniverse();
  } catch (err) {
    console.error(\`CRITICAL_OS_PANIC: \${err.message}\`);
    process.exit(1);
  }
}

mainSystemIgnitionEngine();
`;

export function CodeEditor({ resources }: Props) {
  const [tabs, setTabs] = useState<string[]>(['/src/index.ts', '/src/api-server.ts']);
  const [modified, setModified] = useState<Record<string, boolean>>({ '/src/index.ts': true });
  const [showCommand, setShowCommand] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [showMinimap, setShowMinimap] = useState(true);
  const [wrapLines, setWrapLines] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);

  // 选中文件时自动加入 tabs
  useEffect(() => {
    if (resources.activeFile && !tabs.includes(resources.activeFile)) {
      setTabs([...tabs, resources.activeFile]);
    }
  }, [resources.activeFile]);

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommand(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowFind(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onScroll = useCallback(() => {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  }, []);

  const closeTab = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs(prev => {
      const next = prev.filter(t => t !== path);
      if (resources.activeFile === path) {
        if (next.length > 0) resources.setActiveFile(next[next.length - 1]);
        else resources.setActiveFile('');
      }
      return next;
    });
    setModified(m => { const c = { ...m }; delete c[path]; return c; });
  };

  const lang = useMemo(() => {
    const ext = resources.activeFile.split('.').pop() || '';
    return ext;
  }, [resources.activeFile]);

  // 行号 + 高亮
  const content = useMemo(() => {
    if (resources.activeFile === '/src/index.ts') {
      return SAMPLE_LARGE_CONTENT;
    }
    return resources.content || '// 暂无内容';
  }, [resources.activeFile, resources.content]);

  const lines = useMemo(() => content.split('\n'), [content]);
  const highlighted = useMemo(() => highlight(content, lang), [content, lang]);

  // 简易 minimap (右侧装饰)
  const minimapLines = useMemo(() => {
    const total = lines.length;
    const step = Math.max(1, Math.floor(total / 60));
    const result: number[] = [];
    for (let i = 0; i < total; i += step) {
      result.push(i);
    }
    return result;
  }, [lines]);

  // 文件统计
  const stats = useMemo(() => {
    let chars = content.length;
    let codeLines = lines.filter(l => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('#')).length;
    let commentLines = lines.filter(l => l.trim().startsWith('//') || l.trim().startsWith('#') || l.trim().startsWith('/*') || l.trim().startsWith('*')).length;
    return { chars, codeLines, commentLines, totalLines: lines.length };
  }, [content, lines]);

  return (
    <div className="flex flex-col h-full bg-bg-dim">
      {/* Tabs */}
      <div className="flex items-center bg-surface border-b border-border h-9 overflow-x-auto scrollbar-hide shrink-0">
        {tabs.map(t => {
          const active = t === resources.activeFile;
          const name = t.split('/').pop();
          return (
            <div
              key={t}
              onClick={() => resources.setActiveFile(t)}
              className={`group flex items-center gap-1.5 px-3 h-9 cursor-pointer border-r border-border-light text-[11px] shrink-0 transition-colors ${
                active
                  ? 'bg-bg-dim text-text border-b-2 border-b-primary -mb-px'
                  : 'text-text-secondary hover:text-text hover:bg-surface-high'
              }`}
            >
              <span className="material-symbols-outlined text-xs">{iconForFile(name || '')}</span>
              <span className="font-mono">{name}</span>
              {modified[t] && <span className="w-1.5 h-1.5 rounded-full bg-warning" title="未保存" />}
              <button
                onClick={(e) => closeTab(t, e)}
                className="material-symbols-outlined text-xs text-text-secondary hover:text-text ml-1"
              >close</button>
            </div>
          );
        })}
        <div className="flex-1" />
        <div className="flex items-center gap-0.5 px-2">
          <Tooltip content="命令面板 (Ctrl+K)">
            <IconButton icon="terminal" size="xs" onClick={() => setShowCommand(true)} />
          </Tooltip>
          <Tooltip content="查找 (Ctrl+F)">
            <IconButton icon="search" size="xs" onClick={() => setShowFind(true)} />
          </Tooltip>
          <Tooltip content="自动换行">
            <IconButton icon="wrap_text" size="xs" active={wrapLines} onClick={() => setWrapLines(w => !w)} />
          </Tooltip>
          <Tooltip content="迷你地图">
            <IconButton icon="map" size="xs" active={showMinimap} onClick={() => setShowMinimap(m => !m)} />
          </Tooltip>
          <Tooltip content="拆分编辑器">
            <IconButton icon="splitscreen" size="xs" />
          </Tooltip>
        </div>
      </div>

      {/* 编辑器主体 */}
      <div className="flex-1 flex overflow-hidden bg-bg-dim relative">
        {/* 行号 */}
        <div className="select-none text-right py-2 px-2 text-text-secondary/60 text-[11px] font-mono leading-[1.6] border-r border-border-light bg-bg-dim min-w-[48px]">
          {lines.map((_, n) => (
            <div key={n} className={`hover:text-text ${n % 10 === 0 ? 'text-text-secondary' : ''}`}>
              {n + 1}
            </div>
          ))}
        </div>

        {/* 代码区 */}
        <div className="flex-1 relative overflow-hidden">
          <pre
            ref={preRef}
            aria-hidden
            className={`absolute inset-0 m-0 p-2 text-[12px] font-mono leading-[1.6] text-text ${wrapLines ? 'whitespace-pre-wrap' : 'whitespace-pre'} overflow-auto scrollbar-thin pointer-events-none`}
          >
            <code dangerouslySetInnerHTML={{ __html: highlighted }} />
          </pre>
          <textarea
            ref={taRef}
            value={content}
            readOnly
            onScroll={onScroll}
            spellCheck={false}
            className={`absolute inset-0 m-0 p-2 text-[12px] font-mono leading-[1.6] bg-transparent text-transparent caret-primary ${wrapLines ? 'whitespace-pre-wrap' : 'whitespace-pre'} overflow-auto scrollbar-thin focus:outline-none resize-none w-full`}
          />

          {/* Find 浮层 */}
          {showFind && (
            <div className="absolute top-2 right-2 w-72 bg-surface border border-border rounded-md shadow-xl p-2 animate-slide-in-up z-10">
              <div className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm text-text-secondary">search</span>
                <input
                  autoFocus
                  value={findQuery}
                  onChange={e => setFindQuery(e.target.value)}
                  placeholder="在文件中查找..."
                  className="flex-1 bg-transparent text-xs text-text focus:outline-none placeholder-text-secondary"
                />
                <span className="text-[10px] text-text-secondary font-mono">0/0</span>
                <button onClick={() => setShowFind(false)} className="material-symbols-outlined text-sm text-text-secondary hover:text-text">close</button>
              </div>
              <div className="flex items-center gap-1 mt-1.5 pt-1.5 border-t border-border-light text-[10px] text-text-secondary">
                <span className="material-symbols-outlined text-xs">keyboard</span>
                <span>大小写敏感</span>
                <span>· 整词</span>
                <span>· 正则</span>
              </div>
            </div>
          )}
        </div>

        {/* Minimap */}
        {showMinimap && (
          <div
            ref={minimapRef}
            className="w-24 border-l border-border-light bg-surface-low overflow-hidden p-1 shrink-0"
            title="迷你地图"
          >
            <div className="space-y-px text-[3px] font-mono leading-[3px] text-text-secondary/40 select-none whitespace-pre">
              {minimapLines.map(i => (
                <div key={i} className="truncate">{highlight(lines[i] || '', lang).replace(/<[^>]+>/g, '').slice(0, 60)}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部状态栏 */}
      <div className="flex items-center justify-between px-2 h-6 bg-surface border-t border-border text-[10px] text-text-secondary font-mono shrink-0">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-success">
            <span className="material-symbols-outlined text-xs">sync</span>
            main
          </span>
          <span>UTF-8</span>
          <span>LF</span>
          <span>空格: 2</span>
        </div>
        <div className="flex items-center gap-3">
          <span>行 {stats.totalLines} · {stats.codeLines} 代码 · {stats.commentLines} 注释</span>
          <span>{stats.chars} 字符</span>
          <span>Ln 1, Col 1</span>
          <Badge variant="info">{lang.toUpperCase()}</Badge>
        </div>
      </div>

      {/* 命令面板 */}
      {showCommand && (
        <CommandPalette
          onClose={() => setShowCommand(false)}
          onSelect={(p) => { resources.setActiveFile(p); setShowCommand(false); }}
        />
      )}
    </div>
  );
}

function iconForFile(name: string) {
  const ext = name.split('.').pop() || '';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs'].includes(ext)) return 'code';
  if (['json', 'toml', 'yaml', 'yml'].includes(ext)) return 'data_object';
  if (['md', 'txt'].includes(ext)) return 'description';
  if (['sql', 'surql'].includes(ext)) return 'storage';
  return 'description';
}

// ─── 简易语法高亮 ───
function highlight(src: string, lang: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = esc(src);

  if (['ts', 'tsx', 'js', 'jsx'].includes(lang)) {
    out = out.replace(/(\/\/[^\n]*)/g, '<span class="text-text-secondary italic">$1</span>');
    out = out.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="text-text-secondary italic">$1</span>');
    out = out.replace(/(['"`])((?:\\\1|(?!\1).)*?)\1/g, '<span class="text-success">$1$2$1</span>');
    out = out.replace(/\b(import|export|from|const|let|var|function|return|if|else|for|while|class|extends|new|await|async|of|in|interface|type|enum|public|private|protected|static|void|null|undefined|true|false|try|catch|finally|throw|switch|case|break|continue|default|this|super)\b/g, '<span class="text-accent">$1</span>');
    out = out.replace(/\b(\d+)\b/g, '<span class="text-warning">$1</span>');
    out = out.replace(/(@\w+)/g, '<span class="text-primary">$1</span>');
  } else if (lang === 'rs') {
    out = out.replace(/(\/\/[^\n]*)/g, '<span class="text-text-secondary italic">$1</span>');
    out = out.replace(/(['"`])((?:\\\1|(?!\1).)*?)\1/g, '<span class="text-success">$1$2$1</span>');
    out = out.replace(/\b(fn|let|mut|pub|use|mod|struct|enum|impl|trait|self|Self|return|if|else|for|while|match|in|as|where|ref|unsafe|extern|crate)\b/g, '<span class="text-accent">$1</span>');
  } else if (lang === 'py') {
    out = out.replace(/(#[^\n]*)/g, '<span class="text-text-secondary italic">$1</span>');
    out = out.replace(/(['"`])((?:\\\1|(?!\1).)*?)\1/g, '<span class="text-success">$1$2$1</span>');
    out = out.replace(/\b(def|class|import|from|return|if|elif|else|for|while|in|not|and|or|None|True|False|self|async|await|with|as|pass|yield|lambda|global|nonlocal|try|except|finally|raise)\b/g, '<span class="text-accent">$1</span>');
  } else if (['sql', 'surql'].includes(lang)) {
    out = out.replace(/(--[^\n]*)/g, '<span class="text-text-secondary italic">$1</span>');
    out = out.replace(/(['"`])((?:\\\1|(?!\1).)*?)\1/g, '<span class="text-success">$1$2$1</span>');
    out = out.replace(/\b(DEFINE|TABLE|SCHEMAFULL|SCHEMALESS|FROM|WHERE|SELECT|INSERT|UPDATE|DELETE|CREATE|INDEX|VALUE|VALUES|JOIN|ON|AND|OR|NOT|NULL|TRUE|FALSE|LET|SET|FOR|LIMIT|ORDER|BY|GROUP|COUNT|TYPE|FIELD|ASSERT|PERMISSIONS)\b/g, '<span class="text-accent">$1</span>');
  } else if (lang === 'json') {
    out = out.replace(/("(\\.|[^"\\])*")(\s*:)/g, '<span class="text-accent">$1</span>$3');
    out = out.replace(/:\s*("(\\.|[^"\\])*")/g, ': <span class="text-success">$1</span>');
    out = out.replace(/\b(true|false|null)\b/g, '<span class="text-warning">$1</span>');
  } else if (lang === 'md') {
    out = out.replace(/^(#{1,6})\s+(.+)$/gm, '<span class="text-primary font-bold">$1 $2</span>');
    out = out.replace(/`([^`]+)`/g, '<span class="text-success">`$1`</span>');
  }

  return out;
}

// ─── 命令面板 ───
function CommandPalette({ onClose, onSelect }: { onClose: () => void; onSelect: (p: string) => void }) {
  const [query, setQuery] = useState('');
  const FILES = [
    '/src/index.ts', '/src/api-server.ts', '/src/kernel/runtime-kernel.ts',
    '/src/core/court/consensagent.ts', '/src/data/repositories/surreal-repositories.ts',
    '/rust_core/src/main.rs', '/rust_core/src/scheduler.rs',
    '/python/mappo_server.py', '/python/env.py',
    '/migrations/v1_base.surql', '/migrations/v2_decision.surql',
    '/migrations/v3_court.surql', '/migrations/v4_governor.surql', '/migrations/v5_events.surql',
    '/package.json', '/README.md',
  ];
  const COMMANDS = [
    { id: 'save', label: '保存文件', icon: 'save', shortcut: 'Ctrl+S' },
    { id: 'find', label: '查找', icon: 'search', shortcut: 'Ctrl+F' },
    { id: 'terminal', label: '打开终端', icon: 'terminal', shortcut: 'Ctrl+`' },
    { id: 'settings', label: '打开设置', icon: 'settings' },
    { id: 'theme', label: '切换主题', icon: 'palette' },
  ];

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    const cmds = COMMANDS.filter(c => c.label.toLowerCase().includes(q));
    const files = FILES.filter(f => f.toLowerCase().includes(q)).map(f => ({ id: f, label: f, icon: 'description', isFile: true }));
    return [...cmds, ...files];
  }, [query]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="w-[520px] max-w-[92vw] bg-surface border border-border rounded-xl shadow-2xl overflow-hidden animate-slide-in-up" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 h-11 border-b border-border">
          <span className="material-symbols-outlined text-text-secondary">search</span>
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="输入命令或搜索文件..."
            className="flex-1 bg-transparent text-sm text-text focus:outline-none placeholder-text-secondary"
          />
          <span className="text-[10px] text-text-secondary font-mono">ESC</span>
        </div>
        <div className="max-h-[400px] overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-text-secondary">
              <span className="material-symbols-outlined text-3xl block mb-1 opacity-40">search_off</span>
              无匹配结果
            </div>
          ) : (
            filtered.map((item, i) => (
              <button
                key={i}
                onClick={() => (item as any).isFile ? onSelect(item.id) : alert(`执行: ${item.label}`)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs rounded hover:bg-surface-high transition-colors group"
              >
                <span className="material-symbols-outlined text-text-secondary text-sm">{(item as any).icon || 'description'}</span>
                <span className="flex-1 text-text">{item.label}</span>
                {(item as any).shortcut && (
                  <span className="text-[10px] text-text-secondary font-mono opacity-0 group-hover:opacity-100">
                    {(item as any).shortcut}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
