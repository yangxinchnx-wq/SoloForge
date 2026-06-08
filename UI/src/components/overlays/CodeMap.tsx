// ─────────────────────────────────────────────────────────────────
// 代码地图 (Code Map)
// - 全项目缩略图:文件按行数比例方块,颜色按语言
// - 函数依赖图:节点 = 函数,边 = 调用/import
// - 依赖热力图:文件耦合度,可点击跳转
// - 模拟"代码考古"指标:churn/复杂度/最近修改
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';

// ── 类型 ──
interface CodeFile {
  path: string;
  language: string;
  lines: number;
  bytes: number;
  complexity: number;
  churn: number;            // 修改次数
  lastModified: number;     // ts
  author: string;
  imports: string[];        // 引用的其他文件
  functions: CodeFunction[];
}

interface CodeFunction {
  name: string;
  startLine: number;
  endLine: number;
  signature: string;
  callsTo: string[];       // 调用的其他函数 (name@file 格式)
  cyclomatic: number;       // 圈复杂度
}

interface CodeStats {
  totalFiles: number;
  totalLines: number;
  totalBytes: number;
  byLanguage: Record<string, { files: number; lines: number }>;
  avgComplexity: number;
  totalChurn: number;
}

// ── 模拟数据 ──
const LANGUAGES = [
  { value: 'typescript', color: '#3178c6', label: 'TypeScript' },
  { value: 'javascript', color: '#f7df1e', label: 'JavaScript' },
  { value: 'python',     color: '#3776ab', label: 'Python' },
  { value: 'rust',       color: '#dea584', label: 'Rust' },
  { value: 'css',        color: '#1572b6', label: 'CSS' },
  { value: 'html',       color: '#e34f26', label: 'HTML' },
  { value: 'json',       color: '#a0a0a0', label: 'JSON' },
  { value: 'md',         color: '#6b7280', label: 'Markdown' },
  { value: 'sql',        color: '#ff9800', label: 'SQL' },
];

const AUTHORS = ['Alice林', 'Bob陈', 'Carol王', 'David李', 'Eve周'];

const SAMPLE_FUNCTIONS = [
  'render', 'update', 'fetch', 'parse', 'validate', 'mount', 'unmount',
  'subscribe', 'unsubscribe', 'connect', 'disconnect', 'send', 'receive',
  'compute', 'transform', 'filter', 'sort', 'merge', 'split', 'tokenize',
];

