// ─────────────────────────────────────────────────────────────────
// builtin.go — 内置真实执行器 (替换 relay.go 中的占位实现)
//
// 语义对齐旧 TS 动态工具系统 (UI/server.ts 的 invokeXxx 函数族):
//
//	BrowserUseExecutor — bu_*/browser_* → Browser-Use 本机 HTTP 端点 (/api/browser-use/*)
//	WindowsMCPExecutor — win_*          → 注入的命令执行函数 (翻译为 PowerShell 命令)
//	DevToolsExecutor   — console/network/dom_inspect → 注入的 CDP 端点
//	ObscuraExecutor    — 兜底路由 (探活 + 回显, 对齐 TS invokeObscura)
//
// 所有依赖 (HTTP client / 命令执行函数 / CDP 客户端) 均可注入, 便于
// 单元测试与 Tauri 阶段替换真实后端。结果统一为
// {"executed", "tool", "output"|"error"}, 对齐旧 TS {success, output, error}
// 的"友好错误, 不抛异常"语义 (仅在 ctx 取消时才返回 Go error)。
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// ─── 默认端点 (对齐旧系统本机服务端口) ─────────────────────────────

// DefaultBrowserUseURL Browser-Use 本机服务基址
// (旧系统 Browser-Use 本机端点语义; 可用 BrowserUseExecutor.BaseURL 覆盖)
const DefaultBrowserUseURL = "http://127.0.0.1:8790"

// DefaultCDPURL Obscura CDP 调试端点
// (对齐 TS OBSCURA_URL 默认值 http://127.0.0.1:9222)
const DefaultCDPURL = "http://127.0.0.1:9222"

// ─── 共享依赖抽象与辅助函数 ─────────────────────────────────────────

// HTTPDoer HTTP 客户端最小抽象 (*http.Client 天然满足), 便于注入测试客户端
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// defaultHTTPClient 默认 HTTP 客户端 (30s 超时, 对齐 TS execute_cmd 的 30s 预算)
func defaultHTTPClient() *http.Client { return &http.Client{Timeout: 30 * time.Second} }

// toolResult 构造统一工具结果。executed=false 时 error 携带友好消息,
// 与旧 TS 一样不作为 Go error 抛出。
func toolResult(tool string, executed bool, output, errMsg string) map[string]any {
	r := map[string]any{"executed": executed, "tool": tool}
	if executed {
		r["output"] = output
	} else {
		r["error"] = errMsg
	}
	return r
}

// prettyJSON 缩进格式化 JSON (对齐 TS JSON.stringify(x, null, 2))
func prettyJSON(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, b, "", "  "); err != nil {
		return string(b)
	}
	return buf.String()
}

// argsOrEmpty nil 参数兜底为 "{}" (Dispatch 的 args 可缺省)
func argsOrEmpty(args json.RawMessage) string {
	if len(args) == 0 {
		return "{}"
	}
	return string(args)
}

// argsObject 把 args 解析为键值表 (容忍 nil / 非法 JSON, 返回空表)
func argsObject(args json.RawMessage) map[string]any {
	m := map[string]any{}
	if len(args) > 0 {
		_ = json.Unmarshal(args, &m)
	}
	return m
}

