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
  // ── canvas_push_ui: 直接推送 UI AST 到画布 (核心断路修复) ──
  // 让 LLM/Agent 能通过 tool_call 直接推送 Universal AST 到 Flutter 画布,
  // 不再依赖前端 tryLocalTranslateAndPush 从文本提取代码块。
  // 链路: Agent tool_call → executeToolCall → POST /api/canvas/relay/push-ui → Flutter /render
  {
    type: 'function',
    function: {
      name: 'canvas_push_ui',
      description: 'Push a Universal AST UI tree directly to the Flutter canvas for immediate rendering. Use this tool when the user asks to draw/render/display UI on the canvas. The dsl is a UniversalNode tree (JSON object with type, children, props). The sessionId identifies which canvas to push to.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Canvas session ID (the chat session ID). The relay will look up the registered Flutter port for this session.',
          },
          dsl: {
            type: 'object',
            description: 'Universal AST node tree. Root node has {type, children, props}. Example: {"type":"column","children":[{"type":"text","props":{"data":"Hello World"}}]}',
          },
          language: {
            type: 'string',
            description: 'Source language of the UI code (e.g. html, dart, typescript). Optional, defaults to typescript.',
          },
        },
        required: ['sessionId', 'dsl'],
      },
    },
  },
];

/** 核心工具名称集合 (始终可用, 不受 activeTools 过滤影响) */
const CORE_TOOL_NAMES = new Set([
  'read_file', 'write_file', 'execute_cmd', 'search_code', 'list_files',
  'canvas_push_ui', // 断路修复: 画布推送工具始终可用
]);

/**
 * 扩展工具 schema (对应前端 ResourceManagerBar 中可选的浏览器/Windows 工具)
 * 这些工具的 ID 与 UI/resources/tools/manifest.json 中的 children[].id 一一对应
 */
