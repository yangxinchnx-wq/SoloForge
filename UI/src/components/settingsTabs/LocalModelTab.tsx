import React, { useState, useEffect, useCallback } from 'react';
import {
  Plus, Trash2, FolderOpen, X, Brain, Play, Square, Loader2,
  ChevronDown, RefreshCw,
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

  // 模型选择
  const [selectedPath, setSelectedPath] = useState<string>('');

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

      // 如果有模型已加载，选中它
      if (statusRes.loaded && statusRes.model_path) {
        setSelectedPath(statusRes.model_path);
      }
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
    if (selectedPath === modelPath) setSelectedPath('');
    await refreshModels();
    setInfo('模型已从列表移除');
  };

  const handleDeleteModel = async (modelPath: string) => {
    const modelName = models.find((m) => m.path === modelPath)?.name || modelPath;
    if (!confirm(`确定要删除 "${modelName}" 吗？\n\n这将从列表移除并从磁盘删除文件，不可恢复。`)) return;

    const res = await window.soloforge.localLLM.delete(modelPath);
    if (res.ok) {
      if (selectedPath === modelPath) setSelectedPath('');
      await refreshModels();
      setInfo('模型已删除');
    } else {
      setError(res.error || '删除失败');
    }
  };

  // ── 推理服务启停 ─────────────────────────────────────────

  const handleStartServer = async () => {
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const res = await window.soloforge.localLLM.startServer();
      if (res.ok) {
        setServerRunning(true);
        const statusRes = await window.soloforge.localLLM.status();
        setStatus(statusRes);
        setInfo('推理服务已启动');
      } else {
        setError(res.error || '启动失败');
      }
    } catch (e: any) {
      setError(e.message || '启动失败');
    }
    setLoading(false);
  };

  const handleStopServer = async () => {
    setLoading(true);
    await window.soloforge.localLLM.stopServer();
    setServerRunning(false);
    setStatus(null);
    setSelectedPath('');
    setLoading(false);
    setInfo('推理服务已停止');
  };

  // ── 模型加载 ─────────────────────────────────────────────

  const refreshStatus = async () => {
    const res = await window.soloforge.localLLM.status();
    setStatus(res);
  };

  const handleSelectModel = async (modelPath: string) => {
    if (!modelPath) {
      setSelectedPath('');
      return;
    }
    setSelectedPath(modelPath);

    // 如果服务已运行且当前没有加载模型，自动加载
    if (serverRunning && (!status?.loaded || status.model_path !== modelPath)) {
      await doLoadModel(modelPath);
    }
  };

  const doLoadModel = async (modelPath: string) => {
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const res = await window.soloforge.localLLM.load(modelPath, {
        n_ctx: 4096,
        n_threads: 4,
        n_gpu_layers: 0,
      });
      if (res.ok) {
        await refreshStatus();
        setInfo(`模型 ${res.model_name} 加载成功`);
      } else {
        setError(res.error || '加载失败');
      }
    } catch (e: any) {
      setError(e.message || '加载失败');
    }
    setLoading(false);
  };

  const handleReload = async () => {
    if (!selectedPath) return;
    await doLoadModel(selectedPath);
  };

  // ── 渲染 ────────────────────────────────────────────────────

  const loaded = status?.loaded ?? false;

  return (
    <div className="space-y-5 animate-fadeIn">
      {/* 标题 */}
      <div className="border-b border-[var(--color-outline)]/20 pb-3 mb-2">
        <h3 className="text-base font-bold text-[var(--color-on-surface)]">本地模型管理</h3>
        <p className="text-xs text-on-surface/50 mt-1">
          管理 GGUF 模型文件，启动推理服务后可选择模型加载
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

      {/* 模型选择 + 启停按钮 */}
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <select
            value={selectedPath}
            onChange={(e) => handleSelectModel(e.target.value)}
            disabled={!serverRunning}
            className="w-full appearance-none bg-[var(--color-surface)] border border-[var(--color-outline)]/20 rounded-lg px-3 py-2.5 text-sm text-[var(--color-on-surface)] cursor-pointer hover:border-[var(--color-primary)]/30 transition-all focus:outline-none focus:border-[var(--color-primary)]/50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <option value="">— 选择模型 —</option>
            {models.map((m) => (
              <option key={m.path} value={m.path}>
                {m.name}{m.sizeMb ? ` (${m.sizeMb} MB)` : ''}
              </option>
            ))}
          </select>
          <ChevronDown className="w-4 h-4 text-on-surface/40 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>
        {serverRunning ? (
          <button
            onClick={handleStopServer}
            disabled={loading}
            className="bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/30 active:scale-[0.96] text-red-400 px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 shrink-0"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
            停止
          </button>
        ) : (
          <button
            onClick={handleStartServer}
            disabled={loading}
            className="bg-[var(--color-primary)] hover:opacity-90 active:scale-[0.96] disabled:opacity-50 text-[var(--color-bg)] px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-all cursor-pointer shrink-0"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            启动推理
          </button>
        )}
        {loaded && selectedPath === status?.model_path && (
          <button
            onClick={handleReload}
            disabled={loading}
            className="text-xs text-[var(--color-primary)]/70 hover:text-[var(--color-primary)] disabled:opacity-50 flex items-center gap-1 transition-colors cursor-pointer shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重新加载
          </button>
        )}
      </div>

      {/* ── 模型列表 ── */}
      <div className="space-y-2">
        <span className="text-xs text-[var(--color-primary)] font-mono font-semibold block">添加模型</span>

        {/* 添加模型 */}
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
                  className="p-3 bg-[var(--color-surface)] border border-[var(--color-outline)]/10 rounded-lg flex items-center justify-between hover:border-[var(--color-primary)]/15 transition-all"
                >
                  <div className="flex items-center gap-2.5 flex-1 min-w-0">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${isLoaded ? 'bg-emerald-400' : 'bg-on-surface/20'}`} />
                    <div className="min-w-0">
                      <span className="text-xs font-semibold text-[var(--color-on-surface)] block truncate">
                        {m.name}
                      </span>
                      {m.sizeMb && (
                        <span className="text-xs text-on-surface/30 font-mono tabular-nums">{m.sizeMb} MB</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleRemoveModel(m.path)}
                      className="text-on-surface/30 hover:text-amber-400 p-1.5 rounded transition-colors"
                      title="从列表移除（保留文件）"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDeleteModel(m.path)}
                      className="text-on-surface/30 hover:text-red-400 p-1.5 rounded transition-colors"
                      title="从列表移除并删除文件"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
