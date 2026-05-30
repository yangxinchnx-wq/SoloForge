// ─────────────────────────────────────────────────────────────────
// SoloForge Electron Main Process
// 主进程入口 - 托管 RuntimeKernel
// ─────────────────────────────────────────────────────────────────

// Electron 使用 require 因为它是 CommonJS 模块
const electron = require('electron');
const { app, BrowserWindow, Menu, shell, dialog } = electron;
const path = require('path');
const fs = require('fs');
const { IpcBridge, getIpcBridge, setCoreModules } = require('./ipc-bridge');

let mainWindow: BrowserWindow | null = null;
let ipcBridge: IpcBridge | null = null;

// 判断是否为开发模式
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// 获取项目根目录
function getProjectRoot(): string {
  // 开发模式: src/ 目录的父级
  // 生产模式: 可执行文件所在目录
  if (isDev) {
    // tsx 运行时 __dirname 是 src/ 目录
    return path.join(__dirname, '../..');
  }
  return path.join(__dirname, '..');
}

/**
 * 创建主窗口
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'SoloForge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  });

  // 设置 IPC Bridge 的 WebContents
  if (ipcBridge) {
    ipcBridge.setWebContents(mainWindow.webContents);
  }

  // 加载页面
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // 窗口准备好后显示
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // 点击链接用浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 创建应用菜单
 */
function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Task', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('menu:new-task') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About SoloForge',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About SoloForge',
              message: 'SoloForge',
              detail: 'AI Multi-Agent Autonomous System Core Framework\nVersion 1.0.0'
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * 加载核心模块
 */
async function loadCoreModules(): Promise<void> {
  const rootPath = getProjectRoot();
  console.log('[Main] 项目根目录:', rootPath);

  // 检查核心模块是否存在
  const kernelPath = path.join(rootPath, 'src/kernel/runtime-kernel.ts');
  if (!fs.existsSync(kernelPath)) {
    console.warn('[Main] 核心模块不存在:', kernelPath);
    return;
  }

  try {
    // 动态导入核心模块 (使用相对路径)
    const kernelModule = await import(path.join(rootPath, 'src/kernel/runtime-kernel'));
    const eventsModule = await import(path.join(rootPath, 'src/core/events/runtime-events'));

    setCoreModules(kernelModule.kernel, eventsModule.RuntimeEvent);
    console.log('[Main] 核心模块已加载');
  } catch (e) {
    console.warn('[Main] 无法加载核心模块:', e);
  }
}

/**
 * 初始化 RuntimeKernel
 */
async function initializeRuntime(): Promise<void> {
  try {
    // 获取 IPC Bridge 实例
    ipcBridge = getIpcBridge();

    // 加载核心模块
    await loadCoreModules();

    // 获取项目根目录
    const rootPath = getProjectRoot();

    // 设置持久化管理器
    try {
      const { SurrealPersistence } = await import(path.join(rootPath, 'src/data/surreal_persistence'));
      const persistence = new SurrealPersistence();
      ipcBridge.setPersistence(persistence);
      console.log('[Main] SurrealPersistence 已设置');
    } catch (e) {
      console.warn('[Main] 无法加载 SurrealPersistence:', e);
    }

    // 设置调度器客户端
    try {
      const { GeminiRustSchedulerClient } = await import(path.join(rootPath, 'src/kernel/scheduler-client'));
      const scheduler = new GeminiRustSchedulerClient();
      scheduler.initialize();
      ipcBridge.setScheduler(scheduler);
      console.log('[Main] Scheduler 已设置');
    } catch (e) {
      console.warn('[Main] 无法加载 Scheduler:', e);
    }

    // 初始化 IPC Bridge
    ipcBridge.initialize();

    console.log('[Main] RuntimeKernel 已初始化');
  } catch (error) {
    console.error('[Main] RuntimeKernel 初始化失败:', error);
  }
}

/**
 * 启动 Electron 应用
 */
async function startApp(): Promise<void> {
  console.log('[Main] SoloForge 启动中...');
  console.log('[Main] 开发模式:', isDev);

  // 确保单实例
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // 初始化 Runtime
  await initializeRuntime();

  // 创建窗口和菜单
  createWindow();
  createMenu();

  console.log('[Main] SoloForge 启动完成');
}

// 应用就绪
app.whenReady().then(startApp);

// 所有窗口关闭
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// macOS 激活
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// 退出前清理
app.on('before-quit', () => {
  if (ipcBridge) {
    ipcBridge.destroy();
  }
  console.log('[Main] SoloForge 关闭');
});
