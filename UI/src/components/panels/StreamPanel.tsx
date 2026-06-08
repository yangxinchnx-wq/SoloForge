// ─────────────────────────────────────────────────────────────────
// 流送区：思考 / 工具调用 / 系统消息 / 实时生成
// - 自动滚动
// - 过滤
// - 类型统计
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useMemo } from 'react';
import type { StreamChunk } from '../../types';
import { PanelHeader, IconButton, Tooltip, Button, Badge } from '../ui/Button';
import { ErrorDetailModal } from '../overlays/ErrorDetailModal';
import { pushToast } from '../overlays/Notifications';

// ─── 流式波形 (活跃时显示) ───
function Waveform({ active }: { active: boolean }) {
  return (
    <div className="flex items-end gap-0.5 h-4 mr-2">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="w-0.5 bg-primary rounded-full origin-bottom"
          style={{
            height: active ? `${20 + Math.sin(Date.now() / 200 + i) * 30}%` : '20%',
            animation: active ? `wave 0.${i % 5 + 4}s ease-in-out infinite` : 'none',
            animationDelay: `${i * 0.05}s`,
          }}
        />
      ))}
    </div>
  );
}

interface Props {
  chunks: StreamChunk[];
  onClear: () => void;
  busy: boolean;
  onRetry?: (userInput: string) => void;
  onSwitchModel?: () => void;
  onOpenSettings?: () => void;
  onResendToChat?: (prompt: string) => void;
}

const TYPE_STYLE: Record<StreamChunk['type'], { icon: string; color: string; label: string; bg: string }> = {
  thinking: { icon: 'psychology',  color: 'text-accent',     label: '思考',  bg: 'bg-accent/10' },
  tool:      { icon: 'build',       color: 'text-warning',   label: '工具',  bg: 'bg-warning/10' },
  text:      { icon: 'subtitles',   color: 'text-text',      label: '生成',  bg: 'bg-primary/5' },
  error:     { icon: 'error',       color: 'text-danger',    label: '错误',  bg: 'bg-danger/10' },
  system:    { icon: 'info',        color: 'text-text-secondary', label: '系统',  bg: 'bg-surface-high' },
};

// ─── 错误 sticky 告警条 ───
function ErrorBanner({ count, latest, onJump, onDetail, onDismiss }: {
  count: number;
  latest: string;
  onJump: () => void;
  onDetail: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-danger/15 border-b border-danger/40 backdrop-blur-sm animate-slide-in-down">
      <span className="material-symbols-outlined text-danger text-sm animate-pulse">error</span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold text-danger flex items-center gap-1.5">
          <span>检测到 {count} 条错误</span>
          <span className="text-[9px] font-normal text-danger/70">· 实时</span>
        </div>
        <div className="text-[10px] text-danger/80 truncate font-mono">{latest}</div>
      </div>
      <button
        onClick={onDetail}
        className="text-[10px] text-danger hover:text-white hover:bg-danger px-1.5 h-5 rounded border border-danger/40 transition-colors shrink-0"
        title="查看完整错误"
      >
        详情
      </button>
      <button
        onClick={onJump}
        className="text-[10px] text-danger hover:text-white hover:bg-danger px-1.5 h-5 rounded border border-danger/40 transition-colors shrink-0"
      >
        跳到最新
      </button>
      <button
        onClick={onDismiss}
        className="material-symbols-outlined text-xs text-danger/70 hover:text-danger shrink-0"
        title="暂时忽略"
      >close</button>
    </div>
  );
}

