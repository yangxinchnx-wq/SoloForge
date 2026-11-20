// ─────────────────────────────────────────────────────────────────
// coretools.go — 核心工具实现 (从 TS tool-definitions.ts 的 executeToolCall 迁移)
//
// 对齐 TS 五个核心工具的执行语义:
//
//	read_file   — 分页读取文件 (offset/limit), 4000 字符预算 + 分页提示
//	write_file  — 写文件 (自动建父目录), 敏感文件防护 + 工作区边界校验
//	execute_cmd — 终端命令执行 (Windows cmd /c, *nix sh -c, 30s 超时 → exit 124,
//	              stdout/stderr 经 ToolStreamHook 实时外发), 3000 字符预算保留尾部
//	search_code — 正则搜索代码 (大小写不敏感, 深度 5, 上限 30 条,
//	              跳过隐藏项/node_modules/dist), 2000 字符预算
//	list_files  — 列目录 (glob 过滤, 最多 100 条), 3000 字符预算
//
// 结果统一为 builtin.go 的 toolResult 形态 {executed, tool, output|error};
// 与 TS 一样"友好错误, 不抛异常": 工作区越界/敏感文件拦截一律作为内联结果
// 返回 (executed=false); execute_cmd 非零退出额外带 "isError": true; 仅
// ctx 取消、必选参数缺失、IO 失败、非法正则返回 Go error (对齐 TS 外层
// catch 的 "Error: ..." + isError=true 语义, 由 ExecuteToolCall 统一包装)。
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// ─── 路径解析与工作区边界 ─────────────────────────────────────────

var (
	projectRootMu       sync.RWMutex
	projectRootOverride string
)

// SetProjectRoot 覆盖相对路径解析基准 (对齐 TS PROJECT_ROOT: 仓库根目录)。
// Go 版默认取进程工作目录, 供调用方 (如 Agent 运行时) 注入项目根。
func SetProjectRoot(dir string) {
	projectRootMu.Lock()
	defer projectRootMu.Unlock()
	projectRootOverride = dir
}

// projectRoot 相对路径解析基准 (对齐 TS PROJECT_ROOT)
func projectRoot() string {
	projectRootMu.RLock()
	defer projectRootMu.RUnlock()
	if projectRootOverride != "" {
		return projectRootOverride
	}
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}

// resolvePath 相对路径按项目根目录解析 (对齐 TS resolvePath)
func resolvePath(p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(projectRoot(), p)
}

// checkWorkspaceBoundary 工作区边界校验 (对齐 TS checkWorkspaceBoundary)。
// 返回 "" 表示通过; 否则返回拒绝消息 (作为工具内联结果, 不抛 Go error)。
func checkWorkspaceBoundary(targetPath, workspaceFolder string) string {
	if workspaceFolder == "" {
		return "" // 未绑定工作区, 不限制
	}
	resolved := targetPath
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(workspaceFolder, resolved)
	}
	target := filepath.Clean(resolved)
	ws := filepath.Clean(workspaceFolder)
	if target == ws || strings.HasPrefix(target, ws+string(os.PathSeparator)) {
		return ""
	}
	return fmt.Sprintf("路径 \"%s\" 不在工作区文件夹 \"%s\" 范围内。当前对话已绑定工作区, 文件操作仅限于此文件夹内。如需操作外部文件, 请在对话中告知用户并请求授权。",
		targetPath, workspaceFolder)
}

// ─── 参数辅助 ────────────────────────────────────────────────────

// argStr 取字符串参数 (缺失/类型不符返回 "")
func argStr(a map[string]any, key string) string {
	s, _ := a[key].(string)
	return s
}

// argNum 取数值参数 (JSON number → float64)
func argNum(a map[string]any, key string) (float64, bool) {
	f, ok := a[key].(float64)
	return f, ok
}

// ─── 简单 glob 匹配 ──────────────────────────────────────────────

