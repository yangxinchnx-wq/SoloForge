// ─────────────────────────────────────────────────────────────────
// schema.go — Agent 可用的内置工具定义 (从 TS tool-definitions.ts 迁移)
//
// 遵循 OpenAI Function Calling 协议:
//
//	tools: [{ type: 'function', function: { name, description, parameters } }]
//
// 工具列表:
//
//	核心 5 工具  read_file / write_file / execute_cmd / search_code / list_files
//	画布工具    solo_canvas_* (8 个) + canvas_push_ui
//	扩展工具    browser_* (7) / bu_* (6) / win_* (7)
//
// GetToolsForActiveIds 的缓存稳定性设计 (对齐 TS 2026-07-07):
//   - 核心工具始终包含, 画布工具始终包含 → 构成稳定缓存前缀,
//     不随 activeTools 变化而变化
//   - 扩展工具默认不加载, 只在 activeTools 显式启用时才加
//
// ─────────────────────────────────────────────────────────────────
package toolsrelay

// ToolSchema 工具 schema (OpenAI Function Calling 格式, 对齐 TS ToolSchema)
type ToolSchema struct {
	Type     string       `json:"type"` // 恒为 "function"
	Function ToolFunction `json:"function"`
}

// ToolFunction function 描述块
type ToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  ToolParameters `json:"parameters"`
}

// ToolParameters JSON Schema 参数块
type ToolParameters struct {
	Type       string                  `json:"type"` // 恒为 "object"
	Properties map[string]ToolProperty `json:"properties"`
	Required   []string                `json:"required"`
}

// ToolProperty 单个参数 schema
type ToolProperty struct {
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
}

func prop(typ, desc string) ToolProperty { return ToolProperty{Type: typ, Description: desc} }

func schema(name, desc string, required []string, props map[string]ToolProperty) ToolSchema {
	return ToolSchema{
		Type: "function",
		Function: ToolFunction{
			Name:        name,
			Description: desc,
			Parameters: ToolParameters{
				Type:       "object",
				Properties: props,
				Required:   required,
			},
		},
	}
}

