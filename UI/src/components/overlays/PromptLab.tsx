// ─────────────────────────────────────────────────────────────────
// 提示词工程实验室 — PromptLab
// - 多模型对比 (Claude / GPT / Gemini / Local)
// - 变量插值与模板版本管理
// - 评分 (人工 + 自动 metrics)
// - A/B 测试与历史回溯
// - 评估数据集管理
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type Model = 'claude-opus-4.7' | 'claude-sonnet-4.5' | 'gpt-4o' | 'gpt-4-turbo' | 'gemini-2.0-pro' | 'llama-3.1-70b' | 'qwen-2.5-72b' | 'mistral-large';
type MetricKey = 'relevance' | 'accuracy' | 'creativity' | 'conciseness' | 'safety';

interface TemplateVersion {
  id: string;
  v: string;          // "v1.0.0"
  content: string;
  author: string;
  created: number;
  changeNote: string;
  score: number;      // 0-100
  runs: number;
}

interface EvalCase {
  id: string;
  input: string;
  expected: string;
  category: 'reasoning' | 'coding' | 'summarization' | 'extraction' | 'creative';
  difficulty: 'easy' | 'medium' | 'hard';
}

interface RunResult {
  id: string;
  templateId: string;
  model: Model;
  output: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  metrics: Record<MetricKey, number>;
  manualScore?: number;
  ts: number;
}

const TEMPLATE_VERSIONS: TemplateVersion[] = [
  { id: 'tv1', v: 'v3.2.0', content: '你是一位资深 {{role}}。\n请基于以下上下文回答问题:\n\n{{context}}\n\n要求:\n1. {{requirement_1}}\n2. {{requirement_2}}\n3. 回答不超过 {{max_words}} 字。\n\n问题: {{question}}', author: 'Alice Chen', created: Date.now() - 86400000 * 2,  changeNote: '修复字数限制不生效问题', score: 92, runs: 1247 },
  { id: 'tv2', v: 'v3.1.0', content: '你是 {{role}}。基于上下文:\n{{context}}\n回答: {{question}}', author: 'Bob Wang',   created: Date.now() - 86400000 * 7,  changeNote: '简化结构', score: 84, runs: 3421 },
  { id: 'tv3', v: 'v3.0.0', content: '{{role}}: {{context}} -> {{question}}',            author: 'Alice Chen', created: Date.now() - 86400000 * 14, changeNote: '初始版本', score: 76, runs: 892 },
  { id: 'tv4', v: 'v3.2.1', content: '你是一位资深 {{role}}。请基于以下上下文回答用户问题。\n\n上下文: {{context}}\n\n约束条件:\n- {{requirement_1}}\n- {{requirement_2}}\n- 字数限制: {{max_words}} 字以内\n\n问题: {{question}}\n\n请直接给出答案。', author: 'Carol Liu',  created: Date.now() - 3600000, changeNote: 'A/B 测试胜出版本', score: 96, runs: 156 },
];

const EVAL_CASES: EvalCase[] = [
  { id: 'c1', input: '什么是量子纠缠?',                  expected: '量子纠缠是...',                category: 'reasoning',     difficulty: 'medium' },
  { id: 'c2', input: '用 Python 写一个快排',              expected: 'def quicksort...',             category: 'coding',        difficulty: 'easy' },
  { id: 'c3', input: '总结: [长文本...]',                  expected: '...',                         category: 'summarization', difficulty: 'hard' },
  { id: 'c4', input: '从合同中提取金额',                   expected: '¥1,000,000',                 category: 'extraction',    difficulty: 'medium' },
  { id: 'c5', input: '为新产品写一句广告语',               expected: '...',                         category: 'creative',      difficulty: 'easy' },
  { id: 'c6', input: '用 Rust 实现 LRU 缓存',              expected: 'use std::collections...',     category: 'coding',        difficulty: 'hard' },
];

