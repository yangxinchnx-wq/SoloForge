// ─────────────────────────────────────────────────────────────────
// 模型注册中心 — ModelRegistry
// - 模型注册与版本管理
// - 训练指标追踪
// - 推理性能监控
// - 模型血缘 (Lineage) 与依赖
// - 部署阶段 (dev/staging/prod)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props { open: boolean; onClose: () => void; }

type Stage = 'development' | 'staging' | 'production' | 'archived';
type Framework = 'pytorch' | 'tensorflow' | 'jax' | 'onnx' | 'sklearn' | 'huggingface';

interface ModelVersion {
  id: string;
  modelName: string;
  version: string;
  framework: Framework;
  stage: Stage;
  size: number;        // MB
  created: number;
  author: string;
  metrics: { accuracy: number; f1: number; loss: number; latencyP99: number; throughput: number };
  trainingData: { dataset: string; rows: number; features: number };
  parentVersion?: string;
  tags: string[];
  description: string;
}

const MODELS: ModelVersion[] = [
  { id: 'm1', modelName: 'sentiment-classifier', version: 'v3.2.0', framework: 'pytorch', stage: 'production', size: 412, created: Date.now() - 86400000 * 5,
    author: 'Alice Chen',
    metrics: { accuracy: 0.943, f1: 0.928, loss: 0.087, latencyP99: 45, throughput: 2400 },
    trainingData: { dataset: 'reviews-2026', rows: 1240000, features: 768 },
    parentVersion: 'v3.1.0',
    tags: ['sentiment', 'chinese', 'bert-base'],
    description: '基于 RoBERTa 的中文情感分类模型,准确率较 v3.1 提升 2.3%' },
  { id: 'm2', modelName: 'sentiment-classifier', version: 'v3.1.0', framework: 'pytorch', stage: 'archived', size: 408, created: Date.now() - 86400000 * 32,
    author: 'Alice Chen',
    metrics: { accuracy: 0.920, f1: 0.905, loss: 0.112, latencyP99: 52, throughput: 2200 },
    trainingData: { dataset: 'reviews-2025', rows: 980000, features: 768 },
    parentVersion: 'v3.0.0',
    tags: ['sentiment', 'chinese', 'bert-base'],
    description: '上一版生产模型' },
  { id: 'm3', modelName: 'sentiment-classifier', version: 'v3.3.0-rc', framework: 'pytorch', stage: 'staging', size: 415, created: Date.now() - 86400000 * 2,
    author: 'Alice Chen',
    metrics: { accuracy: 0.951, f1: 0.939, loss: 0.071, latencyP99: 42, throughput: 2350 },
    trainingData: { dataset: 'reviews-2026-q2', rows: 1450000, features: 768 },
    parentVersion: 'v3.2.0',
    tags: ['sentiment', 'chinese', 'roberta-large'],
    description: '候选发布,使用更大模型 + 更多数据' },
  { id: 'm4', modelName: 'recommender-llm', version: 'v2.1.0', framework: 'huggingface', stage: 'production', size: 14200, created: Date.now() - 86400000 * 7,
    author: 'Bob Wang',
    metrics: { accuracy: 0.872, f1: 0.854, loss: 0.142, latencyP99: 320, throughput: 180 },
    trainingData: { dataset: 'user-clicks-2026', rows: 5600000, features: 1536 },
    tags: ['recommendation', 'llm', 'personalization'],
    description: '基于 Qwen-7B 微调的推荐模型' },
  { id: 'm5', modelName: 'recommender-llm', version: 'v2.2.0-rc', framework: 'huggingface', stage: 'development', size: 14300, created: Date.now() - 3600000,
    author: 'Bob Wang',
    metrics: { accuracy: 0.891, f1: 0.876, loss: 0.128, latencyP99: 280, throughput: 210 },
    trainingData: { dataset: 'user-clicks-2026-q2', rows: 6200000, features: 1536 },
    parentVersion: 'v2.1.0',
    tags: ['recommendation', 'llm', 'qwen-7b', 'experimental'],
    description: '添加 RLHF 反馈循环' },
  { id: 'm6', modelName: 'fraud-detector', version: 'v1.4.0', framework: 'sklearn', stage: 'production', size: 12, created: Date.now() - 86400000 * 14,
    author: 'Carol Liu',
    metrics: { accuracy: 0.967, f1: 0.943, loss: 0.082, latencyP99: 8, throughput: 12000 },
    trainingData: { dataset: 'transactions-2025', rows: 8900000, features: 32 },
    tags: ['fraud', 'xgboost', 'finance'],
    description: 'XGBoost 欺诈检测模型' },
  { id: 'm7', modelName: 'image-segmenter', version: 'v0.9.0', framework: 'pytorch', stage: 'development', size: 256, created: Date.now() - 86400000,
    author: 'David Zhang',
    metrics: { accuracy: 0.812, f1: 0.781, loss: 0.243, latencyP99: 180, throughput: 80 },
    trainingData: { dataset: 'coco-mini', rows: 50000, features: 3 },
    tags: ['vision', 'segmentation', 'unet'],
    description: 'UNet 图像分割实验' },
  { id: 'm8', modelName: 'text-embedder', version: 'v1.2.0', framework: 'onnx', stage: 'production', size: 412, created: Date.now() - 86400000 * 21,
    author: 'Eve',
    metrics: { accuracy: 0.892, f1: 0, loss: 0.045, latencyP99: 25, throughput: 4500 },
    trainingData: { dataset: 'multilingual-corpora', rows: 12000000, features: 768 },
    tags: ['embedding', 'multilingual', 'fasttext'],
    description: 'BGE ONNX 导出版,低延迟推理' },
];

