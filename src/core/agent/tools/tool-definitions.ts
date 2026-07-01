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
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
];

// ─── Tool 执行器 ────────────────────────────────────────────────────

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, any>;
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

export async function executeToolCall(request: ToolCallRequest): Promise<ToolCallResult> {
  const start = Date.now();

  try {
    let output: string;

    switch (request.name) {
      case 'read_file': {
        const filePath = resolvePath(request.arguments.file_path);
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
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, request.arguments.content, 'utf-8');
        output = `Successfully wrote ${request.arguments.content.length} chars to ${request.arguments.file_path}`;
        break;
      }

      case 'execute_cmd': {
        const cwd = request.arguments.cwd
          ? resolvePath(request.arguments.cwd)
          : PROJECT_ROOT;
        const { stdout, stderr } = await execAsync(request.arguments.command, {
          cwd,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim();
        if (output.length > 5000) {
          output = output.slice(-5000) + '\n... (truncated)';
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
          : PROJECT_ROOT;
        const pattern = request.arguments.pattern ?? '*';
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        output = entries
          .slice(0, 100)
          .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
          .join('\n');
        break;
      }

      default:
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