// AgentTools 核心工具 + 画布工具 (对齐 TS AGENT_TOOLS)
var AgentTools = []ToolSchema{
	schema("read_file",
		"读取项目中的文件内容。返回文件的完整文本。用于理解现有代码、查看配置文件等。",
		[]string{"file_path"},
		map[string]ToolProperty{
			"file_path": prop("string", "文件的绝对路径或相对于项目根目录的相对路径"),
			"offset":    prop("number", "从第几行开始读取（可选，默认从第 1 行）"),
			"limit":     prop("number", "最多读取多少行（可选，默认读取全部）"),
		}),
	schema("write_file",
		"将内容写入项目文件。如果文件不存在会自动创建（包括父目录）。用于生成代码、配置文件等。",
		[]string{"file_path", "content"},
		map[string]ToolProperty{
			"file_path": prop("string", "文件的绝对路径或相对于项目根目录的相对路径"),
			"content":   prop("string", "要写入的文件内容"),
		}),
	schema("execute_cmd",
		"在项目根目录下执行终端命令。用于运行构建、测试、安装依赖等。超时 30 秒。",
		[]string{"command"},
		map[string]ToolProperty{
			"command": prop("string", "要执行的命令（如 npm test, tsc --noEmit）"),
			"cwd":     prop("string", "工作目录（可选，默认项目根目录）"),
		}),
	schema("search_code",
		"在项目中搜索代码内容（基于正则表达式）。返回匹配的文件路径和行号。用于查找函数定义、引用、配置项等。",
		[]string{"pattern"},
		map[string]ToolProperty{
			"pattern": prop("string", "正则表达式搜索模式"),
			"glob":    prop("string", "文件过滤 glob 模式（可选，如 *.ts, *.tsx）"),
		}),
	schema("list_files",
		"列出指定目录下的文件和子目录。用于了解项目结构。",
		[]string{},
		map[string]ToolProperty{
			"dir_path": prop("string", "目录路径（可选，默认项目根目录）"),
			"pattern":  prop("string", "glob 匹配模式（可选，如 **/*.ts）"),
		}),

	// ── 画布工具 (solo_canvas_*) ──
	// Schema 来自 UI 端 UI/src/server/routes/canvasTools.ts:47-162
	// 通过 HTTP POST {UI_BASE_URL}/api/canvas/tools/invoke 调用 (canvas.go)
	schema("solo_canvas_list",
		"列出所有可用画布（公开的 + 自己创建的）。返回 sessionId、displayName、description、ownerChatSessionId、设备数量。",
		[]string{"requesterChatSessionId"},
		map[string]ToolProperty{
			"requesterChatSessionId": prop("string", "当前对话的 chat session ID（用于 ACL）"),
		}),
	schema("solo_canvas_get",
		"获取画布完整状态：选中的设备、设备列表、背景色、备注等。canvasId 可不传——系统会自动用当前会话绑定的画布。",
		[]string{"requesterChatSessionId"},
		map[string]ToolProperty{
			"canvasId":               prop("string", "画布 ID，如 canvas_1（可选；不传时使用当前会话绑定的画布）"),
			"requesterChatSessionId": prop("string", ""),
		}),
	schema("solo_canvas_create",
		"创建一个新画布。返回创建的画布 ID 和 displayName。",
		[]string{"requesterChatSessionId"},
		map[string]ToolProperty{
			"description":            prop("string", "画布备注（可选）"),
			"requesterChatSessionId": prop("string", ""),
		}),
	schema("solo_canvas_add_device",
		"向画布添加一个 3D 设备（iPhone / iPad / MacBook 等）。canvasId 可不传——系统会自动用当前会话绑定的画布。",
		[]string{"device", "requesterChatSessionId"},
		map[string]ToolProperty{
			"canvasId":               prop("string", "画布 ID（可选；不传时使用当前会话绑定的画布）"),
			"device":                 prop("string", "设备 JSON 对象（modelKey/xRatio/yRatio 等）"),
			"requesterChatSessionId": prop("string", ""),
		}),
	schema("solo_canvas_update_device",
		"更新画布上的某个设备（位置、颜色、UI session 等）。canvasId 可不传——系统会自动用当前会话绑定的画布。",
		[]string{"deviceId", "updates", "requesterChatSessionId"},
		map[string]ToolProperty{
			"canvasId":               prop("string", "画布 ID（可选；不传时使用当前会话绑定的画布）"),
			"deviceId":               prop("string", ""),
			"updates":                prop("string", "要更新的字段 JSON 字符串"),
			"requesterChatSessionId": prop("string", ""),
		}),
	schema("solo_canvas_remove_device",
		"从画布移除指定设备。canvasId 可不传——系统会自动用当前会话绑定的画布。",
		[]string{"deviceId", "requesterChatSessionId"},
		map[string]ToolProperty{
			"canvasId":               prop("string", "画布 ID（可选；不传时使用当前会话绑定的画布）"),
			"deviceId":               prop("string", ""),
			"requesterChatSessionId": prop("string", ""),
		}),
	schema("solo_canvas_rename",
		"修改画布的备注 / 描述（仅 owner 可调）。canvasId 可不传——系统会自动用当前会话绑定的画布。",
		[]string{"description", "requesterChatSessionId"},
		map[string]ToolProperty{
			"canvasId":               prop("string", "画布 ID（可选；不传时使用当前会话绑定的画布）"),
			"description":            prop("string", ""),
			"requesterChatSessionId": prop("string", ""),
		}),
	schema("solo_canvas_delete",
		"删除整个画布（仅 owner 可调，慎用）。canvasId 可不传——系统会自动用当前会话绑定的画布。",
		[]string{"requesterChatSessionId"},
		map[string]ToolProperty{
			"canvasId":               prop("string", "画布 ID（可选；不传时使用当前会话绑定的画布）"),
			"requesterChatSessionId": prop("string", ""),
		}),

	// ── canvas_push_ui: 直接推送 UI AST 到画布 (核心断路修复) ──
	// 让 LLM/Agent 能通过 tool_call 直接推送 Universal AST 到 Flutter 画布,
	// 不再依赖前端 tryLocalTranslateAndPush 从文本提取代码块。
	// 链路: Agent tool_call → ExecuteToolCall → POST /api/canvas/relay/push-ui → Flutter /render
	schema("canvas_push_ui",
		"Push a Universal AST UI tree directly to the Flutter canvas for immediate rendering. Use this tool when the user asks to draw/render/display UI on the canvas. The dsl is a UniversalNode tree (JSON object with type, children, props). The sessionId identifies which canvas to push to.",
		[]string{"sessionId", "dsl"},
		map[string]ToolProperty{
			"sessionId": prop("string", "Canvas session ID (the chat session ID). The relay will look up the registered Flutter port for this session."),
			"dsl":       prop("object", "Universal AST node tree. Root node has {type, children, props}. Example: {\"type\":\"column\",\"children\":[{\"type\":\"text\",\"props\":{\"data\":\"Hello World\"}}]}"),
			"language":  prop("string", "Source language of the UI code (e.g. html, dart, typescript). Optional, defaults to typescript."),
		}),
}

