/**
 * terminalLogStore — AI Agent 命令执行的真实 stdout/stderr 日志库
 *
 * 数据源:
 *   - 后端 tool_stdout / tool_stderr / tool_exit SSE 事件 (via sseBackend.ts)
 *   - 每个 tool_call 一个 instance (页签), 用 toolCallId 作 instanceId
 *   - 按 chatId 维度隔离, 与 TerminalPanel 实例多开/重命名/关闭解耦
 *
 * UI 消费:
 *   - TerminalPanel 从 useState instances 迁到本 store
 *   - useTerminalLogStore(chatId) → 取该 chat 的所有 instance
 *   - renameInstance / closeInstance / clearLogs 是本地 UI 操作, 仍走本 store
 *
 * 生命周期:
 *   - tool_started 事件 → 创建 instance, statusText='running'
 *   - tool_stdout/tool_stderr → append log item
 *   - tool_exit → 标记 isBuilding=false, statusText=`exit ${code}`
 *   - tool_completed → 兜底 (若没收到 tool_exit, 也标记结束)
 *   - clearChat / 切走 → removeChat(chatId) 释放内存
 */
import { create } from 'zustand';

export type LogType = 'info' | 'success' | 'warn' | 'error' | 'system';

export interface LogItem {
  time: string;
  type: LogType;
  msg: string;
}

export interface TerminalInstance {
  id: string;          // = toolCallId
  name: string;        // 默认 `${tool} #${shortId}`, 用户可重命名
  tool: string;        // 'execute_cmd' 等
  logItems: LogItem[];
  progress: number;    // 0..100, 简化为 exit 时 100
  isBuilding: boolean; // true=运行中, false=已结束
  statusText: string;
  autoScroll: boolean;
  /** 用户自定义重命名后的固定 name, 不再被覆盖 */
  renamed?: boolean;
  createdAt: number;
}

interface ChatTerminalState {
  instances: TerminalInstance[];
  activeInstanceId: string | null;
  /** 自增计数器, 用于实例序号命名 (1, 2, 3...) — 不随删除回退 */
  instanceCounter: number;
}

interface TerminalLogState {
  /** chatId → 该 chat 的所有终端实例 */
  chats: Record<string, ChatTerminalState>;

  // ── 来自 SSE 的事件 ─────────────────────────────────
  /** tool_started: 创建 instance (若不存在), 标记 running */
  onToolStarted: (chatId: string, toolCallId: string, tool: string, args?: string) => void;
  /** tool_stdout: append info log */
  onToolStdout: (chatId: string, toolCallId: string, chunk: string, tool: string) => void;
  /** tool_stderr: append error/warn log (按内容启发式判断) */
  onToolStderr: (chatId: string, toolCallId: string, chunk: string, tool: string) => void;
  /** tool_exit: 标记结束 + statusText */
  onToolExit: (chatId: string, toolCallId: string, exitCode: number, durationMs?: number) => void;
  /** tool_completed: 兜底, 若 instance 仍 running 则标记结束 */
  onToolCompleted: (chatId: string, toolCallId: string, success: boolean, durationMs?: number) => void;

  // ── 本地 UI 操作 ────────────────────────────────────
  setActiveInstance: (chatId: string, instanceId: string) => void;
  renameInstance: (chatId: string, instanceId: string, name: string) => void;
  closeInstance: (chatId: string, instanceId: string) => void;
  clearLogs: (chatId: string, instanceId: string) => void;
  setAutoScroll: (chatId: string, instanceId: string, val: boolean) => void;

  /**
   * 用户主动输入命令时创建实例 — 序号命名 (1, 2, 3...)
   * 与 AI 触发的 onToolStarted 区分, 但都使用同一套序号计数器
   */
  createUserInstance: (chatId: string, toolCallId: string, command: string) => void;

  /** 切走/清空 chat 时释放内存 */
  removeChat: (chatId: string) => void;

  /** 读取 (不订阅) */
  getInstances: (chatId: string) => TerminalInstance[];
  getActiveInstance: (chatId: string) => TerminalInstance | null;
}

function nowTime(): string {
  return new Date().toLocaleTimeString();
}

function defaultInstanceName(tool: string, toolCallId: string): string {
  const shortId = toolCallId.length > 8 ? toolCallId.slice(-8) : toolCallId;
  return `${tool} #${shortId}`;
}

function ensureChat(state: TerminalLogState, chatId: string): ChatTerminalState {
  if (!state.chats[chatId]) {
    return { instances: [], activeInstanceId: null, instanceCounter: 0 };
  }
  return state.chats[chatId];
}

