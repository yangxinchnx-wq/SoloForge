// ─────────────────────────────────────────────────────────────────
// registry.go — 工具注册表 (从 TS tool-definitions.ts 的 executeToolCall
// 路由表迁移) — 名称 → 执行函数 的精确映射
//
// 覆盖:
//
//	核心工具   read_file / write_file / execute_cmd / search_code / list_files
//	           (实现在 coretools.go)
//	画布工具   canvas_push_ui + solo_canvas_* (经 UI 进程 HTTP 转发, canvas.go)
//	扩展工具   bu_* → BrowserUseExecutor, win_* → WindowsMCPExecutor,
//	           browser_console/network/dom_inspect → DevToolsExecutor,
//	           其余 browser_* → BrowserUseExecutor (/invoke 统一端点)
//	遗留别名   旧 TS tool-result-relay.ts 路由表的裸名 (powershell 等)
//	           → 规范 win_* 工具名
//
// 与 builtin.go 四大执行器对接: Registry 自身实现 Executor 接口
// (CanHandle = 精确名称命中), 可直接注册进 Relay (见 NewToolChain)。
// Relay 内优先级从低到高 (后注册者优先): Obscura 兜底 → BrowserUse →
// WindowsMCP → DevTools → Registry (精确名称, 最优先)。
//
// ExecuteToolCall 为独立入口 (对齐 TS executeToolCall, 供 Agent 循环/HTTP
// 端点直接调用): 注册表精确命中 → 执行 → 结果归一为 ToolCallResult,
// 并统一应用工具结果预算裁剪。
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"
)

// ─── 类型定义 ────────────────────────────────────────────────────

// ToolFunc 工具执行函数: ctx 控制超时/取消, req 携带参数与执行环境
type ToolFunc func(ctx context.Context, req ToolRequest) (any, error)

// ToolRequest 单次工具调用请求 (对齐 TS ToolCallRequest)
type ToolRequest struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Arguments       json.RawMessage `json:"arguments,omitempty"`
	WorkspaceFolder string          `json:"workspaceFolder,omitempty"`
	// Stream 可选流式事件钩子 (主要给 execute_cmd 用, 对齐 TS streamHook;
	// chatId/subTaskId 由钩子闭包自行捕获, payload 含 tool_call_id/tool/
	// chunk/exitCode/durationMs/ts)
	Stream ToolStreamHook `json:"-"`
}

// ToolStreamHook 工具流式事件钩子 (对齐 TS ToolStreamHook.emit)。
// eventName ∈ tool_stdout / tool_stderr / tool_exit。
type ToolStreamHook func(eventName string, payload map[string]any)

// ToolCallResult 工具调用结果 (对齐 TS ToolCallResult)
type ToolCallResult struct {
	ToolCallID string `json:"tool_call_id"`
	Name       string `json:"name"`
	Output     string `json:"output"`
	IsError    bool   `json:"isError"`
	DurationMs int64  `json:"durationMs"`
}

// ─── Registry 工具注册表 ─────────────────────────────────────────

// Registry 工具注册表: 工具名 → 执行函数 (并发安全, 同名覆盖)。
// Browser/Windows/DevTools 为扩展工具对接的 builtin.go 执行器实例
// (Obscura 为 Relay 兜底, 不经注册表)。
type Registry struct {
	mu    sync.RWMutex
	tools map[string]ToolFunc

	Browser  *BrowserUseExecutor
	Windows  *WindowsMCPExecutor
	DevTools *DevToolsExecutor
}

// NewRegistry 空注册表; 三个对接执行器为 nil 时补默认实例
func NewRegistry(browser *BrowserUseExecutor, win *WindowsMCPExecutor, dev *DevToolsExecutor) *Registry {
	rg := &Registry{tools: make(map[string]ToolFunc), Browser: browser, Windows: win, DevTools: dev}
	rg.ensureExecutors()
	return rg
}

// NewRegistryEmpty 仅创建空表 (不构造执行器), 供逐步装配
func NewRegistryEmpty() *Registry {
	return &Registry{tools: make(map[string]ToolFunc)}
}

// ensureExecutors 补默认执行器 (零值 Registry 直接注册时防 nil 解引用)
func (rg *Registry) ensureExecutors() {
	rg.mu.Lock()
	defer rg.mu.Unlock()
	if rg.Browser == nil {
		rg.Browser = NewBrowserUseExecutor()
	}
	if rg.Windows == nil {
		rg.Windows = NewWindowsMCPExecutor()
	}
	if rg.DevTools == nil {
		rg.DevTools = NewDevToolsExecutor()
	}
}