function generateFiles(): CodeFile[] {
  const dirs = ['src/', 'src/components/', 'src/hooks/', 'src/api/', 'src/data/', 'src/themes/', 'src/components/overlays/', 'src/components/panels/', 'rust_core/src/', 'migrations/', 'docs/'];
  const basenames = [
    'index.ts', 'App.tsx', 'useChat.ts', 'useBackend.ts', 'useKeybindingStore.ts',
    'CodeReview.tsx', 'TaskScheduler.tsx', 'CollabCursors.tsx', 'BreakpointDebugger.tsx',
    'PluginRegistry.tsx', 'SnippetsManager.tsx', 'SurrealExplorer.tsx', 'GitTimeMachine.tsx',
    'WorkflowPipeline.tsx', 'MermaidEditor.tsx', 'ThemeGenerator.tsx', 'ThemeGenerator.ts',
    'scheduler.rs', 'train.py', 'predict.py', 'utils.py',
    'v1_base.surql', 'v2_decision.surql', 'v3_court.surql', 'v4_governor.surql', 'v5_events.surql',
    'README.md', 'ARCHITECTURE.md', 'package.json', 'tsconfig.json', 'Cargo.toml',
    'style.css', 'index.html',
  ];
  const files: CodeFile[] = [];
  basenames.forEach((bn, i) => {
    const dir = dirs[i % dirs.length];
    const lang = bn.endsWith('.ts') || bn.endsWith('.tsx') ? 'typescript' :
                 bn.endsWith('.js') || bn.endsWith('.jsx') ? 'javascript' :
                 bn.endsWith('.py') ? 'python' :
                 bn.endsWith('.rs') ? 'rust' :
                 bn.endsWith('.css') ? 'css' :
                 bn.endsWith('.html') ? 'html' :
                 bn.endsWith('.json') ? 'json' :
                 bn.endsWith('.md') ? 'md' :
                 bn.endsWith('.surql') || bn.endsWith('.sql') ? 'sql' : 'json';
    const lines = Math.floor(20 + Math.random() * 800);
    const complexity = Math.floor(1 + Math.random() * 30);
    const churn = Math.floor(1 + Math.random() * 30);
    const fnCount = Math.floor(2 + Math.random() * 12);
    const functions: CodeFunction[] = Array.from({ length: fnCount }, (_, k) => ({
      name: SAMPLE_FUNCTIONS[k % SAMPLE_FUNCTIONS.length] + (k > SAMPLE_FUNCTIONS.length ? Math.floor(k / SAMPLE_FUNCTIONS.length) : ''),
      startLine: Math.floor(1 + (lines / fnCount) * k),
      endLine: Math.floor(1 + (lines / fnCount) * (k + 1)),
      signature: 'function(' + Array.from({ length: Math.floor(Math.random() * 3) }, (_, j) => 'arg' + j).join(', ') + '): ' + (Math.random() < 0.5 ? 'void' : 'Promise<any>'),
      callsTo: [],
      cyclomatic: 1 + Math.floor(Math.random() * 8),
    }));
    files.push({
      path: dir + bn,
      language: lang,
      lines,
      bytes: lines * (30 + Math.floor(Math.random() * 40)),
      complexity,
      churn,
      lastModified: Date.now() - Math.floor(Math.random() * 30 * 86400_000),
      author: AUTHORS[Math.floor(Math.random() * AUTHORS.length)],
      imports: files.slice(-Math.min(5, files.length)).filter(f => f.path !== dir + bn).map(f => f.path),
      functions,
    });
  });
  // 互相调用
  files.forEach(f => {
    f.functions.forEach(fn => {
      const otherFiles = files.filter(x => x.path !== f.path).slice(0, 3);
      otherFiles.forEach(of => {
        if (of.functions[0]) fn.callsTo.push(of.functions[0].name + '@' + of.path);
      });
    });
  });
  return files;
}

// ─── 主组件 ───
interface Props {
  open: boolean;
  onClose: () => void;
  onJumpToFile?: (path: string) => void;
}