export const useTerminalLogStore = create<TerminalLogState>((set, get) => ({
  chats: {},

  // ─────────── SSE 事件 ───────────────────────────────

  onToolStarted: (chatId, toolCallId, tool, args) => {
    set((state) => {
      const chat = ensureChat(state, chatId);
      if (chat.instances.some((i) => i.id === toolCallId)) {
        // 同一 toolCallId 收到两次 tool_started, 不重复创建
        return state;
      }
      const seq = chat.instanceCounter + 1;
      const inst: TerminalInstance = {
        id: toolCallId,
        name: String(seq),
        tool,
        logItems: args
          ? [{ time: nowTime(), type: 'system', msg: `$ ${args.slice(0, 200)}` }]
          : [],
        progress: 0,
        isBuilding: true,
        statusText: 'running',
        autoScroll: true,
        createdAt: Date.now(),
      };
      return {
        chats: {
          ...state.chats,
          [chatId]: {
            instances: [...chat.instances, inst],
            instanceCounter: seq,
            // 用户/AI 新发起命令时自动切到该 instance
            activeInstanceId: toolCallId,
          },
        },
      };
    });
  },

  onToolStdout: (chatId, toolCallId, chunk, tool) => {
    set((state) => {
      const chat = state.chats[chatId];
      if (!chat) return state;
      const inst = chat.instances.find((i) => i.id === toolCallId);
      if (!inst) {
        // 收到 stdout 但 instance 不存在 (tool_started 丢失), 自动创建
        const seq = chat.instanceCounter + 1;
        const newInst: TerminalInstance = {
          id: toolCallId,
          name: String(seq),
          tool,
          logItems: [{ time: nowTime(), type: 'info', msg: chunk }],
          progress: 0,
          isBuilding: true,
          statusText: 'running',
          autoScroll: true,
          createdAt: Date.now(),
        };
        return {
          chats: {
            ...state.chats,
            [chatId]: {
              instances: [...chat.instances, newInst],
              instanceCounter: seq,
              activeInstanceId: toolCallId,
            },
          },
        };
      }
      return {
        chats: {
          ...state.chats,
          [chatId]: {
            ...chat,
            instances: chat.instances.map((i) =>
              i.id === toolCallId
                ? { ...i, logItems: [...i.logItems, { time: nowTime(), type: 'info', msg: chunk }] }
                : i
            ),
          },
        },
      };
    });
  },

  onToolStderr: (chatId, toolCallId, chunk, tool) => {
    set((state) => {
      const chat = state.chats[chatId];
      if (!chat) return state;
      // 启发式: 包含 error/Error/ERROR 的算 error, 否则 warn
      const isErr = /\b(error|fatal|failed|exception)\b/i.test(chunk);
      const inst = chat.instances.find((i) => i.id === toolCallId);
      if (!inst) {
        const seq = chat.instanceCounter + 1;
        const newInst: TerminalInstance = {
          id: toolCallId,
          name: String(seq),
          tool,
          logItems: [{ time: nowTime(), type: isErr ? 'error' : 'warn', msg: chunk }],
          progress: 0,
          isBuilding: true,
          statusText: 'running',
          autoScroll: true,
          createdAt: Date.now(),
        };
        return {
          chats: {
            ...state.chats,
            [chatId]: {
              instances: [...chat.instances, newInst],
              instanceCounter: seq,
              activeInstanceId: chat.activeInstanceId ?? toolCallId,
            },
          },
        };
      }
      return {
        chats: {
          ...state.chats,
          [chatId]: {
            ...chat,
            instances: chat.instances.map((i) =>
              i.id === toolCallId
                ? { ...i, logItems: [...i.logItems, { time: nowTime(), type: isErr ? 'error' : 'warn', msg: chunk }] }
                : i
            ),
          },
        },
      };
    });
  },

  onToolExit: (chatId, toolCallId, exitCode, durationMs) => {
    set((state) => {
      const chat = state.chats[chatId];
      if (!chat) return state;
      return {
        chats: {
          ...state.chats,
          [chatId]: {
            ...chat,
            instances: chat.instances.map((i) =>
              i.id === toolCallId
                ? {
                    ...i,
                    isBuilding: false,
                    progress: 100,
                    statusText: `exit ${exitCode}${durationMs ? ` (${durationMs}ms)` : ''}`,
                    logItems:
                      exitCode === 0
                        ? i.logItems
                        : [
                            ...i.logItems,
                            { time: nowTime(), type: 'error', msg: `[exit ${exitCode}]` },
                          ],
                  }
                : i
            ),
          },
        },
      };
    });
  },

  onToolCompleted: (chatId, toolCallId, success, durationMs) => {
    set((state) => {
      const chat = state.chats[chatId];
      if (!chat) return state;
      return {
        chats: {
          ...state.chats,
          [chatId]: {
            ...chat,
            instances: chat.instances.map((i) => {
              if (i.id !== toolCallId) return i;
              // 若已通过 tool_exit 标记结束, 不覆盖
              if (!i.isBuilding) return i;
              return {
                ...i,
                isBuilding: false,
                progress: 100,
                statusText: success
                  ? `done${durationMs ? ` (${durationMs}ms)` : ''}`
                  : `failed${durationMs ? ` (${durationMs}ms)` : ''}`,
              };
            }),
          },
        },
      };
    });
  },

  // ─────────── 本地 UI 操作 ────────────────────────────

  /**
   * 用户主动输入命令时创建实例.
   * 与 AI 触发的 onToolStarted 共用 instanceCounter, 保证序号唯一递增.
   */
  createUserInstance: (chatId, toolCallId, command) => {
    set((state) => {
      const chat = ensureChat(state, chatId);
      if (chat.instances.some((i) => i.id === toolCallId)) return state;
      const seq = chat.instanceCounter + 1;
      const inst: TerminalInstance = {
        id: toolCallId,
        name: String(seq),
        tool: 'execute_cmd',
        logItems: [{ time: nowTime(), type: 'system', msg: `$ ${command}` }],
        progress: 0,
        isBuilding: true,
        statusText: 'running',
        autoScroll: true,
        createdAt: Date.now(),
      };
      return {
        chats: {
          ...state.chats,
          [chatId]: {
            instances: [...chat.instances, inst],
            instanceCounter: seq,
            activeInstanceId: toolCallId,
          },
        },
      };
    });
  },

  setActiveInstance: (chatId, instanceId) => {
    set((state) => {
      const chat = state.chats[chatId];
      if (!chat) return state;
      return {
        chats: { ...state.chats, [chatId]: { ...chat, activeInstanceId: instanceId } },
      };
    });
  },

  renameInstance: (chatId, instanceId, name) => {
    const clean = name.trim();
    if (!clean) return;
    set((state) => {
      const chat = state.chats[chatId];
      if (!chat) return state;
      return {
        chats: {
          ...state.chats,
          [chatId]: {
            ...chat,
            instances: chat.instances.map((i) =>
              i.id === instanceId ? { ...i, name: clean, renamed: true } : i
            ),
          },
        },
      };
    });
  },

  closeInstance: (chatId, instanceId) => {
    set((state) => {
      const chat = state.chats[chatId];
      if (!chat) return state;
      const remaining = chat.instances.filter((i) => i.id !== instanceId);
      const nextActive =
        chat.activeInstanceId === instanceId
          ? (remaining[remaining.length - 1]?.id ?? null)
          : chat.activeInstanceId;
      return {
        chats: { ...state.chats, [chatId]: { ...chat, instances: remaining, activeInstanceId: nextActive } },
      };
    });
  },

  clearLogs: (chatId, instanceId) => {
    set((state) => {
      const chat = state.chats[chatId];
      if (!chat) return state;
      return {
        chats: {
          ...state.chats,
          [chatId]: {
            ...chat,
            instances: chat.instances.map((i) =>
              i.id === instanceId ? { ...i, logItems: [] } : i
            ),
          },
        },
      };
    });
  },

  setAutoScroll: (chatId, instanceId, val) => {
    set((state) => {
      const chat = state.chats[chatId];
      if (!chat) return state;
      return {
        chats: {
          ...state.chats,
          [chatId]: {
            ...chat,
            instances: chat.instances.map((i) =>
              i.id === instanceId ? { ...i, autoScroll: val } : i
            ),
          },
        },
      };
    });
  },

  removeChat: (chatId) => {
    set((state) => {
      if (!state.chats[chatId]) return state;
      const next = { ...state.chats };
      delete next[chatId];
      return { chats: next };
    });
  },

  getInstances: (chatId) => get().chats[chatId]?.instances ?? [],
  getActiveInstance: (chatId) => {
    const chat = get().chats[chatId];
    if (!chat) return null;
    if (!chat.activeInstanceId) return chat.instances[0] ?? null;
    return chat.instances.find((i) => i.id === chat.activeInstanceId) ?? chat.instances[0] ?? null;
  },
}));

// 调试导出 (生产环境可保留, 仅用于运行时状态检查)
if (typeof window !== 'undefined') {
  (window as any).__terminalLogStore = useTerminalLogStore;
}