// coreToolNames 核心工具名称集合 (始终可用, 不受 activeTools 过滤影响)。
// canvas_push_ui 属于核心 (断路修复: 画布推送工具始终可用)。
var coreToolNames = map[string]bool{
	"read_file":      true,
	"write_file":     true,
	"execute_cmd":    true,
	"search_code":    true,
	"list_files":     true,
	"canvas_push_ui": true,
}

// ExtendedToolSchemas 扩展工具 schema (对齐 TS EXTENDED_TOOL_SCHEMAS)。
// 对应前端 ResourceManagerBar 中可选的浏览器/Windows 工具,
// 工具 ID 与 UI/resources/tools/manifest.json 中的 children[].id 一一对应。
var ExtendedToolSchemas = []ToolSchema{
	// ── Obscura 浏览器工具 ──
	schema("browser_screenshot",
		"对指定 URL 的网页进行高清截图。返回截图保存路径。",
		[]string{"url"},
		map[string]ToolProperty{
			"url":      prop("string", "要截图的网页 URL"),
			"selector": prop("string", "CSS 选择器, 仅截取匹配元素 (可选)"),
		}),
	schema("browser_devtools",
		"打开 Chrome DevTools 调试指定网页。返回页面概要信息。",
		[]string{"url"},
		map[string]ToolProperty{
			"url": prop("string", "要调试的网页 URL"),
		}),
	schema("browser_console",
		"实时捕获指定网页的浏览器控制台日志。返回最近的日志条目。",
		[]string{"url"},
		map[string]ToolProperty{
			"url":   prop("string", "目标网页 URL"),
			"lines": prop("number", "返回最近多少条日志 (可选, 默认 50)"),
		}),
	schema("browser_network",
		"拦截并分析指定网页的网络请求。返回请求列表 (URL/方法/状态码/耗时)。",
		[]string{"url"},
		map[string]ToolProperty{
			"url":    prop("string", "目标网页 URL"),
			"filter": prop("string", "URL 过滤关键词 (可选)"),
		}),
	schema("browser_dom_inspect",
		"检查指定网页的 DOM 树结构。返回简化版的 DOM 树。",
		[]string{"url"},
		map[string]ToolProperty{
			"url":      prop("string", "目标网页 URL"),
			"selector": prop("string", "CSS 选择器, 仅检查匹配的元素 (可选)"),
		}),
	schema("browser_perf_trace",
		"对指定网页进行性能追踪分析。返回页面加载与渲染性能报告。",
		[]string{"url"},
		map[string]ToolProperty{
			"url": prop("string", "目标网页 URL"),
		}),
	schema("browser_cookies",
		"读取或写入指定域名的浏览器 Cookie。",
		[]string{"url", "action"},
		map[string]ToolProperty{
			"url":    prop("string", "目标网页 URL"),
			"action": prop("string", "操作类型: get (读取) 或 set (写入)"),
			"name":   prop("string", "Cookie 名称 (set 时必填)"),
			"value":  prop("string", "Cookie 值 (set 时必填)"),
		}),

	// ── Browser-Use 任务编排工具 ──
	schema("bu_run_task",
		"用自然语言描述一个浏览器任务, LLM 自动规划并执行步骤。返回任务 ID 和执行结果。",
		[]string{"task"},
		map[string]ToolProperty{
			"task": prop("string", "自然语言任务描述 (如 \"打开 GitHub 并搜索 SoloForge\")"),
			"url":  prop("string", "起始页面 URL (可选)"),
		}),
	schema("bu_pause",
		"暂停正在执行的浏览器任务。",
		[]string{"task_id"},
		map[string]ToolProperty{"task_id": prop("string", "任务 ID")}),
	schema("bu_resume",
		"恢复已暂停的浏览器任务。",
		[]string{"task_id"},
		map[string]ToolProperty{"task_id": prop("string", "任务 ID")}),
	schema("bu_state",
		"查询浏览器任务的执行状态与进度。",
		[]string{"task_id"},
		map[string]ToolProperty{"task_id": prop("string", "任务 ID")}),
	schema("bu_screenshot",
		"对浏览器任务当前页面进行截图。",
		[]string{"task_id"},
		map[string]ToolProperty{"task_id": prop("string", "任务 ID")}),
	schema("bu_history",
		"查看浏览器任务的 ReAct 推理历史与执行轨迹。",
		[]string{"task_id"},
		map[string]ToolProperty{"task_id": prop("string", "任务 ID")}),

	// ── Windows-MCP 系统自动化工具 ──
	schema("win_reg_read",
		"读取 Windows 注册表键值。返回键值数据。",
		[]string{"path"},
		map[string]ToolProperty{
			"path": prop("string", "注册表路径 (如 HKLM\\Software\\Microsoft\\Windows\\CurrentVersion)"),
			"name": prop("string", "键值名称 (可选, 不传则返回所有子键)"),
		}),
	schema("win_service_ctrl",
		"管理 Windows 系统服务 (启动/停止/查询状态)。",
		[]string{"action"},
		map[string]ToolProperty{
			"action": prop("string", "操作: start / stop / status / list"),
			"name":   prop("string", "服务名称 (list 操作可不传)"),
		}),
	schema("win_task_scheduler",
		"创建或管理 Windows 系统定时任务。",
		[]string{"action"},
		map[string]ToolProperty{
			"action":  prop("string", "操作: create / delete / list / run"),
			"name":    prop("string", "任务名称"),
			"command": prop("string", "要执行的命令 (create 时必填)"),
			"trigger": prop("string", "触发条件 (如 daily, onstart)"),
		}),
	schema("win_event_log",
		"读取 Windows 事件日志。",
		[]string{"source"},
		map[string]ToolProperty{
			"source": prop("string", "日志源 (如 Application, System, Security)"),
			"count":  prop("number", "返回最近多少条 (可选, 默认 20)"),
		}),
	schema("win_powershell",
		"执行 PowerShell 脚本命令。比 execute_cmd 更适合 Windows 系统管理操作。",
		[]string{"script"},
		map[string]ToolProperty{
			"script": prop("string", "PowerShell 脚本内容"),
		}),
	schema("win_firewall",
		"查看或修改 Windows 防火墙规则。",
		[]string{"action"},
		map[string]ToolProperty{
			"action": prop("string", "操作: list / add / delete / enable / disable"),
			"name":   prop("string", "规则名称 (list 操作可不传)"),
		}),
	schema("win_perfmon",
		"获取 Windows 性能监视器数据 (CPU、内存、磁盘实时监控)。",
		[]string{},
		map[string]ToolProperty{
			"counter": prop("string", "性能计数器路径 (可选, 不传则返回常用指标)"),
		}),
}