const MODEL_LABEL: Record<Model, string> = {
  'claude-opus-4.7':  'Claude Opus 4.7',
  'claude-sonnet-4.5':'Claude Sonnet 4.5',
  'gpt-4o':           'GPT-4o',
  'gpt-4-turbo':      'GPT-4 Turbo',
  'gemini-2.0-pro':   'Gemini 2.0 Pro',
  'llama-3.1-70b':    'Llama 3.1 70B',
  'qwen-2.5-72b':     'Qwen 2.5 72B',
  'mistral-large':    'Mistral Large',
};

const SAMPLE_RUNS: RunResult[] = [
  { id: 'r1', templateId: 'tv4', model: 'claude-opus-4.7',  output: '量子纠缠是指两个粒子在某些性质上关联...',  latencyMs: 2340, tokensIn: 256, tokensOut: 412, costUsd: 0.018, metrics: { relevance: 96, accuracy: 94, creativity: 88, conciseness: 91, safety: 100 }, manualScore: 5, ts: Date.now() - 1800000 },
  { id: 'r2', templateId: 'tv4', model: 'gpt-4o',           output: '量子纠缠是量子力学中的一种现象...',       latencyMs: 1890, tokensIn: 256, tokensOut: 380, costUsd: 0.012, metrics: { relevance: 92, accuracy: 90, creativity: 85, conciseness: 88, safety: 100 }, manualScore: 4, ts: Date.now() - 1500000 },
  { id: 'r3', templateId: 'tv2', model: 'claude-sonnet-4.5',output: '量子纠缠: ...',                            latencyMs: 980,  tokensIn: 80,  tokensOut: 220, costUsd: 0.003, metrics: { relevance: 78, accuracy: 82, creativity: 70, conciseness: 75, safety: 100 }, ts: Date.now() - 7200000 },
  { id: 'r4', templateId: 'tv4', model: 'gemini-2.0-pro',   output: '量子纠缠是当两个或多个粒子...',           latencyMs: 1450, tokensIn: 256, tokensOut: 350, costUsd: 0.007, metrics: { relevance: 88, accuracy: 87, creativity: 82, conciseness: 86, safety: 98 }, manualScore: 4, ts: Date.now() - 3600000 },
];

const VARIABLES = [
  { name: 'role',          sample: '产品经理' },
  { name: 'context',       sample: '我们的产品是一个 AI 编程助手...' },
  { name: 'requirement_1', sample: '使用通俗易懂的语言' },
  { name: 'requirement_2', sample: '提供具体例子' },
  { name: 'max_words',     sample: '300' },
  { name: 'question',      sample: '这个产品有什么核心优势?' },
];

