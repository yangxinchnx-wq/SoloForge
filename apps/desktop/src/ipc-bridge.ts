// ─────────────────────────────────────────────────────────────────
// SoloForge Electron IPC Bridge
// 桥接 RuntimeKernel EventBus 到 Electron IPC
// ─────────────────────────────────────────────────────────────────

const electron = require('electron');
const { ipcMain, BrowserWindow, WebContents } = electron;

// 核心模块引用 (由 main.ts 设置)
export let kernel: any = null;
export let RuntimeEvent: any = null;

/**
 * 设置核心模块引用
 */
export function setCoreModules(k: any, re: any): void {
  kernel = k;
  RuntimeEvent = re;
}

interface IpcHandler {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface Subscription {
  eventName: string;
  callback: (payload: any) => void;
}

export class IpcBridge {
  private static instance: IpcBridge | null = null;
  private webContents: WebContents | null = null;
  private subscriptions: Map<string, Subscription[]> = new Map();
  private pendingRequests: Map<string, IpcHandler> = new Map();
  private requestIdCounter = 0;

  private constructor() {}

  public static getInstance(): IpcBridge {
    if (!IpcBridge.instance) {
      IpcBridge.instance = new IpcBridge();
    }
    return IpcBridge.instance;
  }

  /**
   * 设置 WebContents 用于向渲染进程发送事件
   */
  public setWebContents(webContents: WebContents): void {
    this.webContents = webContents;
  }

  private persistence: any = null;
  private scheduler: any = null;

  /**
   * 设置持久化管理器
   */
  public setPersistence(persistence: any): void {
    this.persistence = persistence;
  }

  /**
   * 设置调度器客户端
   */
  public setScheduler(scheduler: any): void {
    this.scheduler = scheduler;
  }

  /**
   * 初始化 IPC 处理器
   */
  public initialize(): void {
    this.registerKernelHandlers();
    this.registerDatabaseHandlers();
    this.registerSchedulerHandlers();
    this.registerEventHandlers();
    this.subscribeToKernelEvents();
    console.log('[IPC Bridge] 初始化完成');
  }

  /**
   * 注册内核查询处理器
   */
  private registerKernelHandlers(): void {
    // 获取内核状态
    ipcMain.handle('kernel:status', () => {
      if (!kernel) return { state: 'loading', mode: 'unknown', version: 0, startedAt: 0 };
      return {
        state: kernel.getState?.() || 'running',
        mode: kernel.getMode?.() || 'autonomous',
        version: kernel.version || 1,
        startedAt: kernel.startedAt || Date.now()
      };
    });

    // 获取组件列表
    ipcMain.handle('kernel:components', () => {
      const components = kernel?.components;
      if (components instanceof Map) {
        return Array.from(components.keys());
      }
      return [];
    });

    // 健康检查
    ipcMain.handle('kernel:health', async () => {
      try {
        const healthy = kernel?.healthCheck ? await kernel.healthCheck() : true;
        return { healthy, state: kernel?.getState?.() || 'running' };
      } catch (e) {
        return { healthy: false, error: (e as Error).message };
      }
    });

    // 获取事件日志
    ipcMain.handle('kernel:events', (_, limit?: number) => {
      if (!kernel?.eventBus) return [];
      const events = kernel.eventBus.getEventLog?.() || [];
      return limit ? events.slice(-limit) : events;
    });

    // 获取域所有权
    ipcMain.handle('kernel:ownership', (_, domain: string) => {
      const patterns = kernel?.stateOwnership?.getOwnershipPatterns?.(domain) || [];
      return { domain, patterns };
    });

    console.log('[IPC Bridge] 内核查询处理器已注册');
  }

