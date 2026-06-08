// ─────────────────────────────────────────────────────────────────
// 错误详情弹层
// - 来自 StreamPanel 的 error chunk
// - 展示:类别 / code / stack / 上下文
// - 操作:复制 / 重试 / 切换模型 / 打开设置
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useMemo } from 'react';
import type { StreamChunk } from '../../types';
import { pushToast } from './Notifications';
import { Kbd, KbdGroup, Button, Badge } from '../ui/Button';

interface Props {
  chunk: StreamChunk | null;
  onClose: () => void;
  onRetry?: () => void;
  onSwitchModel?: () => void;
  onOpenSettings?: () => void;
  onResendToChat?: (prompt: string) => void;
  allChunks?: StreamChunk[];
  onJumpToError?: (chunk: StreamChunk) => void;
}

const CATEGORY_META: Record<string, { label: string; icon: string; color: string; hint: string; retriable: boolean }> = {
  abort:      { label: '用户中止',     icon: 'stop_circle',  color: 'text-warning', hint: '请求被用户主动中断',                retriable: true  },
  network:    { label: '网络错误',     icon: 'wifi_off',     color: 'text-warning', hint: '检查网络连接或后端服务是否可达',       retriable: true  },
  auth:       { label: '认证失败',     icon: 'lock',         color: 'text-danger',  hint: 'API Key 无效或过期,请检查设置',         retriable: false },
  rate_limit: { label: '速率限制',     icon: 'hourglass_top',color: 'text-warning', hint: '触发 Provider 速率限制,请稍后重试',     retriable: true  },
  server:     { label: '服务端错误',   icon: 'dns',          color: 'text-danger',  hint: '上游模型服务异常,建议切换或重试',       retriable: true  },
  unknown:    { label: '未知错误',     icon: 'help',         color: 'text-danger',  hint: '未分类错误,查看 stack 或联系支持',     retriable: true  },
};

