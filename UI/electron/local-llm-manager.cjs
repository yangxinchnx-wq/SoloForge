// ─────────────────────────────────────────────────────────────────
// SoloForge Local LLM Manager (v2 — node-llama-cpp)
//
// 职责:
//   1. 直接在 Electron 主进程中加载 llama.cpp（无需 Python 进程）
//   2. 持久化模型列表 (settingsStorage)
//   3. 文件操作 (浏览 / 删除)
//   4. IPC 桥接 (渲染进程 ↔ 主进程 ↔ llama.cpp)
//
// 优势 (相比 v1 Python 方案):
//   - 无额外进程，无 HTTP 层，无端口占用
//   - 无 1.6GB Python 环境依赖
//   - 流式输出通过 IPC 事件推送，不走 SSE fetch
//   - 启动毫秒级
// ─────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { createSettingsStorage } = require('./settingsStorage.cjs');

const STORE_NAME = 'local-llm';
const SETTINGS_FILE = path.join(os.homedir(), '.soloforge', 'local-llm.json');

// ── 运行时状态 ──────────────────────────────────────────────────

let _nodeLlamaCpp = null;     // ESM 模块缓存
let _llama = null;             // Llama 实例 (native binding)
let _model = null;             // LlamaModel 实例
let _context = null;           // LlamaContext 实例
let _session = null;           // LlamaChatSession 实例

let _settingsStorage = null;
let _isReady = false;          // llama binding 已加载
let _isLoadingModel = false;

// 已加载模型的元数据
let _loadedModelPath = null;
let _loadedModelName = null;
let _loadedFileSizeMb = null;
let _loadedParams = null;      // { n_ctx, n_threads, n_gpu_layers }

// 性能指标
let _lastMetrics = {
  tokens_per_second: 0,
  time_to_first_token_ms: 0,
  total_tokens: 0,
  total_time_ms: 0,
};

// 活跃的 chat abort controller（按 streamId 索引）
const _chatAbortControllers = new Map();

// ── 初始化 ──────────────────────────────────────────────────────

function init(settingsStorage) {
  _settingsStorage = settingsStorage || createSettingsStorage(SETTINGS_FILE);
}

// 延迟加载 ESM 模块
async function _ensureModule() {
  if (_nodeLlamaCpp) return _nodeLlamaCpp;
  _nodeLlamaCpp = await import('node-llama-cpp');
  return _nodeLlamaCpp;
}

// ── 模型列表持久化 ──────────────────────────────────────────────

function _getStore() {
  return _settingsStorage.getStore(STORE_NAME);
}

function getModelList() {
  const store = _getStore();
  return store.models || [];
}

function _saveModelList(models) {
  const store = _getStore();
  store.models = models;
  _settingsStorage.scheduleWrite();
}

function addModel(modelPath) {
  if (!fs.existsSync(modelPath)) {
    return { ok: false, error: 'File not found' };
  }
  if (!modelPath.toLowerCase().endsWith('.gguf')) {
    return { ok: false, error: 'Not a .gguf file' };
  }

  const models = getModelList();
  const exists = models.find((m) => m.path === modelPath);
  if (exists) {
    return { ok: false, error: 'Model already added' };
  }

  const name = path.basename(modelPath, '.gguf');
  const stat = fs.statSync(modelPath);
  const model = {
    path: modelPath,
    name,
    addedAt: new Date().toISOString(),
    sizeMb: Math.round(stat.size / (1024 * 1024) * 10) / 10,
  };

  models.push(model);
  _saveModelList(models);
  return { ok: true, model };
}

function removeModel(modelPath) {
  const models = getModelList();
  const filtered = models.filter((m) => m.path !== modelPath);
  _saveModelList(filtered);
  return { ok: true };
}