export function CodeMap({ open, onClose, onJumpToFile }: Props) {
  const [files] = useState<CodeFile[]>(generateFiles);
  const [view, setView] = useState<'grid' | 'dependency' | 'hotspot' | 'function'>('grid');
  const [metric, setMetric] = useState<'lines' | 'complexity' | 'churn' | 'lastModified'>('lines');
  const [langFilter, setLangFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [hoveredFile, setHoveredFile] = useState<string | null>(null);

  const stats: CodeStats = useMemo(() => {
    const byLanguage: Record<string, { files: number; lines: number }> = {};
    let totalLines = 0, totalBytes = 0, totalChurn = 0;
    files.forEach(f => {
      totalLines += f.lines;
      totalBytes += f.bytes;
      totalChurn += f.churn;
      if (!byLanguage[f.language]) byLanguage[f.language] = { files: 0, lines: 0 };
      byLanguage[f.language].files++;
      byLanguage[f.language].lines += f.lines;
    });
    return {
      totalFiles: files.length,
      totalLines,
      totalBytes,
      byLanguage,
      avgComplexity: files.reduce((a, f) => a + f.complexity, 0) / files.length,
      totalChurn,
    };
  }, [files]);

  const filtered = useMemo(() => {
    return files.filter(f => {
      if (langFilter !== 'all' && f.language !== langFilter) return false;
      if (search && !f.path.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [files, langFilter, search]);

  const selected = selectedFile ? files.find(f => f.path === selectedFile) : null;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[min(98vw,1280px)] h-[min(94vh,860px)] bg-bg-elevated border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">map</span>
            <h2 className="text-base font-semibold">代码地图</h2>
            <span className="text-xs text-text-secondary ml-2">
              {stats.totalFiles} 文件 · {stats.totalLines.toLocaleString()} 行 · {Math.round(stats.totalBytes / 1024)}KB
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {([
              { id: 'grid',       label: '缩略图',   icon: 'grid_view' },
              { id: 'dependency', label: '依赖图',   icon: 'account_tree' },
              { id: 'hotspot',    label: '热力图',   icon: 'whatshot' },
              { id: 'function',   label: '函数',     icon: 'function' },
            ] as const).map(t => (
              <button
                key={t.id}
                onClick={() => setView(t.id)}
                className={'px-2.5 py-1 text-xs rounded border flex items-center gap-1 ' +
                  (view === t.id ? 'border-primary text-primary bg-primary/10' : 'border-border hover:bg-bg-dim')}
              >
                <span className="material-symbols-outlined text-sm">{t.icon}</span>
                {t.label}
              </button>
            ))}
            <button onClick={onClose} className="px-2 py-1 rounded hover:bg-bg-dim text-text-secondary ml-1">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* 左: 筛选 */}
          <div className="w-56 border-r border-border flex flex-col shrink-0">
            <div className="px-3 py-2 border-b border-border text-xs text-text-secondary uppercase">语言</div>
            <div className="px-2 py-1 space-y-0.5 border-b border-border">
              <button
                onClick={() => setLangFilter('all')}
                className={'w-full px-2 py-1 text-xs rounded text-left flex items-center gap-1.5 ' +
                  (langFilter === 'all' ? 'bg-primary/15 text-primary' : 'hover:bg-bg-dim')}
              >
                <span className="material-symbols-outlined text-sm">dehaze</span>
                全部 ({stats.totalFiles})
              </button>
              {LANGUAGES.map(l => {
                const s = stats.byLanguage[l.value];
                if (!s) return null;
                return (
                  <button
                    key={l.value}
                    onClick={() => setLangFilter(l.value)}
                    className={'w-full px-2 py-1 text-xs rounded text-left flex items-center gap-1.5 ' +
                      (langFilter === l.value ? 'bg-primary/15 text-primary' : 'hover:bg-bg-dim')}
                  >
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: l.color }} />
                    <span className="truncate">{l.label}</span>
                    <span className="ml-auto text-text-secondary">{s.files}</span>
                  </button>
                );
              })}
            </div>

            <div className="px-3 py-2 border-b border-t border-border text-xs text-text-secondary uppercase">度量</div>
            <div className="px-2 py-1 space-y-0.5">
              {([
                { id: 'lines', label: '行数', icon: 'format_list_numbered' },
                { id: 'complexity', label: '复杂度', icon: 'psychology' },
                { id: 'churn', label: '修改次数', icon: 'history' },
                { id: 'lastModified', label: '最近修改', icon: 'schedule' },
              ] as const).map(m => (
                <button
                  key={m.id}
                  onClick={() => setMetric(m.id)}
                  className={'w-full px-2 py-1 text-xs rounded text-left flex items-center gap-1.5 ' +
                    (metric === m.id ? 'bg-primary/15 text-primary' : 'hover:bg-bg-dim')}
                >
                  <span className="material-symbols-outlined text-sm">{m.icon}</span>
                  {m.label}
                </button>
              ))}
            </div>

            <div className="px-3 py-2 border-b border-t border-border text-xs text-text-secondary uppercase">搜索</div>
            <div className="p-2">
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="文件路径..."
                className="w-full px-2 py-1 rounded border border-border bg-bg text-xs"
              />
            </div>

            <div className="flex-1" />
            <div className="p-3 border-t border-border text-[10px] text-text-secondary space-y-0.5">
              <div>平均复杂度 <span className="text-text font-mono">{stats.avgComplexity.toFixed(1)}</span></div>
              <div>总修改次数 <span className="text-text font-mono">{stats.totalChurn}</span></div>
              <div>代码体积 <span className="text-text font-mono">{(stats.totalBytes / 1024).toFixed(1)}KB</span></div>
            </div>
          </div>

          {/* 中: 主视图 */}
          <div className="flex-1 overflow-auto p-4">
            {view === 'grid' && (
              <GridView
                files={filtered}
                metric={metric}
                onSelect={setSelectedFile}
                selected={selectedFile}
                hovered={hoveredFile}
                setHovered={setHoveredFile}
              />
            )}
            {view === 'dependency' && <DependencyView files={filtered} onSelect={setSelectedFile} />}
            {view === 'hotspot' && <HotspotView files={filtered} onSelect={setSelectedFile} />}
            {view === 'function' && <FunctionView files={filtered} onSelect={setSelectedFile} />}
          </div>

          {/* 右: 详情 */}
          {selected && (
            <div className="w-80 border-l border-border flex flex-col shrink-0">
              <div className="px-3 py-2 border-b border-border flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-sm">description</span>
                <h3 className="text-sm font-mono font-semibold truncate flex-1">{selected.path.split('/').pop()}</h3>
                <button onClick={() => onJumpToFile?.(selected.path)} className="text-xs text-text-secondary hover:text-primary">跳转</button>
              </div>
              <div className="flex-1 overflow-auto p-3 text-xs space-y-2">
                <div className="text-text-secondary truncate">{selected.path}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="px-2 py-1.5 rounded bg-bg-dim">
                    <div className="text-text-secondary text-[10px]">语言</div>
                    <div className="text-text">{LANGUAGES.find(l => l.value === selected.language)?.label}</div>
                  </div>
                  <div className="px-2 py-1.5 rounded bg-bg-dim">
                    <div className="text-text-secondary text-[10px]">行数</div>
                    <div className="text-text font-mono">{selected.lines}</div>
                  </div>
                  <div className="px-2 py-1.5 rounded bg-bg-dim">
                    <div className="text-text-secondary text-[10px]">复杂度</div>
                    <div className="text-text font-mono">{selected.complexity}</div>
                  </div>
                  <div className="px-2 py-1.5 rounded bg-bg-dim">
                    <div className="text-text-secondary text-[10px]">修改</div>
                    <div className="text-text font-mono">×{selected.churn}</div>
                  </div>
                  <div className="col-span-2 px-2 py-1.5 rounded bg-bg-dim">
                    <div className="text-text-secondary text-[10px]">最近作者</div>
                    <div className="text-text">{selected.author}</div>
                  </div>
                </div>

                <div>
                  <div className="text-text-secondary mb-1">函数 ({selected.functions.length})</div>
                  <div className="space-y-1">
                    {selected.functions.map(fn => (
                      <div key={fn.name} className="px-2 py-1.5 rounded bg-bg-dim text-[11px]">
                        <div className="font-mono text-text">fn {fn.name}</div>
                        <div className="text-text-secondary text-[10px]">L{fn.startLine}-{fn.endLine} · 圈复杂 {fn.cyclomatic}</div>
                        <div className="text-text-secondary text-[10px] font-mono truncate">{fn.signature}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {selected.imports.length > 0 && (
                  <div>
                    <div className="text-text-secondary mb-1">引用 ({selected.imports.length})</div>
                    <div className="space-y-0.5">
                      {selected.imports.slice(0, 8).map(imp => (
                        <div key={imp} className="px-2 py-1 rounded hover:bg-bg-dim text-[10px] font-mono truncate text-text-secondary">
                          → {imp}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 视图 1: 缩略图 ──
function GridView({ files, metric, onSelect, selected, hovered, setHovered }: any) {
  const maxValue = useMemo(() => {
    if (metric === 'lines') return Math.max(...files.map((f: CodeFile) => f.lines));
    if (metric === 'complexity') return Math.max(...files.map((f: CodeFile) => f.complexity));
    if (metric === 'churn') return Math.max(...files.map((f: CodeFile) => f.churn));
    if (metric === 'lastModified') return Date.now();
    return 1;
  }, [files, metric]);

  return (
    <div>
      <div className="text-xs text-text-secondary mb-2">每个方块 = 一个文件 · 面积 = {metric === 'lines' ? '行数' : metric === 'complexity' ? '复杂度' : metric === 'churn' ? '修改次数' : '最近修改'} · 颜色 = 语言</div>
      <div className="flex flex-wrap gap-1 content-start">
        {files.map((f: CodeFile) => {
          const lang = LANGUAGES.find(l => l.value === f.language);
          const v = metric === 'lines' ? f.lines : metric === 'complexity' ? f.complexity : metric === 'churn' ? f.churn : Date.now() - f.lastModified;
          const ratio = v / maxValue;
          const size = 30 + ratio * 80;
          const isSelected = selected === f.path;
          const isHovered = hovered === f.path;
          return (
            <div
              key={f.path}
              onClick={() => onSelect(f.path)}
              onMouseEnter={() => setHovered(f.path)}
              onMouseLeave={() => setHovered(null)}
              className={'rounded transition-all cursor-pointer ' +
                (isSelected ? 'ring-2 ring-primary' : isHovered ? 'ring-1 ring-primary/50' : '')}
              style={{
                width: size,
                height: size,
                backgroundColor: lang?.color + (isSelected || isHovered ? 'cc' : '88'),
                borderLeft: `4px solid ${lang?.color}`,
              }}
              title={f.path + ' · ' + v}
            />
          );
        })}
      </div>
      {hovered && (
        <div className="mt-3 px-3 py-2 rounded bg-bg-dim text-xs font-mono">
          <span className="text-text">{hovered}</span>
          {(() => {
            const f = files.find((x: CodeFile) => x.path === hovered);
            if (!f) return null;
            return <span className="text-text-secondary"> · {f.lines}行 · 复杂{f.complexity} · ×{f.churn}</span>;
          })()}
        </div>
      )}
    </div>
  );
}

// ── 视图 2: 依赖图 ──
function DependencyView({ files, onSelect }: any) {
  const maxNodes = 30;
  const sub = files.slice(0, maxNodes);
  const positions = useMemo(() => {
    const pos: Record<string, { x: number; y: number }> = {};
    sub.forEach((f: CodeFile, i: number) => {
      const angle = (i / sub.length) * Math.PI * 2;
      const radius = 200 + (i % 3) * 50;
      pos[f.path] = {
        x: 400 + Math.cos(angle) * radius,
        y: 300 + Math.sin(angle) * radius,
      };
    });
    return pos;
  }, [sub]);

  return (
    <div className="relative h-full">
      <div className="absolute top-2 left-2 text-xs text-text-secondary z-10">文件依赖关系 · {sub.length} 节点 · 边 = import 关系</div>
      <svg width="100%" height="700" viewBox="0 0 800 600" className="border border-border rounded bg-bg-dim/30">
        <defs>
          <marker id="dep-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
          </marker>
        </defs>
        {/* 边 */}
        {sub.map((f: CodeFile) =>
          f.imports.filter((imp: string) => positions[imp]).map((imp: string, i: number) => {
            const from = positions[f.path], to = positions[imp];
            return (
              <line
                key={i}
                x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                stroke="#64748b" strokeWidth="0.5" opacity="0.4" markerEnd="url(#dep-arrow)"
              />
            );
          })
        )}
        {/* 节点 */}
        {sub.map((f: CodeFile) => {
          const p = positions[f.path];
          const lang = LANGUAGES.find(l => l.value === f.language);
          return (
            <g key={f.path} onClick={() => onSelect(f.path)} className="cursor-pointer">
              <circle cx={p.x} cy={p.y} r={Math.max(8, Math.min(20, f.lines / 40))} fill={lang?.color || '#6b7280'} stroke="#1e293b" strokeWidth="1.5" opacity="0.85" />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="9" fill="#fff" pointerEvents="none">{f.path.split('/').pop()?.slice(0, 6)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── 视图 3: 热力图 ──
function HotspotView({ files, onSelect }: any) {
  // 颜色: churn × complexity
  return (
    <div>
      <div className="text-xs text-text-secondary mb-2">热点: churn (横) × complexity (纵) · 大小 = 行数 · 颜色 = 风险</div>
      <div className="border border-border rounded bg-bg-dim/30 p-4 relative h-[500px]">
        {files.map((f: CodeFile) => {
          const maxChurn = Math.max(...files.map((x: CodeFile) => x.churn));
          const maxComplexity = Math.max(...files.map((x: CodeFile) => x.complexity));
          const x = 40 + (f.churn / maxChurn) * 600;
          const y = 30 + (1 - f.complexity / maxComplexity) * 400;
          const size = 6 + (f.lines / 100) * 8;
          const risk = (f.churn * f.complexity) / (maxChurn * maxComplexity);
          const color = risk > 0.7 ? '#ef4444' : risk > 0.4 ? '#f59e0b' : risk > 0.2 ? '#10b981' : '#3b82f6';
          return (
            <button
              key={f.path}
              onClick={() => onSelect(f.path)}
              className="absolute hover:scale-110 transition-transform group"
              style={{ left: x - size / 2, top: y - size / 2, width: size, height: size }}
              title={f.path}
            >
              <div className="rounded-full w-full h-full" style={{ backgroundColor: color, opacity: 0.7 }} />
              <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 hidden group-hover:block px-2 py-1 rounded bg-bg-elevated border border-border text-xs whitespace-nowrap z-10">
                <div className="font-mono">{f.path}</div>
                <div className="text-text-secondary text-[10px]">churn {f.churn} · 复杂 {f.complexity}</div>
              </div>
            </button>
          );
        })}
        {/* 轴 */}
        <div className="absolute left-2 top-2 text-[10px] text-text-secondary">复杂 ↑</div>
        <div className="absolute right-2 bottom-2 text-[10px] text-text-secondary">修改 →</div>
        {/* 象限说明 */}
        <div className="absolute right-2 top-2 text-[10px] text-text-secondary space-y-0.5">
          <div><span className="inline-block w-2 h-2 rounded-full bg-danger mr-1" />危险 (右上)</div>
          <div><span className="inline-block w-2 h-2 rounded-full bg-warning mr-1" />需关注</div>
          <div><span className="inline-block w-2 h-2 rounded-full bg-success mr-1" />稳定</div>
          <div><span className="inline-block w-2 h-2 rounded-full bg-primary mr-1" />低风险</div>
        </div>
      </div>
    </div>
  );
}

// ── 视图 4: 函数视图 ──
function FunctionView({ files, onSelect }: any) {
  const allFns = useMemo(() => {
    return files.flatMap((f: CodeFile) => f.functions.map(fn => ({ ...fn, file: f.path, language: f.language })));
  }, [files]);
  const maxCyc = Math.max(...allFns.map((f: any) => f.cyclomatic));
  return (
    <div>
      <div className="text-xs text-text-secondary mb-2">{allFns.length} 个函数 · 宽度 = 行跨度 · 颜色 = 圈复杂度</div>
      <div className="space-y-1">
        {allFns.sort((a: any, b: any) => b.cyclomatic - a.cyclomatic).slice(0, 80).map((fn: any) => {
          const widthPct = Math.min(100, (fn.endLine - fn.startLine) / 2);
          const color = fn.cyclomatic > 10 ? '#ef4444' : fn.cyclomatic > 5 ? '#f59e0b' : '#10b981';
          return (
            <button
              key={fn.name + '@' + fn.file + fn.startLine}
              onClick={() => onSelect(fn.file)}
              className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-dim text-left text-xs"
            >
              <div className="font-mono text-text w-32 truncate">{fn.name}</div>
              <div className="text-text-secondary text-[10px] w-32 truncate">{fn.file.split('/').pop()}</div>
              <div className="flex-1 h-3 rounded bg-bg-dim overflow-hidden">
                <div className="h-full" style={{ width: widthPct + '%', backgroundColor: color, opacity: 0.7 }} />
              </div>
              <div className="font-mono text-[10px] w-12 text-right" style={{ color }}>C{fn.cyclomatic}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
