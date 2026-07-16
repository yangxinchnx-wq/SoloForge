import React, { useState, useEffect, useCallback } from 'react';
import {
  Plus, Trash2, FolderOpen, X, Brain, Play, Square, Loader2,
} from '../../utils/icons';

// ── 类型定义 ──────────────────────────────────────────────────────

interface ModelEntry {
  path: string;
  name: string;
  addedAt: string;
  sizeMb?: number;
}

interface ModelStatus {
  loaded: boolean;
  model_path?: string;
  model_name?: string;
  file_size_mb?: number;
  params?: {
    n_ctx: number;
    n_threads: number;
    n_gpu_layers: number;
  };
}

// ── 组件 ──────────────────────────────────────────────────────────

export default function LocalModelTab() {
  // 模型列表
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [newModelPath, setNewModelPath] = useState('');

  // 服务状态
  const [serverRunning, setServerRunning] = useState(false);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // ── 初始化 ──────────────────────────────────────────────────

  const initialize = useCallback(async () => {
    try {
      const { running } = await window.soloforge.localLLM.serverRunning();
      setServerRunning(running);

      const [listRes, statusRes] = await Promise.all([
        window.soloforge.localLLM.list(),
        running ? window.soloforge.localLLM.status() : Promise.resolve({ loaded: false }),
      ]);
      setModels(listRes.models || []);
      setStatus(statusRes);
    } catch (e) {
      console.error('[LocalModelTab] init failed:', e);
    }
  }, []);

  useEffect(() => {
    initialize();
  }, [initialize]);

  // ── 模型列表 CRUD ───────────────────────────────────────────

  const refreshModels = async () => {
    const res = await window.soloforge.localLLM.list();
    setModels(res.models || []);
  };

  const refreshStatus = async () => {
    const res = await window.soloforge.localLLM.status();
    setStatus(res);
  };

  const handleBrowse = async () => {
    const res = await window.soloforge.localLLM.browse();
    if (res.ok && res.path) {
      setNewModelPath(res.path);
    }
  };

  const handleAddModel = async () => {
    if (!newModelPath.trim()) return;
    setError(null);
    const res = await window.soloforge.localLLM.add(newModelPath.trim());
    if (res.ok) {
      setNewModelPath('');
      await refreshModels();
      setInfo('模型已添加');
    } else {
      setError(res.error || '添加失败');
    }
  };

  const handleRemoveModel = async (modelPath: string) => {
    await window.soloforge.localLLM.remove(modelPath);
    await refreshModels();
    setInfo('模型已从列表移除');
  };

  const handleDeleteModel = async (modelPath: string) => {
    const modelName = models.find((m) => m.path === modelPath)?.name || modelPath;
    if (!confirm(`确定要删除 "${modelName}" 吗？\n\n这将从列表移除并从磁盘删除文件，不可恢复。`)) return;

    const res = await window.soloforge.localLLM.delete(modelPath);
    if (res.ok) {
      await refreshModels();
      setInfo('模型已删除');
    } else {
      setError(res.error || '删除失败');
    }
  };

  // ── 模型启停（开关） ──────────────────────────────────────

  const handleToggleModel = async (modelPath: string) => {
    const isThisLoaded = loaded && status?.model_path === modelPath;

    if (isThisLoaded) {
      // 停止：卸载模型 + 停止服务
      setLoading(true);
      await window.soloforge.localLLM.stopServer();
      setServerRunning(false);
      setStatus(null);
      setLoading(false);
      setInfo('推理服务已停止');
    } else {
      // 启动：如果服务未运行，先启动
      setLoading(true);
      setError(null);
      setInfo(null);
      try {
        if (!serverRunning) {
          const startRes = await window.soloforge.localLLM.startServer();
          if (!startRes.ok) {
            setError(startRes.error || '启动失败');
            setLoading(false);
            return;
          }
          setServerRunning(true);
        }
        // 加载模型
        const loadRes = await window.soloforge.localLLM.load(modelPath, {
          n_ctx: 4096,
          n_threads: 4,
          n_gpu_layers: 0,
        });
        if (loadRes.ok) {
          await refreshStatus();
          setInfo(`模型 ${loadRes.model_name} 加载成功`);
        } else {
          setError(loadRes.error || '加载失败');
        }
      } catch (e: any) {
        setError(e.message || '操作失败');
      }
      setLoading(false);
    }
  };

  // ── 渲染 ────────────────────────────────────────────────────

  const loaded = status?.loaded ?? false;

  return (
    <div className="space-y-5 animate-fadeIn">
      {/* 标题 */}
      <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
        <h3 className="text-base font-bold text-[var(--color-on-surface)]">本地模型管理</h3>
        <p className="text-xs text-on-surface/50 mt-1">
          管理 GGUF 模型文件，点击模型右侧开关启停推理
        </p>
      </div>

      {/* 错误 / 信息提示 */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
          <X className="w-4 h-4 text-red-400 shrink-0" />
          <span className="text-xs text-red-400 flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400/50 hover:text-red-400">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {info && !error && (
        <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
          <span className="text-xs text-emerald-400 flex-1">{info}</span>
          <button onClick={() => setInfo(null)} className="text-emerald-400/50 hover:text-emerald-400">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 推理服务状态 */}
      <div className="flex items-center gap-2">
        <Brain className="w-4 h-4 text-on-surface/40" />
        <span className="text-sm text-[var(--color-on-surface)]">推理服务</span>
        <span className={`text-xs font-mono tabular-nums ml-auto ${serverRunning ? 'text-emerald-400' : 'text-on-surface/30'}`}>
          {serverRunning
            ? `运行中${loaded ? ` · ${status?.model_name}` : ''}`
            : '未启动'}
        </span>
      </div>

      {/* 添加模型 */}
      <div className="space-y-2">
        <span className="text-xs text-[var(--color-primary)] font-mono font-semibold block">添加模型</span>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newModelPath}
            onChange={(e) => setNewModelPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddModel(); }}
            placeholder="输入 GGUF 模型文件路径..."
            className="flex-1 bg-[var(--color-surface)] border border-[var(--color-outline)]/15 rounded-lg px-3 py-2 text-xs text-[var(--color-on-surface)] focus:outline-none focus:border-[var(--color-primary)]/30 transition-all"
          />
          <button
            onClick={handleBrowse}
            className="bg-[var(--color-surface)] border border-[var(--color-outline)]/15 hover:border-[var(--color-primary)]/30 text-[var(--color-on-surface)]/60 hover:text-[var(--color-primary)] px-3 py-2 rounded-lg transition-all cursor-pointer"
            title="浏览文件"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleAddModel}
            disabled={!newModelPath.trim()}
            className="bg-[var(--color-primary)] hover:opacity-90 active:scale-[0.96] disabled:opacity-30 text-[var(--color-bg)] px-3 py-2 rounded-lg transition-all cursor-pointer"
            title="添加模型"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 模型列表 */}
        {models.length === 0 ? (
          <p className="text-xs text-on-surface/30 text-center py-4">
            还没有添加模型，请输入路径或点击浏览按钮
          </p>
        ) : (
          <div className="space-y-1.5">
            {models.map((m) => {
              const isLoaded = loaded && status?.model_path === m.path;
              return (
                <div
                  key={m.path}
                  className="p-2.5 bg-[var(--color-surface)] border border-[var(--color-outline)]/10 rounded-lg flex items-center gap-2.5 hover:border-[var(--color-primary)]/15 transition-all"
                >
                  <button
                    onClick={() => handleToggleModel(m.path)}
                    disabled={loading}
                    className={`shrink-0 p-1 rounded transition-colors cursor-pointer disabled:opacity-50 ${
                      isLoaded
                        ? 'text-emerald-400 hover:text-emerald-300'
                        : 'text-on-surface/30 hover:text-[var(--color-primary)]'
                    }`}
                    title={isLoaded ? '停止推理' : '启动推理'}
                  >
                    {loading && (isLoaded || (!loaded && !serverRunning))
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : isLoaded
                        ? <Square className="w-4 h-4" />
                        : <Play className="w-4 h-4" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-semibold text-[var(--color-on-surface)] block truncate">
                      {m.name}
                    </span>
                    {m.sizeMb && (
                      <span className="text-xs text-on-surface/30 font-mono tabular-nums">{m.sizeMb} MB</span>
                    )}
                  </div>
                  <button
                    onClick={() => handleRemoveModel(m.path)}
                    className="text-on-surface/25 hover:text-amber-400 p-1 rounded transition-colors shrink-0"
                    title="从列表移除（保留文件）"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDeleteModel(m.path)}
                    className="text-on-surface/25 hover:text-red-400 p-1 rounded transition-colors shrink-0"
                    title="从列表移除并删除文件"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