// cdpProbe CDP discovery 端点探活 (对齐 TS: GET {OBSCURA_URL}/json/version)。
// 返回产品名 (info.product || info.Browser)、非 200 时的状态码与错误。
func cdpProbe(ctx context.Context, doer HTTPDoer, base string) (product string, status int, err error) {
	req, reqErr := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimRight(base, "/")+"/json/version", nil)
	if reqErr != nil {
		return "", 0, reqErr
	}
	resp, doErr := doer.Do(req)
	if doErr != nil {
		return "", 0, doErr
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", resp.StatusCode, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var info struct {
		Product string `json:"product"`
		Browser string `json:"Browser"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", resp.StatusCode, err
	}
	product = info.Product
	if product == "" {
		product = info.Browser
	}
	if product == "" {
		product = "CDP server" // 对齐 TS: info.product || info.Browser || "CDP server"
	}
	return product, resp.StatusCode, nil
}

// ─── BrowserUse 执行器 ─────────────────────────────────────────────

// BrowserUseExecutor Browser-Use 任务编排执行器。
//
// 语义对齐 TS invokeBrowserUse: 先探活 GET /api/browser-use/health,
// 再按工具名路由到 /run、/pause/:id、/resume/:id、/state/:id 等本机端点。
// browser_* 工具 (未被 DevTools 认领的) 转发到统一调用端点 /invoke,
// 请求体 {name, arguments}, 对齐 TS 扩展工具的 /api/tools/invoke 形态。
type BrowserUseExecutor struct {
	// BaseURL Browser-Use 本机服务基址 (默认 http://127.0.0.1:8790)
	BaseURL string
	// HTTP HTTP 客户端 (可注入; nil 时用 30s 超时的默认客户端)
	HTTP HTTPDoer
}

// NewBrowserUseExecutor 带默认端点与客户端的执行器
func NewBrowserUseExecutor() *BrowserUseExecutor {
	return &BrowserUseExecutor{BaseURL: DefaultBrowserUseURL, HTTP: defaultHTTPClient()}
}

// CanHandle 匹配 bu_* / browser_* 前缀
// (browser_console/browser_network/browser_dom_inspect 由更具体的
// DevToolsExecutor 优先认领, 见 NewWithBuiltins 的注册顺序)
func (e *BrowserUseExecutor) CanHandle(tool string) bool {
	return strings.HasPrefix(tool, "bu_") || strings.HasPrefix(tool, "browser_")
}

// Execute 探活后按旧 TS 路由表转发到 Browser-Use 本机端点
func (e *BrowserUseExecutor) Execute(ctx context.Context, tool string, args json.RawMessage) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	base := e.BaseURL
	if base == "" {
		base = DefaultBrowserUseURL
	}
	doer := e.HTTP
	if doer == nil {
		doer = defaultHTTPClient()
	}

	// 1) 探活 (对齐 TS: GET /api/browser-use/health → {success, ready, error})
	if msg := browserUseHealth(ctx, doer, base); msg != "" {
		return toolResult(tool, false, "", msg), nil
	}

	// 2) 按工具名路由 (对齐 TS invokeBrowserUse 的 switch 表)
	a := argsObject(args)
	taskID, _ := a["task_id"].(string)
	switch {
	case tool == "bu_run_task":
		task, _ := a["task"].(string)
		if task == "" {
			return toolResult(tool, false, "", `bu_run_task 缺少 "task" 参数`), nil
		}
		body := map[string]string{"task": task}
		if u, _ := a["url"].(string); u != "" {
			body["url"] = u
		}
		return e.call(ctx, doer, base, tool, http.MethodPost, "/api/browser-use/run", body)

	case tool == "bu_pause":
		if taskID == "" {
			return toolResult(tool, false, "", `bu_pause 缺少 "task_id" 参数`), nil
		}
		return e.call(ctx, doer, base, tool, http.MethodPost,
			"/api/browser-use/pause/"+url.PathEscape(taskID), nil)

	case tool == "bu_resume":
		if taskID == "" {
			return toolResult(tool, false, "", `bu_resume 缺少 "task_id" 参数`), nil
		}
		return e.call(ctx, doer, base, tool, http.MethodPost,
			"/api/browser-use/resume/"+url.PathEscape(taskID), nil)

	case tool == "bu_state" || tool == "bu_screenshot" || tool == "bu_history":
		if taskID == "" {
			return toolResult(tool, false, "", tool+` 缺少 "task_id" 参数`), nil
		}
		return e.call(ctx, doer, base, tool, http.MethodGet,
			"/api/browser-use/state/"+url.PathEscape(taskID), nil)

	case strings.HasPrefix(tool, "browser_"):
		// browser_* (除 DevTools 认领的三个) → 统一调用端点,
		// 请求体 {name, arguments} 对齐 TS 扩展工具转发形态
		body := map[string]any{"name": tool, "arguments": argsObject(args)}
		return e.callInvoke(ctx, doer, base, tool, body)

	default:
		return toolResult(tool, false, "", "未知的 Browser-Use 工具: "+tool), nil
	}
}

// browserUseHealth 探活 /api/browser-use/health。就绪返回 "", 否则返回友好错误消息。
func browserUseHealth(ctx context.Context, doer HTTPDoer, base string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimRight(base, "/")+"/api/browser-use/health", nil)
	if err != nil {
		return "工具服务 [Browser-Use] 未启动，请先启动对应服务"
	}
	resp, err := doer.Do(req)
	if err != nil {
		return "工具服务 [Browser-Use] 未启动，请先启动对应服务"
	}
	defer resp.Body.Close()
	var h struct {
		Success bool   `json:"success"`
		Ready   bool   `json:"ready"`
		Error   string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		return "工具服务 [Browser-Use] 未启动，请先启动对应服务"
	}
	if !h.Success || !h.Ready {
		msg := "not ready"
		if h.Error != "" {
			msg = h.Error
		}
		return "工具服务 [Browser-Use] 未就绪: " + msg
	}
	return ""
}

// call 调用 Browser-Use 端点并解析 {success, task?, error} 响应。
// output 对齐 TS: task 存在时输出 task 的缩进 JSON, 否则输出整个响应。
func (e *BrowserUseExecutor) call(ctx context.Context, doer HTTPDoer, base, tool, method, path string, body any) (any, error) {
	var reader io.Reader
	if body != nil {
		var buf bytes.Buffer
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return toolResult(tool, false, "", "构造请求失败: "+err.Error()), nil
		}
		reader = &buf
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(base, "/")+path, reader)
	if err != nil {
		return toolResult(tool, false, "", "工具服务 [Browser-Use] 未启动，请先启动对应服务"), nil
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := doer.Do(req)
	if err != nil {
		return toolResult(tool, false, "", "工具服务 [Browser-Use] 未启动，请先启动对应服务"), nil
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return toolResult(tool, false, "", fmt.Sprintf("Browser-Use 调用失败 (HTTP %d)", resp.StatusCode)), nil
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(raw, &data); err != nil {
		return toolResult(tool, false, "", fmt.Sprintf("Browser-Use 调用失败 (HTTP %d)", resp.StatusCode)), nil
	}
	var success bool
	if v, ok := data["success"]; ok {
		_ = json.Unmarshal(v, &success)
	}
	if !success {
		errMsg := "Browser-Use 调用失败"
		var errStr string
		if v, ok := data["error"]; ok {
			if jsonErr := json.Unmarshal(v, &errStr); jsonErr == nil && errStr != "" {
				errMsg = errStr
			}
		}
		return toolResult(tool, false, "", errMsg), nil
	}
	if task, ok := data["task"]; ok && len(task) > 0 && string(task) != "null" {
		return toolResult(tool, true, prettyJSON(task), ""), nil
	}
	return toolResult(tool, true, prettyJSON(raw), ""), nil
}

// callInvoke 调用统一工具端点 /api/browser-use/invoke, 解析 {success, output, error}。
func (e *BrowserUseExecutor) callInvoke(ctx context.Context, doer HTTPDoer, base, tool string, body any) (any, error) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		return toolResult(tool, false, "", "构造请求失败: "+err.Error()), nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(base, "/")+"/api/browser-use/invoke", &buf)
	if err != nil {
		return toolResult(tool, false, "", "工具服务 [Browser-Use] 未启动，请先启动对应服务"), nil
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := doer.Do(req)
	if err != nil {
		return toolResult(tool, false, "", "工具服务 [Browser-Use] 未启动，请先启动对应服务"), nil
	}
	defer resp.Body.Close()
	var data struct {
		Success bool   `json:"success"`
		Output  string `json:"output"`
		Error   string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return toolResult(tool, false, "", fmt.Sprintf("Browser-Use 调用失败 (HTTP %d)", resp.StatusCode)), nil
	}
	if !data.Success {
		msg := data.Error
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return toolResult(tool, false, "", "Error: "+msg), nil
	}
	out := data.Output
	if out == "" {
		out = "OK" // 对齐 TS: data.output ?? 'OK'
	}
	return toolResult(tool, true, out, ""), nil
}

// ─── WindowsMCP 执行器 ─────────────────────────────────────────────

// CommandFunc 命令执行函数抽象 (可注入; 默认走本机 PowerShell)。
// 返回命令输出; err 非 nil 表示命令执行失败。
type CommandFunc func(ctx context.Context, command string) (string, error)

// DefaultCommandFunc 默认命令执行: 本机 PowerShell
// (Windows 用 powershell, 其他平台用 pwsh), 由 ctx 控制超时。
func DefaultCommandFunc(ctx context.Context, command string) (string, error) {
	exe := "powershell"
	if runtime.GOOS != "windows" {
		exe = "pwsh"
	}
	cmd := exec.CommandContext(ctx, exe, "-NoProfile", "-NonInteractive", "-Command", command)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// WindowsMCPExecutor Windows 系统自动化执行器。
//
// Execute 通过注入的命令执行函数执行: win_* 工具先翻译为 PowerShell 命令
// (对齐 TS invokeWindowsMcp 的 toolMap 翻译表), 再交给 CommandFunc。
// 差异说明: 旧 TS 版 win_reg_read 走 MCP "Registry" 工具、win_service_ctrl
// 的 start/stop 也被译成 Get-Service (只查不控); 本版统一译为等价
// PowerShell 命令 (Get-ItemProperty / Start-Service / Stop-Service)。
type WindowsMCPExecutor struct {
	// Run 命令执行函数 (可注入; nil 时用 DefaultCommandFunc)
	Run CommandFunc
}

// NewWindowsMCPExecutor 带默认命令执行函数的执行器
func NewWindowsMCPExecutor() *WindowsMCPExecutor {
	return &WindowsMCPExecutor{Run: DefaultCommandFunc}
}

// CanHandle 匹配 win_* 前缀, 覆盖 win_powershell / win_reg_read /
// win_service_ctrl / win_task_scheduler / win_event_log / win_firewall /
// win_perfmon 全部 Windows-MCP 工具
func (e *WindowsMCPExecutor) CanHandle(tool string) bool {
	return strings.HasPrefix(tool, "win_")
}

// psQuote PowerShell 单引号字面量转义 (内容中的单引号翻倍)
func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// Execute 翻译 win_* 工具为 PowerShell 命令并经注入的命令函数执行
func (e *WindowsMCPExecutor) Execute(ctx context.Context, tool string, args json.RawMessage) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	a := argsObject(args)
	str := func(k string) string { s, _ := a[k].(string); return s }

	var command string
	switch tool {
	case "win_powershell":
		script := str("script")
		if script == "" {
			return toolResult(tool, false, "", `win_powershell 缺少 "script" 参数`), nil
		}
		command = script

	case "win_reg_read":
		path := str("path")
		if path == "" {
			return toolResult(tool, false, "", `win_reg_read 缺少 "path" 参数`), nil
		}
		command = "Get-ItemProperty -Path " + psQuote(path)
		if name := str("name"); name != "" {
			command += " -Name " + psQuote(name)
		}

	case "win_service_ctrl":
		action := str("action")
		if action == "" {
			return toolResult(tool, false, "", `win_service_ctrl 缺少 "action" 参数`), nil
		}
		name := str("name")
		switch action {
		case "list":
			command = "Get-Service"
		case "start", "stop":
			if name == "" {
				return toolResult(tool, false, "", `win_service_ctrl `+action+` 操作缺少 "name" 参数`), nil
			}
			verb := "Start-Service"
			if action == "stop" {
				verb = "Stop-Service"
			}
			command = verb + " -Name " + psQuote(name)
		default: // status 等: 对齐 TS 的 Get-Service -Name 查询
			if name == "" {
				return toolResult(tool, false, "", `win_service_ctrl `+action+` 操作缺少 "name" 参数`), nil
			}
			command = "Get-Service -Name " + psQuote(name)
		}

	case "win_task_scheduler":
		action := str("action")
		if action == "" {
			return toolResult(tool, false, "", `win_task_scheduler 缺少 "action" 参数`), nil
		}
		if action == "list" { // 对齐 TS: schtasks /query
			command = "schtasks /query"
		} else {
			name := str("name")
			if name == "" {
				return toolResult(tool, false, "", `win_task_scheduler `+action+` 操作缺少 "name" 参数`), nil
			}
			command = "schtasks /" + action + " /tn " + psQuote(name)
		}

	case "win_event_log":
		source := str("source")
		if source == "" {
			return toolResult(tool, false, "", `win_event_log 缺少 "source" 参数`), nil
		}
		count := 20 // 对齐 TS 默认 20 条
		if c, ok := a["count"].(float64); ok && c > 0 {
			count = int(c)
		}
		command = fmt.Sprintf("Get-EventLog -LogName %s -Newest %d", psQuote(source), count)

	case "win_firewall":
		action := str("action")
		if action == "" {
			return toolResult(tool, false, "", `win_firewall 缺少 "action" 参数`), nil
		}
		if action == "list" { // 对齐 TS: netsh 全量规则
			command = "netsh advfirewall firewall show rule name=all"
		} else {
			name := str("name")
			if name == "" {
				return toolResult(tool, false, "", `win_firewall `+action+` 操作缺少 "name" 参数`), nil
			}
			command = "netsh advfirewall firewall show rule name=" + psQuote(name)
		}

	case "win_perfmon":
		if counter := str("counter"); counter != "" {
			command = "Get-Counter -Counter " + psQuote(counter)
		} else {
			command = "Get-Counter" // 对齐 TS: 无 counter 时取常用指标
		}

	default:
		return toolResult(tool, false, "", "未知的 Windows-MCP 工具: "+tool), nil
	}

	run := e.Run
	if run == nil {
		run = DefaultCommandFunc
	}
	out, err := run(ctx, command)
	if err != nil {
		// 对齐 TS: "Windows-MCP 工具执行错误: ..." 友好消息, 不抛 Go error
		return toolResult(tool, false, "", fmt.Sprintf("Windows-MCP 工具执行错误: %v", err)), nil
	}
	return map[string]any{
		"executed": true,
		"tool":     tool,
		"command":  command,
		"output":   strings.TrimSpace(out),
	}, nil
}

// ─── DevTools 执行器 ───────────────────────────────────────────────

// CDPClient CDP (Chrome DevTools Protocol) 端点抽象 (可注入)。
// Call 向调试端点发送一条协议命令并返回原始 JSON 结果。
type CDPClient interface {
	Call(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error)
}

// DevToolsExecutor DevTools 调试执行器。
//
// CanHandle 匹配 console / network / dom_inspect (对应 schema 的
// browser_console / browser_network / browser_dom_inspect, 含其变体)。
// Execute 经注入的 CDP 端点执行: 先探活 {URL}/json/version (对齐旧系统
// Obscura CDP 语义), 再按工具映射 CDP 命令。未注入 CDP 客户端时仅探活并
// 回显调用 (对齐 TS invokeObscura 的兜底行为), 方便 Tauri 阶段接入真驱动。
type DevToolsExecutor struct {
	// URL CDP 调试端点 (默认 http://127.0.0.1:9222)
	URL string
	// HTTP 探活用 HTTP 客户端 (可注入; nil 时用默认客户端)
	HTTP HTTPDoer
	// CDP CDP 协议客户端 (可注入; nil 时只探活 + 回显)
	CDP CDPClient
}

// NewDevToolsExecutor 带默认端点的执行器 (CDP 客户端待注入)
func NewDevToolsExecutor() *DevToolsExecutor {
	return &DevToolsExecutor{URL: DefaultCDPURL, HTTP: defaultHTTPClient()}
}

// devToolsCDPMethod 工具名 → CDP 协议命令映射。
// console/network 的日志与事件经 CDP 事件流推送, enable 即开始捕获;
// dom_inspect 用 DOM.getDocument 拉取整棵 DOM (selector 细化由驱动侧处理)。
func devToolsCDPMethod(tool string) string {
	switch {
	case strings.Contains(tool, "console"):
		return "Log.enable"
	case strings.Contains(tool, "network"):
		return "Network.enable"
	case strings.Contains(tool, "dom_inspect"):
		return "DOM.getDocument"
	default:
		return ""
	}
}

// CanHandle 匹配 console / network / dom_inspect 片段
func (e *DevToolsExecutor) CanHandle(tool string) bool {
	return devToolsCDPMethod(tool) != ""
}

// Execute 探活 CDP 端点后, 经注入的 CDP 客户端执行协议命令
func (e *DevToolsExecutor) Execute(ctx context.Context, tool string, args json.RawMessage) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	base := e.URL
	if base == "" {
		base = DefaultCDPURL
	}
	doer := e.HTTP
	if doer == nil {
		doer = defaultHTTPClient()
	}

	// 1) 探活 (对齐 TS invokeObscura: GET /json/version)
	product, status, err := cdpProbe(ctx, doer, base)
	if err != nil {
		if status != 0 { // 服务在线但探测失败
			return toolResult(tool, false, "", fmt.Sprintf("工具服务 [DevTools] 健康检查失败 (%d)", status)), nil
		}
		return toolResult(tool, false, "", "工具服务 [DevTools] 未启动，请先启动对应服务 (obscura serve)"), nil
	}

	// 2) 注入了 CDP 客户端 → 执行真实协议调用
	method := devToolsCDPMethod(tool)
	if e.CDP != nil {
		res, callErr := e.CDP.Call(ctx, method, []byte("{}"))
		if callErr != nil {
			return toolResult(tool, false, "", fmt.Sprintf("CDP 调用失败: %v", callErr)), nil
		}
		return map[string]any{
			"executed":   true,
			"tool":       tool,
			"cdp_method": method,
			"output":     prettyJSON(res),
		}, nil
	}

	// 3) 未注入 CDP 客户端 → 探活 + 回显 (对齐 TS invokeObscura 成功分支)
	output := fmt.Sprintf("DevTools (CDP) 端点已就绪 (%s)。已接收工具 %s 调用，参数: %s。注入 CDPClient 后执行真实协议调用 (%s)。",
		product, tool, argsOrEmpty(args), method)
	return toolResult(tool, true, output, ""), nil
}

// ─── Obscura 执行器 (兜底路由) ─────────────────────────────────────

// ObscuraExecutor Obscura 兜底执行器。
//
// CanHandle 恒真 (兜底路由), 接住其他执行器都不认领的工具。
// 行为对齐 TS invokeObscura: 探活 {URL}/json/version 并回显收到的调用;
// CDP 完整驱动 (截图/DOM 检查等) 仍由 CDP 客户端完成。
type ObscuraExecutor struct {
	// URL Obscura CDP 端点 (默认 http://127.0.0.1:9222)
	URL string
	// HTTP 探活用 HTTP 客户端 (可注入; nil 时用默认客户端)
	HTTP HTTPDoer
}

// NewObscuraExecutor 带默认端点的执行器
func NewObscuraExecutor() *ObscuraExecutor {
	return &ObscuraExecutor{URL: DefaultCDPURL, HTTP: defaultHTTPClient()}
}

// CanHandle 兜底: 恒真, 依赖注册顺序保证最低优先级
func (e *ObscuraExecutor) CanHandle(tool string) bool { return true }

// Execute 探活 Obscura CDP 端点并回显调用 (对齐 TS invokeObscura)
func (e *ObscuraExecutor) Execute(ctx context.Context, tool string, args json.RawMessage) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	base := e.URL
	if base == "" {
		base = DefaultCDPURL
	}
	doer := e.HTTP
	if doer == nil {
		doer = defaultHTTPClient()
	}

	product, status, err := cdpProbe(ctx, doer, base)
	if err != nil {
		if status != 0 {
			return toolResult(tool, false, "", fmt.Sprintf("工具服务 [Obscura] 健康检查失败 (%d)", status)), nil
		}
		return toolResult(tool, false, "", "工具服务 [Obscura] 未启动，请先启动对应服务 (obscura serve)"), nil
	}
	output := fmt.Sprintf("Obscura 服务已就绪 (%s)。已接收工具 %s 调用，参数: %s",
		product, tool, argsOrEmpty(args))
	return toolResult(tool, true, output, ""), nil
}

// ─── 装配 ──────────────────────────────────────────────────────────

// NewWithBuiltins 带真实内置执行器的 Relay (替换占位版 NewWithPlaceholders)。
//
// Register 的语义是后注册者优先匹配, 因此注册顺序即优先级从低到高:
//  1. Obscura   — 兜底, 必须最先注册以保证最低优先级
//  2. BrowserUse — bu_*/browser_* 前缀
//  3. WindowsMCP — win_* 前缀
//  4. DevTools   — console/network/dom_inspect 最具体, 必须后注册以
//     覆盖 BrowserUse 对 browser_* 的宽泛前缀
func NewWithBuiltins() *Relay {
	r := New()
	r.Register(NewObscuraExecutor())
	r.Register(NewBrowserUseExecutor())
	r.Register(NewWindowsMCPExecutor())
	r.Register(NewDevToolsExecutor())
	return r
}