export function PromptLab({ open, onClose }: Props) {
  const [tab, setTab] = useState<'editor' | 'eval' | 'abtest' | 'history'>('editor');
  const [activeVersion, setActiveVersion] = useState<string>(TEMPLATE_VERSIONS[0].id);
  const [activeModel, setActiveModel] = useState<Model>('claude-opus-4.7');
  const [varValues, setVarValues] = useState<Record<string, string>>({
    role: '产品经理',
    context: '我们的产品是一个 AI 编程助手 SoloForge...',
    requirement_1: '使用通俗易懂的语言',
    requirement_2: '提供具体例子',
    max_words: '300',
    question: '这个产品有什么核心优势?',
  });

  const tpl = TEMPLATE_VERSIONS.find(v => v.id === activeVersion) || TEMPLATE_VERSIONS[0];
  const filledPrompt = useMemo(() => {
    let p = tpl.content;
    for (const [k, v] of Object.entries(varValues)) p = p.split(`{{${k}}}`).join(v);
    return p;
  }, [tpl, varValues]);

  if (!open) return null;

  function setVar(name: string, val: string) { setVarValues(s => ({ ...s, [name]: val })); }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">psychology</span>
          <h2 className="text-sm font-semibold text-text">提示词工程实验室</h2>
          <Badge variant="info">{TEMPLATE_VERSIONS.length} 版本</Badge>
          <Badge variant="success">最佳 {tpl.score}/100</Badge>
          <div className="ml-auto flex items-center gap-1">
            <select value={activeModel} onChange={(e) => setActiveModel(e.target.value as Model)} className="bg-bg border border-border-light rounded px-2 h-7 text-[10px]">
              {Object.entries(MODEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <Button size="sm" icon="play_arrow" variant="primary">运行</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'editor',  l: '编辑器' },
            { k: 'eval',    l: `评估 (${EVAL_CASES.length})` },
            { k: 'abtest',  l: 'A/B 测试' },
            { k: 'history', l: `历史 (${SAMPLE_RUNS.length})` },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-64 border-r border-border bg-bg overflow-y-auto p-2">
            <p className="text-[10px] text-text-secondary px-1 mb-1">版本历史</p>
            {TEMPLATE_VERSIONS.map(v => (
              <div key={v.id} onClick={() => setActiveVersion(v.id)}
                className={'p-2 rounded cursor-pointer mb-1 ' + (activeVersion === v.id ? 'bg-accent/15 border border-accent/30' : 'hover:bg-surface-high border border-transparent')}>
                <div className="flex items-center gap-1">
                  <Badge variant={v.score >= 90 ? 'success' : v.score >= 80 ? 'info' : 'warning'}>{v.v}</Badge>
                  <span className="text-[10px] text-text-secondary ml-auto">{v.score}</span>
                </div>
                <p className="text-[10px] text-text mt-1 truncate">{v.changeNote}</p>
                <p className="text-[10px] text-text-secondary mt-0.5">{v.runs.toLocaleString()} 次运行 · {v.author}</p>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'editor' && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-xs font-semibold text-text">{tpl.v} - 模板</h3>
                    <span className="text-[10px] text-text-secondary">by {tpl.author}</span>
                    <span className="text-[10px] text-text-secondary ml-auto">{new Date(tpl.created).toLocaleDateString()}</span>
                  </div>
                  <pre className="bg-surface-high border border-border-light rounded p-3 text-[11px] font-mono text-text whitespace-pre-wrap">{tpl.content}</pre>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">变量 (Variables)</h3>
                    <div className="space-y-2">
                      {VARIABLES.map(v => (
                        <div key={v.name}>
                          <label className="text-[10px] text-accent font-mono block mb-0.5">{`{{${v.name}}}`}</label>
                          {v.name === 'context' || v.name === 'requirement_1' || v.name === 'requirement_2' ? (
                            <textarea value={varValues[v.name]} onChange={(e) => setVar(v.name, e.target.value)} className="w-full bg-surface-high border border-border-light rounded px-2 py-1 text-[11px] h-12 resize-none" />
                          ) : (
                            <input value={varValues[v.name]} onChange={(e) => setVar(v.name, e.target.value)} className="w-full bg-surface-high border border-border-light rounded px-2 h-6 text-[11px]" />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">渲染后 ({MODEL_LABEL[activeModel]})</h3>
                    <pre className="bg-surface-high border border-border-light rounded p-3 text-[11px] font-mono text-text whitespace-pre-wrap h-64 overflow-y-auto">{filledPrompt}</pre>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[10px]">
                      <div className="bg-surface-high rounded p-1.5">
                        <p className="text-text-secondary">Tokens In</p>
                        <p className="text-text font-mono">{Math.ceil(filledPrompt.length / 4)}</p>
                      </div>
                      <div className="bg-surface-high rounded p-1.5">
                        <p className="text-text-secondary">预估成本</p>
                        <p className="text-text font-mono">${(Math.ceil(filledPrompt.length / 4) * 0.000015).toFixed(4)}</p>
                      </div>
                      <div className="bg-surface-high rounded p-1.5">
                        <p className="text-text-secondary">变量数</p>
                        <p className="text-text font-mono">{VARIABLES.length}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}

            {tab === 'eval' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">评估数据集 ({EVAL_CASES.length})</h3>
                <div className="space-y-1.5">
                  {EVAL_CASES.map(c => (
                    <div key={c.id} className="flex items-start gap-3 p-2 bg-surface-high rounded">
                      <Badge variant="info">{c.category}</Badge>
                      <Badge variant={c.difficulty === 'hard' ? 'danger' : c.difficulty === 'medium' ? 'warning' : 'success'}>{c.difficulty}</Badge>
                      <div className="flex-1">
                        <p className="text-[11px] text-text">{c.input}</p>
                        <p className="text-[10px] text-text-secondary mt-0.5">期望: <code className="font-mono">{c.expected}</code></p>
                      </div>
                      <Button size="sm" icon="play_arrow">运行</Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'abtest' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">A/B 测试</h3>
                <div className="grid grid-cols-2 gap-3">
                  {TEMPLATE_VERSIONS.slice(0, 2).map((v, i) => (
                    <div key={v.id} className={'bg-surface-high rounded p-3 border ' + (i === 0 ? 'border-accent' : 'border-info')}>
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant={i === 0 ? 'default' : 'info'}>{i === 0 ? 'A (对照)' : 'B (实验)'}</Badge>
                        <span className="text-[11px] font-semibold text-text">{v.v}</span>
                        <span className="text-[10px] text-text-secondary ml-auto">{v.runs} 样本</span>
                      </div>
                      <pre className="text-[10px] font-mono text-text-secondary bg-bg p-2 rounded max-h-24 overflow-y-auto">{v.content}</pre>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                        <div>
                          <p className="text-text-secondary">转化率</p>
                          <p className="text-text font-mono">{(i === 0 ? 72.4 : 78.9).toFixed(1)}%</p>
                        </div>
                        <div>
                          <p className="text-text-secondary">平均分</p>
                          <p className="text-text font-mono">{(v.score / 20).toFixed(2)}/5</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 bg-success/10 border border-success/30 rounded p-3">
                  <p className="text-[11px] text-text"><span className="material-symbols-outlined text-base align-middle text-success">check_circle</span> B 版本胜出 (p=0.023, 显著性 95%), 建议将 B 设为默认</p>
                </div>
              </div>
            )}

            {tab === 'history' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-2">运行历史</h3>
                <div className="space-y-1.5">
                  {SAMPLE_RUNS.map(r => {
                    const tplV = TEMPLATE_VERSIONS.find(t => t.id === r.templateId);
                    return (
                      <div key={r.id} className="bg-surface-high rounded p-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant="info">{tplV?.v}</Badge>
                          <Badge variant="warning">{MODEL_LABEL[r.model]}</Badge>
                          <span className="text-[10px] text-text-secondary ml-auto">{new Date(r.ts).toLocaleString()}</span>
                        </div>
                        <div className="grid grid-cols-5 gap-1.5 text-[10px] mt-1.5">
                          {Object.entries(r.metrics).map(([k, v]) => (
                            <div key={k} className="bg-bg rounded p-1.5 text-center">
                              <p className="text-text-secondary">{k}</p>
                              <p className="text-text font-mono font-semibold">{v}</p>
                            </div>
                          ))}
                        </div>
                        <div className="mt-1.5 flex items-center gap-3 text-[10px] text-text-secondary">
                          <span>延迟: <span className="text-text font-mono">{r.latencyMs}ms</span></span>
                          <span>Tokens: <span className="text-text font-mono">{r.tokensIn}/{r.tokensOut}</span></span>
                          <span>成本: <span className="text-text font-mono">${r.costUsd.toFixed(4)}</span></span>
                          {r.manualScore !== undefined && <span>人工评分: <span className="text-text font-mono">{'★'.repeat(r.manualScore)}</span></span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