// matchGlob 简单 glob 匹配 (支持 *, **, ?; 对齐 TS matchGlob)。
// 非法 pattern 时不做过滤 (返回 true)。
func matchGlob(name, pattern string) bool {
	if pattern == "" || pattern == "*" {
		return true
	}
	if strings.HasPrefix(pattern, "**/") {
		return matchGlob(name, pattern[3:])
	}
	var b strings.Builder
	b.WriteByte('^')
	for _, r := range pattern {
		switch r {
		case '*':
			b.WriteString("[^/]*")
		case '?':
			b.WriteString("[^/]")
		default:
			// 转义正则特殊字符 (对齐 TS /[.+^${}()|[\]\\]/g)
			if strings.ContainsRune(".+^${}()|[]\\", r) {
				b.WriteByte('\\')
			}
			b.WriteRune(r)
		}
	}
	b.WriteByte('$')
	re, err := regexp.Compile(b.String())
	if err != nil {
		return true // 非法 pattern 时不做过滤
	}
	return re.MatchString(name)
}

// ─── 工具结果预算 (L2 优化: 防止单个结果撑爆上下文) ────────────────

// toolResultBudgets 各工具输出预算 (字符数, 按 rune 计; 对齐 TS TOOL_RESULT_BUDGET)
var toolResultBudgets = map[string]int{
	"read_file":   4000,
	"execute_cmd": 3000,
	"search_code": 2000,
	"list_files":  3000,
}

// defaultToolResultBudget 通用上限 (对齐 TS DEFAULT_TOOL_RESULT_BUDGET)
const defaultToolResultBudget = 4000

// applyToolResultBudget 按预算裁剪工具输出 (对齐 TS applyToolResultBudget):
// read_file 截头部并提示 offset/limit 分页; execute_cmd 保留尾部 (错误通常
// 在最后); 其余截头部。长度按 rune 计 (TS 为 UTF-16 码元, ASCII 下一致)。
func applyToolResultBudget(toolName, output string) string {
	budget, ok := toolResultBudgets[toolName]
	if !ok {
		budget = defaultToolResultBudget
	}
	runes := []rune(output)
	totalChars := len(runes)
	if totalChars <= budget {
		return output
	}
	switch toolName {
	case "read_file":
		// 截断头部, 提示用 offset/limit 分页
		truncated := string(runes[:budget])
		totalLines := strings.Count(output, "\n") + 1
		shownLines := strings.Count(truncated, "\n") + 1
		return truncated + fmt.Sprintf(
			"\n\n... [TRUNCATED by Agent Loop Budget] showing first %d of ~%d lines (%d chars total). Use offset=%d and limit=100 to read the next section.",
			shownLines, totalLines, totalChars, shownLines+1)
	case "execute_cmd":
		// 保留尾部 (错误信息通常在最后)
		tail := string(runes[totalChars-budget:])
		return fmt.Sprintf("... [TRUNCATED: first %d chars omitted, showing last %d] ...\n",
			totalChars-budget, budget) + tail
	default:
		// 其余工具: 截断头部
		return string(runes[:budget]) + fmt.Sprintf(
			"\n\n... [TRUNCATED by Agent Loop Budget] %d chars total, showing first %d.",
			totalChars, budget)
	}
}

// ─── read_file ───────────────────────────────────────────────────

// toolReadFile 读取项目文件 (对齐 TS read_file: offset 从 1 起, limit 缺省读全部)
func toolReadFile(ctx context.Context, req ToolRequest) (any, error) {
	a := argsObject(req.Arguments)
	filePath := argStr(a, "file_path")
	if filePath == "" {
		return nil, fmt.Errorf("read_file 缺少 \"file_path\" 参数")
	}
	filePath = resolvePath(filePath)
	if msg := checkWorkspaceBoundary(filePath, req.WorkspaceFolder); msg != "" {
		return toolResult(req.Name, false, "", msg), nil
	}
	content, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(content), "\n")

	// offset: 对齐 TS (offset ?? 1) - 1; 越界收敛到有效区间 (TS 的 JS 负数
	// slice 语义为隐性行为, Go 版取"从第 1 行起"的直觉语义)
	offset := 0
	if v, ok := argNum(a, "offset"); ok && v >= 1 {
		offset = int(v) - 1
	}
	if offset > len(lines) {
		offset = len(lines)
	}
	// limit: 对齐 TS limit ?? 全部; 0 表示读空 (与 TS slice 行为一致)
	limit := len(lines)
	if v, ok := argNum(a, "limit"); ok && v >= 0 {
		limit = int(v)
	}
	end := offset + limit
	if end > len(lines) {
		end = len(lines)
	}

	output := strings.Join(lines[offset:end], "\n")
	// L2 优化: 4000 字符预算 + 分页提示
	output = applyToolResultBudget("read_file", output)
	return toolResult(req.Name, true, output, ""), nil
}