  /**
   * 注册数据库操作处理器
   */
  private registerDatabaseHandlers(): void {
    // 执行 SQL 查询
    ipcMain.handle('db:query', async (_, sql: string, params?: Record<string, any>) => {
      if (!this.persistence) {
        return { error: 'Persistence not initialized' };
      }
      try {
        const result = await this.persistence.query(sql, params);
        return { success: true, data: result };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    });

    // 获取 Schema 信息
    ipcMain.handle('db:schema', async () => {
      return {
        tables: [
          'migration_history',
          'system_config',
          'decision',
          'candidate',
          'decision_strategy',
          'evidence',
          'courtSubmission',
          'courtVerdict',
          'courtJuror',
          'marlEpisode',
          'policySnapshot',
          'governorState',
          'governorPolicy',
          'eventLog',
          'traceLinkage',
          'eventSequence',
          'replaySession',
          'auditCompliance'
        ],
        namespaces: ['soloforge_core'],
        databases: ['autonomous_network']
      };
    });

    // 获取表列表
    ipcMain.handle('db:tables', async () => {
      return [
        'migration_history',
        'system_config',
        'decision',
        'candidate',
        'decision_strategy',
        'evidence',
        'courtSubmission',
        'courtVerdict',
        'courtJuror',
        'marlEpisode',
        'policySnapshot',
        'governorState',
        'governorPolicy',
        'eventLog',
        'traceLinkage',
        'eventSequence',
        'replaySession',
        'auditCompliance'
      ];
    });

    console.log('[IPC Bridge] 数据库操作处理器已注册');
  }

  /**
   * 注册调度器处理器
   */
  private registerSchedulerHandlers(): void {
    // 获取调度器统计
    ipcMain.handle('scheduler:stats', async () => {
      if (!this.scheduler) {
        return { mode: 'stub', queueSize: 0 };
      }
      try {
        const stats = await this.scheduler.getStats?.();
        return { mode: 'rust', stats };
      } catch (e) {
        return { mode: 'error', error: (e as Error).message };
      }
    });

    // 获取队列内容
    ipcMain.handle('scheduler:queue', async () => {
      return [];
    });

    console.log('[IPC Bridge] 调度器处理器已注册');
  }

  /**
   * 注册事件订阅处理器
   */
  private registerEventHandlers(): void {
    // 订阅事件
    ipcMain.handle('event:subscribe', (_, eventName: string) => {
      if (!this.subscriptions.has(eventName)) {
        this.subscriptions.set(eventName, []);
      }
      return { subscribed: eventName, success: true };
    });

    // 取消订阅
    ipcMain.handle('event:unsubscribe', (_, eventName: string) => {
      this.subscriptions.delete(eventName);
      return { unsubscribed: eventName, success: true };
    });

    // 获取已订阅事件列表
    ipcMain.handle('event:list', () => {
      return Array.from(this.subscriptions.keys());
    });

    console.log('[IPC Bridge] 事件订阅处理器已注册');
  }

  /**
   * 订阅内核事件并转发到渲染进程
   */
  private subscribeToKernelEvents(): void {
    if (!kernel || !RuntimeEvent) {
      console.warn('[IPC Bridge] 核心模块未加载，跳过事件订阅');
      return;
    }

    const coreEvents = [
      RuntimeEvent.Heartbeat,
      RuntimeEvent.KernelInitialized,
      RuntimeEvent.RuntimeModeChanged,
      RuntimeEvent.RuntimeShutdown,
      RuntimeEvent.CommandAccepted,
      RuntimeEvent.CommandRejected,
      RuntimeEvent.TransactionCommitted,
      RuntimeEvent.TransactionRolledBack,
      RuntimeEvent.CourtPhase1Completed,
      RuntimeEvent.CourtPhase2Completed,
      RuntimeEvent.SpanRecorded,
      RuntimeEvent.AuditRecorded
    ];

    for (const eventName of coreEvents) {
      this.subscribeToEvent(eventName);
    }

    console.log(`[IPC Bridge] 已订阅 ${coreEvents.length} 个内核事件`);
  }

  /**
   * 订阅单个事件
   */
  private subscribeToEvent(eventName: string): void {
    if (!kernel) {
      console.warn('[IPC Bridge] kernel 未加载，跳过事件订阅:', eventName);
      return;
    }

    kernel.eventBus?.on(eventName, (payload: any) => {
      this.forwardEvent(eventName, payload);

      const callbacks = this.subscriptions.get(eventName);
      if (callbacks) {
        for (const sub of callbacks) {
          try {
            sub.callback(payload);
          } catch (e) {
            console.error(`[IPC Bridge] 订阅回调错误:`, e);
          }
        }
      }
    });
  }

  /**
   * 转发事件到渲染进程
   */
  private forwardEvent(eventName: string, payload: any): void {
    if (!this.webContents || this.webContents.isDestroyed()) {
      return;
    }

    try {
      this.webContents.send('kernel:event', {
        event: eventName,
        payload,
        timestamp: Date.now()
      });
    } catch (e) {
      console.error(`[IPC Bridge] 转发事件失败:`, e);
    }
  }

  /**
   * 执行命令
   */
  public async executeCommand(type: string, domain: string, payload: any): Promise<any> {
    return kernel?.executeCommand?.({ type, domain, caller: 'ELECTRON_UI', payload });
  }

  /**
   * 清理资源
   */
  public destroy(): void {
    this.subscriptions.clear();
    this.pendingRequests.clear();
    IpcBridge.instance = null;
    console.log('[IPC Bridge] 已销毁');
  }
}

// 导出单例获取函数
export function getIpcBridge(): IpcBridge {
  return IpcBridge.getInstance();
}
