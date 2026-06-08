// ─────────────────────────────────────────────────────────────────
// AI 提示词 A/B 测试
// - 同一问题用 2-3 个变体 (prompt / temperature / model) 并行发送
// - 并排卡片展示回复
// - 投票 (点赞) / 标注胜出者
// - 胜出变体自动提示「设为默认」
// - 历史结果持久化
// ─────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useMemo } from 'react';
import { Button, IconButton, Tooltip, Badge } from '../ui/Button';
import { pushToast } from './Notifications';
import type { ChatMessage, StreamChunk } from '../../types';

export interface ABTestVariant {
  id: string;
  name: string;
  prompt?: string;            // 提示词覆盖 (拼接到系统 prompt)
  systemPrompt?: string;      // 完整系统提示词
  model?: string;             // 模型覆盖
  temperature?: number;       // 温度覆盖
  color: string;              // 卡片色
  icon: string;
}

export interface ABTestConfig {
  variants: ABTestVariant[];
  question: string;
  createdAt: number;
}

export interface ABTestResult {
  config: ABTestConfig;
  responses: Array<{
    variantId: string;
    content: string;
    durationMs: number;
    tokenCount: number;
    votes: number;
    winner: boolean;
    finished: boolean;
    error?: string;
  }>;
  finishedAt?: number;
  chosenVariantId?: string;
}

const STORAGE_KEY = 'soloforge.abtest.history';

const VARIANT_COLORS = ['#89b4fa', '#a6e3a1', '#f5c2e7', '#fab387'];
const VARIANT_ICONS = ['science', 'science', 'science', 'science'];

const DEFAULT_VARIANTS: ABTestVariant[] = [
  {
    id: 'concise',
    name: '简洁版',
    systemPrompt: '你是一个简洁的助手,3 句话内回答完,代码示例优先。',
    temperature: 0.3,
    color: VARIANT_COLORS[0],
    icon: 'bolt',
  },
  {
    id: 'detailed',
    name: '详细版',
    systemPrompt: '你是一个详尽的助手,先解释思路再给代码,列出所有边界情况。',
    temperature: 0.7,
    color: VARIANT_COLORS[1],
    icon: 'article',
  },
  {
    id: 'creative',
    name: '创造版',
    systemPrompt: '你是一个有创造力的助手,可以用类比和反直觉的角度解释,鼓励新颖解法。',
    temperature: 1.0,
    color: VARIANT_COLORS[2],
    icon: 'auto_awesome',
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
  chat: {
    sessions: any[];
    activeId: string | null;
    settings: any;
    send: (text: string, attachments?: string[]) => Promise<any> | void;
    newSession: () => string;
    setMessages: (sessionId: string, messages: ChatMessage[]) => void;
  };
  initialQuestion?: string;
  initialVariants?: ABTestVariant[];
}

function loadHistory(): ABTestResult[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}
function saveHistory(h: ABTestResult[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(h.slice(0, 30))); } catch { /* ignore */ }
}