// ─── write_file ──────────────────────────────────────────────────

// dangerousPathRe 敏感文件路径匹配 (对齐 TS DANGEROUS_PATTERNS; 输入已
// 规范化 + 小写化, 故无需大小写标志)
var dangerousPathRe = regexp.MustCompile(
	`\.env$|\.env\.\w+$|/\.git/|/\.ssh/|credentials|secret|private[_-]?key|\.pem$|\.key$|id_rsa`)

// toolWriteFile 写入项目文件 (对齐 TS write_file: 自动建父目录 + 敏感文件防护)
func toolWriteFile(ctx context.Context, req ToolRequest) (any, error) {
	a := argsObject(req.Arguments)
	filePath := argStr(a, "file_path")
	if filePath == "" {
		return nil, fmt.Errorf("write_file 缺少 \"file_path\" 参数")
	}
	content, ok := a["content"].(string)
	if !ok {
		return nil, fmt.Errorf("write_file 缺少 \"content\" 参数 (需为字符串)")
	}
	resolved := resolvePath(filePath)
	if msg := checkWorkspaceBoundary(resolved, req.WorkspaceFolder); msg != "" {
		return toolResult(req.Name, false, "", msg), nil
	}
	// 危险文件防护: 阻止 LLM 覆盖敏感文件 (对齐 TS: normalize → 斜杠化 → 小写)
	normalized := strings.ReplaceAll(filepath.Clean(resolved), "\\", "/")
	normalized = strings.ToLower(normalized)
	if dangerousPathRe.MatchString(normalized) {
		return toolResult(req.Name, false, "", fmt.Sprintf(
			"ERROR: write_file blocked: \"%s\" matches a sensitive file pattern. Refusing to overwrite credentials, secrets, SSH keys, .env, or .git files.",
			filePath)), nil
	}
	if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(resolved, []byte(content), 0o644); err != nil {
		return nil, err
	}
	output := fmt.Sprintf("Successfully wrote %d chars to %s", utf8.RuneCountInString(content), filePath)
	return toolResult(req.Name, true, output, ""), nil
}

// ─── execute_cmd ─────────────────────────────────────────────────

// streamWriter 子进程输出捕获: 累积到缓冲, 同时经 ToolStreamHook 实时外发
// (对齐 TS stdout/stderr data 事件 → tool_stdout/tool_stderr 流式 emit)
type streamWriter struct {
	mu     sync.Mutex
	buf    strings.Builder
	event  string // 事件名: tool_stdout / tool_stderr
	callID string
	tool   string
	hook   ToolStreamHook // nil 表示无钩子
}

func (w *streamWriter) init(event string, req ToolRequest) {
	w.event = event
	w.callID = req.ID
	w.tool = req.Name
	w.hook = req.Stream
}

func (w *streamWriter) Write(p []byte) (int, error) {
	s := string(p)
	w.mu.Lock()
	w.buf.WriteString(s)
	w.mu.Unlock()
	if w.hook != nil {
		// emit 失败不影响执行 (对齐 TS try/catch 吞错)
		w.hook(w.event, map[string]any{
			"tool_call_id": w.callID,
			"tool":         w.tool,
			"chunk":        s,
			"ts":           time.Now().UnixMilli(),
		})
	}
	return len(p), nil
}