// Register 注册工具执行函数 (同名覆盖)
func (rg *Registry) Register(name string, fn ToolFunc) {
	rg.mu.Lock()
	defer rg.mu.Unlock()
	rg.tools[name] = fn
}

// Lookup 按名称查执行函数
func (rg *Registry) Lookup(name string) (ToolFunc, bool) {
	rg.mu.RLock()
	defer rg.mu.RUnlock()
	fn, ok := rg.tools[name]
	return fn, ok
}

// Names 已注册工具名 (排序返回, 便于诊断与测试)
func (rg *Registry) Names() []string {
	rg.mu.RLock()
	defer rg.mu.RUnlock()
	names := make([]string, 0, len(rg.tools))
	for n := range rg.tools {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// CanHandle 实现 Executor: 精确名称命中
func (rg *Registry) CanHandle(tool string) bool {
	_, ok := rg.Lookup(tool)
	return ok
}

// Execute 实现 Executor: 查表执行 (CanHandle 保证命中)
func (rg *Registry) Execute(ctx context.Context, tool string, args json.RawMessage) (any, error) {
	fn, ok := rg.Lookup(tool)
	if !ok {
		return nil, fmt.Errorf("工具未注册: %s", tool)
	}
	return fn(ctx, ToolRequest{Name: tool, Arguments: args})
}

// ─── 扩展工具对接 (builtin.go 四大执行器) ──────────────────────────

// executorDelegate 把执行器适配为 ToolFunc (req 透传)。对齐 TS
// invokeExtendedToolViaUI 的转发语义 — Go 版直连执行器, 不再绕 UI 进程。
func executorDelegate(ex Executor) ToolFunc {
	return func(ctx context.Context, req ToolRequest) (any, error) {
		return ex.Execute(ctx, req.Name, req.Arguments)
	}
}

// renamedDelegate 别名委托: 以规范名调用执行器
// (用于旧路由表裸名 → win_*/browser_* 规范名)
func renamedDelegate(ex Executor, canonical string) ToolFunc {
	return func(ctx context.Context, req ToolRequest) (any, error) {
		return ex.Execute(ctx, canonical, req.Arguments)
	}
}

// registerExtendedTools 注册扩展工具 (名称精确路由到对应执行器,
// 工具清单对齐 TS EXTENDED_TOOL_SCHEMAS)
func registerExtendedTools(rg *Registry) {
	// ── Browser-Use 任务编排 (bu_*) → BrowserUseExecutor ──
	for _, name := range []string{"bu_run_task", "bu_pause", "bu_resume", "bu_state", "bu_screenshot", "bu_history"} {
		rg.Register(name, executorDelegate(rg.Browser))
	}
	// ── Windows-MCP 系统自动化 (win_*) → WindowsMCPExecutor ──
	for _, name := range []string{"win_reg_read", "win_service_ctrl", "win_task_scheduler",
		"win_event_log", "win_powershell", "win_firewall", "win_perfmon"} {
		rg.Register(name, executorDelegate(rg.Windows))
	}
	// ── Obscura 浏览器工具 (browser_*): console/network/dom_inspect 走 CDP
	//    (DevToolsExecutor); 其余 (screenshot/devtools/perf_trace/cookies)
	//    走 BrowserUseExecutor 的统一 /invoke 端点, 对齐 TS UI 转发路由 ──
	for _, name := range []string{"browser_console", "browser_network", "browser_dom_inspect"} {
		rg.Register(name, executorDelegate(rg.DevTools))
	}
	for _, name := range []string{"browser_screenshot", "browser_devtools", "browser_perf_trace", "browser_cookies"} {
		rg.Register(name, executorDelegate(rg.Browser))
	}
}

// legacyAliases 旧路由表 (TS tool-result-relay.ts executeToolCall switch)
// 裸名 → 规范 win_* 工具名。其余裸名 (browser_use/console/network/
// dom_inspect/screenshot/perf_trace/cookies/obscura) 无需别名: Relay 的
// 前缀执行器或 Obscura 兜底已能正确路由 (对齐 TS 旧分发器的后端归属)。
var legacyAliases = map[string]string{
	"powershell":     "win_powershell",
	"service_ctrl":   "win_service_ctrl",
	"task_scheduler": "win_task_scheduler",
	"event_log":      "win_event_log",
	"firewall":       "win_firewall",
	"perfmon":        "win_perfmon",
}

// registerLegacyAliases 注册旧路由表裸名别名
func registerLegacyAliases(rg *Registry) {
	for bare, canonical := range legacyAliases {
		rg.Register(bare, renamedDelegate(rg.Windows, canonical))
	}
}

// registerCoreTools 注册五个核心工具 (实现在 coretools.go)
func registerCoreTools(rg *Registry) {
	rg.Register("read_file", toolReadFile)
	rg.Register("write_file", toolWriteFile)
	rg.Register("execute_cmd", toolExecuteCmd)
	rg.Register("search_code", toolSearchCode)
	rg.Register("list_files", toolListFiles)
}

// RegisterBuiltinTools 注册全部内置工具 (核心 + 画布 + 扩展 + 遗留别名)
func RegisterBuiltinTools(rg *Registry) {
	rg.ensureExecutors()
	registerCoreTools(rg)
	registerCanvasTools(rg)
	registerExtendedTools(rg)
	registerLegacyAliases(rg)
}

// ─── ToolChain 装配 ────────────────────────────────────────────────

// ToolChain 工具链 = 注册表 (精确名称) + Relay (前缀路由 + 兜底)。
// Relay 注册顺序即优先级从低到高 (后注册者优先, 对齐 builtin.go
// NewWithBuiltins 的注释约定):
//
//	Obscura (兜底) → BrowserUse → WindowsMCP → DevTools → Registry (最具体)
type ToolChain struct {
	Registry *Registry
	Relay    *Relay
}

// NewToolChain 装配完整工具链
func NewToolChain() *ToolChain {
	browser := NewBrowserUseExecutor()
	win := NewWindowsMCPExecutor()
	dev := NewDevToolsExecutor()
	rg := NewRegistry(browser, win, dev)
	RegisterBuiltinTools(rg)

	r := New()
	r.Register(NewObscuraExecutor()) // 兜底, 必须最先注册 (最低优先级)
	r.Register(browser)
	r.Register(win)
	r.Register(dev)
	r.Register(rg) // 注册表最具体, 必须最后注册 (最高优先级)
	return &ToolChain{Registry: rg, Relay: r}
}

// Execute 执行一次工具调用 (对齐 TS executeToolCall 主体)。
// 结果归一为 ToolCallResult; isError 语义对齐 TS:
//   - Go error (ctx 取消/必选参数缺失/IO 失败) → "Error: ..." + isError=true
//     (对齐 TS 外层 catch)
//   - executed=false (工作区越界/敏感文件拦截/服务未启动) → 内联消息 +
//     isError=false (对齐 TS 的 inline output)
//   - execute_cmd 非零退出 → isError=true (对齐 TS 提前 return 分支)
func (tc *ToolChain) Execute(ctx context.Context, req ToolRequest) ToolCallResult {
	start := time.Now()
	res := tc.execute(ctx, req)
	res.DurationMs = time.Since(start).Milliseconds()
	return res
}

// execute 单次调用的主体 (耗时统计由 Execute 包裹)
func (tc *ToolChain) execute(ctx context.Context, req ToolRequest) ToolCallResult {
	res := ToolCallResult{ToolCallID: req.ID, Name: req.Name}
	fn, ok := tc.Registry.Lookup(req.Name)
	if !ok {
		// 对齐 TS: 未知工具返回 "Unknown tool: X" (isError=false)
		res.Output = applyToolResultBudget(req.Name, "Unknown tool: "+req.Name)
		return res
	}
	v, err := fn(ctx, req)
	if err != nil {
		// 对齐 TS 外层 catch: "Error: ..." + isError=true, 不再裁剪
		res.Output = "Error: " + err.Error()
		res.IsError = true
		return res
	}
	m, mok := v.(map[string]any)
	if !mok {
		res.Output = fmt.Sprint(v)
		return res
	}
	executed, _ := m["executed"].(bool)
	if !executed {
		// 对齐 TS 内联错误 (边界/敏感文件/缺参/服务未启动): 输出消息,
		// isError=false, 统一预算裁剪
		msg, _ := m["error"].(string)
		res.Output = applyToolResultBudget(req.Name, msg)
		return res
	}
	out, _ := m["output"].(string)
	// L2 优化: 对未单独裁剪的工具 (画布/扩展) 统一应用预算 (对齐 TS 出口裁剪;
	// 已裁剪过的 output 长度 ≤ 预算, 不会二次截断)
	res.Output = applyToolResultBudget(req.Name, out)
	res.IsError, _ = m["isError"].(bool)
	return res
}

// defaultChain 进程级默认工具链 (对齐 TS executeToolCall 的模块级入口)
var defaultChain = NewToolChain()

// ExecuteToolCall 执行一次工具调用 (对齐 TS executeToolCall, Agent 循环的
// 统一入口); 需要自定义装配 (注入执行器/工作区) 时直接用 ToolChain.Execute。
func ExecuteToolCall(ctx context.Context, req ToolRequest) ToolCallResult {
	return defaultChain.Execute(ctx, req)
}