export const EXTENDED_TOOL_SCHEMAS: ToolSchema[] = [
  // ── Obscura 浏览器工具 ──
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: '对指定 URL 的网页进行高清截图。返回截图保存路径。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要截图的网页 URL' },
          selector: { type: 'string', description: 'CSS 选择器, 仅截取匹配元素 (可选)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_devtools',
      description: '打开 Chrome DevTools 调试指定网页。返回页面概要信息。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要调试的网页 URL' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_console',
      description: '实时捕获指定网页的浏览器控制台日志。返回最近的日志条目。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标网页 URL' },
          lines: { type: 'number', description: '返回最近多少条日志 (可选, 默认 50)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network',
      description: '拦截并分析指定网页的网络请求。返回请求列表 (URL/方法/状态码/耗时)。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标网页 URL' },
          filter: { type: 'string', description: 'URL 过滤关键词 (可选)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_dom_inspect',
      description: '检查指定网页的 DOM 树结构。返回简化版的 DOM 树。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标网页 URL' },
          selector: { type: 'string', description: 'CSS 选择器, 仅检查匹配的元素 (可选)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_perf_trace',
      description: '对指定网页进行性能追踪分析。返回页面加载与渲染性能报告。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标网页 URL' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_cookies',
      description: '读取或写入指定域名的浏览器 Cookie。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标网页 URL' },
          action: { type: 'string', description: '操作类型: get (读取) 或 set (写入)' },
          name: { type: 'string', description: 'Cookie 名称 (set 时必填)' },
          value: { type: 'string', description: 'Cookie 值 (set 时必填)' },
        },
        required: ['url', 'action'],
      },
    },
  },
  // ── Browser-Use 任务编排工具 ──
  {
    type: 'function',
    function: {
      name: 'bu_run_task',
      description: '用自然语言描述一个浏览器任务, LLM 自动规划并执行步骤。返回任务 ID 和执行结果。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '自然语言任务描述 (如 "打开 GitHub 并搜索 SoloForge")' },
          url: { type: 'string', description: '起始页面 URL (可选)' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bu_pause',
      description: '暂停正在执行的浏览器任务。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务 ID' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bu_resume',
      description: '恢复已暂停的浏览器任务。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务 ID' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bu_state',
      description: '查询浏览器任务的执行状态与进度。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务 ID' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bu_screenshot',
      description: '对浏览器任务当前页面进行截图。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务 ID' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bu_history',
      description: '查看浏览器任务的 ReAct 推理历史与执行轨迹。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务 ID' },
        },
        required: ['task_id'],
      },
    },
  },
  // ── Windows-MCP 系统自动化工具 ──
  {
    type: 'function',
    function: {
      name: 'win_reg_read',
      description: '读取 Windows 注册表键值。返回键值数据。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '注册表路径 (如 HKLM\\Software\\Microsoft\\Windows\\CurrentVersion)' },
          name: { type: 'string', description: '键值名称 (可选, 不传则返回所有子键)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'win_service_ctrl',
      description: '管理 Windows 系统服务 (启动/停止/查询状态)。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '操作: start / stop / status / list' },
          name: { type: 'string', description: '服务名称 (list 操作可不传)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'win_task_scheduler',
      description: '创建或管理 Windows 系统定时任务。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '操作: create / delete / list / run' },
          name: { type: 'string', description: '任务名称' },
          command: { type: 'string', description: '要执行的命令 (create 时必填)' },
          trigger: { type: 'string', description: '触发条件 (如 daily, onstart)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'win_event_log',
      description: '读取 Windows 事件日志。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '日志源 (如 Application, System, Security)' },
          count: { type: 'number', description: '返回最近多少条 (可选, 默认 20)' },
        },
        required: ['source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'win_powershell',
      description: '执行 PowerShell 脚本命令。比 execute_cmd 更适合 Windows 系统管理操作。',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'PowerShell 脚本内容' },
        },
        required: ['script'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'win_firewall',
      description: '查看或修改 Windows 防火墙规则。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '操作: list / add / delete / enable / disable' },
          name: { type: 'string', description: '规则名称 (list 操作可不传)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'win_perfmon',
      description: '获取 Windows 性能监视器数据 (CPU、内存、磁盘实时监控)。',
      parameters: {
        type: 'object',
        properties: {
          counter: { type: 'string', description: '性能计数器路径 (可选, 不传则返回常用指标)' },
        },
        required: [],
      },
    },
  },
];

/**
 * 根据前端选中的工具 ID 列表, 构建传给 LLM 的 tools 数组
 *
 * 缓存稳定性设计 (2026-07-07):
 *   - 核心工具 (read_file, write_file, execute_cmd, search_code, list_files) 始终包含
 *   - 画布工具 (solo_canvas_*) 始终包含
 *   - 核心工具构成稳定缓存前缀,不随 activeTools 变化而变化
 *   - 扩展工具 (browser_*, bu_*, win_*) 默认不加载,只在 activeTools 显式启用时才加
 *   - 用户切换 activeTools 只影响扩展工具,核心工具缓存前缀保持稳定
 *
 * @param activeToolIds 前端 ResourceManagerBar 中选中的工具 ID (含父级 ID 如 obscura)
 */
export function getToolsForActiveIds(activeToolIds?: string[] | null): ToolSchema[] {
  if (!activeToolIds || activeToolIds.length === 0) {
    // 无 activeTools 时,只返回核心工具+画布工具 (稳定缓存前缀)
    return AGENT_TOOLS;
  }

  const activeSet = new Set(activeToolIds);
  const result: ToolSchema[] = [];

  // 1) 始终包含核心工具和画布工具 (构成稳定缓存前缀)
  for (const tool of AGENT_TOOLS) {
    if (CORE_TOOL_NAMES.has(tool.function.name) || tool.function.name.startsWith('solo_canvas_')) {
      result.push(tool);
    }
  }

  // 2) 添加匹配的扩展工具 (按需加载,不影响核心工具缓存)
  for (const tool of EXTENDED_TOOL_SCHEMAS) {
    if (activeSet.has(tool.function.name)) {
      result.push(tool);
    }
  }

  return result;
}

// ─── 工具结果预算 (L2 优化: 防止单个工具结果撑爆上下文) ──────────────
// Claude Code 的 L1 压缩: 每个 tool_result 限制最大字符数,
// 超出时截断并标注原始长度,引导 LLM 用 offset/limit 分页查看。
// 参考: Claude Code Agent Loop 的 tool result budget 机制。
//
// 不同工具的预算不同:
//   read_file:     4000 字符 (约 1000 token,一个中等文件的前 100 行)
//   execute_cmd:   3000 字符 (约 750 token,保留最后 N 行输出)
//   search_code:   2000 字符 (约 500 token,匹配结果摘要)
//   其他工具:      4000 字符 (通用上限)
export const TOOL_RESULT_BUDGET: Record<string, number> = {
  read_file: 4000,
  execute_cmd: 3000,
  search_code: 2000,
  list_files: 3000,
};
export const DEFAULT_TOOL_RESULT_BUDGET = 4000;

/**
 * 按预算裁剪工具输出。超出时截断并附加分页提示。
 * 与直接 slice 的区别: 保留尾部信息(execute_cmd 的错误通常在最后),
 * 并告知 LLM 如何获取剩余内容(read_file 用 offset/limit)。
 */
function applyToolResultBudget(
  toolName: string,
  output: string,
  extraInfo?: string,
): string {
  const budget = TOOL_RESULT_BUDGET[toolName] ?? DEFAULT_TOOL_RESULT_BUDGET;
  if (output.length <= budget) return output;

  // read_file: 截断头部,提示用 offset/limit 分页
  if (toolName === 'read_file') {
    const truncated = output.slice(0, budget);
    const totalChars = output.length;
    const totalLines = output.split('\n').length;
    const shownLines = truncated.split('\n').length;
    return (
      truncated +
      `\n\n... [TRUNCATED by Agent Loop Budget] ` +
      `showing first ${shownLines} of ~${totalLines} lines (${totalChars} chars total). ` +
      `Use offset=${shownLines + 1} and limit=100 to read the next section.`
    );
  }

  // execute_cmd: 保留尾部 (错误信息通常在最后)
  if (toolName === 'execute_cmd') {
    const tail = output.slice(-budget);
    return (
      `... [TRUNCATED: first ${output.length - budget} chars omitted, showing last ${budget}] ...\n` +
      tail
    );
  }

  // 其他工具: 截断头部
  const truncated = output.slice(0, budget);
  return (
    truncated +
    `\n\n... [TRUNCATED by Agent Loop Budget] ${output.length} chars total, showing first ${budget}.`
  );
}

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

/**
 * 扩展工具 (browser_*, bu_*, win_*) 的 HTTP 转发
 * 转发到 UI 进程的统一工具调用端点: POST /api/tools/invoke
 * UI 端负责路由到具体的工具服务 (Obscura / Browser-Use / Windows-MCP)
 */
async function invokeExtendedToolViaUI(
  toolName: string,
  args: Record<string, any>
): Promise<string> {
  try {
    const res = await fetch(`${UI_BASE_URL}/api/tools/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: toolName, arguments: args }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      output?: string;
      error?: string;
    };

    if (!res.ok || data.success !== true) {
      return `Error: ${data.error || `HTTP ${res.status}`}`;
    }

    return data.output ?? 'OK';
  } catch (err) {
    return `Error: failed to call UI tool endpoint (${UI_BASE_URL}) for ${toolName}: ${
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
        // L2 优化: 统一走 applyToolResultBudget (4000 字符预算 + 分页提示)
        output = applyToolResultBudget('read_file', output);
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
        // L2 优化: 统一走 applyToolResultBudget (3000 字符预算,保留尾部)
        output = applyToolResultBudget('execute_cmd', output);
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
        // L2 优化: 搜索结果预算裁剪
        output = applyToolResultBudget('search_code', output);
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

      // ─── canvas_push_ui: 直接推送 UI AST 到 Flutter 画布 ──
      // 断路修复: 让 Agent 能通过 tool_call 直接推送 Universal AST,
      // 无需依赖前端 tryLocalTranslateAndPush 从文本提取代码块。
      // 链路: executeToolCall → POST /api/canvas/relay/push-ui → Flutter /render
      case 'canvas_push_ui': {
        const sessionId = String(request.arguments.sessionId || '');
        const dsl = request.arguments.dsl;
        const language = String(request.arguments.language || 'typescript');
        if (!sessionId) {
          output = 'Error: canvas_push_ui requires "sessionId" argument';
          break;
        }
        if (!dsl || typeof dsl !== 'object') {
          output = 'Error: canvas_push_ui requires "dsl" argument (Universal AST object)';
          break;
        }
        try {
          const relayUrl = `${UI_BASE_URL}/api/canvas/relay/push-ui`;
          const relayRes = await fetch(relayUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, dsl, language }),
          });
          const relayData = await relayRes.json().catch(() => ({})) as {
            success?: boolean;
            error?: string;
            port?: number;
            dslBytes?: number;
          };
          if (!relayRes.ok || relayData.success !== true) {
            output = `Error: canvas relay push-ui failed: ${relayData.error || `HTTP ${relayRes.status}`}`;
          } else {
            output = `Successfully pushed UI to canvas (sessionId=${sessionId}, port=${relayData.port}, dslBytes=${relayData.dslBytes}). The UI has been rendered on the Flutter canvas.`;
          }
        } catch (err) {
          output = `Error: failed to reach canvas relay (${UI_BASE_URL}): ${err instanceof Error ? err.message : String(err)}`;
        }
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
        // ── 扩展工具 (browser_*, bu_*, win_*)──
        // 转发到 UI 进程的统一工具调用端点
        if (request.name.startsWith('browser_') ||
            request.name.startsWith('bu_') ||
            request.name.startsWith('win_')) {
          output = await invokeExtendedToolViaUI(request.name, request.arguments);
          break;
        }
        output = `Unknown tool: ${request.name}`;
    }

    // L2 优化: 对未单独处理的工具(画布/扩展)统一应用预算裁剪
    // 已在各 case 内部裁剪过的工具,此处 output.length <= budget,不会二次截断
    output = applyToolResultBudget(request.name, output);

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
