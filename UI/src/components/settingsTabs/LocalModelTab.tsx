import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus, Trash2, FolderOpen, X, Brain, Play, Square, Loader2,
  Globe, Copy, CheckCircle2, Network,
} from '../../utils/icons';
import { ToggleSwitch } from '../header-bar/ToggleSwitch';
import { toLocalModelId } from '../../utils/localModelName';

// ── cherry_providers_v2 注入/注销 ──────────────────────────────

const LOCAL_PROVIDER_ID = 'local-llm';
const LOCAL_API_KEY = 'local';

/**
 * 将本地已加载模型注册到 cherry_providers_v2，使主模型选择器可见
 * 在 HTTP 服务器启动后调用 — 因为 baseUrl 指向的就是那个 HTTP 端口
 */
function registerLocalModel(modelPath: string, modelId: string, port: number) {
  try {
    const saved = localStorage.getItem('cherry_providers_v2');
    const providers = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(providers)) return;

    const baseUrl = `http://127.0.0.1:${port}/v1`;

    // 查找或创建 local provider
    let prov = providers.find((p: any) => p.id === LOCAL_PROVIDER_ID);
    if (!prov) {
      prov = {
        id: LOCAL_PROVIDER_ID,
        name: '本地推理',
        desc: '本地 GGUF 模型 (llama.cpp)',
        enabled: true,
        apiKey: LOCAL_API_KEY,
        baseUrl,
        defaultUrl: baseUrl,
        models: [],
        customModels: [],
        status: 'success',
        color: '#4ECDC4',
        iconType: 'animal:owl',
      };
      providers.push(prov);
    }

    // 更新 baseUrl (端口可能变了)
    prov.baseUrl = baseUrl;
    prov.defaultUrl = baseUrl;
    prov.enabled = true;
    prov.status = 'success';
    prov.apiKey = LOCAL_API_KEY;

    // 添加模型 (去重)
    if (!prov.models.some((m: any) => m.id === modelId)) {
      prov.models.push({ id: modelId, name: modelId, enabled: true });
    }
    // 确保已有模型已启用
    prov.models = prov.models.map((m: any) =>
      m.id === modelId ? { ...m, enabled: true } : m
    );

    localStorage.setItem('cherry_providers_v2', JSON.stringify(providers));
    window.dispatchEvent(new CustomEvent('providers_updated'));
  } catch (e) {
    console.error('[LocalModelTab] registerLocalModel failed:', e);
  }
}

/**
 * 清理所有残留的本地模型注册（应用重启后后端可能未运行）
 * 在 initialize() 中，如果服务未运行则调用
 */
function cleanupStaleLocalModels() {
  try {
    const saved = localStorage.getItem('cherry_providers_v2');
    if (!saved) return;
    const providers = JSON.parse(saved);
    if (!Array.isArray(providers)) return;

    const idx = providers.findIndex((p: any) => p.id === LOCAL_PROVIDER_ID);
    if (idx >= 0) {
      providers.splice(idx, 1);
      localStorage.setItem('cherry_providers_v2', JSON.stringify(providers));
      window.dispatchEvent(new CustomEvent('providers_updated'));
    }
  } catch (e) {
    console.error('[LocalModelTab] cleanupStaleLocalModels failed:', e);
  }
}

/**
 * 从 cherry_providers_v2 注销本地模型
 * 在 HTTP 服务器停止 / 模型卸载时调用
 */
function unregisterLocalModel(modelId: string) {
  try {
    const saved = localStorage.getItem('cherry_providers_v2');
    if (!saved) return;
    const providers = JSON.parse(saved);
    if (!Array.isArray(providers)) return;

    const prov = providers.find((p: any) => p.id === LOCAL_PROVIDER_ID);
    if (!prov) return;

    // 移除该模型
    prov.models = (prov.models || []).filter((m: any) => m.id !== modelId);

    // 如果没有模型了，移除整个 provider
    if (prov.models.length === 0) {
      const idx = providers.indexOf(prov);
      if (idx >= 0) providers.splice(idx, 1);
    }

    localStorage.setItem('cherry_providers_v2', JSON.stringify(providers));
    window.dispatchEvent(new CustomEvent('providers_updated'));
  } catch (e) {
    console.error('[LocalModelTab] unregisterLocalModel failed:', e);
  }
}

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