func (w *streamWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// appendSpawnError spawn 失败时写入 stderr 缓冲 (对齐 TS [spawn error])
func (w *streamWriter) appendSpawnError(err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf.WriteString("\n[spawn error] " + err.Error() + "\n")
}

// toolExecuteCmd 在项目目录执行终端命令 (对齐 TS execute_cmd)。
// 跨平台: Windows 用 cmd /c, *nix 用 sh -c; 30s 兜底超时 (超时 exit 124,
// 对齐 TS SIGTERM → 124); 非零退出时结果带 "isError": true 让 LLM 知道失败。
func toolExecuteCmd(ctx context.Context, req ToolRequest) (any, error) {
	a := argsObject(req.Arguments)
	command := argStr(a, "command") // 对齐 TS String(args.command || '')

	cwd := ""
	if c := argStr(a, "cwd"); c != "" {
		cwd = resolvePath(c)
	} else if req.WorkspaceFolder != "" {
		cwd = req.WorkspaceFolder
	} else {
		cwd = projectRoot()
	}
	if msg := checkWorkspaceBoundary(cwd, req.WorkspaceFolder); msg != "" {
		return toolResult(req.Name, false, "", msg), nil
	}

	// 30s 兜底超时 (对齐 TS setTimeout 30000)
	runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var stdoutW, stderrW streamWriter
	stdoutW.init("tool_stdout", req)
	stderrW.init("tool_stderr", req)

	toolStart := time.Now()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(runCtx, "cmd.exe", "/c", command)
	} else {
		cmd = exec.CommandContext(runCtx, "sh", "-c", command)
	}
	cmd.Dir = cwd
	cmd.Stdout = &stdoutW
	cmd.Stderr = &stderrW

	runErr := cmd.Run()

	// 退出码: 正常 0; 外层取消交上层; 超时 124 (对齐 TS); 子进程非零取其码;
	// spawn 失败 (找不到 shell 等) 记 1 并把错误写入 stderr
	exitCode := 0
	var ee *exec.ExitError
	switch {
	case runErr == nil:
	case ctx.Err() != nil:
		return nil, ctx.Err() // 外层取消, 对齐 builtin 执行器约定
	case runCtx.Err() == context.DeadlineExceeded:
		exitCode = 124
	case errors.As(runErr, &ee):
		exitCode = ee.ExitCode()
	default:
		stderrW.appendSpawnError(runErr)
		exitCode = 1
	}

	durationMs := time.Since(toolStart).Milliseconds()
	if req.Stream != nil {
		req.Stream("tool_exit", map[string]any{
			"tool_call_id": req.ID,
			"tool":         req.Name,
			"exitCode":     exitCode,
			"durationMs":   durationMs,
			"ts":           time.Now().UnixMilli(),
		})
	}

	output := stdoutW.String()
	if stderr := stderrW.String(); stderr != "" {
		output += "\n[stderr]\n" + stderr
	}
	output = strings.TrimSpace(output)
	// L2 优化: 3000 字符预算, 保留尾部 (错误信息通常在最后)
	output = applyToolResultBudget("execute_cmd", output)

	r := toolResult(req.Name, true, output, "")
	if exitCode != 0 {
		// 对齐 TS: 仍走 isError 分支, 让 LLM 知道命令失败
		r["isError"] = true
		r["output"] = output + fmt.Sprintf("\n[exit %d]", exitCode)
	}
	return r, nil
}

// ─── search_code ─────────────────────────────────────────────────

// maxSearchResults 搜索结果上限 (对齐 TS maxResults = 30)
const maxSearchResults = 30

// isBinary 粗略二进制嗅探: 含 NUL 字节视为二进制文件, 跳过不搜
// (TS 以 UTF-8 读入后正则匹配, 二进制几乎不命中; Go 显式跳过避免乱码)
func isBinary(b []byte) bool {
	return bytes.IndexByte(b, 0x00) >= 0
}