export function StreamPanel({ chunks, onClear, busy, onRetry, onSwitchModel, onOpenSettings, onResendToChat }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<StreamChunk['type'] | 'all'>('all');
  const [viewMode, setViewMode] = useState<'timeline' | 'grouped'>('timeline');
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState(200);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [errorSeen, setErrorSeen] = useState(0);
  const [detailChunk, setDetailChunk] = useState<StreamChunk | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // 错误累计(累积到 chunks 末尾, 用户可暂时忽略)
  const errorCount = useMemo(() => chunks.filter(c => c.type === 'error').length, [chunks]);
  useEffect(() => {
    if (errorCount > errorSeen) setErrorDismissed(false);
    setErrorSeen(errorCount);
  }, [errorCount, errorSeen]);

  const latestError = useMemo(() => {
    for (let i = chunks.length - 1; i >= 0; i--) {
      if (chunks[i].type === 'error') return chunks[i];
    }
    return null;
  }, [chunks]);

  const jumpToLatestError = () => {
    if (!scrollRef.current) return;
    setAutoScroll(false);
    const errs = scrollRef.current.querySelectorAll('[data-error]');
    const last = errs[errs.length - 1] as HTMLElement;
    if (last) {
      last.scrollIntoView({ behavior: 'smooth', block: 'center' });
      last.classList.add('animate-pulse-ring');
      setTimeout(() => last.classList.remove('animate-pulse-ring'), 1600);
    }
  };

  // 跳到任意 chunk (按 id 找 DOM 元素)
  const jumpToChunk = (target: StreamChunk) => {
    if (!scrollRef.current) return;
    setAutoScroll(false);
    const el = scrollRef.current.querySelector(`[data-chunk-id="${target.id}"]`) as HTMLElement;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('animate-pulse-ring');
      setTimeout(() => el.classList.remove('animate-pulse-ring'), 1600);
    }
  };

  // 自动滚动
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chunks, autoScroll]);

  // 检测手动滚动
  const onScroll = () => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    setAutoScroll(atBottom);
  };

  // 类型统计
  const stats = useMemo(() => {
    const out = { thinking: 0, tool: 0, text: 0, error: 0, system: 0 };
    chunks.forEach(c => { out[c.type] = (out[c.type] || 0) + 1; });
    return out;
  }, [chunks]);

  const filtered = useMemo(() => {
    let list = chunks;
    if (filter !== 'all') list = list.filter(c => c.type === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c => c.content.toLowerCase().includes(q));
    }
    return list;
  }, [chunks, filter, search]);

  // ─── 导出 (放在 stats/filtered 之后以便引用) ───
  const buildMarkdown = (cs: StreamChunk[]) => {
    const lines: string[] = [];
    lines.push('# SoloForge 流送区报告');
    lines.push('');
    lines.push(`> 生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}  `);
    lines.push(`> 共 ${cs.length} 条 · 思考 ${stats.thinking} · 工具 ${stats.tool} · 生成 ${stats.text} · 错误 ${stats.error} · 系统 ${stats.system}  `);
    if (filter !== 'all') lines.push(`> 当前过滤: ${TYPE_STYLE[filter].label}  `);
    lines.push('');
    lines.push('## 类型分布');
    lines.push('| 类型 | 数量 |');
    lines.push('|------|------|');
    Object.entries(stats).forEach(([k, v]) => {
      const s = TYPE_STYLE[k as StreamChunk['type']];
      lines.push(`| ${s.icon} ${s.label} | ${v} |`);
    });
    lines.push('');
    lines.push('## 事件时间线');
    lines.push('');
    cs.forEach((c, i) => {
      const s = TYPE_STYLE[c.type];
      const t = new Date(c.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
      lines.push(`### ${i + 1}. [${t}] ${s.icon} ${s.label}`);
      lines.push('');
      lines.push('```');
      lines.push(c.content || '(空)');
      lines.push('```');
      if (c.type === 'error' && c.meta) {
        const m = c.meta as any;
        if (m.code || m.category) {
          lines.push('');
          lines.push(`- **类别**: ${m.category || 'unknown'}  `);
          if (m.code) lines.push(`- **代码**: \`${m.code}\`  `);
          if (m.retriable !== undefined) lines.push(`- **可重试**: ${m.retriable ? '是' : '否'}`);
        }
      }
      if (c.type === 'tool' && c.meta) {
        const m = c.meta as any;
        if (m.tool || m.args) {
          lines.push('');
          if (m.tool) lines.push(`**工具**: \`${m.tool}\`  `);
          if (m.args) lines.push(`**参数**: \`${JSON.stringify(m.args).slice(0, 200)}\``);
        }
      }
      lines.push('');
    });
    return lines.join('\n');
  };

  const exportAs = (fmt: 'md' | 'json' | 'log') => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (fmt === 'md') {
      const md = buildMarkdown(filtered);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `soloforge-stream-${ts}.md`;
      a.click();
      URL.revokeObjectURL(url);
      pushToast({ level: 'success', title: 'Markdown 报告已下载', message: `${filtered.length} 条`, duration: 1800 });
    } else if (fmt === 'json') {
      const json = JSON.stringify({ exportedAt: new Date().toISOString(), filter, chunks: filtered }, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `soloforge-stream-${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
      pushToast({ level: 'success', title: 'JSON 已下载', message: `${filtered.length} 条`, duration: 1800 });
    } else {
      const text = filtered.map(c => `[${new Date(c.timestamp).toISOString()}] [${c.type}] ${c.content}`).join('\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `soloforge-stream-${ts}.log`;
      a.click();
      URL.revokeObjectURL(url);
      pushToast({ level: 'success', title: '纯文本日志已下载', duration: 1800 });
    }
    setExportMenuOpen(false);
  };
  const copyAsMarkdown = () => {
    const md = buildMarkdown(filtered);
    navigator.clipboard?.writeText(md).then(() => {
      pushToast({ level: 'success', title: 'Markdown 已复制', message: '可粘贴到 Notion/飞书/GitHub', duration: 2000 });
    });
    setExportMenuOpen(false);
  };

  // 性能:分页渲染
  const visibleCount = filtered.length;
  const renderedChunks = useMemo(() => filtered.slice(-pageSize), [filtered, pageSize]);
  const hiddenCount = visibleCount - renderedChunks.length;

  // 分组视图
  const grouped = useMemo(() => {
    if (viewMode !== 'grouped') return null;
    const groups: Record<string, { label: string; icon: string; color: string; bg: string; chunks: StreamChunk[] }> = {};
    filtered.forEach(c => {
      const k = c.type;
      if (!groups[k]) {
        const s = TYPE_STYLE[k];
        groups[k] = { label: s.label, icon: s.icon, color: s.color, bg: s.bg, chunks: [] };
      }
      groups[k].chunks.push(c);
    });
    return groups;
  }, [filtered, viewMode]);

  return (
    <div className="flex flex-col h-full bg-bg-dim">
      <PanelHeader
        icon="stream"
        title={
          <span className="flex items-center gap-2">
            流送区
            <Waveform active={busy} />
          </span>
        }
        count={
          <span className="flex items-center gap-1.5">
            {chunks.length > 0 && (
              <>
                {stats.thinking > 0 && <button onClick={() => setFilter('thinking')}><Badge variant="info" dot className="hover:scale-105 transition-transform cursor-pointer">思考 {stats.thinking}</Badge></button>}
                {stats.tool > 0 && <button onClick={() => setFilter('tool')}><Badge variant="warning" dot className="hover:scale-105 transition-transform cursor-pointer">工具 {stats.tool}</Badge></button>}
                {stats.text > 0 && <button onClick={() => setFilter('text')}><Badge variant="primary" dot className="hover:scale-105 transition-transform cursor-pointer">生成 {stats.text}</Badge></button>}
                {stats.error > 0 && <button onClick={() => setFilter('error')}><Badge variant="danger" dot className="hover:scale-105 transition-transform cursor-pointer">错误 {stats.error}</Badge></button>}
              </>
            )}
            {chunks.length === 0 && <span className="text-text-secondary">空闲</span>}
          </span>
        }
        action={
          <>
            <div className="flex items-center bg-surface-high rounded-md border border-border-light p-0.5">
              {(['all', 'thinking', 'tool', 'text', 'error'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setFilter(t)}
                  className={`px-1.5 h-5 text-[10px] rounded transition-colors ${
                    filter === t ? 'bg-surface text-text shadow-sm' : 'text-text-secondary hover:text-text'
                  }`}
                >
                  {t === 'all' ? '全部' : TYPE_STYLE[t].label}
                </button>
              ))}
            </div>
            <Tooltip content="自动滚动">
              <IconButton icon={autoScroll ? 'vertical_align_bottom' : 'pause'} size="xs" active={autoScroll} onClick={() => setAutoScroll(s => !s)} />
            </Tooltip>
            <Tooltip content={viewMode === 'timeline' ? '切换到分组' : '切换到时间线'}>
              <IconButton icon={viewMode === 'timeline' ? 'view_agenda' : 'view_timeline'} size="xs" onClick={() => setViewMode(v => v === 'timeline' ? 'grouped' : 'timeline')} />
            </Tooltip>
            <Tooltip content="清空">
              <IconButton icon="delete_sweep" size="xs" onClick={onClear} />
            </Tooltip>
            <Tooltip content="导出 (Markdown / JSON / 原始)">
              <div className="relative">
                <IconButton icon="download" size="xs" onClick={() => setExportMenuOpen(o => !o)} />
                {exportMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setExportMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-surface border border-border rounded-lg shadow-lg overflow-hidden animate-slide-in-up">
                      <div className="px-2 py-1 text-[9px] text-text-secondary/70 font-mono border-b border-border-light bg-bg-dim">
                        导出流送区 · {filtered.length} 条
                      </div>
                      <button
                        onClick={() => exportAs('md')}
                        className="w-full flex items-center gap-2 px-2 h-7 text-[11px] text-text hover:bg-surface-high transition-colors"
                      >
                        <span className="material-symbols-outlined text-xs text-primary">markdown</span>
                        <span className="flex-1 text-left">Markdown 报告</span>
                        <span className="text-[9px] text-text-secondary/60 font-mono">.md</span>
                      </button>
                      <button
                        onClick={() => exportAs('json')}
                        className="w-full flex items-center gap-2 px-2 h-7 text-[11px] text-text hover:bg-surface-high transition-colors"
                      >
                        <span className="material-symbols-outlined text-xs text-accent">data_object</span>
                        <span className="flex-1 text-left">JSON 原始数据</span>
                        <span className="text-[9px] text-text-secondary/60 font-mono">.json</span>
                      </button>
                      <button
                        onClick={() => exportAs('log')}
                        className="w-full flex items-center gap-2 px-2 h-7 text-[11px] text-text hover:bg-surface-high transition-colors"
                      >
                        <span className="material-symbols-outlined text-xs text-text-secondary">description</span>
                        <span className="flex-1 text-left">纯文本日志</span>
                        <span className="text-[9px] text-text-secondary/60 font-mono">.log</span>
                      </button>
                      <div className="border-t border-border-light">
                        <button
                          onClick={copyAsMarkdown}
                          className="w-full flex items-center gap-2 px-2 h-7 text-[11px] text-text hover:bg-surface-high transition-colors"
                        >
                          <span className="material-symbols-outlined text-xs text-success">content_copy</span>
                          <span className="flex-1 text-left">复制 Markdown</span>
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </Tooltip>
          </>
        }
      />

      {/* 搜索条 */}
      <div className="flex items-center gap-2 px-2 h-8 border-b border-border-light bg-bg-dim">
        <div className="flex items-center flex-1 gap-1.5 px-2 h-6 bg-surface border border-border-light rounded-md focus-within:border-primary">
          <span className="material-symbols-outlined text-xs text-text-secondary">search</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索流送内容..."
            className="flex-1 bg-transparent text-[10px] text-text placeholder-text-secondary outline-none"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="material-symbols-outlined text-xs text-text-secondary hover:text-text"
            >close</button>
          )}
        </div>
        {visibleCount > pageSize && (
          <span className="text-[10px] text-text-secondary font-mono shrink-0">
            显示 {renderedChunks.length} / {visibleCount}
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto scrollbar-thin"
      >
        {errorCount > 0 && !errorDismissed && latestError && (
          <ErrorBanner
            count={errorCount}
            latest={latestError.content}
            onJump={jumpToLatestError}
            onDetail={() => setDetailChunk(latestError)}
            onDismiss={() => setErrorDismissed(true)}
          />
        )}
        {filtered.length === 0 ? (
          <Empty busy={busy} hasAny={chunks.length > 0} />
        ) : viewMode === 'grouped' && grouped ? (
          <div className="p-2 space-y-2">
            {hiddenCount > 0 && (
              <div className="text-center py-1.5 text-[10px] text-text-secondary">
                <button
                  onClick={() => setPageSize(s => s + 200)}
                  className="hover:text-text underline"
                >↑ 显示前 {hiddenCount} 条更早记录</button>
              </div>
            )}
            {Object.entries(grouped).map(([type, g]) => (
              <div key={type} className={`rounded-lg border border-border-light ${g.bg} overflow-hidden`}>
                <div className="flex items-center gap-2 px-2 py-1 bg-surface border-b border-border-light">
                  <span className={`material-symbols-outlined text-sm ${g.color}`}>{g.icon}</span>
                  <span className={`text-[11px] font-semibold ${g.color}`}>{g.label}</span>
                  <Badge variant="default" className="text-[9px]">{g.chunks.length}</Badge>
                </div>
                <div className="p-1 space-y-1">
                  {g.chunks.slice(-pageSize).map((c, idx) => <ChunkLine key={c.id} chunk={c} index={idx} search={search} onErrorClick={setDetailChunk} />)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {hiddenCount > 0 && (
              <div className="text-center py-1.5 text-[10px] text-text-secondary">
                <button
                  onClick={() => setPageSize(s => s + 200)}
                  className="hover:text-text underline"
                >↑ 显示前 {hiddenCount} 条更早记录</button>
              </div>
            )}
            {renderedChunks.map((c, idx) => <ChunkLine key={c.id} chunk={c} index={idx} search={search} onErrorClick={setDetailChunk} />)}
          </div>
        )}
      </div>

      {/* 底部状态条 */}
      {busy && (
        <div className="flex items-center justify-between px-3 h-7 bg-primary/5 border-t border-primary/20 text-[10px] text-primary">
          <div className="flex items-center gap-1.5">
            <span className="flex gap-0.5">
              <span className="w-1 h-1 bg-primary rounded-full animate-typing" />
              <span className="w-1 h-1 bg-primary rounded-full animate-typing" />
              <span className="w-1 h-1 bg-primary rounded-full animate-typing" />
            </span>
            <span>正在生成...</span>
          </div>
          <button onClick={() => alert('已发送停止信号')} className="text-danger hover:underline">停止</button>
        </div>
      )}

      {/* 错误详情弹层 */}
      <ErrorDetailModal
        chunk={detailChunk}
        onClose={() => setDetailChunk(null)}
        allChunks={chunks}
        onJumpToError={(c) => { setDetailChunk(c); jumpToChunk(c); }}
        onRetry={() => {
          if (!detailChunk) return;
          const input = (detailChunk.meta as any)?.userInput;
          if (input && onRetry) {
            onRetry(input);
            pushToast({ level: 'info', title: '已重新发送', message: input.slice(0, 60), duration: 2000 });
          }
          setDetailChunk(null);
        }}
        onSwitchModel={onSwitchModel}
        onOpenSettings={onOpenSettings}
        onResendToChat={onResendToChat}
      />
    </div>
  );
}

function ChunkLine({ chunk, index, search, onErrorClick }: { chunk: StreamChunk; index: number; search?: string; onErrorClick?: (c: StreamChunk) => void }) {
  const s = TYPE_STYLE[chunk.type] || TYPE_STYLE.system;
  const time = new Date(chunk.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const isError = chunk.type === 'error';
  const isLong = chunk.content.length > 200;
  const display = !expanded && isLong ? chunk.content.slice(0, 200) + '…' : chunk.content;

  // 关键词高亮
  const renderHighlighted = (text: string) => {
    if (!search || !search.trim()) return text;
    const q = search.trim();
    const lower = text.toLowerCase();
    const ql = q.toLowerCase();
    const parts: Array<{ text: string; hit: boolean }> = [];
    let i = 0;
    while (i < text.length) {
      const idx = lower.indexOf(ql, i);
      if (idx === -1) {
        parts.push({ text: text.slice(i), hit: false });
        break;
      }
      if (idx > i) parts.push({ text: text.slice(i, idx), hit: false });
      parts.push({ text: text.slice(idx, idx + q.length), hit: true });
      i = idx + q.length;
    }
    return (
      <>
        {parts.map((p, j) =>
          p.hit
            ? <mark key={j} className="bg-warning/30 text-text rounded px-0.5">{p.text}</mark>
            : <span key={j}>{p.text}</span>
        )}
      </>
    );
  };

  return (
    <div
      data-error={isError ? '1' : undefined}
      data-chunk-id={chunk.id}
      onDoubleClick={() => isError && onErrorClick?.(chunk)}
      title={isError ? '双击查看错误详情' : undefined}
      style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}
      className={`group relative flex items-start gap-2 text-xs leading-relaxed px-2 py-1.5 rounded border-l-2 animate-slide-in-up ${
        isError
          ? 'bg-danger/8 border-l-danger border-y border-r border-danger/30 shadow-[0_0_0_1px_rgba(220,38,38,0.08)] cursor-pointer hover:bg-danger/12'
          : `${s.bg} hover:bg-surface/60`
      }`}
    >
      <span className="text-text-secondary/70 font-mono shrink-0 w-16 text-[10px]">{time}</span>
      <Tooltip content={s.label}>
        <span className={`material-symbols-outlined text-sm shrink-0 ${isError ? 'text-danger animate-pulse' : s.color}`}>{s.icon}</span>
      </Tooltip>
      <span className={`shrink-0 px-1.5 py-0 rounded text-[9px] font-semibold ${s.color} bg-surface border border-border-light`}>
        {s.label}
      </span>
      <pre className={`flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed ${isError ? 'text-danger' : 'text-text'}`}>{renderHighlighted(display)}</pre>
      <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0">
        {isLong && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="material-symbols-outlined text-xs text-text-secondary hover:text-text"
            title={expanded ? '收起' : '展开'}
          >{expanded ? 'expand_less' : 'expand_more'}</button>
        )}
        <button
          onClick={() => {
            navigator.clipboard?.writeText(chunk.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="material-symbols-outlined text-xs text-text-secondary hover:text-text"
          title="复制"
        >{copied ? 'check' : 'content_copy'}</button>
      </div>
    </div>
  );
}

function Empty({ busy, hasAny }: { busy: boolean; hasAny: boolean }) {
  if (busy) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary">
        <div className="flex gap-1.5 mb-3">
          <span className="w-2 h-2 bg-primary rounded-full animate-typing" />
          <span className="w-2 h-2 bg-primary rounded-full animate-typing" />
          <span className="w-2 h-2 bg-primary rounded-full animate-typing" />
        </div>
        <p className="text-xs">主模型正在思考...</p>
      </div>
    );
  }
  if (hasAny) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary">
        <span className="material-symbols-outlined text-4xl mb-2 opacity-40">filter_alt_off</span>
        <p className="text-xs">当前过滤下无内容</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center h-full text-text-secondary">
      <div className="relative mb-3">
        <span className="material-symbols-outlined text-5xl opacity-30">stream</span>
        <span className="absolute inset-0 blur-2xl bg-primary/10 rounded-full" />
      </div>
      <p className="text-xs font-medium text-text-secondary">等待任务开始...</p>
      <p className="text-[10px] text-text-secondary/60 mt-1">流式输出将在这里实时显示</p>
    </div>
  );
}
