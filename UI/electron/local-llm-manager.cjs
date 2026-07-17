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
const http = require('http');
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

// ── HTTP 服务器状态（局域网共享） ────────────────────────────────
let _httpServer = null;
let _httpHost = '0.0.0.0';
let _httpPort = 8768;
let _httpContext = null;        // 独立 context（不干扰 UI 调试对话）
let _httpSession = null;        // 独立 session
let _httpLock = false;          // 请求锁：串行化推理，避免并发崩溃
let _httpRequestCount = 0;

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
  // ★ 必须先停止 HTTP 服务器，否则 _model 被释放后 HTTP 仍持有 _httpContext/_httpSession
  await stopHttpServer();
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
    // 先停止 HTTP 服务器 + 卸载当前模型
    await stopHttpServer();
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
  // 先停止 HTTP 服务器（其 context/session 依赖当前 model）
  await stopHttpServer();
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

// ── HTTP 服务器（局域网共享） ────────────────────────────────────

/**
 * 获取局域网 IP 地址
 */
function getLanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

async function startHttpServer(host, port) {
  if (_httpServer) {
    return { ok: false, error: 'HTTP 服务器已运行' };
  }
  if (!_model || !_loadedModelPath) {
    return { ok: false, error: '请先加载模型' };
  }

  _httpHost = host || '0.0.0.0';
  _httpPort = port || 8768;

  try {
    // 创建独立 context + session（不干扰 UI 调试对话）
    _httpContext = await _model.createContext({
      contextSize: _loadedParams.n_ctx,
      threads: _loadedParams.n_threads,
    });
    const mod = await _ensureModule();
    const sequence = _httpContext.getSequence();
    _httpSession = new mod.LlamaChatSession({ contextSequence: sequence });

    _httpServer = http.createServer(handleHttpRequest);
    await new Promise((resolve, reject) => {
      _httpServer.on('error', reject);
      _httpServer.listen(_httpPort, _httpHost, resolve);
    });

    _httpRequestCount = 0;
    const lanIP = getLanIP();
    console.log(`[local-llm] HTTP API server on http://${_httpHost}:${_httpPort} (LAN: http://${lanIP}:${_httpPort})`);
    return { ok: true, host: _httpHost, port: _httpPort, lanIP };
  } catch (e) {
    console.error('[local-llm] Failed to start HTTP server:', e);
    await _cleanupHttpModel();
    _httpServer = null;
    return { ok: false, error: e.message || 'Failed to start HTTP server' };
  }
}

async function stopHttpServer() {
  if (_httpServer) {
    await new Promise((resolve) => _httpServer.close(resolve));
    _httpServer = null;
  }
  await _cleanupHttpModel();
  _httpLock = false;
  _httpRequestCount = 0;
  console.log('[local-llm] HTTP server stopped');
  return { ok: true };
}

async function _cleanupHttpModel() {
  if (_httpSession) {
    try { _httpSession.dispose(); } catch {}
    _httpSession = null;
  }
  if (_httpContext) {
    try { await _httpContext.dispose(); } catch {}
    _httpContext = null;
  }
}

function isHttpServerRunning() {
  return _httpServer !== null;
}

function getHttpServerInfo() {
  return {
    running: _httpServer !== null,
    host: _httpHost,
    port: _httpPort,
    lanIP: getLanIP(),
    url: _httpServer ? `http://${getLanIP()}:${_httpPort}` : null,
    localUrl: _httpServer ? `http://127.0.0.1:${_httpPort}` : null,
    requestCount: _httpRequestCount,
    modelLoaded: _httpSession !== null,
    modelName: _loadedModelName,
  };
}

// ── HTTP 请求处理 ────────────────────────────────────────────────

function _readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function _setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function handleHttpRequest(req, res) {
  _setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET 路由
  if (req.method === 'GET') {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        model_loaded: _httpSession !== null,
        model_name: _loadedModelName,
        request_count: _httpRequestCount,
      }));
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{
          id: _loadedModelName,
          object: 'model',
          owned_by: 'soloforge-local',
        }],
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // POST 路由
  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
    await _handleChatCompletion(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

async function _handleChatCompletion(req, res) {
  // 请求锁：串行化推理
  if (_httpLock) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server is busy, another request is being processed' }));
    return;
  }
  _httpLock = true;
  _httpRequestCount++;

  try {
    const body = await _readBody(req);
    const data = JSON.parse(body);

    const messages = data.messages || [];
    const temperature = data.temperature ?? 0.3;
    const topP = data.top_p ?? 1.0;
    const maxTokens = data.max_tokens ?? 1024;
    const repeatPenalty = data.repeat_penalty ?? 1.1;
    const stream = data.stream ?? false;

    if (messages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'messages is empty' }));
      return;
    }

    // 重置 session，构建全新对话上下文
    _httpSession.resetChatHistory();

    // 设置 system message
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg) {
      _httpSession.setSystemMessage(systemMsg.content);
    }

    // 提取最后一条 user 消息
    const conversationMessages = messages.filter(m => m.role !== 'system');
    const lastUserMsg = [...conversationMessages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No user message found' }));
      return;
    }

    const completionId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      // SSE 流式输出
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      await _httpSession.prompt(lastUserMsg.content, {
        temperature,
        topP,
        maxTokens,
        repeatPenalty: { penalty: repeatPenalty },
        onTextChunk: (chunk) => {
          const sseData = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: _loadedModelName,
            choices: [{
              index: 0,
              delta: { content: chunk },
              finish_reason: null,
            }],
          };
          res.write(`data: ${JSON.stringify(sseData)}\n\n`);
        },
      });

      // 结束 chunk
      const finalChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: _loadedModelName,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // 非流式
      const responseText = await _httpSession.prompt(lastUserMsg.content, {
        temperature,
        topP,
        maxTokens,
        repeatPenalty: { penalty: repeatPenalty },
      });

      const result = {
        id: completionId,
        object: 'chat.completion',
        created,
        model: _loadedModelName,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: responseText },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
  } catch (e) {
    console.error('[local-llm] HTTP chat completion error:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Internal error' }));
    } else {
      try { res.end(); } catch {}
    }
  } finally {
    _httpLock = false;
  }
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

  // HTTP 服务器（局域网共享）
  ipcMain.handle('local-llm:start-http-server', async (_e, { host, port }) => {
    return startHttpServer(host, port);
  });

  ipcMain.handle('local-llm:stop-http-server', async () => {
    return stopHttpServer();
  });

  ipcMain.handle('local-llm:http-server-info', () => {
    return getHttpServerInfo();
  });
}

// ── 清理 ────────────────────────────────────────────────────────

async function cleanup() {
  // 中止所有活跃的聊天
  for (const [, controller] of _chatAbortControllers) {
    try { controller.abort(); } catch {}
  }
  _chatAbortControllers.clear();

  // 停止 HTTP 服务器
  await stopHttpServer();

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
  // HTTP 服务器（局域网共享）
  startHttpServer,
  stopHttpServer,
  isHttpServerRunning,
  getHttpServerInfo,
};