function deleteModel(modelPath) {
  removeModel(modelPath);
  try {
    if (fs.existsSync(modelPath)) {
      fs.unlinkSync(modelPath);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed to delete file: ${e.message}` };
  }
}

// ── 服务生命周期 ────────────────────────────────────────────────

async function startServer() {
  if (_isReady) {
    return { ok: true, message: 'Already initialized' };
  }

  try {
    const mod = await _ensureModule();
    const { getLlama } = mod;

    // build: "never" — 只用预编译二进制，不尝试源码编译
    // （Electron 打包后无法编译）
    _llama = await getLlama({
      build: 'never',
      logLevel: 'error',
    });
    _isReady = true;
    console.log('[local-llm] node-llama-cpp initialized, GPU:', _llama.gpu);
    return { ok: true };
  } catch (e) {
    console.error('[local-llm] init failed:', e);
    return { ok: false, error: e.message || 'Failed to initialize llama.cpp' };
  }
}

async function stopServer() {
  await _cleanupModel();
  if (_llama) {
    try { await _llama.dispose(); } catch {}
    _llama = null;
  }
  _isReady = false;
  return { ok: true };
}

function isServerRunning() {
  return _isReady;
}

// ── 模型加载/卸载 ───────────────────────────────────────────────

async function _cleanupModel() {
  // 顺序: session → context → model
  if (_session) {
    try { _session.dispose(); } catch {}
    _session = null;
  }
  if (_context) {
    try { await _context.dispose(); } catch {}
    _context = null;
  }
  if (_model) {
    try { await _model.dispose(); } catch {}
    _model = null;
  }
  _loadedModelPath = null;
  _loadedModelName = null;
  _loadedFileSizeMb = null;
  _loadedParams = null;
}

async function loadModel(modelPath, params) {
  if (!_isReady || !_llama) {
    return { ok: false, error: 'Service not started' };
  }
  if (_isLoadingModel) {
    return { ok: false, error: 'Another model is loading' };
  }

  _isLoadingModel = true;
  try {
    // 先卸载当前模型
    await _cleanupModel();

    const nCtx = params?.n_ctx ?? 4096;
    const nThreads = params?.n_threads ?? 4;
    const nGpuLayers = params?.n_gpu_layers ?? 0;

    const mod = await _ensureModule();

    // 加载模型
    _model = await _llama.loadModel({
      modelPath,
      gpuLayers: nGpuLayers === -1 ? 'max' : nGpuLayers,
    });

    // 创建上下文
    _context = await _model.createContext({
      contextSize: nCtx,
      threads: nThreads,
    });

    // 创建聊天会话
    const sequence = _context.getSequence();
    _session = new mod.LlamaChatSession({
      contextSequence: sequence,
    });

    // 记录元数据
    const stat = fs.statSync(modelPath);
    _loadedModelPath = modelPath;
    _loadedModelName = path.basename(modelPath, '.gguf');
    _loadedFileSizeMb = Math.round(stat.size / (1024 * 1024) * 10) / 10;
    _loadedParams = { n_ctx: nCtx, n_threads: nThreads, n_gpu_layers: nGpuLayers };

    console.log(`[local-llm] Model loaded: ${_loadedModelName} (${_loadedFileSizeMb}MB)`);
    return {
      ok: true,
      model_name: _loadedModelName,
      model_path: modelPath,
      file_size_mb: _loadedFileSizeMb,
      params: _loadedParams,
    };
  } catch (e) {
    console.error('[local-llm] Load model failed:', e);
    await _cleanupModel();
    return { ok: false, error: e.message || 'Failed to load model' };
  } finally {
    _isLoadingModel = false;
  }
}

async function unloadModel() {
  await _cleanupModel();
  return { ok: true };
}

// ── 状态查询 ────────────────────────────────────────────────────

async function getStatus() {
  if (_model && _loadedModelPath) {
    return {
      loaded: true,
      model_path: _loadedModelPath,
      model_name: _loadedModelName,
      file_size_mb: _loadedFileSizeMb,
      params: _loadedParams,
    };
  }
  return { loaded: false };
}

// ── 设备检测 ────────────────────────────────────────────────────

async function getDeviceInfo() {
  const cpuCores = os.cpus().length;
  const ramGb = Math.round(os.totalmem() / (1024 ** 3) * 10) / 10;

  // GPU 检测 (nvidia-smi)
  let gpu = null;
  try {
    const result = execSync(
      'nvidia-smi --query-gpu=name --format=csv,noheader',
      { encoding: 'utf-8', timeout: 5000, windowsHide: true }
    );
    if (result.trim()) {
      gpu = result.trim().split('\n')[0];
    }
  } catch {}

  // node-llama-cpp GPU 支持
  let cudaSupported = false;
  if (_llama) {
    cudaSupported = _llama.supportsGpuOffloading;
  }

  const info = {
    cpu_cores: cpuCores,
    ram_gb: ramGb,
    gpu,
    cuda_supported: cudaSupported,
  };

  // 推荐参数
  info.suggested = _suggestParams(info);
  return info;
}

function _suggestParams(deviceInfo) {
  const cpu = deviceInfo.cpu_cores;
  const ram = deviceInfo.ram_gb;
  const gpu = deviceInfo.gpu;
  const cudaSupported = deviceInfo.cuda_supported;

  const nThreads = Math.min(Math.max(cpu - 2, 1), 8);

  let nCtx;
  if (ram >= 32) nCtx = 16384;
  else if (ram >= 16) nCtx = 8192;
  else if (ram >= 8) nCtx = 4096;
  else nCtx = 2048;

  const nGpuLayers = (gpu && cudaSupported) ? -1 : 0;

  return { n_ctx: nCtx, n_threads: nThreads, n_gpu_layers: nGpuLayers };
}

// ── 性能指标 ────────────────────────────────────────────────────

function getMetrics() {
  return _lastMetrics;
}

// ── 流式聊天 ────────────────────────────────────────────────────

/**
 * 流式聊天 — 通过 IPC 事件推送 token
 * 渲染进程通过 onToken/onDone/onError 监听
 */
async function chat(event, { text, params, streamId }) {
  if (!_session) {
    event.sender.send(`local-llm:error:${streamId}`, 'No model loaded');
    return;
  }

  const abortController = new AbortController();
  _chatAbortControllers.set(streamId, abortController);

  const t0 = Date.now();
  let firstTokenTime = null;
  let tokenCount = 0;

  try {
    await _session.prompt(text, {
      temperature: params?.temperature ?? 0.3,
      topP: params?.top_p ?? 1.0,
      maxTokens: params?.max_tokens ?? 1024,
      repeatPenalty: {
        penalty: params?.repeat_penalty ?? 1.1,
      },
      signal: abortController.signal,
      stopOnAbortSignal: true,
      onTextChunk: (chunk) => {
        if (firstTokenTime === null) {
          firstTokenTime = Date.now();
        }
        tokenCount++;
        event.sender.send(`local-llm:token:${streamId}`, chunk);
      },
    });

    // 计算性能指标
    const elapsed = (Date.now() - t0) / 1000;
    const ttft = firstTokenTime ? (firstTokenTime - t0) : 0;
    _lastMetrics = {
      tokens_per_second: elapsed > 0 ? Math.round(tokenCount / elapsed * 100) / 100 : 0,
      time_to_first_token_ms: Math.round(ttft),
      total_tokens: tokenCount,
      total_time_ms: Math.round(elapsed * 1000),
    };

    event.sender.send(`local-llm:done:${streamId}`);
  } catch (e) {
    if (e.name === 'AbortError' || (e.message && e.message.includes('abort'))) {
      // 用户主动中止，不算错误
      const elapsed = (Date.now() - t0) / 1000;
      const ttft = firstTokenTime ? (firstTokenTime - t0) : 0;
      _lastMetrics = {
        tokens_per_second: elapsed > 0 ? Math.round(tokenCount / elapsed * 100) / 100 : 0,
        time_to_first_token_ms: Math.round(ttft),
        total_tokens: tokenCount,
        total_time_ms: Math.round(elapsed * 1000),
      };
      event.sender.send(`local-llm:done:${streamId}`);
    } else {
      console.error('[local-llm] Chat error:', e);
      event.sender.send(`local-llm:error:${streamId}`, e.message || 'Inference failed');
    }
  } finally {
    _chatAbortControllers.delete(streamId);
  }
}

function abortChat(streamId) {
  const controller = _chatAbortControllers.get(streamId);
  if (controller) {
    controller.abort();
  }
  return { ok: true };
}

function resetChat() {
  if (_session) {
    _session.resetChatHistory();
  }
  return { ok: true };
}

// ── IPC 注册 ────────────────────────────────────────────────────

function registerIpc(ipcMain, dialog) {
  // 模型列表
  ipcMain.handle('local-llm:list', () => {
    return { ok: true, models: getModelList() };
  });

  ipcMain.handle('local-llm:add', (_e, { path: modelPath }) => {
    return addModel(modelPath);
  });

  ipcMain.handle('local-llm:remove', (_e, { path: modelPath }) => {
    return removeModel(modelPath);
  });

  ipcMain.handle('local-llm:delete', (_e, { path: modelPath }) => {
    return deleteModel(modelPath);
  });

  // 文件浏览
  ipcMain.handle('local-llm:browse', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 GGUF 模型文件',
      filters: [{ name: 'GGUF Model', extensions: ['gguf'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    return { ok: true, path: result.filePaths[0] };
  });

  // 模型加载/卸载
  ipcMain.handle('local-llm:load', async (_e, { path: modelPath, params }) => {
    return loadModel(modelPath, params);
  });

  ipcMain.handle('local-llm:unload', async () => {
    return unloadModel();
  });

  // 状态查询
  ipcMain.handle('local-llm:status', async () => {
    return getStatus();
  });

  ipcMain.handle('local-llm:device', async () => {
    return getDeviceInfo();
  });

  ipcMain.handle('local-llm:metrics', async () => {
    return getMetrics();
  });

  // 服务管理
  ipcMain.handle('local-llm:start-server', async () => {
    return startServer();
  });

  ipcMain.handle('local-llm:stop-server', async () => {
    return stopServer();
  });

  ipcMain.handle('local-llm:server-running', () => {
    return { running: isServerRunning() };
  });

  // 流式聊天 (IPC 事件推送)
  ipcMain.handle('local-llm:chat', async (event, { text, params, streamId }) => {
    return chat(event, { text, params, streamId });
  });

  ipcMain.handle('local-llm:chat-abort', (_e, { streamId }) => {
    return abortChat(streamId);
  });

  ipcMain.handle('local-llm:chat-reset', () => {
    return resetChat();
  });
}

// ── 清理 ────────────────────────────────────────────────────────

async function cleanup() {
  // 中止所有活跃的聊天
  for (const [, controller] of _chatAbortControllers) {
    try { controller.abort(); } catch {}
  }
  _chatAbortControllers.clear();

  await _cleanupModel();
  if (_llama) {
    try { await _llama.dispose(); } catch {}
    _llama = null;
  }
  _isReady = false;
}

module.exports = {
  init,
  registerIpc,
  cleanup,
  startServer,
  stopServer,
  isServerRunning,
  loadModel,
  unloadModel,
  getStatus,
  getDeviceInfo,
  getMetrics,
  getModelList,
  addModel,
  removeModel,
  deleteModel,
  abortChat,
  resetChat,
};
