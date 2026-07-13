// ─────────────────────────────────────────────────────────────────
// SoloForge Local LLM Manager
//
// 职责:
//   1. 管理 Python 推理服务进程 (spawn / kill)
//   2. 持久化模型列表 (settingsStorage)
//   3. 文件操作 (浏览 / 删除)
//   4. IPC 桥接 (渲染进程 ↔ 主进程 ↔ Python HTTP)
//
// 模型列表存储格式 (settingsStorage store="local-llm"):
//   { "models": [ { "path": "C:\\...\\model.gguf", "name": "model-name", "addedAt": "..." } ] }
// ─────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { createSettingsStorage } = require('./settingsStorage.cjs');

const LLM_PORT = 8767;
const LLM_HOST = '127.0.0.1';
const STORE_NAME = 'local-llm';
// 独立文件，避免与 proxy-service.cjs 的 settingsStorage 实例写覆盖
const SETTINGS_FILE = path.join(os.homedir(), '.soloforge', 'local-llm.json');

let _pythonProcess = null;
let _settingsStorage = null;
let _isStarting = false;

// ── 初始化 ──────────────────────────────────────────────────────

function init(settingsStorage) {
  // 可选注入 storage (测试用)，否则自建
  _settingsStorage = settingsStorage || createSettingsStorage(SETTINGS_FILE);
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
  // 先从列表移除
  removeModel(modelPath);
  // 再从磁盘删除
  try {
    if (fs.existsSync(modelPath)) {
      fs.unlinkSync(modelPath);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed to delete file: ${e.message}` };
  }
}

// ── Python 进程管理 ─────────────────────────────────────────────

function getPythonExe() {
  const appPath = process.resourcesPath || path.resolve(__dirname, '..');
  // dev 模式: __dirname = UI/electron, 项目根 = ../..
  // prod 模式: resourcesPath = .../resources, python 在 .../bin/python-3.13/
  const devPython = path.resolve(__dirname, '..', '..', 'bin', 'python-3.13', 'python.exe');
  const prodPython = path.join(appPath, 'bin', 'python-3.13', 'python.exe');

  if (fs.existsSync(devPython)) return devPython;
  if (fs.existsSync(prodPython)) return prodPython;
  return null;
}

function getPythonDir() {
  const devDir = path.resolve(__dirname, '..', '..', 'python');
  const prodDir = path.join(process.resourcesPath || path.resolve(__dirname, '..'), 'python');
  return fs.existsSync(devDir) ? devDir : prodDir;
}

async function startServer() {
  if (_pythonProcess) {
    return { ok: true, message: 'Server already running' };
  }
  if (_isStarting) {
    return { ok: false, error: 'Server is starting...' };
  }

  _isStarting = true;
  const pythonExe = getPythonExe();
  if (!pythonExe) {
    _isStarting = false;
    return { ok: false, error: 'Python not found' };
  }

  const pythonDir = getPythonDir();

  _pythonProcess = spawn(
    pythonExe,
    ['-m', 'marl_service.llm_inference_server', '--port', String(LLM_PORT)],
    {
      cwd: pythonDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  _pythonProcess.stdout?.on('data', (d) => process.stdout.write(`[local-llm] ${d}`));
  _pythonProcess.stderr?.on('data', (d) => process.stderr.write(`[local-llm] ${d}`));
  _pythonProcess.on('exit', (code) => {
    console.log(`[local-llm] Python server exited with code ${code}`);
    _pythonProcess = null;
  });

  // 等待服务就绪
  const ready = await _waitForServer(15000);
  _isStarting = false;

  if (ready) {
    return { ok: true, port: LLM_PORT };
  }
  return { ok: false, error: 'Server failed to start within timeout' };
}

function stopServer() {
  if (_pythonProcess) {
    const pid = _pythonProcess.pid;
    if (pid && process.platform === 'win32') {
      // Windows: taskkill /T /F 杀整棵进程树
      try {
        require('child_process').spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true,
        });
      } catch {
        try { _pythonProcess.kill(); } catch {}
      }
    } else {
      try { _pythonProcess.kill('SIGKILL'); } catch {}
    }
    _pythonProcess = null;
    return { ok: true };
  }
  return { ok: true, message: 'Server not running' };
}

function isServerRunning() {
  return _pythonProcess !== null;
}

async function _waitForServer(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await _httpGet('/health');
      if (ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ── HTTP 代理 (到 Python 服务) ───────────────────────────────────

function _httpGet(pathStr) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: LLM_HOST, port: LLM_PORT, path: pathStr, timeout: 5000 },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function _httpPost(pathStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      {
        hostname: LLM_HOST,
        port: LLM_PORT,
        path: pathStr,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        timeout: timeoutMs || 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(bodyStr);
    req.end();
  });
}

// ── 对外 API ────────────────────────────────────────────────────

async function loadModel(modelPath, params) {
  // 模型加载可能很慢（6GB+ 文件），给 5 分钟超时
  return _httpPost('/api/load', {
    model_path: modelPath,
    n_ctx: params?.n_ctx ?? 4096,
    n_threads: params?.n_threads ?? 4,
    n_gpu_layers: params?.n_gpu_layers ?? 0,
  }, 300000);
}

async function unloadModel() {
  return _httpPost('/api/unload', {});
}

async function getStatus() {
  return _httpGet('/api/status');
}

async function getDeviceInfo() {
  return _httpGet('/api/device');
}

async function getMetrics() {
  return _httpGet('/api/metrics');
}

function getServerUrl() {
  return `http://${LLM_HOST}:${LLM_PORT}`;
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

  ipcMain.handle('local-llm:stop-server', () => {
    return stopServer();
  });

  ipcMain.handle('local-llm:server-running', () => {
    return { running: isServerRunning() };
  });

  ipcMain.handle('local-llm:server-url', () => {
    return { url: getServerUrl() };
  });
}

// ── 清理 ────────────────────────────────────────────────────────

function cleanup() {
  stopServer();
}

module.exports = {
  init,
  registerIpc,
  cleanup,
  startServer,
  stopServer,
  isServerRunning,
  getServerUrl,
  getModelList,
  addModel,
  removeModel,
  deleteModel,
  loadModel,
  unloadModel,
  getStatus,
  getDeviceInfo,
  getMetrics,
  LLM_PORT,
};