interface HttpServerInfo {
  running: boolean;
  host: string;
  port: number;
  lanIP: string;
  url: string | null;
  localUrl: string | null;
  requestCount: number;
  modelLoaded: boolean;
  modelName: string | null;
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

  // HTTP 服务器 (模型加载后自动启动, 127.0.0.1)
  const [httpRunning, setHttpRunning] = useState(false);
  const [lanExposed, setLanExposed] = useState(false); // 0.0.0.0 vs 127.0.0.1
  const [httpPort, setHttpPort] = useState(8768);
  const [httpInfo, setHttpInfo] = useState<HttpServerInfo | null>(null);
  const [httpLoading, setHttpLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const httpPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── 初始化 ──────────────────────────────────────────────────

  const _startHttpPolling = useCallback(() => {
    if (httpPollRef.current) clearInterval(httpPollRef.current);
    httpPollRef.current = setInterval(async () => {
      try {
        const info = await window.soloforge.localLLM.getHttpServerInfo();
        setHttpInfo(info);
      } catch {}
    }, 2000);
  }, []);

  const _stopHttpPolling = useCallback(() => {
    if (httpPollRef.current) {
      clearInterval(httpPollRef.current);
      httpPollRef.current = null;
    }
  }, []);

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

      // 检查 HTTP 服务器状态
      if (running) {
        const httpInfo = await window.soloforge.localLLM.getHttpServerInfo();
        setHttpInfo(httpInfo);
        setHttpRunning(httpInfo.running);
        if (httpInfo.running) {
          setHttpPort(httpInfo.port);
          setLanExposed(httpInfo.host === '0.0.0.0');
          _startHttpPolling();
        } else if (statusRes.loaded && statusRes.model_path) {
          // 模型已加载但 HTTP 未运行 — 补启动 (兼容旧版本残留状态)
          const httpRes = await window.soloforge.localLLM.startHttpServer('127.0.0.1', 8768);
          if (httpRes.ok) {
            setHttpRunning(true);
            setLanExposed(false);
            setHttpPort(httpRes.port);
            const info = await window.soloforge.localLLM.getHttpServerInfo();
            setHttpInfo(info);
            _startHttpPolling();
            const modelId = toLocalModelId(statusRes.model_path);
            registerLocalModel(statusRes.model_path, modelId, httpRes.port);
          }
        }
      } else {
        // 服务未运行 — 清除残留的本地模型注册
        cleanupStaleLocalModels();
      }
    } catch (e) {
      console.error('[LocalModelTab] init failed:', e);
    }
  }, [_startHttpPolling]);

  useEffect(() => {
    return () => _stopHttpPolling();
  }, [_stopHttpPolling]);

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
      const modelId = status?.model_path ? toLocalModelId(status.model_path) : null;
      _stopHttpPolling();
      setHttpRunning(false);
      setLanExposed(false);
      setHttpInfo(null);
      // ★ 从 cherry_providers_v2 注销
      if (modelId) {
        unregisterLocalModel(modelId);
      }
      await window.soloforge.localLLM.stopServer();
      setServerRunning(false);
      setStatus(null);
      setLoading(false);
      setInfo('推理服务已停止，已从主模型选择器移除');
    } else {
      // 启动：如果服务未运行，先启动
      setLoading(true);
      setError(null);
      setInfo(null);
      try {
        // ★ 如果当前有其他模型已加载，先注销旧模型 (切换模型场景)
        if (loaded && status?.model_path && status.model_path !== modelPath) {
          const oldModelId = toLocalModelId(status.model_path);
          unregisterLocalModel(oldModelId);
        }
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
          // ★ 自动启动 localhost HTTP 服务器 (127.0.0.1, 不暴露局域网)
          //    后端 RACER 需要通过 HTTP 调用本地模型
          const httpRes = await window.soloforge.localLLM.startHttpServer('127.0.0.1', httpPort);
          if (httpRes.ok) {
            setHttpRunning(true);
            setLanExposed(false);
            const info = await window.soloforge.localLLM.getHttpServerInfo();
            setHttpInfo(info);
            _startHttpPolling();
            // ★ 注册到 cherry_providers_v2，让主模型选择器立即可见
            const modelId = toLocalModelId(modelPath);
            registerLocalModel(modelPath, modelId, httpRes.port);
            setInfo(`模型已加载，可在主模型选择器中使用`);
          } else {
            setError(httpRes.error || '本地 HTTP 服务启动失败，模型无法被主选择器调用');
          }
        } else {
          setError(loadRes.error || '加载失败');
        }
      } catch (e: any) {
        setError(e.message || '操作失败');
      }
      setLoading(false);
    }
  };

  // ── 局域网暴露开关 (切换 127.0.0.1 ↔ 0.0.0.0, 不影响注册状态) ───

  const handleToggleLan = async (next: boolean) => {
    if (!loaded || !httpRunning) return;
    setHttpLoading(true);
    setError(null);
    setInfo(null);
    try {
      // 停止当前 HTTP 服务器
      await window.soloforge.localLLM.stopHttpServer();
      // 用新的绑定地址重启
      const host = next ? '0.0.0.0' : '127.0.0.1';
      const res = await window.soloforge.localLLM.startHttpServer(host, httpPort);
      if (res.ok) {
        setLanExposed(next);
        const info = await window.soloforge.localLLM.getHttpServerInfo();
        setHttpInfo(info);
        if (next) {
          setInfo(`局域网暴露已开启: http://${res.lanIP}:${res.port}`);
        } else {
          setInfo('局域网暴露已关闭，仅本机可访问');
        }
      } else {
        // 重启失败，尝试恢复原来的绑定
        const fallbackHost = next ? '127.0.0.1' : '0.0.0.0';
        const fallbackRes = await window.soloforge.localLLM.startHttpServer(fallbackHost, httpPort);
        if (fallbackRes.ok) {
          const info = await window.soloforge.localLLM.getHttpServerInfo();
          setHttpInfo(info);
          setError(res.error || '切换失败，已恢复原状态');
        } else {
          // 回退也失败，HTTP 服务器已停止
          setHttpRunning(false);
          setLanExposed(false);
          setHttpInfo(null);
          setError('HTTP 服务器重启失败，模型已无法被主选择器调用');
        }
      }
    } catch (e: any) {
      setError(e.message || '操作失败');
    }
    setHttpLoading(false);
  };

  const handleCopyUrl = async () => {
    if (!httpInfo?.url) return;
    try {
      await navigator.clipboard.writeText(httpInfo.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
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

      {/* 推理服务状态 + 局域网暴露（服务级控制，固定顶部，不被模型列表埋没） */}
      <div className="p-3.5 bg-[var(--color-surface)] border border-[var(--color-outline)]/10 rounded-xl space-y-3">
        {/* 第一行：推理服务状态 */}
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-on-surface/40 shrink-0" />
          <span className="text-sm text-[var(--color-on-surface)]">推理服务</span>
          <span className={`text-xs font-mono tabular-nums ml-auto ${serverRunning ? 'text-emerald-400' : 'text-on-surface/30'}`}>
            {serverRunning
              ? `运行中${loaded ? ` · ${status?.model_name}` : ''}`
              : '未启动'}
          </span>
        </div>

        {/* 第二行：局域网暴露开关（模型加载后显示，控制 0.0.0.0 vs 127.0.0.1） */}
        {httpRunning && (
          <div className="flex items-center gap-2.5 pt-1 border-t border-[var(--color-outline)]/8">
            <Network className={`w-4 h-4 shrink-0 ${lanExposed ? 'text-[var(--color-primary)]' : 'text-on-surface/30'}`} />
            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold text-[var(--color-on-surface)] block">局域网暴露</span>
              <span className="text-xs text-on-surface/40">
                {lanExposed
                  ? `已暴露 · 请求 ${httpInfo?.requestCount ?? 0} 次`
                  : `仅本机 · 请求 ${httpInfo?.requestCount ?? 0} 次`}
              </span>
            </div>
            <ToggleSwitch
              checked={lanExposed}
              onChange={handleToggleLan}
              disabled={httpLoading}
              label="局域网暴露开关"
              title={lanExposed ? '点击关闭局域网暴露' : '点击开启局域网暴露'}
            />
          </div>
        )}

        {/* 端口选择 (仅未运行时显示) */}
        {!httpRunning && (
          <div className="flex items-center gap-2 pl-6 pt-1 border-t border-[var(--color-outline)]/8">
            <label className="text-xs text-on-surface/40">端口</label>
            <input
              type="number"
              value={httpPort}
              onChange={(e) => setHttpPort(parseInt(e.target.value) || 8768)}
              min={1024}
              max={65535}
              className="w-20 bg-[var(--color-bg)]/50 border border-[var(--color-outline)]/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-on-surface)] font-mono tabular-nums focus:outline-none focus:border-[var(--color-primary)]/30 transition-all"
            />
            <span className="text-xs text-on-surface/25">加载模型后自动启动本地 HTTP 服务</span>
          </div>
        )}

        {/* 局域网地址展示 (仅暴露时显示) */}
        {httpRunning && lanExposed && httpInfo && (
          <div className="space-y-1.5 pl-6">
            {/* 局域网地址 */}
            {httpInfo.url && (
              <div className="flex items-center gap-2 p-2 bg-[var(--color-bg)]/50 border border-[var(--color-outline)]/10 rounded-lg">
                <Globe className="w-3 h-3 text-[var(--color-primary)]/60 shrink-0" />
                <span className="text-xs text-on-surface/40 font-mono shrink-0">LAN</span>
                <code className="flex-1 text-xs text-[var(--color-primary)] font-mono truncate">
                  {httpInfo.url}
                </code>
                <button
                  onClick={handleCopyUrl}
                  className="text-on-surface/40 hover:text-[var(--color-primary)] transition-colors shrink-0"
                  title="复制地址"
                >
                  {copied
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}
            {/* 本机地址 */}
            {httpInfo.localUrl && (
              <div className="flex items-center gap-2 p-2 bg-[var(--color-bg)]/50 border border-[var(--color-outline)]/10 rounded-lg">
                <span className="text-xs text-on-surface/40 font-mono shrink-0 ml-[18px]">本机</span>
                <code className="flex-1 text-xs text-on-surface/50 font-mono truncate">
                  {httpInfo.localUrl}
                </code>
              </div>
            )}
            <p className="text-xs text-on-surface/25 leading-relaxed pl-[18px]">
              其他设备可将此地址设为 OpenAI base_url，兼容 <code className="text-on-surface/40">/v1/chat/completions</code>
            </p>
          </div>
        )}

        {/* 加载中指示 */}
        {httpLoading && (
          <div className="flex items-center gap-2 pl-6">
            <Loader2 className="w-3 h-3 text-[var(--color-primary)] animate-spin" />
            <span className="text-xs text-on-surface/40">正在{lanExposed ? '关闭' : '开启'}局域网暴露...</span>
          </div>
        )}
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
                        ? 'text-red-400 hover:text-red-300'
                        : 'text-[var(--color-primary)] hover:opacity-70'
                    }`}
                    title={isLoaded ? '停止推理' : '启动推理'}
                  >
                    {loading
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
