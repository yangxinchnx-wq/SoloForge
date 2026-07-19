/**
 * 工具清单硬编码兜底数据
 *
 * 2026-07-03 阶段3.1.A 从 ChatPanel.tsx 抽出 (原行 958-1003)。
 * 当后端拉取资源失败时,以此为基础与远端 manifest 合并。
 *
 * 类型保留 any[] 与原实现一致,后续阶段3.1.D 抽 ResourceManager 时再补 ToolManifest 类型。
 */

/** 工具 schema (OpenAI Function Calling 格式的 parameters 部分) */
export interface ToolSchema {
  type: string;
  properties: Record<string, any>;
  required?: string[];
}

export interface ToolManifestChild {
  id: string;
  name: string;
  description: string;
  /** OpenAI Function Calling 格式的 parameters schema (内置工具可不填, Java 端自带) */
  schema?: ToolSchema;
}

export interface ToolManifestItem {
  id: string;
  name: string;
  description: string;
  group: string;
  children?: ToolManifestChild[];
}

/**
 * Java Agent 内置工具 ID (Java MultiWorkerExecutionService.buildSingleToolSchema 中有对应 case)。
 * 这些工具由 Java 端直接执行, schema 也由 Java 端构建, 前端 manifest 中的 schema 仅供参考。
 * canvas_push_ui 不在此列表中 — 它仅在 ultimate/expert 权限模式下可用。
 */
export const BUILTIN_TOOL_IDS = [
  'read_file',
  'write_file',
  'list_files',
  'search_code',
  'execute_cmd',
] as const;

