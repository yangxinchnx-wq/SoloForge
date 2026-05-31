// ─────────────────────────────────────────────────────────────────
// SoloForge Electron Main Process
// 主进程入口 - 托管 RuntimeKernel
// ─────────────────────────────────────────────────────────────────

import { app, BrowserWindow, Menu, shell, dialog, ipcMain } from 'electron';
import * as path from 'path';

let mainWindow: BrowserWindow | null = null;

// 模拟数据存储
const mockData = {
  kernel: {
    state: 'READY',
    mode: 'NORMAL',
    version: 1,
    startedAt: Date.now()
  },
  subscribedEvents: new Set<string>(),
  eventLog: [] as Array<{ event: string; payload: any; timestamp: number }>
};

// ─────────────────────────────────────────────────────────────────
// 注册 IPC Handlers
// ─────────────────────────────────────────────────────────────────
function registerIpcHandlers(): void {
  console.log('[Main] 注册 IPC Handlers...');

  // ── Kernel Handlers ──
  ipcMain.handle('kernel:status', async () => {
    return {
      state: mockData.kernel.state,
      mode: mockData.kernel.mode,
      version: mockData.kernel.version,
      startedAt: mockData.kernel.startedAt
    };
  });

  ipcMain.handle('kernel:components', async () => {
    return [
      'RuntimeKernel',
      'CommandBus',
      'TransactionManager',
      'EventBus',
      'SchedulerClient',
      'SurrealPersistence',
      'GarnetCache',
      'JsonlStore'
    ];
  });

  ipcMain.handle('kernel:health', async () => {
    return {
      healthy: true,
      state: 'healthy',
      error: null
    };
  });

  ipcMain.handle('kernel:events', async (_event, limit: number = 50) => {
    return mockData.eventLog.slice(-limit);
  });

  ipcMain.handle('kernel:ownership', async (_event, domain: string) => {
    const ownerships: Record<string, string[]> = {
      'JudicialCourt': ['court_case_registry*'],
      'AIRuntime': ['AIRuntime*', 'core_scheduler*'],
      'Governor': ['governor*'],
      'ShadowGovernor': ['governor_shadow*'],
      'DecisionEngine': ['decision*']
    };
    return {
      domain,
      patterns: ownerships[domain] || []
    };
  });

  // ── Database Handlers ──
  ipcMain.handle('db:query', async (_event, sql: string, _params?: unknown[]) => {
    console.log('[Main] DB Query:', sql);
    // 模拟数据库查询
    return {
      success: true,
      data: [
        {
          id: 'migration_01',
          version: 'v1_base',
          applied_at: new Date().toISOString(),
          description: 'Initial schema'
        },
        {
          id: 'migration_02',
          version: 'v2_decision',
          applied_at: new Date().toISOString(),
          description: 'Decision chain schema'
        },
        {
          id: 'migration_03',
          version: 'v3_court',
          applied_at: new Date().toISOString(),
          description: 'Court governance schema'
        }
      ]
    };
  });

  ipcMain.handle('db:schema', async () => {
    return {
      tables: ['decision', 'courtSubmission', 'courtVerdict', 'marlEpisode', 'eventLog', 'migration_history'],
      namespaces: ['soloforge_core'],
      databases: ['autonomous_network']
    };
  });

  ipcMain.handle('db:tables', async () => {
    return ['decision', 'courtSubmission', 'courtVerdict', 'marlEpisode', 'eventLog', 'migration_history'];
  });

  // ── Scheduler Handlers ──
  ipcMain.handle('scheduler:stats', async () => {
    return {
      mode: 'performance',
      queueSize: Math.floor(Math.random() * 10),
      stats: {
        total_push: Math.floor(Math.random() * 100),
        total_pop: Math.floor(Math.random() * 100),
        total_ping: Math.floor(Math.random() * 1000)
      },
      error: null
    };
  });

  ipcMain.handle('scheduler:queue', async () => {
    return [
      { id: 'task_1', priority: 100, status: 'pending' },
      { id: 'task_2', priority: 90, status: 'pending' },
      { id: 'task_3', priority: 80, status: 'running' }
    ];
  });

  // ── Event Handlers ──
  ipcMain.handle('event:subscribe', async (_event, eventName: string) => {
    mockData.subscribedEvents.add(eventName);
    console.log('[Main] Subscribed to:', eventName);
    return { subscribed: eventName, success: true };
  });

  ipcMain.handle('event:unsubscribe', async (_event, eventName: string) => {
    mockData.subscribedEvents.delete(eventName);
    return { unsubscribed: eventName, success: true };
  });

  ipcMain.handle('event:list', async () => {
    return Array.from(mockData.subscribedEvents);
  });

  console.log('[Main] IPC Handlers 注册完成');
}

// ─────────────────────────────────────────────────────────────────
// 窗口管理
// ─────────────────────────────────────────────────────────────────
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

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (isDev) {
    // Vite root 指向 UI/，端口 5188（见 vite.config.ts）
    mainWindow.loadURL('http://localhost:5188');
    mainWindow.webContents.openDevTools();
  } else {
    // 生产模式加载打包后的 UI
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─────────────────────────────────────────────────────────────────
// 菜单
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
// 模拟心跳事件
// ─────────────────────────────────────────────────────────────────
function startHeartbeat(): void {
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const event = {
        event: 'Heartbeat',
        payload: { tick: Date.now() },
        timestamp: Date.now()
      };
      mockData.eventLog.push(event);

      // 发送到订阅了 '*' 或 'Heartbeat' 的前端
      mainWindow.webContents.send('kernel:event', event);
    }
  }, 2000);
}

// ─────────────────────────────────────────────────────────────────
// 应用启动
// ─────────────────────────────────────────────────────────────────
async function startApp(): Promise<void> {
  console.log('[Main] SoloForge 启动中...');
  console.log('[Main] 版本: 1.0.0');

  // 单实例锁
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    console.log('[Main] 已有实例运行，退出');
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // 注册 IPC
  registerIpcHandlers();

  // 创建窗口和菜单
  createWindow();
  createMenu();

  // 启动心跳模拟
  startHeartbeat();

  console.log('[Main] SoloForge 启动完成');
}

app.whenReady().then(startApp);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

console.log('[Main] Electron 主进程已加载');
