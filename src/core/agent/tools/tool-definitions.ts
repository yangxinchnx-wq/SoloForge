/**
 * tool-definitions.ts — Agent 可用的内置工具定义
 *
 * 遵循 OpenAI Function Calling 协议:
 *   tools: [{ type: 'function', function: { name, description, parameters } }]
 *
 * 工具列表:
 *   - read_file:    读取项目文件
 *   - write_file:   写入项目文件
 *   - execute_cmd:  执行终端命令
 *   - search_code:  搜索代码内容
 *   - list_files:   列出目录文件
 */

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

// ─── Tool Schema (OpenAI Function Calling 格式) ─────────────────────

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required: string[];
    };
  };
}

export const AGENT_TOOLS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取项目中的文件内容。返回文件的完整文本。用于理解现有代码、查看配置文件等。',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '文件的绝对路径或相对于项目根目录的相对路径',
          },
          offset: {
            type: 'number',
            description: '从第几行开始读取（可选，默认从第 1 行）',
          },
          limit: {
            type: 'number',
            description: '最多读取多少行（可选，默认读取全部）',
          },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '将内容写入项目文件。如果文件不存在会自动创建（包括父目录）。用于生成代码、配置文件等。',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '文件的绝对路径或相对于项目根目录的相对路径',
          },
          content: {
            type: 'string',
            description: '要写入的文件内容',
          },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_cmd',
      description: '在项目根目录下执行终端命令。用于运行构建、测试、安装依赖等。超时 30 秒。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的命令（如 npm test, tsc --noEmit）',
          },
          cwd: {
            type: 'string',
            description: '工作目录（可选，默认项目根目录）',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: '在项目中搜索代码内容（基于正则表达式）。返回匹配的文件路径和行号。用于查找函数定义、引用、配置项等。',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: '正则表达式搜索模式',
          },
          glob: {
            type: 'string',
            description: '文件过滤 glob 模式（可选，如 *.ts, *.tsx）',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出指定目录下的文件和子目录。用于了解项目结构。',
      parameters: {
        type: 'object',
        properties: {
          dir_path: {
            type: 'string',
            description: '目录路径（可选，默认项目根目录）',
          },
          pattern: {
            type: 'string',
            description: 'glob 匹配模式（可选，如 **/*.ts）',
          },
        },
        required: [],
      },
    },
  },
  // ── 画布工具（solo_canvas_*）──
  // Schema 来自 UI 端 UI/src/server/routes/canvasTools.ts:47-162
  // 通过 HTTP POST {SOLOFORGE_UI_BASE_URL}/api/canvas/tools/invoke 调用
  {
    type: 'function',
    function: {
      name: 'solo_canvas_list',
      description: '列出所有可用画布（公开的 + 自己创建的）。返回 sessionId、displayName、description、ownerChatSessionId、设备数量。',
      parameters: {
        type: 'object',
        properties: {
          requesterChatSessionId: { type: 'string', description: '当前对话的 chat session ID（用于 ACL）' },
        },
        required: ['requesterChatSessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'solo_canvas_get',
      description: '获取画布完整状态：选中的设备、设备列表、背景色、备注等。canvasId 可不传——系统会自动用当前会话绑定的画布。',
      parameters: {
        type: 'object',
        properties: {
          canvasId: { type: 'string', description: '画布 ID，如 canvas_1（可选；不传时使用当前会话绑定的画布）' },
          requesterChatSessionId: { type: 'string' },
        },
        required: ['requesterChatSessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'solo_canvas_create',
      description: '创建一个新画布。返回创建的画布 ID 和 displayName。',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '画布备注（可选）' },
          requesterChatSessionId: { type: 'string' },
        },
        required: ['requesterChatSessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'solo_canvas_add_device',
      description: '向画布添加一个 3D 设备（iPhone / iPad / MacBook 等）。canvasId 可不传——系统会自动用当前会话绑定的画布。',
      parameters: {
        type: 'object',
        properties: {
          canvasId: { type: 'string', description: '画布 ID（可选；不传时使用当前会话绑定的画布）' },
          device: { type: 'string', description: '设备 JSON 对象（modelKey/xRatio/yRatio 等）' },
          requesterChatSessionId: { type: 'string' },
        },
        required: ['device', 'requesterChatSessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'solo_canvas_update_device',
      description: '更新画布上的某个设备（位置、颜色、UI session 等）。canvasId 可不传——系统会自动用当前会话绑定的画布。',
      parameters: {
        type: 'object',
        properties: {
          canvasId: { type: 'string', description: '画布 ID（可选；不传时使用当前会话绑定的画布）' },
          deviceId: { type: 'string' },
          updates: { type: 'string', description: '要更新的字段 JSON 字符串' },
          requesterChatSessionId: { type: 'string' },
        },
        required: ['deviceId', 'updates', 'requesterChatSessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'solo_canvas_remove_device',
      description: '从画布移除指定设备。canvasId 可不传——系统会自动用当前会话绑定的画布。',
      parameters: {
        type: 'object',
        properties: {
          canvasId: { type: 'string', description: '画布 ID（可选；不传时使用当前会话绑定的画布）' },
          deviceId: { type: 'string' },
          requesterChatSessionId: { type: 'string' },
        },
        required: ['deviceId', 'requesterChatSessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'solo_canvas_rename',
      description: '修改画布的备注 / 描述（仅 owner 可调）。canvasId 可不传——系统会自动用当前会话绑定的画布。',
      parameters: {
        type: 'object',
        properties: {
          canvasId: { type: 'string', description: '画布 ID（可选；不传时使用当前会话绑定的画布）' },
          description: { type: 'string' },
          requesterChatSessionId: { type: 'string' },
        },
        required: ['description', 'requesterChatSessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'solo_canvas_delete',
      description: '删除整个画布（仅 owner 可调，慎用）。canvasId 可不传——系统会自动用当前会话绑定的画布。',
      parameters: {
        type: 'object',
        properties: {
          canvasId: { type: 'string', description: '画布 ID（可选；不传时使用当前会话绑定的画布）' },
          requesterChatSessionId: { type: 'string' },
        },
        required: ['requesterChatSessionId'],
      },
    },
  },
];

// ─── Tool 执行器 ────────────────────────────────────────────────────

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, any>;
  /**
   * 可选: 流式事件注入点 (主要给 execute_cmd 用)。
   * 命中时, spawn 的 stdout/stderr data 事件会被实时 emit 到 streamHook,
   * 由 agent-loop → kernel.eventBus → SSE → 前端 TerminalPanel 实时显示。
   */
  streamHook?: ToolStreamHook;
  /** 工作区文件夹路径 (用于路径强制校验, 为空则不校验) */
  workspaceFolder?: string;
}

/**
 * 工具流式事件钩子。
 * - eventName='tool_stdout' / 'tool_stderr' / 'tool_exit'
 * - payload.toolCallId 与 ToolCallRequest.id 对齐, 前端按此路由到对应终端页签
 */
export type ToolStreamEmit = (
  eventName: 'tool_stdout' | 'tool_stderr' | 'tool_exit',
  payload: {
    chatId: string;
    subTaskId: string;
    toolCallId: string;
    tool: string;
    chunk?: string;
    exitCode?: number;
    durationMs?: number;
    ts: number;
  },
) => void;

export interface ToolStreamHook {
  chatId: string;
  subTaskId: string;
  emit: ToolStreamEmit;
}

export interface ToolCallResult {
  tool_call_id: string;
  name: string;
  output: string;
  isError: boolean;
  durationMs: number;
}

const PROJECT_ROOT = path.resolve(
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')),
  '../../../../'
);

function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(PROJECT_ROOT, filePath);
}

/**
 * 检查目标路径是否在工作区文件夹范围内
 * @returns true 如果路径在工作区内或没有工作区限制
 */
function isPathWithinWorkspace(targetPath: string, workspaceFolder?: string): boolean {
  if (!workspaceFolder) return true; // 没有绑定工作区, 不限制
  const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(workspaceFolder, targetPath);
  const normalizedTarget = path.normalize(resolved);
  const normalizedWs = path.normalize(workspaceFolder);
  // 检查 target 是否以 workspace 开头
  return normalizedTarget === normalizedWs || normalizedTarget.startsWith(normalizedWs + path.sep);
}

/**
 * 如果路径不在工作区内, 返回错误消息
 */
function checkWorkspaceBoundary(targetPath: string, workspaceFolder?: string): string | null {
  if (!workspaceFolder) return null;
  if (isPathWithinWorkspace(targetPath, workspaceFolder)) return null;
  return `路径 "${targetPath}" 不在工作区文件夹 "${workspaceFolder}" 范围内。当前对话已绑定工作区, 文件操作仅限于此文件夹内。如需操作外部文件, 请在对话中告知用户并请求授权。`;
}

// ─── 画布 HTTP 转发 ────────────────────────────────────────────────
// 后端 Agent 进程 → UI 进程 (跨进程 HTTP) → SessionStore
// UI_BASE_URL 默认指向 Vite dev server；Electron 生产环境由主进程注入覆盖
const UI_BASE_URL = process.env.SOLOFORGE_UI_BASE_URL || 'http://localhost:3000';

async function invokeCanvasToolViaUI(
  toolName: string,
  args: Record<string, any>
): Promise<string> {
  const requesterChatSessionId = args.requesterChatSessionId;
  if (!requesterChatSessionId) {
    return `Error: ${toolName} requires 'requesterChatSessionId' arg`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Requester-Chat-Session-Id': requesterChatSessionId,
  };

  try {
    const res = await fetch(`${UI_BASE_URL}/api/canvas/tools/invoke`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: toolName, arguments: args }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      payload?: unknown;
      error?: string;
    };

    if (!res.ok || data.success !== true) {
      return `Error: ${data.error || `HTTP ${res.status}`}`;
    }

    if (data.payload === undefined || data.payload === null) {
      return 'OK';
    }
    return typeof data.payload === 'string'
      ? data.payload
      : JSON.stringify(data.payload, null, 2);
  } catch (err) {
    return `Error: failed to call UI canvas endpoint (${UI_BASE_URL}): ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

export async function executeToolCall(request: ToolCallRequest): Promise<ToolCallResult> {
  const start = Date.now();

  try {
    let output: string;

    switch (request.name) {
      case 'read_file': {
        const filePath = resolvePath(request.arguments.file_path);
        const boundaryErr = checkWorkspaceBoundary(filePath, request.workspaceFolder);
        if (boundaryErr) {
          output = boundaryErr;
          break;
        }
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const offset = (request.arguments.offset ?? 1) - 1;
        const limit = request.arguments.limit ?? lines.length;
        const slice = lines.slice(offset, offset + limit);
        output = slice.join('\n');
        if (output.length > 10000) {
          output = output.slice(0, 10000) + '\n... (truncated, total ' + content.length + ' chars)';
        }
        break;
      }

      case 'write_file': {
        const filePath = resolvePath(request.arguments.file_path);
        const boundaryErr = checkWorkspaceBoundary(filePath, request.workspaceFolder);
        if (boundaryErr) {
          output = boundaryErr;
          break;
        }
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, request.arguments.content, 'utf-8');
        output = `Successfully wrote ${request.arguments.content.length} chars to ${request.arguments.file_path}`;
        break;
      }

      case 'execute_cmd': {
        const cwd = request.arguments.cwd
          ? resolvePath(request.arguments.cwd)
          : (request.workspaceFolder || PROJECT_ROOT);
        const boundaryErr = checkWorkspaceBoundary(cwd, request.workspaceFolder);
        if (boundaryErr) {
          output = boundaryErr;
          break;
        }
        const command = String(request.arguments.command || '');
        const hook = request.streamHook;
        const toolStart = Date.now();

        // 跨平台 spawn: 在 Windows 上用 cmd /c, 在 *nix 上用 sh -c
        const isWin = process.platform === 'win32';
        const child = isWin
          ? spawn('cmd.exe', ['/c', command], { cwd, windowsHide: true })
          : spawn('sh', ['-c', command], { cwd });

        let stdoutBuf = '';
        let stderrBuf = '';

        const pushStdout = (chunk: string) => {
          stdoutBuf += chunk;
          if (hook) {
            try {
              hook.emit('tool_stdout', {
                chatId: hook.chatId,
                subTaskId: hook.subTaskId,
                toolCallId: request.id,
                tool: 'execute_cmd',
                chunk,
                ts: Date.now(),
              });
            } catch { /* emit 失败不影响执行 */ }
          }
        };
        const pushStderr = (chunk: string) => {
          stderrBuf += chunk;
          if (hook) {
            try {
              hook.emit('tool_stderr', {
                chatId: hook.chatId,
                subTaskId: hook.subTaskId,
                toolCallId: request.id,
                tool: 'execute_cmd',
                chunk,
                ts: Date.now(),
              });
            } catch { /* emit 失败不影响执行 */ }
          }
        };

        child.stdout?.on('data', (data: Buffer) => pushStdout(data.toString('utf-8')));
        child.stderr?.on('data', (data: Buffer) => pushStderr(data.toString('utf-8')));

        const exitCode: number = await new Promise((resolve) => {
          child.on('close', (code: number | null) => resolve(code ?? 0));
          child.on('error', (err: Error) => {
            pushStderr(`\n[spawn error] ${err.message}\n`);
            resolve(1);
          });
          // 兜底超时: 30s
          setTimeout(() => {
            try { child.kill('SIGTERM'); } catch { /* ignore */ }
            resolve(124);
          }, 30000);
        });

        const durationMs = Date.now() - toolStart;
        if (hook) {
          try {
            hook.emit('tool_exit', {
              chatId: hook.chatId,
              subTaskId: hook.subTaskId,
              toolCallId: request.id,
              tool: 'execute_cmd',
              exitCode,
              durationMs,
              ts: Date.now(),
            });
          } catch { /* ignore */ }
        }

        output = (stdoutBuf + (stderrBuf ? `\n[stderr]\n${stderrBuf}` : '')).trim();
        if (output.length > 5000) {
          output = output.slice(-5000) + '\n... (truncated)';
        }
        if (exitCode !== 0) {
          // 仍走 isError 分支, 让 LLM 知道命令失败
          return {
            tool_call_id: request.id,
            name: 'execute_cmd',
            output: output + `\n[exit ${exitCode}]`,
            isError: true,
            durationMs,
          };
        }
        break;
      }

      case 'search_code': {
        const regex = new RegExp(request.arguments.pattern, 'i');
        const matches: string[] = [];
        const maxResults = 30;

        async function searchDir(dir: string, depth: number): Promise<void> {
          if (depth > 5 || matches.length >= maxResults) return;
          let entries;
          try {
            entries = await fs.readdir(dir, { withFileTypes: true });
          } catch { return; }
          for (const entry of entries) {
            if (matches.length >= maxResults) break;
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await searchDir(fullPath, depth + 1);
            } else if (entry.isFile()) {
              if (request.arguments.glob) {
                const ext = request.arguments.glob.replace('*', '');
                if (!entry.name.endsWith(ext)) continue;
              }
              try {
                const content = await fs.readFile(fullPath, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
                  if (regex.test(lines[i])) {
                    const rel = path.relative(PROJECT_ROOT, fullPath);
                    matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                  }
                }
              } catch { /* skip binary files */ }
            }
          }
        }

        await searchDir(PROJECT_ROOT, 0);
        output = matches.length > 0 ? matches.join('\n') : 'No matches found.';
        break;
      }

      case 'list_files': {
        const dirPath = request.arguments.dir_path
          ? resolvePath(request.arguments.dir_path)
          : (request.workspaceFolder || PROJECT_ROOT);
        const boundaryErr = checkWorkspaceBoundary(dirPath, request.workspaceFolder);
        if (boundaryErr) {
          output = boundaryErr;
          break;
        }
        const pattern = request.arguments.pattern ?? '*';
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        output = entries
          .slice(0, 100)
          .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
          .join('\n');
        break;
      }

      // ─── 画布工具（solo_canvas_*）──
      // 转发到 UI 进程 UI/src/server/routes/canvasTools.ts 的 HTTP 端点
      // UI_BASE_URL 默认 http://localhost:3000（Vite dev server），
      // Electron 生产环境由主进程注入（见 electron/main.cjs）
      default:
        if (request.name.startsWith('solo_canvas_')) {
          output = await invokeCanvasToolViaUI(request.name, request.arguments);
          break;
        }
        output = `Unknown tool: ${request.name}`;
    }

    return {
      tool_call_id: request.id,
      name: request.name,
      output,
      isError: false,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      tool_call_id: request.id,
      name: request.name,
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
      durationMs: Date.now() - start,
    };
  }
}