function stageColor(s: Stage): 'success' | 'info' | 'warning' | 'default' {
  return s === 'production' ? 'success' : s === 'staging' ? 'info' : s === 'development' ? 'warning' : 'default';
}
function frameworkLabel(f: Framework): string {
  return { pytorch: 'PyTorch', tensorflow: 'TensorFlow', jax: 'JAX', onnx: 'ONNX', sklearn: 'scikit-learn', huggingface: 'HuggingFace' }[f];
}

export function ModelRegistry({ open, onClose }: Props) {
  const [tab, setTab] = useState<'registry' | 'detail' | 'lineage' | 'monitoring'>('registry');
  const [stageFilter, setStageFilter] = useState<Stage | 'all'>('all');
  const [activeModelId, setActiveModelId] = useState<string>(MODELS[0].id);
  const activeModel = MODELS.find(m => m.id === activeModelId) || MODELS[0];

  const filtered = stageFilter === 'all' ? MODELS : MODELS.filter(m => m.stage === stageFilter);
  const modelNames = Array.from(new Set(MODELS.map(m => m.modelName)));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-[1280px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">deployed_code</span>
          <h2 className="text-sm font-semibold text-text">模型注册中心</h2>
          <Badge variant="info">{MODELS.length} 版本</Badge>
          <Badge variant="success">{MODELS.filter(m => m.stage === 'production').length} 生产</Badge>
          <Badge variant="info">{MODELS.filter(m => m.stage === 'staging').length} 预发</Badge>
          <Badge variant="info">{modelNames.length} 模型</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" icon="upload" variant="primary">注册新模型</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="px-3 py-1 border-b border-border bg-bg flex items-center gap-1">
          {([
            { k: 'registry',   l: `注册表 (${MODELS.length})` },
            { k: 'detail',     l: '版本详情' },
            { k: 'lineage',    l: '血缘关系' },
            { k: 'monitoring', l: '推理监控' },
          ] as const).map(t => (
            <button key={t.k} onClick={() => setTab(t.k)} className={'px-3 h-6 rounded text-[10px] ' + (tab === t.k ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-high')}>{t.l}</button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="w-72 border-r border-border bg-bg overflow-y-auto">
            <div className="px-3 py-2 border-b border-border-light">
              <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value as any)} className="w-full bg-bg border border-border-light rounded px-2 h-6 text-[10px]">
                <option value="all">所有阶段</option>
                <option value="development">开发</option>
                <option value="staging">预发</option>
                <option value="production">生产</option>
                <option value="archived">归档</option>
              </select>
            </div>
            {filtered.map(m => (
              <div key={m.id} onClick={() => { setActiveModelId(m.id); setTab('detail'); }}
                className={'px-3 py-2 border-b border-border-light cursor-pointer hover:bg-surface-high ' + (activeModelId === m.id ? 'bg-accent/10 border-l-2 border-l-accent' : '')}>
                <div className="flex items-center gap-1 mb-1">
                  <Badge variant={stageColor(m.stage)}>{m.stage}</Badge>
                  <code className="text-[10px] font-mono text-text-secondary">{m.version}</code>
                </div>
                <div className="text-[11px] font-medium text-text truncate">{m.modelName}</div>
                <div className="text-[10px] text-text-secondary mt-0.5 flex items-center gap-2">
                  <span>{frameworkLabel(m.framework)}</span>
                  <span>·</span>
                  <span>{m.size} MB</span>
                  <span>·</span>
                  <span className="text-success font-mono">acc {(m.metrics.accuracy * 100).toFixed(1)}%</span>
                </div>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {tab === 'registry' && (
              <div className="space-y-3">
                {modelNames.map(name => {
                  const versions = MODELS.filter(m => m.modelName === name);
                  return (
                    <div key={name} className="bg-bg border border-border-light rounded-lg p-3">
                      <h3 className="text-sm font-semibold text-text mb-2">{name}</h3>
                      <div className="space-y-1.5">
                        {versions.map(v => (
                          <div key={v.id} onClick={() => { setActiveModelId(v.id); setTab('detail'); }} className="flex items-center gap-2 p-2 bg-surface-high rounded cursor-pointer hover:border-accent border border-transparent">
                            <Badge variant={stageColor(v.stage)}>{v.stage}</Badge>
                            <code className="text-[11px] font-mono text-text">{v.version}</code>
                            <span className="text-[10px] text-text-secondary">{frameworkLabel(v.framework)}</span>
                            <span className="text-[10px] text-text-secondary ml-auto">{v.author}</span>
                            <span className="text-[10px] text-text-secondary">{new Date(v.created).toLocaleDateString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {tab === 'detail' && activeModel && (
              <>
                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant={stageColor(activeModel.stage)}>{activeModel.stage}</Badge>
                    <code className="text-base font-mono font-bold text-text">{activeModel.modelName}</code>
                    <Badge variant="info">{activeModel.version}</Badge>
                    <span className="text-[10px] text-text-secondary ml-auto">{new Date(activeModel.created).toLocaleString()}</span>
                  </div>
                  <p className="text-[11px] text-text-secondary mb-3">{activeModel.description}</p>
                  <div className="grid grid-cols-4 gap-3 text-[11px]">
                    <div><p className="text-[10px] text-text-secondary">作者</p><p className="text-text">{activeModel.author}</p></div>
                    <div><p className="text-[10px] text-text-secondary">框架</p><p className="text-text">{frameworkLabel(activeModel.framework)}</p></div>
                    <div><p className="text-[10px] text-text-secondary">大小</p><p className="text-text font-mono">{activeModel.size} MB</p></div>
                    <div><p className="text-[10px] text-text-secondary">父版本</p><code className="text-text text-[10px]">{activeModel.parentVersion || '无'}</code></div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {activeModel.tags.map(t => <Badge key={t} variant="default">{t}</Badge>)}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">训练指标</h3>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-surface-high rounded p-2">
                        <p className="text-[10px] text-text-secondary">Accuracy</p>
                        <p className="text-lg font-bold text-text font-mono">{(activeModel.metrics.accuracy * 100).toFixed(2)}%</p>
                      </div>
                      <div className="bg-surface-high rounded p-2">
                        <p className="text-[10px] text-text-secondary">F1 Score</p>
                        <p className="text-lg font-bold text-text font-mono">{activeModel.metrics.f1 > 0 ? activeModel.metrics.f1.toFixed(3) : 'N/A'}</p>
                      </div>
                      <div className="bg-surface-high rounded p-2">
                        <p className="text-[10px] text-text-secondary">Loss</p>
                        <p className="text-lg font-bold text-text font-mono">{activeModel.metrics.loss.toFixed(3)}</p>
                      </div>
                      <div className="bg-surface-high rounded p-2">
                        <p className="text-[10px] text-text-secondary">数据集</p>
                        <p className="text-[11px] text-text font-mono">{activeModel.trainingData.dataset}</p>
                      </div>
                    </div>
                  </div>
                  <div className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-text mb-2">推理性能</h3>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-surface-high rounded p-2">
                        <p className="text-[10px] text-text-secondary">P99 延迟</p>
                        <p className="text-lg font-bold text-text font-mono">{activeModel.metrics.latencyP99}ms</p>
                      </div>
                      <div className="bg-surface-high rounded p-2">
                        <p className="text-[10px] text-text-secondary">吞吐量</p>
                        <p className="text-lg font-bold text-text font-mono">{activeModel.metrics.throughput} qps</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-bg border border-border-light rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-text mb-2">训练数据</h3>
                  <div className="grid grid-cols-3 gap-3 text-[11px]">
                    <div>
                      <p className="text-[10px] text-text-secondary">数据集</p>
                      <code className="text-text font-mono">{activeModel.trainingData.dataset}</code>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary">样本数</p>
                      <p className="text-text font-mono">{activeModel.trainingData.rows.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-text-secondary">特征数</p>
                      <p className="text-text font-mono">{activeModel.trainingData.features}</p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button size="sm" icon="arrow_upward">提升到生产</Button>
                  <Button size="sm" icon="science">A/B 测试</Button>
                  <Button size="sm" icon="download">下载权重</Button>
                  <Button size="sm" icon="code">推理代码</Button>
                  <Button size="sm" icon="delete" variant="danger">归档</Button>
                </div>
              </>
            )}

            {tab === 'lineage' && (
              <div className="bg-bg border border-border-light rounded-lg p-3">
                <h3 className="text-xs font-semibold text-text mb-3">模型血缘 (Lineage)</h3>
                <svg viewBox="0 0 800 400" className="w-full bg-surface-high rounded" style={{ minHeight: 400 }}>
                  {[
                    { x: 100, y: 50,  label: 'v3.0.0', stage: 'archived',  desc: '初始版本' },
                    { x: 100, y: 150, label: 'v3.1.0', stage: 'archived',  desc: '数据扩充' },
                    { x: 100, y: 250, label: 'v3.2.0', stage: 'production',desc: '当前生产' },
                    { x: 100, y: 350, label: 'v3.3.0-rc', stage: 'staging', desc: '候选' },
                    { x: 400, y: 150, label: 'v2.1.0', stage: 'production',desc: '推荐模型' },
                    { x: 400, y: 250, label: 'v2.2.0-rc', stage: 'development',desc: '实验' },
                    { x: 700, y: 50,  label: 'v1.4.0', stage: 'production',desc: '欺诈检测' },
                    { x: 700, y: 150, label: 'v1.2.0', stage: 'production',desc: '文本嵌入' },
                    { x: 700, y: 350, label: 'v0.9.0', stage: 'development',desc: '图像分割' },
                  ].map((n, i) => (
                    <g key={i}>
                      <rect x={n.x - 60} y={n.y - 22} width="120" height="44" rx="4"
                        fill={n.stage === 'production' ? 'rgba(34,197,94,0.2)' : n.stage === 'staging' ? 'rgba(59,130,246,0.2)' : 'rgba(156,163,175,0.2)'}
                        stroke={n.stage === 'production' ? '#16a34a' : n.stage === 'staging' ? '#3b82f6' : '#9ca3af'}
                        strokeWidth="1.5" />
                      <text x={n.x} y={n.y - 6} fontSize="10" fill="#1f2937" textAnchor="middle" fontWeight="600">{n.label}</text>
                      <text x={n.x} y={n.y + 8} fontSize="8" fill="#6b7280" textAnchor="middle">{n.desc}</text>
                    </g>
                  ))}
                  {/* Arrows showing lineage */}
                  <line x1="100" y1="50"  x2="100" y2="130" stroke="#9ca3af" strokeWidth="1.5" markerEnd="url(#arrowhead)" />
                  <line x1="100" y1="150" x2="100" y2="230" stroke="#9ca3af" strokeWidth="1.5" markerEnd="url(#arrowhead)" />
                  <line x1="100" y1="250" x2="100" y2="330" stroke="#9ca3af" strokeWidth="1.5" markerEnd="url(#arrowhead)" strokeDasharray="3 3" />
                  <line x1="400" y1="150" x2="400" y2="230" stroke="#9ca3af" strokeWidth="1.5" markerEnd="url(#arrowhead)" strokeDasharray="3 3" />
                  <defs>
                    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
                      <polygon points="0 0, 10 3, 0 6" fill="#9ca3af" />
                    </marker>
                  </defs>
                </svg>
              </div>
            )}

            {tab === 'monitoring' && (
              <div className="grid grid-cols-2 gap-3">
                {MODELS.filter(m => m.stage === 'production').map(m => (
                  <div key={m.id} className="bg-bg border border-border-light rounded-lg p-3">
                    <h3 className="text-sm font-semibold text-text mb-1">{m.modelName} {m.version}</h3>
                    <p className="text-[10px] text-text-secondary mb-2">推理实时监控</p>
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div className="bg-surface-high rounded p-1.5">
                        <p className="text-[10px] text-text-secondary">QPS</p>
                        <p className="text-text font-mono">{(m.metrics.throughput * (0.5 + Math.random())).toFixed(0)}</p>
                      </div>
                      <div className="bg-surface-high rounded p-1.5">
                        <p className="text-[10px] text-text-secondary">错误率</p>
                        <p className="text-text font-mono">{(Math.random() * 0.02).toFixed(3)}%</p>
                      </div>
                      <div className="bg-surface-high rounded p-1.5">
                        <p className="text-[10px] text-text-secondary">P50 延迟</p>
                        <p className="text-text font-mono">{Math.round(m.metrics.latencyP99 * 0.4)}ms</p>
                      </div>
                      <div className="bg-surface-high rounded p-1.5">
                        <p className="text-[10px] text-text-secondary">数据漂移</p>
                        <p className="text-text font-mono">{(Math.random() * 0.1).toFixed(3)}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