export function ABTest({ open, onClose, chat, initialQuestion = '', initialVariants = DEFAULT_VARIANTS }: Props) {
  const [variants, setVariants] = useState<ABTestVariant[]>(initialVariants);
  const [question, setQuestion] = useState(initialQuestion);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Record<string, { content: string; done: boolean; durationMs?: number; tokenCount?: number; error?: string }>>({});
  const [activeResult, setActiveResult] = useState<ABTestResult | null>(null);
  const [history, setHistory] = useState<ABTestResult[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const questionRef = useRef(question);
  questionRef.current = question;

  useEffect(() => { saveHistory(history); }, [history]);

  useEffect(() => {
    if (open && initialQuestion) {
      setQuestion(initialQuestion);
    }
  }, [open, initialQuestion]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !running) {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, running, question, variants]);

  const updateVariant = (id: string, patch: Partial<ABTestVariant>) => {
    setVariants(prev => prev.map(v => v.id === id ? { ...v, ...patch } : v));
  };
  const addVariant = () => {
    if (variants.length >= 4) {
      pushToast({ level: 'warning', title: '最多 4 个变体', duration: 1500 });
      return;
    }
    const idx = variants.length;
    setVariants(prev => [...prev, {
      id: 'v_' + Date.now().toString(36),
      name: `变体 ${idx + 1}`,
      systemPrompt: '',
      temperature: 0.7,
      color: VARIANT_COLORS[idx % VARIANT_COLORS.length],
      icon: VARIANT_ICONS[idx % VARIANT_ICONS.length],
    }]);
  };
  const removeVariant = (id: string) => {
    if (variants.length <= 2) {
      pushToast({ level: 'warning', title: '至少保留 2 个变体', duration: 1500 });
      return;
    }
    setVariants(prev => prev.filter(v => v.id !== id));
  };

  const run = async () => {
    const q = question.trim();
    if (!q) {
      pushToast({ level: 'warning', title: '请输入问题', duration: 1500 });
      return;
    }
    if (running) return;
    setRunning(true);
    setProgress({});
    setActiveResult(null);

    const config: ABTestConfig = { variants: [...variants], question: q, createdAt: Date.now() };

    // 为每个变体创建独立 session 并启动并行回复
    const results: ABTestResult['responses'] = variants.map(v => ({
      variantId: v.id,
      content: '',
      durationMs: 0,
      tokenCount: 0,
      votes: 0,
      winner: false,
      finished: false,
    }));

    // 并行模拟: 每个变体用不同的 systemPrompt + temperature 走一遍
    const startTime = Date.now();
    await Promise.all(variants.map(async (variant) => {
      const variantStart = Date.now();
      try {
        // 模拟流式输出: 拼接生成不同长度的回复
        const length = variant.id === 'concise' ? 0.4 : variant.id === 'detailed' ? 1.2 : 0.9;
        const reply = generateABReply(q, variant);
        const replyLen = Math.floor(reply.length * length);
        const finalReply = reply.slice(0, Math.max(120, replyLen));

        // 模拟 token 流入
        const tokens: string[] = [];
        for (const ch of finalReply) {
          if (/[\s\n]/.test(ch)) {
            if (tokens.length) tokens.push(tokens.pop()! + ch);
            else tokens.push(ch);
          } else {
            tokens.push(ch);
          }
        }

        const idx = results.findIndex(r => r.variantId === variant.id);
        let acc = '';
        const totalDelay = 1200 + Math.random() * 1500;
        const stepDelay = totalDelay / tokens.length;
        for (let i = 0; i < tokens.length; i++) {
          if (!running) return;
          acc += tokens[i];
          setProgress(prev => ({
            ...prev,
            [variant.id]: { ...prev[variant.id], content: acc, done: false },
          }));
          await new Promise(r => setTimeout(r, stepDelay));
        }
        const durationMs = Date.now() - variantStart;
        const tokenCount = tokens.length;
        results[idx] = {
          variantId: variant.id,
          content: acc,
          durationMs,
          tokenCount,
          votes: 0,
          winner: false,
          finished: true,
        };
        setProgress(prev => ({
          ...prev,
          [variant.id]: { content: acc, done: true, durationMs, tokenCount },
        }));
      } catch (err: any) {
        const idx = results.findIndex(r => r.variantId === variant.id);
        results[idx] = {
          ...results[idx],
          finished: true,
          error: err.message || '生成失败',
        };
        setProgress(prev => ({
          ...prev,
          [variant.id]: { ...prev[variant.id], error: err.message, done: true },
        }));
      }
    }));

    const finishedAt = Date.now();
    const result: ABTestResult = { config, responses: results, finishedAt };
    setActiveResult(result);
    setHistory(prev => [result, ...prev].slice(0, 30));
    setRunning(false);
    pushToast({
      level: 'success',
      title: 'A/B 测试完成',
      message: `${results.filter(r => r.finished).length}/${variants.length} 变体已生成`,
      duration: 2000,
    });
  };

  const vote = (variantId: string) => {
    if (!activeResult) return;
    const updated: ABTestResult = {
      ...activeResult,
      responses: activeResult.responses.map(r => ({
        ...r,
        votes: r.variantId === variantId ? r.votes + 1 : r.votes,
        winner: false,
      })),
    };
    setActiveResult(updated);
    setHistory(prev => prev.map(h => h === activeResult ? updated : h));
  };

  const declareWinner = (variantId: string) => {
    if (!activeResult) return;
    const updated: ABTestResult = {
      ...activeResult,
      chosenVariantId: variantId,
      responses: activeResult.responses.map(r => ({ ...r, winner: r.variantId === variantId })),
    };
    setActiveResult(updated);
    setHistory(prev => prev.map(h => h === activeResult ? updated : h));
    const variant = variants.find(v => v.id === variantId);
    pushToast({ level: 'success', title: '已选定胜出者', message: variant?.name, duration: 1500 });
  };

  const loadFromHistory = (h: ABTestResult) => {
    setActiveResult(h);
    setQuestion(h.config.question);
    setVariants(h.config.variants);
    setShowHistory(false);
  };

  const applyWinnerToChat = (variantId: string) => {
    const r = activeResult?.responses.find(x => x.variantId === variantId);
    if (!r) return;
    // 创建一个新 session, 包含用户问题 + 胜出回复
    const id = chat.newSession();
    const userMsg: ChatMessage = {
      id: 'm_' + Date.now().toString(36),
      role: 'user',
      content: question,
      timestamp: Date.now(),
    };
    const replyMsg: ChatMessage = {
      id: 'm_' + (Date.now() + 1).toString(36),
      role: 'assistant',
      content: r.content,
      timestamp: Date.now(),
      model: 'AB-test-winner',
    };
    chat.setMessages(id, [userMsg, replyMsg]);
    pushToast({ level: 'success', title: '已应用到新会话', duration: 1500 });
    onClose();
  };

  const applyVariantAsSystemPrompt = (variantId: string) => {
    const v = variants.find(x => x.id === variantId);
    if (!v?.systemPrompt) return;
    pushToast({
      level: 'info',
      title: '请到 设置 → AI 模型 → 系统提示词 手动应用',
      message: v.name + ' 已复制到剪贴板',
      duration: 3500,
    });
    navigator.clipboard?.writeText(v.systemPrompt);
  };

  // 计算当前 winner (高票者)
  const currentWinner = useMemo(() => {
    if (!activeResult) return null;
    const sorted = [...activeResult.responses].sort((a, b) => b.votes - a.votes);
    return sorted[0]?.votes > 0 ? sorted[0] : null;
  }, [activeResult]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[215] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[1100px] max-w-[96vw] h-[720px] max-h-[92vh] overflow-hidden bg-surface rounded-2xl border border-border shadow-2xl flex flex-col animate-slide-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-border shrink-0">
          <span className="material-symbols-outlined text-primary text-lg">science</span>
          <h3 className="font-display font-semibold text-text">A/B 测试</h3>
          <Badge variant="primary">实验</Badge>
          <span className="text-[10px] text-text-secondary font-mono">
            · 用同一问题并行测试 {variants.length} 个变体
          </span>
          <div className="flex-1" />
          <Tooltip content="历史 (30 条)">
            <IconButton icon="history" size="sm" onClick={() => setShowHistory(s => !s)} />
          </Tooltip>
          <IconButton icon="close" size="sm" onClick={onClose} />
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 左侧: 配置 */}
          <div className="w-[320px] border-r border-border bg-surface-low flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-border-light shrink-0">
              <div className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-1">问题</div>
              <textarea
                value={question}
                onChange={e => setQuestion(e.target.value)}
                disabled={running}
                placeholder="输入要测试的问题..."
                className="w-full h-20 px-2 py-1.5 bg-bg-dim border border-border-light text-xs text-text rounded
                  focus:outline-none focus:border-primary placeholder-text-secondary resize-none font-mono"
              />
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin">
              <div className="px-3 pt-2 pb-1 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
                  变体 ({variants.length}/4)
                </span>
                <Button size="xs" variant="ghost" icon="add" onClick={addVariant} disabled={running}>
                  添加
                </Button>
              </div>
              {variants.map((v, vi) => (
                <VariantEditor
                  key={v.id}
                  variant={v}
                  onChange={(patch) => updateVariant(v.id, patch)}
                  onRemove={() => removeVariant(v.id)}
                  canRemove={variants.length > 2}
                  disabled={running}
                />
              ))}
            </div>

            <div className="px-3 py-2 border-t border-border-light shrink-0">
              <Button
                variant="primary"
                size="sm"
                icon={running ? 'progress_activity' : 'play_arrow'}
                className="w-full"
                disabled={running || !question.trim()}
                onClick={run}
              >
                {running ? '生成中...' : `并行测试 (${variants.length})`}
              </Button>
              <div className="mt-1 text-[10px] text-text-secondary/70 text-center">
                <kbd className="px-1 py-0.5 rounded bg-bg-dim border border-border-light">Ctrl+↵</kbd>
                {' '}快捷运行
              </div>
            </div>
          </div>

          {/* 右侧: 结果 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {showHistory ? (
              <HistoryView
                history={history}
                onLoad={loadFromHistory}
                onDelete={(i) => setHistory(prev => prev.filter((_, idx) => idx !== i))}
              />
            ) : activeResult ? (
              <ResultView
                result={activeResult}
                variants={variants}
                running={running}
                progress={progress}
                onVote={vote}
                onDeclareWinner={declareWinner}
                onApplyToChat={applyWinnerToChat}
                onApplyAsSystem={applyVariantAsSystemPrompt}
                currentWinner={currentWinner}
              />
            ) : (
              <EmptyHint onLoadFromHistory={() => setShowHistory(true)} hasHistory={history.length > 0} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 变体编辑器 ───
function VariantEditor({ variant, onChange, onRemove, canRemove, disabled }: {
  variant: ABTestVariant;
  onChange: (patch: Partial<ABTestVariant>) => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled: boolean;
}) {
  return (
    <div className="mx-3 mb-2 rounded-lg border border-border-light bg-bg-dim/40 overflow-hidden">
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border-light" style={{ borderLeftWidth: 3, borderLeftColor: variant.color, borderLeftStyle: 'solid' }}>
        <span className="material-symbols-outlined text-sm" style={{ color: variant.color }}>{variant.icon}</span>
        <input
          value={variant.name}
          onChange={e => onChange({ name: e.target.value })}
          disabled={disabled}
          className="flex-1 bg-transparent text-[11px] font-semibold text-text outline-none"
        />
        {canRemove && (
          <IconButton icon="close" size="xs" onClick={onRemove} disabled={disabled} />
        )}
      </div>
      <div className="px-2 py-1.5 space-y-1.5">
        <div>
          <div className="text-[9px] text-text-secondary mb-0.5">系统提示词</div>
          <textarea
            value={variant.systemPrompt || ''}
            onChange={e => onChange({ systemPrompt: e.target.value })}
            disabled={disabled}
            rows={3}
            className="w-full px-1.5 py-1 bg-surface border border-border-light text-[10px] text-text rounded
              focus:outline-none focus:border-primary placeholder-text-secondary resize-none font-mono"
            placeholder="(留空则使用默认)"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <div className="text-[9px] text-text-secondary mb-0.5 flex items-center justify-between">
              <span>温度</span>
              <span className="font-mono text-text">{variant.temperature?.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={variant.temperature ?? 0.7}
              onChange={e => onChange({ temperature: Number(e.target.value) })}
              disabled={disabled}
              className="w-full h-1 accent-primary"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 结果视图 ───
function ResultView({ result, variants, running, progress, onVote, onDeclareWinner, onApplyToChat, onApplyAsSystem, currentWinner }: {
  result: ABTestResult;
  variants: ABTestVariant[];
  running: boolean;
  progress: Record<string, { content: string; done: boolean; durationMs?: number; tokenCount?: number; error?: string }>;
  onVote: (id: string) => void;
  onDeclareWinner: (id: string) => void;
  onApplyToChat: (id: string) => void;
  onApplyAsSystem: (id: string) => void;
  currentWinner: any;
}) {
  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin p-3">
      {/* 问题摘要 */}
      <div className="mb-3 px-3 py-2 rounded-lg bg-bg-dim/50 border border-border-light">
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-xs text-text-secondary">help</span>
          <span className="text-[10px] text-text-secondary font-mono">问题</span>
          <span className="text-[10px] text-text-secondary/60">· {new Date(result.config.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
        </div>
        <div className="text-xs text-text">{result.config.question}</div>
      </div>

      {/* 并排卡片 */}
      <div className={`grid gap-3 ${variants.length === 2 ? 'grid-cols-2' : variants.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {variants.map(v => {
          const r = result.responses.find(x => x.variantId === v.id);
          const p = progress[v.id];
          const isWinner = currentWinner?.variantId === v.id;
          const declaredWinner = r?.winner;
          return (
            <div
              key={v.id}
              className={`flex flex-col rounded-lg overflow-hidden border transition-all ${
                declaredWinner
                  ? 'border-success shadow-lg shadow-success/20'
                  : isWinner && currentWinner?.votes >= 2
                    ? 'border-primary'
                    : 'border-border-light'
              }`}
              style={{ borderTopWidth: 3, borderTopColor: v.color, borderTopStyle: 'solid' }}
            >
              {/* header */}
              <div className="px-3 py-2 bg-bg-dim/50 border-b border-border-light flex items-center gap-2">
                <span className="material-symbols-outlined text-sm" style={{ color: v.color }}>{v.icon}</span>
                <span className="text-xs font-semibold text-text flex-1 truncate">{v.name}</span>
                {r && (
                  <>
                    <Tooltip content="投票">
                      <button
                        onClick={() => onVote(v.id)}
                        className="flex items-center gap-0.5 px-1.5 h-5 rounded text-[10px] bg-surface border border-border-light hover:border-primary text-text-secondary hover:text-primary"
                      >
                        <span className="material-symbols-outlined text-xs">thumb_up</span>
                        <span className="font-mono">{r.votes}</span>
                      </button>
                    </Tooltip>
                    {declaredWinner && (
                      <span className="flex items-center gap-0.5 px-1.5 h-5 rounded text-[10px] bg-success/15 text-success border border-success/40 font-mono">
                        <span className="material-symbols-outlined text-xs">emoji_events</span>
                        胜出
                      </span>
                    )}
                  </>
                )}
              </div>

              {/* stats */}
              <div className="px-3 py-1 bg-bg-dim/30 border-b border-border-light flex items-center gap-3 text-[9px] text-text-secondary font-mono">
                <span>T={v.temperature?.toFixed(2)}</span>
                {r?.durationMs != null && <span>{r.durationMs}ms</span>}
                {r?.tokenCount != null && <span>{r.tokenCount} tok</span>}
                {running && !r?.finished && (
                  <span className="flex items-center gap-0.5 text-warning">
                    <span className="material-symbols-outlined text-[10px] animate-spin">progress_activity</span>
                    生成中
                  </span>
                )}
              </div>

              {/* body */}
              <div className="flex-1 p-3 min-h-[200px] text-[11px] text-text whitespace-pre-wrap break-words font-mono leading-relaxed">
                {p?.error ? (
                  <div className="text-danger">❌ {p.error}</div>
                ) : (p?.content || r?.content) ? (
                  <>
                    {(p?.content || r?.content)}
                    {!r?.finished && <span className="inline-block w-1.5 h-3 bg-primary ml-0.5 animate-pulse align-middle" />}
                  </>
                ) : running ? (
                  <div className="text-text-secondary/50 italic">等待生成...</div>
                ) : (
                  <div className="text-text-secondary/50 italic">(空)</div>
                )}
              </div>

              {/* actions */}
              {r?.finished && !running && (
                <div className="px-2 py-1.5 bg-bg-dim/30 border-t border-border-light flex items-center gap-1">
                  <Button size="xs" variant="ghost" icon="thumb_up" onClick={() => onVote(v.id)}>投票</Button>
                  <Button size="xs" variant="ghost" icon="emoji_events" onClick={() => onDeclareWinner(v.id)}>胜出</Button>
                  <Button size="xs" variant="ghost" icon="forum" onClick={() => onApplyToChat(v.id)}>应用</Button>
                  <Button size="xs" variant="ghost" icon="content_copy" onClick={() => {
                    navigator.clipboard?.writeText(r.content);
                    pushToast({ level: 'success', title: '已复制', duration: 1000 });
                  }}>复制</Button>
                  {v.systemPrompt && (
                    <Button size="xs" variant="ghost" icon="auto_fix" onClick={() => onApplyAsSystem(v.id)} title="复制系统提示词到设置">采纳</Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 历史视图 ───
function HistoryView({ history, onLoad, onDelete }: {
  history: ABTestResult[];
  onLoad: (h: ABTestResult) => void;
  onDelete: (i: number) => void;
}) {
  if (history.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-secondary">
        <span className="material-symbols-outlined text-4xl mb-2 opacity-40">history</span>
        <p className="text-xs">暂无 A/B 测试历史</p>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
      {history.map((h, i) => {
        const sorted = [...h.responses].sort((a, b) => b.votes - a.votes);
        const winner = h.chosenVariantId ? h.responses.find(r => r.variantId === h.chosenVariantId) : sorted[0];
        return (
          <div key={i} className="group flex items-start gap-2 px-3 py-2 rounded-lg hover:bg-surface-high transition-colors cursor-pointer" onClick={() => onLoad(h)}>
            <span className="material-symbols-outlined text-sm text-primary mt-0.5 shrink-0">science</span>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-text truncate">{h.config.question}</div>
              <div className="flex items-center gap-2 mt-0.5 text-[9px] text-text-secondary font-mono">
                <span>{new Date(h.config.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                <span>·</span>
                <span>{h.config.variants.length} 变体</span>
                {winner && (
                  <>
                    <span>·</span>
                    <span className="text-success flex items-center gap-0.5">
                      <span className="material-symbols-outlined text-[10px]">emoji_events</span>
                      {h.config.variants.find(v => v.id === winner.variantId)?.name} ({winner.votes} 票)
                    </span>
                  </>
                )}
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(i); }}
              className="material-symbols-outlined text-xs text-text-secondary opacity-0 group-hover:opacity-100 hover:text-danger"
            >delete</button>
          </div>
        );
      })}
    </div>
  );
}

// ─── 空状态 ───
function EmptyHint({ onLoadFromHistory, hasHistory }: { onLoadFromHistory: () => void; hasHistory: boolean }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-text-secondary p-8">
      <span className="material-symbols-outlined text-6xl mb-3 opacity-30">science</span>
      <h3 className="text-sm font-display font-semibold text-text mb-1">A/B 测试你的提示词</h3>
      <p className="text-[11px] text-text-secondary/80 max-w-md text-center leading-relaxed">
        配置 2-4 个变体 (不同 system prompt / 温度),<br />
        同一问题会并行生成,适合对比效果后选出最佳实践。
      </p>
      <div className="mt-4 grid grid-cols-3 gap-2 max-w-md text-[10px]">
        <div className="px-2 py-1.5 rounded bg-bg-dim border border-border-light">
          <span className="material-symbols-outlined text-xs text-primary align-middle">bolt</span>
          <span className="ml-1">并排对比</span>
        </div>
        <div className="px-2 py-1.5 rounded bg-bg-dim border border-border-light">
          <span className="material-symbols-outlined text-xs text-success align-middle">thumb_up</span>
          <span className="ml-1">投票胜出</span>
        </div>
        <div className="px-2 py-1.5 rounded bg-bg-dim border border-border-light">
          <span className="material-symbols-outlined text-xs text-warning align-middle">forum</span>
          <span className="ml-1">应用会话</span>
        </div>
      </div>
      {hasHistory && (
        <Button size="sm" variant="ghost" icon="history" className="mt-4" onClick={onLoadFromHistory}>
          查看历史
        </Button>
      )}
    </div>
  );
}

// ─── Mock 回复生成 ───
function generateABReply(q: string, v: ABTestVariant): string {
  const head = v.id === 'concise'
    ? `**简答**：${q.slice(0, 30)} 的核心是 ...`
    : v.id === 'detailed'
      ? `## 思路分析\n\n针对「${q.slice(0, 40)}」,我从以下角度展开:\n\n1. **背景** — ...\n2. **方案** — ...\n3. **边界** — ...\n\n## 实现\n\n\`\`\`typescript\nfunction example() {\n  // 详细实现\n  return result;\n}\n\`\`\`\n\n## 注意事项\n\n- ...\n- ...`
      : `🤔 想象一下: ${q.slice(0, 20)} 其实像...换个角度看...`;
  return `${head}\n\n---\n模型: ${v.model || 'default'} · 温度 ${v.temperature?.toFixed(2)}\n系统: ${v.systemPrompt?.slice(0, 60)}...`;
}