// toolSearchCode 在项目中正则搜索代码 (对齐 TS search_code: 大小写不敏感,
// 递归深度 5, 上限 30 条, 跳过隐藏项/node_modules/dist)
func toolSearchCode(ctx context.Context, req ToolRequest) (any, error) {
	a := argsObject(req.Arguments)
	pattern := argStr(a, "pattern")
	if pattern == "" {
		return nil, fmt.Errorf("search_code 缺少 \"pattern\" 参数")
	}
	// 对齐 TS: new RegExp(pattern, 'i') — 大小写不敏感; 非法正则报错
	re, err := regexp.Compile("(?i)" + pattern)
	if err != nil {
		return nil, fmt.Errorf("非法正则表达式 %q: %w", pattern, err)
	}
	glob := argStr(a, "glob")

	var matches []string
	root := projectRoot()
	var searchDir func(dir string, depth int)
	searchDir = func(dir string, depth int) {
		if depth > 5 || len(matches) >= maxSearchResults {
			return
		}
		entries, readErr := os.ReadDir(dir)
		if readErr != nil {
			return // 对齐 TS: 读不了的目录跳过
		}
		for _, entry := range entries {
			if len(matches) >= maxSearchResults {
				break
			}
			name := entry.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == "dist" {
				continue
			}
			full := filepath.Join(dir, name)
			if entry.IsDir() {
				searchDir(full, depth+1)
				continue
			}
			if !entry.Type().IsRegular() {
				continue // 对齐 TS: 仅普通文件 (entry.isFile())
			}
			if glob != "" {
				// 对齐 TS: glob → 扩展名过滤 ("*.ts" → ".ts"); TS 只替换首个
				// '*', "**/*.x" 形态会失效, Go 版替换全部 (修正该隐性缺陷)
				ext := strings.ReplaceAll(glob, "*", "")
				if !strings.HasSuffix(name, ext) {
					continue
				}
			}
			content, readErr := os.ReadFile(full)
			if readErr != nil || isBinary(content) {
				continue // 对齐 TS: 读取失败 (二进制) 跳过
			}
			lines := strings.Split(string(content), "\n")
			for i, line := range lines {
				if len(matches) >= maxSearchResults {
					break
				}
				if re.MatchString(line) {
					rel, relErr := filepath.Rel(root, full)
					if relErr != nil {
						rel = full
					}
					matches = append(matches, fmt.Sprintf("%s:%d: %s", rel, i+1, strings.TrimSpace(line)))
				}
			}
		}
	}
	searchDir(root, 0)

	output := "No matches found."
	if len(matches) > 0 {
		output = strings.Join(matches, "\n")
	}
	// L2 优化: 搜索结果预算裁剪 (2000 字符)
	output = applyToolResultBudget("search_code", output)
	return toolResult(req.Name, true, output, ""), nil
}

// ─── list_files ──────────────────────────────────────────────────

// toolListFiles 列出目录内容 (对齐 TS list_files: glob 过滤, 最多 100 条)
func toolListFiles(ctx context.Context, req ToolRequest) (any, error) {
	a := argsObject(req.Arguments)
	dirPath := ""
	if d := argStr(a, "dir_path"); d != "" {
		dirPath = resolvePath(d)
	} else if req.WorkspaceFolder != "" {
		dirPath = req.WorkspaceFolder
	} else {
		dirPath = projectRoot()
	}
	if msg := checkWorkspaceBoundary(dirPath, req.WorkspaceFolder); msg != "" {
		return toolResult(req.Name, false, "", msg), nil
	}
	pattern := argStr(a, "pattern")
	if pattern == "" {
		pattern = "*"
	}
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}
	var listed []string
	for _, e := range entries {
		if len(listed) >= 100 {
			break
		}
		if !matchGlob(e.Name(), pattern) {
			continue
		}
		icon := "📄"
		if e.IsDir() {
			icon = "📁"
		}
		listed = append(listed, icon+" "+e.Name())
	}
	output := strings.Join(listed, "\n")
	if output == "" {
		output = "(无匹配文件)"
	}
	// L2 优化: 3000 字符预算
	output = applyToolResultBudget("list_files", output)
	return toolResult(req.Name, true, output, ""), nil
}