// GetToolsForActiveIds 根据前端选中的工具 ID 列表, 构建传给 LLM 的 tools 数组
// (对齐 TS getToolsForActiveIds)。
//
//	无 activeTools 时: 只返回核心工具 + 画布工具 (稳定缓存前缀)
//	有 activeTools 时: 核心 + 画布工具照常 + 按 ID 精确匹配的扩展工具
//
// activeToolIds 为前端 ResourceManagerBar 中选中的工具 ID (含父级 ID 如 obscura)。
func GetToolsForActiveIds(activeToolIds []string) []ToolSchema {
	if len(activeToolIds) == 0 {
		// 无 activeTools 时, 只返回核心工具 + 画布工具 (稳定缓存前缀)
		out := make([]ToolSchema, len(AgentTools))
		copy(out, AgentTools)
		return out
	}

	activeSet := make(map[string]bool, len(activeToolIds))
	for _, id := range activeToolIds {
		activeSet[id] = true
	}

	var result []ToolSchema

	// 1) 始终包含核心工具和画布工具 (构成稳定缓存前缀)
	for _, tool := range AgentTools {
		if coreToolNames[tool.Function.Name] ||
			len(tool.Function.Name) >= len("solo_canvas_") &&
				tool.Function.Name[:len("solo_canvas_")] == "solo_canvas_" {
			result = append(result, tool)
		}
	}

	// 2) 添加匹配的扩展工具 (按需加载, 不影响核心工具缓存)
	for _, tool := range ExtendedToolSchemas {
		if activeSet[tool.Function.Name] {
			result = append(result, tool)
		}
	}

	return result
}