export const DEFAULT_TOOLS_MANIFEST: ToolManifestItem[] = [
  {
    id: 'core-tools',
    name: '核心工具',
    description: 'Agent 内置工具，支持文件读写、代码搜索、命令执行、画布推送。无需额外服务，Java Agent 直接执行。',
    group: '核心',
    children: [
      {
        id: 'read_file',
        name: '读取文件',
        description: '读取指定路径文件的内容。',
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '绝对或相对文件路径' },
          },
          required: ['path'],
        },
      },
      {
        id: 'write_file',
        name: '写入文件',
        description: '写入内容到指定路径文件，自动创建父目录。',
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '绝对或相对文件路径' },
            content: { type: 'string', description: '要写入的内容' },
          },
          required: ['path', 'content'],
        },
      },
      {
        id: 'list_files',
        name: '列出文件',
        description: '列出指定目录下的文件和子目录。',
        schema: {
          type: 'object',
          properties: {
            dirPath: { type: 'string', description: '目录路径' },
          },
          required: ['dirPath'],
        },
      },
      {
        id: 'search_code',
        name: '搜索代码',
        description: '在当前工作目录下搜索文本模式。',
        schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '要搜索的文本模式' },
            fileGlob: { type: 'string', description: '可选文件名 glob 过滤 (如 *.java)' },
          },
          required: ['pattern'],
        },
      },
      {
        id: 'execute_cmd',
        name: '执行命令',
        description: '执行 shell 命令并返回 stdout+stderr。',
        schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的 shell 命令' },
          },
          required: ['command'],
        },
      },
      {
        id: 'canvas_push_ui',
        name: '画布推送UI',
        description: '推送 UI 组件 (DSL) 到前端画布实时预览。仅 ultimate/expert 模式可用。',
        schema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: '画布会话 ID' },
            dslJson: { type: 'string', description: 'UI DSL JSON 字符串' },
            language: { type: 'string', description: '目标语言 (html/react/vue/flutter)' },
          },
          required: ['sessionId', 'dslJson', 'language'],
        },
      },
    ],
  },
  {
    id: 'obscura',
    name: 'Obscura',
    description: '无头浏览器引擎，支持网页抓取、CDP协议、MCP工具调用',
    group: '浏览器',
    children: [
      { id: 'browser_devtools', name: 'DevTools 调试器', description: 'Chrome 开发者工具集成' },
      { id: 'browser_console', name: 'Console 日志捕获', description: '实时捕获浏览器控制台' },
      { id: 'browser_network', name: 'Network 网络监控', description: '拦截与分析网络请求' },
      { id: 'browser_dom_inspect', name: 'DOM 元素检查器', description: '页面 DOM 树实时浏览' },
      { id: 'browser_screenshot', name: '页面截图工具', description: '对页面进行高清截图' },
      { id: 'browser_perf_trace', name: 'Performance 性能追踪', description: '页面加载与渲染性能分析' },
      { id: 'browser_cookies', name: 'Cookie 管理器', description: '读写浏览器 Cookie 存储' },
    ]
  },
  {
    id: 'browser-use',
    name: 'Browser-Use',
    description: '高层 LLM 浏览器任务编排，LLM 自动规划执行步骤，底层由 Obscura CDP 引擎驱动',
    group: '浏览器',
    children: [
      { id: 'bu_run_task', name: '运行浏览器任务', description: '自然语言描述任务, LLM 自动规划执行步骤' },
      { id: 'bu_pause', name: '暂停任务', description: '暂停正在执行的浏览器任务' },
      { id: 'bu_resume', name: '恢复任务', description: '恢复已暂停的浏览器任务' },
      { id: 'bu_state', name: '任务状态查询', description: '查看浏览器任务执行进度与轨迹' },
      { id: 'bu_screenshot', name: '任务截图', description: '对当前浏览器页面截图' },
      { id: 'bu_history', name: '历史轨迹', description: '查看任务 ReAct 推理历史与结果' },
    ]
  },
  {
    id: 'windows-mcp',
    name: 'Windows-MCP',
    description: 'Windows系统自动化MCP服务器，支持UI交互、应用控制、文件导航',
    group: 'Windows',
    children: [
      { id: 'win_reg_read', name: '注册表读取器', description: '读取 Windows 注册表键值' },
      { id: 'win_service_ctrl', name: '服务控制器', description: '管理 Windows 系统服务启停' },
      { id: 'win_task_scheduler', name: '任务计划程序', description: '创建与管理系统定时任务' },
      { id: 'win_event_log', name: '事件日志查看器', description: '读取 Windows 事件日志' },
      { id: 'win_powershell', name: 'PowerShell 执行器', description: '执行 PowerShell 脚本命令' },
      { id: 'win_firewall', name: '防火墙规则管理', description: '查看与修改防火墙规则' },
      { id: 'win_perfmon', name: '性能监视器', description: 'CPU、内存、磁盘实时监控' },
    ]
  },
];

/**
 * 从工具 manifest 中递归提取指定工具 ID 的 OpenAI Function Calling 格式 schema。
 *
 * 遍历 parent → children 结构，匹配 id 且有 schema 字段的叶子节点。
 * 用于构建发给 Java Agent 的 toolSchemas，让 LLM 看到 MCP/远程工具的正确参数定义。
 *
 * 内置工具 (read_file 等) 的 schema 也会被提取，但 Java 端 buildOpenAiToolSchemas
 * 优先使用自己的 buildSingleToolSchema (确保 executeToolCall 参数解析一致)。
 */
export function extractToolSchemas(
  manifest: ToolManifestItem[],
  toolIds: string[],
): Array<{ type: string; function: { name: string; description: string; parameters: ToolSchema } }> {
  const schemas: Array<{ type: string; function: { name: string; description: string; parameters: ToolSchema } }> = [];
  const idSet = new Set(toolIds);

  const visit = (items: Array<ToolManifestItem | ToolManifestChild>): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item && idSet.has(item.id) && (item as ToolManifestChild).schema) {
        const child = item as ToolManifestChild;
        schemas.push({
          type: 'function',
          function: {
            name: child.id,
            description: child.description || child.name || child.id,
            parameters: child.schema!,
          },
        });
      }
      if ((item as ToolManifestItem).children) {
        visit((item as ToolManifestItem).children!);
      }
    }
  };
  visit(manifest);
  return schemas;
}