// ─── 类别过滤 chip ───
function FilterChip({ active, onClick, label, count, color }: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 flex items-center gap-1 px-1.5 h-5 rounded-full text-[10px] transition-colors ${
        active
          ? 'bg-primary-container text-on-primary-container border border-primary/40'
          : 'bg-surface text-text-secondary hover:text-text border border-border-light'
      }`}
    >
      <span className={active ? '' : (color || 'text-text-secondary')}>
        {label}
      </span>
      <span className={`font-mono tabular-nums ${active ? 'text-on-primary-container/70' : 'text-text-secondary/60'}`}>
        {count}
      </span>
    </button>
  );
}

export function ErrorDetailModal({ chunk, onClose, onRetry, onSwitchModel, onOpenSettings, onResendToChat, allChunks, onJumpToError }: Props) {
  const [tab, setTab] = useState<'summary' | 'stack' | 'context' | 'history'>('summary');
  const [copied, setCopied] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<string>('all');
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chunk) setTab('summary');
  }, [chunk]);

  useEffect(() => {
    if (!chunk) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleCopy('content', chunk.content);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chunk, onClose]);

  // 历史错误: 同 session 内所有 error chunk (按时间倒序)
  const sessionId = (chunk?.meta as any)?.sessionId;
  const historyErrors = useMemo(() => {
    if (!allChunks) return [];
    return allChunks
      .filter(c => c.type === 'error')
      .filter(c => !sessionId || ((c.meta as any)?.sessionId === sessionId))
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [allChunks, sessionId]);

  // 按类别聚合
  const historyByCategory = useMemo(() => {
    const out: Record<string, number> = {};
    historyErrors.forEach(e => {
      const k = (e.meta as any)?.category || 'unknown';
      out[k] = (out[k] || 0) + 1;
    });
    return out;
  }, [historyErrors]);

  // 按小时聚合 (24 桶, 左侧最新)
  const historyByHour = useMemo(() => {
    if (historyErrors.length === 0) return { buckets: [] as number[], labels: [] as string[], peak: 0 };
    const BUCKETS = 24;
    const WINDOW_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const counts = new Array(BUCKETS).fill(0);
    let max = 0;
    for (const e of historyErrors) {
      const age = now - e.timestamp;
      if (age < 0 || age > WINDOW_MS) continue;
      const bucket = Math.min(BUCKETS - 1, Math.floor((age / WINDOW_MS) * BUCKETS));
      counts[bucket]++;
      if (counts[bucket] > max) max = counts[bucket];
    }
    // 翻转:左新右旧
    const ordered = counts.slice().reverse();
    const labels = ordered.map((_, i) => {
      const ageHours = ((BUCKETS - 1 - i) * WINDOW_MS / BUCKETS) / 3600000;
      if (i === BUCKETS - 1) return '24h';
      if (i === 0) return 'now';
      if (ageHours < 1) return `${Math.round(ageHours * 60)}m`;
      return `${Math.round(ageHours)}h`;
    });
    return { buckets: ordered, labels, peak: max };
  }, [historyErrors]);

  const filteredHistory = useMemo(() => {
    if (historyFilter === 'all') return historyErrors;
    return historyErrors.filter(e => ((e.meta as any)?.category || 'unknown') === historyFilter);
  }, [historyErrors, historyFilter]);

  if (!chunk) return null;

  const meta = (chunk.meta || {}) as {
    code?: string;
    category?: string;
    stack?: string;
    retriable?: boolean;
    userInput?: string;
    sessionId?: string;
    model?: string;
  };
  const cat = CATEGORY_META[meta.category || 'unknown'] || CATEGORY_META.unknown;
  const retriable = meta.retriable !== false;

  const handleCopy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
    pushToast({ level: 'success', title: '已复制', duration: 1500 });
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ chunk, meta, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `soloforge-error-${chunk.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    pushToast({ level: 'success', title: '错误报告已导出', duration: 1800 });
  };

  // 复制为 Markdown 报告
  const buildMarkdownReport = () => {
    const lines: string[] = [];
    lines.push(`# 错误报告 — ${cat.label}`);
    lines.push('');
    lines.push(`> 生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}  `);
    lines.push(`> Chunk ID: \`${chunk.id}\`  `);
    lines.push(`> 错误类别: **${cat.label}** (\`${meta.category || 'unknown'}\`)  `);
    if (meta.code) lines.push(`> 错误代码: \`${meta.code}\`  `);
    if (meta.model) lines.push(`> 模型: \`${meta.model}\`  `);
    if (meta.sessionId) lines.push(`> Session: \`${meta.sessionId}\`  `);
    lines.push(`> 可重试: ${retriable ? '是' : '否'}  `);
    lines.push('');
    lines.push('## 错误消息');
    lines.push('```');
    lines.push(chunk.content);
    lines.push('```');
    lines.push('');
    if (meta.stack && meta.stack !== chunk.content) {
      lines.push('## Stack Trace');
      lines.push('```');
      const stackLines = meta.stack.split('\n').slice(0, 50);
      lines.push(stackLines.join('\n'));
      if (meta.stack.split('\n').length > 50) {
        lines.push(`... (共 ${meta.stack.split('\n').length} 行,已截断)`);
      }
      lines.push('```');
      lines.push('');
    }
    if (meta.userInput) {
      lines.push('## 触发输入');
      lines.push('```');
      lines.push(meta.userInput);
      lines.push('```');
      lines.push('');
    }
    // 类别说明
    lines.push('## 错误类别');
    lines.push(`- **图标**: ${cat.icon}`);
    lines.push(`- **标签**: ${cat.label}`);
    lines.push(`- **说明**: ${cat.hint}`);
    lines.push(`- **可重试**: ${cat.retriable ? '是' : '否'}`);
    lines.push('');
    // 历史汇总
    if (historyErrors.length > 0) {
      lines.push('## 错误历史 (本 session)');
      lines.push(`共 ${historyErrors.length} 条, 按类别:`);
      lines.push('');
      lines.push('| 类别 | 数量 |');
      lines.push('|------|------|');
      Object.entries(historyByCategory)
        .sort((a, b) => b[1] - a[1])
        .forEach(([k, c]) => {
          const cm = CATEGORY_META[k] || CATEGORY_META.unknown;
          lines.push(`| ${cm.label} | ${c} |`);
        });
      lines.push('');
      // 24h 分布 (markdown 表格)
      if (historyByHour.peak > 0) {
        const visible = historyByHour.buckets
          .map((c, i) => ({ c, label: historyByHour.labels[i] }))
          .filter(b => b.c > 0);
        if (visible.length > 0) {
          lines.push('### 24h 错误分布');
          lines.push('| 时间 | 次数 |');
          lines.push('|------|------|');
          visible.forEach(b => lines.push(`| ${b.label} 前 | ${b.c} |`));
          lines.push('');
        }
      }
    }
    lines.push('## 完整 Chunk 数据');
    lines.push('```json');
    lines.push(JSON.stringify({ id: chunk.id, type: chunk.type, content: chunk.content, timestamp: chunk.timestamp, meta: chunk.meta }, null, 2));
    lines.push('```');
    return lines.join('\n');
  };

  const [copyMdState, setCopyMdState] = useState<'idle' | 'copied' | 'downloaded'>('idle');
  const copyAsMarkdown = async () => {
    const md = buildMarkdownReport();
    try {
      await navigator.clipboard.writeText(md);
      setCopyMdState('copied');
      pushToast({ level: 'success', title: 'Markdown 报告已复制', message: '可粘贴到 Notion/GitHub/飞书', duration: 2200 });
    } catch {
      pushToast({ level: 'warning', title: '剪贴板不可用', message: '改用下载', duration: 1800 });
    }
    setTimeout(() => setCopyMdState('idle'), 1500);
  };
  const downloadMarkdown = () => {
    const md = buildMarkdownReport();
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `soloforge-error-${chunk.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
    setCopyMdState('downloaded');
    pushToast({ level: 'success', title: 'Markdown 报告已下载', duration: 1800 });
    setTimeout(() => setCopyMdState('idle'), 1500);
  };

  const buildReviewPrompt = () => {
    const lines: string[] = [];
    lines.push('请帮我复盘以下运行时错误,分析根因并给出修复建议。\n');
    lines.push('## 错误摘要');
    lines.push(`- **类别**: ${cat.label}`);
    lines.push(`- **代码**: ${meta.code || 'N/A'}`);
    lines.push(`- **时间**: ${new Date(chunk.timestamp).toLocaleString('zh-CN')}`);
    if (meta.model) lines.push(`- **模型**: \`${meta.model}\``);
    if (meta.sessionId) lines.push(`- **Session**: \`${meta.sessionId}\``);
    lines.push(`- **可重试**: ${retriable ? '是' : '否'}`);
    lines.push('\n## 错误消息');
    lines.push('```');
    lines.push(chunk.content);
    lines.push('```');
    if (meta.stack && meta.stack !== chunk.content) {
      lines.push('\n## Stack Trace');
      lines.push('```');
      // 截取前 30 行避免过长
      const stackLines = meta.stack.split('\n').slice(0, 30);
      lines.push(stackLines.join('\n'));
      if (meta.stack.split('\n').length > 30) lines.push(`\n... (共 ${meta.stack.split('\n').length} 行,已截断)`);
      lines.push('```');
    }
    if (meta.userInput) {
      lines.push('\n## 触发输入');
      lines.push('```');
      lines.push(meta.userInput);
      lines.push('```');
    }
    lines.push('\n## 你的任务');
    lines.push('1. 简要分析这个错误最可能的原因 (1-2 句话)');
    lines.push('2. 给出具体的修复步骤 (代码片段 + 解释)');
    lines.push('3. 如果是配置/网络/限流类问题,告诉我应该检查哪些设置');
    return lines.join('\n');
  };

  const handleResend = () => {
    if (!onResendToChat) {
      // fallback: 复制到剪贴板
      const prompt = buildReviewPrompt();
      navigator.clipboard?.writeText(prompt).catch(() => {});
      pushToast({ level: 'success', title: '复盘提示已复制', message: '粘贴到对话区', duration: 2500 });
      return;
    }
    onResendToChat(buildReviewPrompt());
    pushToast({ level: 'info', title: '已发送给 AI 复盘', duration: 2000 });
    onClose();
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[680px] max-w-[92vw] max-h-[85vh] bg-surface border border-danger/40 rounded-xl shadow-2xl overflow-hidden flex flex-col animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 h-11 bg-danger/10 border-b border-danger/30 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`material-symbols-outlined ${cat.color} text-base shrink-0`}>{cat.icon}</span>
            <span className="text-xs font-semibold text-text">错误详情</span>
            <Badge variant="danger">{cat.label}</Badge>
            {meta.code && (
              <code className="px-1.5 py-0.5 rounded bg-bg-dim text-text-secondary border border-border-light font-mono text-[10px]">
                {meta.code}
              </code>
            )}
          </div>
          <button
            onClick={onClose}
            className="material-symbols-outlined text-sm text-text-secondary hover:text-text"
          >close</button>
        </div>

        {/* 错误信息 */}
        <div className="px-4 py-3 border-b border-border-light bg-bg-dim">
          <div className="text-[10px] text-text-secondary mb-1">原始消息</div>
          <div className="text-xs text-danger font-mono break-all leading-relaxed">{chunk.content}</div>
          <div className="mt-1.5 text-[10px] text-text-secondary/80 flex items-center gap-2 font-mono">
            <span>{new Date(chunk.timestamp).toLocaleString('zh-CN', { hour12: false })}</span>
            <span>·</span>
            <span>ID: {chunk.id}</span>
          </div>
        </div>

        {/* Tab */}
        <div className="flex items-center gap-1 px-3 h-8 bg-bg-dim border-b border-border-light shrink-0">
          {([
            { id: 'summary', label: '摘要', icon: 'info' },
            { id: 'stack', label: 'Stack', icon: 'code' },
            { id: 'context', label: '上下文', icon: 'data_object' },
            { id: 'history', label: '历史', icon: 'history', count: historyErrors.length },
          ] as const).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1 px-2 h-6 text-[10px] rounded transition-colors ${
                tab === t.id ? 'bg-surface text-text shadow-sm' : 'text-text-secondary hover:text-text'
              }`}
            >
              <span className="material-symbols-outlined text-xs">{t.icon}</span>
              {t.label}
              {'count' in t && t.count > 0 && (
                <span className="px-1 py-0 rounded-full bg-danger/20 text-danger text-[8px] font-bold tabular-nums">
                  {t.count}
                </span>
              )}
            </button>
          ))}
          <div className="flex-1" />
          {meta.stack && tab === 'stack' && (
            <span className="text-[9px] text-text-secondary/60 font-mono">
              {meta.stack.split('\n').length} 行
            </span>
          )}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
          {tab === 'summary' && (
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-[80px_1fr] gap-y-1.5">
                <div className="text-text-secondary">类别</div>
                <div className={`flex items-center gap-1.5 ${cat.color} font-semibold`}>
                  <span className="material-symbols-outlined text-sm">{cat.icon}</span>
                  {cat.label}
                </div>

                <div className="text-text-secondary">提示</div>
                <div className="text-text">{cat.hint}</div>

                <div className="text-text-secondary">可重试</div>
                <div>
                  {retriable ? (
                    <span className="text-success flex items-center gap-1">
                      <span className="material-symbols-outlined text-xs">check_circle</span>
                      是
                    </span>
                  ) : (
                    <span className="text-danger flex items-center gap-1">
                      <span className="material-symbols-outlined text-xs">block</span>
                      否 (需先修复配置)
                    </span>
                  )}
                </div>

                {meta.model && (
                  <>
                    <div className="text-text-secondary">模型</div>
                    <code className="px-1.5 py-0.5 rounded bg-bg-dim text-text border border-border-light font-mono text-[10px]">
                      {meta.model}
                    </code>
                  </>
                )}

                {meta.sessionId && (
                  <>
                    <div className="text-text-secondary">Session</div>
                    <code className="px-1.5 py-0.5 rounded bg-bg-dim text-text-secondary border border-border-light font-mono text-[10px] truncate">
                      {meta.sessionId}
                    </code>
                  </>
                )}
              </div>

              {/* 错误代码 - 颜色编码 */}
              <div className="mt-3 p-2.5 bg-bg-dim border border-border-light rounded-lg">
                <div className="text-[10px] text-text-secondary mb-1.5">错误代码语义</div>
                <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                  {Object.entries(CATEGORY_META).map(([k, v]) => (
                    <div
                      key={k}
                      className={`flex items-center gap-1.5 px-1.5 py-1 rounded ${
                        (meta.category || 'unknown') === k ? 'bg-danger/15 border border-danger/30' : 'bg-surface border border-border-light'
                      }`}
                    >
                      <span className={`material-symbols-outlined text-xs ${v.color}`}>{v.icon}</span>
                      <span className={v.color}>{v.label}</span>
                      {v.retriable && <span className="ml-auto text-text-secondary/50 text-[9px]">↻</span>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'stack' && (
            <div>
              {meta.stack ? (
                <pre className="text-[10px] font-mono text-text bg-bg-dim border border-border-light rounded-lg p-3 overflow-x-auto leading-relaxed whitespace-pre-wrap break-all">
                  {meta.stack}
                </pre>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-text-secondary">
                  <span className="material-symbols-outlined text-3xl mb-1 opacity-40">code_off</span>
                  <p className="text-xs">无可用 stack trace</p>
                  <p className="text-[10px] mt-1">客户端模拟不会产生真实 stack</p>
                </div>
              )}
            </div>
          )}

          {tab === 'context' && (
            <div className="space-y-3 text-xs">
              {meta.userInput && (
                <div>
                  <div className="text-[10px] text-text-secondary mb-1">触发输入</div>
                  <pre className="text-[11px] font-mono text-text bg-bg-dim border border-border-light rounded p-2 break-all whitespace-pre-wrap">
                    {meta.userInput}
                  </pre>
                </div>
              )}
              <div>
                <div className="text-[10px] text-text-secondary mb-1">完整 Chunk (JSON)</div>
                <pre className="text-[10px] font-mono text-text-secondary bg-bg-dim border border-border-light rounded p-2 overflow-x-auto">
                  {JSON.stringify({ id: chunk.id, type: chunk.type, content: chunk.content, timestamp: chunk.timestamp, meta: chunk.meta }, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {tab === 'history' && (
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between text-[10px] text-text-secondary">
                <span>
                  {sessionId ? `Session ${sessionId.slice(0, 12)}... · ` : ''}共 {historyErrors.length} 条错误
                </span>
                <span>按时间倒序</span>
              </div>
              {/* 类别过滤 chips */}
              {historyErrors.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  <FilterChip
                    active={historyFilter === 'all'}
                    onClick={() => setHistoryFilter('all')}
                    label="全部"
                    count={historyErrors.length}
                  />
                  {Object.entries(historyByCategory)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, count]) => {
                      const c = CATEGORY_META[k] || CATEGORY_META.unknown;
                      return (
                        <FilterChip
                          key={k}
                          active={historyFilter === k}
                          onClick={() => setHistoryFilter(k)}
                          label={c.label}
                          count={count}
                          color={c.color}
                        />
                      );
                    })}
                </div>
              )}

              {/* 24h 柱状图 */}
              {historyErrors.length > 0 && historyByHour.peak > 0 && (
                <div className="flex items-end gap-px h-8 w-full px-1" title={`24h 错误分布 · 峰值 ${historyByHour.peak} 条/小时`}>
                  {historyByHour.buckets.map((c, i) => {
                    const h = historyByHour.peak === 0 ? 1 : Math.max(1, Math.round((c / historyByHour.peak) * 30));
                    const ratio = c / historyByHour.peak;
                    const color = ratio > 0.75 ? 'bg-danger' : ratio > 0.4 ? 'bg-danger/60' : ratio > 0.1 ? 'bg-danger/35' : 'bg-danger/15';
                    return (
                      <div
                        key={i}
                        className="flex-1 flex flex-col items-center justify-end group"
                      >
                        <div
                          className={`w-full rounded-sm ${color} transition-all`}
                          style={{ height: `${h}px` }}
                        />
                        {c > 0 && historyByHour.peak > 1 && (
                          <span className="text-[8px] text-text-secondary/70 mt-0.5 tabular-nums leading-none">
                            {c}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {historyErrors.length > 0 && (
                <div className="flex items-center justify-between text-[8px] text-text-secondary/50 font-mono px-1">
                  <span>{historyByHour.labels[0]}</span>
                  <span>24h 错误密度</span>
                  <span>{historyByHour.labels[historyByHour.labels.length - 1]}</span>
                </div>
              )}
              {historyErrors.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-text-secondary">
                  <span className="material-symbols-outlined text-3xl mb-1 opacity-40">task_alt</span>
                  <p className="text-xs">暂无历史错误</p>
                </div>
              ) : filteredHistory.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 text-text-secondary">
                  <span className="material-symbols-outlined text-2xl mb-1 opacity-40">filter_alt_off</span>
                  <p className="text-xs">该类别下无错误</p>
                </div>
              ) : (
                <div className="relative pl-4">
                  {/* 时间线竖线 */}
                  <div className="absolute left-1.5 top-2 bottom-2 w-px bg-border-light" />
                  {filteredHistory.map((e: StreamChunk, i: number) => {
                    const em = (e.meta || {}) as { category?: string; code?: string; retriable?: boolean };
                    const isCurrent = e.id === chunk.id;
                    const eCat = CATEGORY_META[em.category || 'unknown'] || CATEGORY_META.unknown;
                    return (
                      <div
                        key={e.id}
                        className={`relative pb-3 ${i === historyErrors.length - 1 ? '' : ''}`}
                      >
                        {/* 时间点 */}
                        <div className={`absolute -left-[14px] top-0.5 w-3 h-3 rounded-full border-2 ${
                          isCurrent ? 'bg-danger border-danger animate-pulse' : 'bg-surface border-danger/40'
                        }`} />
                        <div
                          onClick={() => onJumpToError?.(e)}
                          className={`group ml-3 p-2 rounded-lg border cursor-pointer transition-colors ${
                            isCurrent
                              ? 'bg-danger/10 border-danger/40'
                              : 'bg-surface border-border-light hover:border-danger/30 hover:bg-danger/5'
                          }`}
                        >
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`material-symbols-outlined text-xs ${eCat.color}`}>{eCat.icon}</span>
                            <Badge variant="danger" className="text-[9px]">{eCat.label}</Badge>
                            {em.code && (
                              <code className="px-1 py-0.5 rounded bg-bg-dim text-text-secondary font-mono text-[9px]">
                                {em.code}
                              </code>
                            )}
                            {isCurrent && (
                              <span className="text-[9px] text-danger font-semibold">· 当前</span>
                            )}
                            <span className="ml-auto text-[9px] text-text-secondary/70 font-mono shrink-0">
                              {new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
                            </span>
                          </div>
                          <div className="mt-1 text-[10px] text-text font-mono break-all line-clamp-2">
                            {e.content}
                          </div>
                          {onJumpToError && (
                            <div className="mt-1 text-[9px] text-text-secondary/60 group-hover:text-primary flex items-center gap-0.5">
                              <span className="material-symbols-outlined text-[10px]">arrow_forward</span>
                              跳到此错误
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 操作栏 */}
        <div className="flex items-center justify-between px-3 h-10 bg-bg-dim border-t border-border-light shrink-0">
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="xs"
              icon={copied === 'content' ? 'check' : 'content_copy'}
              onClick={() => handleCopy('content', chunk.content)}
            >
              {copied === 'content' ? '已复制' : '复制消息'}
            </Button>
            {meta.stack && (
              <Button
                variant="ghost"
                size="xs"
                icon={copied === 'stack' ? 'check' : 'code'}
                onClick={() => handleCopy('stack', meta.stack!)}
              >
                {copied === 'stack' ? '已复制' : '复制 stack'}
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              icon={copyMdState === 'copied' ? 'check' : 'markdown'}
              onClick={copyAsMarkdown}
              tooltip="复制为 Markdown 报告 (含错误/Stack/输入/历史)"
            >
              {copyMdState === 'copied' ? '已复制 MD' : '复制 MD'}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              icon={copyMdState === 'downloaded' ? 'check' : 'download'}
              onClick={downloadMarkdown}
              tooltip="下载为 .md 文件"
            >
              {copyMdState === 'downloaded' ? '已下载' : '下载 .md'}
            </Button>
            <Button variant="ghost" size="xs" icon="data_object" onClick={exportJson}>
              JSON
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="xs" icon="forum" onClick={handleResend}>
              {onResendToChat ? 'AI 复盘' : '复制提示'}
            </Button>
            {meta.category === 'auth' && onOpenSettings && (
              <Button variant="outline" size="xs" icon="settings" onClick={onOpenSettings}>
                打开设置
              </Button>
            )}
            {onSwitchModel && (
              <Button variant="outline" size="xs" icon="swap_horiz" onClick={onSwitchModel}>
                切换模型
              </Button>
            )}
            {retriable && onRetry && (
              <Button variant="primary" size="xs" icon="refresh" onClick={onRetry}>
                重试
              </Button>
            )}
            <KbdGroup keys={['Esc']} className="ml-1" />
          </div>
        </div>
      </div>
    </div>
  );
}
