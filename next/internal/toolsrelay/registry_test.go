// ─────────────────────────────────────────────────────────────────
// registry_test.go — TS 工具链移植行为自测
//
// 覆盖: glob/预算/边界辅助函数、核心工具读写搜列执行回路、
// 注册表精确路由与遗留别名、Relay 优先级 (注册表 > 执行器 > 兜底)、
// 会话级缓存 TTL/容量/清理、缓存白名单。
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ─── 桩执行器 ────────────────────────────────────────────────────

// stubExecutor 回显桩: 输出 "tag:tool:args"
type stubExecutor struct{ tag string }

func (s stubExecutor) CanHandle(tool string) bool { return true }
func (s stubExecutor) Execute(ctx context.Context, tool string, args json.RawMessage) (any, error) {
	return toolResult(tool, true, s.tag+":"+tool+":"+string(args), ""), nil
}

// pickyStub 只认领一个工具的桩 (测 Relay 优先级)
type pickyStub struct{ tag string }

func (p pickyStub) CanHandle(tool string) bool { return tool == "stub_tool" }
func (p pickyStub) Execute(ctx context.Context, tool string, args json.RawMessage) (any, error) {
	return toolResult(tool, true, p.tag+":"+tool, ""), nil
}

// ─── 辅助函数 ────────────────────────────────────────────────────

func TestMatchGlob(t *testing.T) {
	cases := []struct {
		name, pattern string
		want          bool
	}{
		{"foo.ts", "*.ts", true},
		{"foo.tsx", "*.ts", false}, // '*' 不跨越 (TS 同款正则语义)
		{"a/b.ts", "*.ts", false},
		// **/ 前缀剥离后仍用 [^/]* 匹配 — 与 TS 实际行为一致 (TS 注释称
		// 多级路径可命中系文档笔误; list_files 只传 basename, 实际等价命中)
		{"deep/nested/file.ts", "**/*.ts", false},
		{"file.ts", "**/*.ts", true},
		{"foo.ts", "", true}, // 空 pattern 不过滤
		{"foo.ts", "*", true},
		{"foo", "f?o", true}, // ? 匹配单字符
		{"fxo", "f?o", true},
		{"foo.ts", "foo?.ts", false},
	}
	for _, c := range cases {
		if got := matchGlob(c.name, c.pattern); got != c.want {
			t.Errorf("matchGlob(%q, %q) = %v, want %v", c.name, c.pattern, got, c.want)
		}
	}
}

func TestApplyToolResultBudget(t *testing.T) {
	if got := applyToolResultBudget("read_file", "short"); got != "short" {
		t.Errorf("短输出不应截断, got %q", got)
	}
	long := strings.Repeat("a", 5000)
	r := applyToolResultBudget("read_file", long)
	if !strings.Contains(r, "[TRUNCATED by Agent Loop Budget]") || !strings.Contains(r, "Use offset=") {
		t.Errorf("read_file 截断应带分页提示, got %q", r[:80])
	}
	r = applyToolResultBudget("execute_cmd", long)
	if !strings.HasPrefix(r, "... [TRUNCATED: first") {
		t.Errorf("execute_cmd 截断应保留尾部提示前缀, got %q", r[:40])
	}
	if !strings.HasSuffix(r, strings.Repeat("a", 100)) {
		t.Errorf("execute_cmd 截断应保留尾部内容")
	}
	r = applyToolResultBudget("other_tool", long)
	if !strings.Contains(r, "5000 chars total") {
		t.Errorf("通用截断应报告总长, got %q", r[len(r)-60:])
	}
}

func TestWorkspaceBoundary(t *testing.T) {
	ws := t.TempDir()
	if msg := checkWorkspaceBoundary(filepath.Join(ws, "a.txt"), ws); msg != "" {
		t.Errorf("工作区内路径应通过, got %q", msg)
	}
	outside := filepath.Join(filepath.Dir(ws), "outside.txt")
	if msg := checkWorkspaceBoundary(outside, ws); msg == "" {
		t.Errorf("工作区外路径应被拒绝")
	}
	if msg := checkWorkspaceBoundary("D:/any", ""); msg != "" {
		t.Errorf("未绑定工作区应不限制, got %q", msg)
	}
	// ../ 逃逸应被拒绝 (对齐 TS path.resolve 规范化语义)
	if msg := checkWorkspaceBoundary(filepath.Join(ws, "..", "escape.txt"), ws); msg == "" {
		t.Errorf("../ 逃逸路径应被拒绝")
	}
}

// ─── 核心工具回路 ────────────────────────────────────────────────

func TestCoreToolsRoundTrip(t *testing.T) {
	root := t.TempDir()
	SetProjectRoot(root)
	defer SetProjectRoot("")
	ctx := context.Background()

	// write_file → 自动建父目录
	res := ExecuteToolCall(ctx, ToolRequest{
		ID: "c1", Name: "write_file",
		Arguments: json.RawMessage(`{"file_path":"src/a.ts","content":"line1\nline2\n"}`),
	})
	if res.IsError || !strings.Contains(res.Output, "Successfully wrote") {
		t.Fatalf("write_file 失败: %+v", res)
	}

	// read_file 全量
	res = ExecuteToolCall(ctx, ToolRequest{
		ID: "c2", Name: "read_file",
		Arguments: json.RawMessage(`{"file_path":"src/a.ts"}`),
	})
	if res.IsError || !strings.Contains(res.Output, "line1") || !strings.Contains(res.Output, "line2") {
		t.Fatalf("read_file 全量失败: %+v", res)
	}

	// read_file offset/limit 分页
	res = ExecuteToolCall(ctx, ToolRequest{
		ID: "c3", Name: "read_file",
		Arguments: json.RawMessage(`{"file_path":"src/a.ts","offset":2,"limit":1}`),
	})
	if res.IsError || strings.TrimSpace(res.Output) != "line2" {
		t.Fatalf("read_file 分页失败: %+v", res)
	}

	// search_code 正则 + glob (rel 路径分隔符随平台, 与 TS path.relative 一致)
	res = ExecuteToolCall(ctx, ToolRequest{
		ID: "c4", Name: "search_code",
		Arguments: json.RawMessage(`{"pattern":"LINE2","glob":"*.ts"}`),
	})
	if res.IsError || !strings.Contains(res.Output, "a.ts:2: line2") {
		t.Fatalf("search_code 失败 (大小写不敏感 + rel 路径): %+v", res)
	}

	// list_files
	res = ExecuteToolCall(ctx, ToolRequest{
		ID: "c5", Name: "list_files",
		Arguments: json.RawMessage(`{"dir_path":"src"}`),
	})
	if res.IsError || !strings.Contains(res.Output, "a.ts") {
		t.Fatalf("list_files 失败: %+v", res)
	}

	// execute_cmd: echo (Windows cmd /c 与 *nix sh -c 均支持)
	res = ExecuteToolCall(ctx, ToolRequest{
		ID: "c6", Name: "execute_cmd",
		Arguments: json.RawMessage(`{"command":"echo hello"}`),
	})
	if res.IsError || !strings.Contains(res.Output, "hello") {
		t.Fatalf("execute_cmd echo 失败: %+v", res)
	}

	// execute_cmd: 非零退出 → isError=true + [exit N]
	res = ExecuteToolCall(ctx, ToolRequest{
		ID: "c7", Name: "execute_cmd",
		Arguments: json.RawMessage(`{"command":"exit 3"}`),
	})
	if !res.IsError || !strings.Contains(res.Output, "[exit 3]") {
		t.Fatalf("execute_cmd 非零退出应 isError=true, got %+v", res)
	}
}

func TestExecuteToolCallWrap(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	SetProjectRoot(root)
	defer SetProjectRoot("")

	// 未知工具: "Unknown tool: X", isError=false (对齐 TS)
	res := ExecuteToolCall(ctx, ToolRequest{ID: "u1", Name: "nope"})
	if res.IsError || res.Output != "Unknown tool: nope" {
		t.Fatalf("未知工具应返回 Unknown tool, got %+v", res)
	}

	// IO 失败: "Error: ..." + isError=true (对齐 TS 外层 catch)
	res = ExecuteToolCall(ctx, ToolRequest{
		ID: "u2", Name: "read_file",
		Arguments: json.RawMessage(`{"file_path":"no/such/file.txt"}`),
	})
	if !res.IsError || !strings.HasPrefix(res.Output, "Error:") {
		t.Fatalf("IO 失败应 isError=true + Error 前缀, got %+v", res)
	}

	// 工作区越界: 内联消息, isError=false (对齐 TS inline output)
	// 注: 路径经 json.Marshal 转义, 避免反斜杠破坏 JSON
	outside := filepath.Join(filepath.Dir(root), "outside.txt")
	argsBytes, _ := json.Marshal(map[string]string{"file_path": outside})
	res = ExecuteToolCall(ctx, ToolRequest{
		ID: "u3", Name: "read_file",
		WorkspaceFolder: root,
		Arguments:       argsBytes,
	})
	if res.IsError || !strings.Contains(res.Output, "不在工作区文件夹") {
		t.Fatalf("工作区越界应内联拒绝消息且 isError=false, got %+v", res)
	}

	// write_file 敏感文件拦截: 内联 ERROR, isError=false
	res = ExecuteToolCall(ctx, ToolRequest{
		ID: "u4", Name: "write_file",
		Arguments: json.RawMessage(`{"file_path":"id_rsa","content":"x"}`),
	})
	if res.IsError || !strings.Contains(res.Output, "write_file blocked") {
		t.Fatalf("敏感文件应被拦截, got %+v", res)
	}
}

// ─── 注册表与路由 ────────────────────────────────────────────────

func TestRegistryBuiltinNames(t *testing.T) {
	rg := NewRegistry(nil, nil, nil)
	RegisterBuiltinTools(rg)
	names := rg.Names()
	have := map[string]bool{}
	for _, n := range names {
		have[n] = true
	}
	// 核心工具 + 画布工具 + 扩展工具 + 遗留别名 抽查
	for _, want := range []string{
		"read_file", "write_file", "execute_cmd", "search_code", "list_files",
		"canvas_push_ui", "solo_canvas_list", "solo_canvas_delete",
		"bu_run_task", "bu_state", "win_reg_read", "win_perfmon",
		"browser_console", "browser_cookies",
		"powershell", "service_ctrl",
	} {
		if !have[want] {
			t.Errorf("注册表缺少工具 %q (共 %d 个: %v)", want, len(names), names)
		}
	}
}

func TestRegistryExecuteAndAlias(t *testing.T) {
	rg := NewRegistry(nil, nil, nil)
	rg.Register("echo_tool", executorDelegate(stubExecutor{"stub"}))

	// 委托执行器: req 透传
	v, err := rg.Execute(context.Background(), "echo_tool", json.RawMessage(`{"x":1}`))
	if err != nil {
		t.Fatalf("委托执行失败: %v", err)
	}
	if m := v.(map[string]any); !strings.Contains(m["output"].(string), "stub:echo_tool:") {
		t.Errorf("委托输出不符: %v", m)
	}

	// 遗留别名: 裸名 powershell → 规范名 win_powershell (缺 script 参数 → 内联拒绝)
	RegisterBuiltinTools(rg)
	v, err = rg.Execute(context.Background(), "powershell", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("别名执行失败: %v", err)
	}
	m := v.(map[string]any)
	if m["executed"].(bool) || !strings.Contains(m["error"].(string), `win_powershell 缺少 "script" 参数`) {
		t.Errorf("别名应路由到 win_powershell, got %v", m)
	}
}

func TestRelayPriority(t *testing.T) {
	rg := NewRegistry(nil, nil, nil)
	RegisterBuiltinTools(rg)

	// 注册顺序 = 优先级从低到高 (后注册者优先, 对齐 relay.go 语义)
	r := New()
	r.Register(stubExecutor{"fallback"}) // 兜底
	r.Register(pickyStub{"picky"})       // 只认领 stub_tool
	r.Register(rg)                       // 注册表最优先

	// 1) 注册表精确命中优先于执行器 (read_file 缺参 → 注册表 Go error,
	//    而非兜底桩的成功回显)
	_, err := r.Dispatch(context.Background(), "read_file", json.RawMessage(`{}`))
	if err == nil {
		t.Errorf("注册表应优先于兜底执行器 (read_file 缺参应报错)")
	}

	// 2) 未注册且无前缀命中的工具 → picky 不认领 → 兜底桩
	v, err := r.Dispatch(context.Background(), "unknown_thing", nil)
	if err != nil {
		t.Fatalf("兜底不应报错: %v", err)
	}
	if m := v.(map[string]any); !strings.HasPrefix(m["output"].(string), "fallback:unknown_thing") {
		t.Errorf("未知工具应落到兜底桩, got %v", m)
	}

	// 3) 扩展工具经注册表 → WindowsMCP 执行器 (缺参内联拒绝, 无进程派生)
	v, err = r.Dispatch(context.Background(), "win_powershell", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("win_powershell 不应报错: %v", err)
	}
	m := v.(map[string]any)
	if m["executed"].(bool) || !strings.Contains(m["error"].(string), `win_powershell 缺少 "script" 参数`) {
		t.Errorf("win_powershell 应路由到 WindowsMCP 执行器, got %v", m)
	}
}

func TestToolChainRelayAvailable(t *testing.T) {
	tc := NewToolChain()
	if tc.Relay == nil || tc.Registry == nil {
		t.Fatal("ToolChain 未正确装配")
	}
	// 兜底语义保留: 完全未知的工具在 Relay 层落到 Obscura 执行器
	// (executed=false, 友好消息), 而非报错
	v, err := tc.Relay.Dispatch(context.Background(), "mystery_tool", nil)
	if err != nil {
		t.Fatalf("Relay 兜底不应报错: %v", err)
	}
	m := v.(map[string]any)
	if m["executed"].(bool) {
		t.Errorf("未接入工具应 executed=false, got %v", m)
	}
	if _, ok := m["error"]; !ok {
		t.Errorf("未接入工具应携带 error 消息, got %v", m)
	}
}

// ─── 会话级缓存 ──────────────────────────────────────────────────

func TestSessionToolCache(t *testing.T) {
	c := NewSessionToolCache()
	defer c.Stop()

	args := json.RawMessage(`{"file_path":"a.txt"}`)

	// 未命中
	if _, ok := c.Lookup("chat1", "read_file", args); ok {
		t.Fatal("空缓存不应命中")
	}
	// 写入 → 命中
	c.Store("chat1", "read_file", args, "cached-output", 50*time.Millisecond)
	out, ok := c.Lookup("chat1", "read_file", args)
	if !ok || out != "cached-output" {
		t.Fatalf("应命中, got %q ok=%v", out, ok)
	}
	// 过期 → 未命中
	time.Sleep(60 * time.Millisecond)
	if _, ok := c.Lookup("chat1", "read_file", args); ok {
		t.Fatal("过期条目不应命中")
	}
	// 按 chatId 清理
	c.Store("chat2", "read_file", args, "x", 0)
	c.Store("chat3", "read_file", args, "y", 0)
	if n := c.ClearByChatId("chat2"); n != 1 {
		t.Fatalf("ClearByChatId 应清理 1 条, got %d", n)
	}
	if _, ok := c.Lookup("chat3", "read_file", args); !ok {
		t.Fatal("其他会话缓存不应被误清")
	}
	// 容量淘汰: 501 条 ≤ 上限 500
	for i := 0; i < sessionCacheMaxEntries+1; i++ {
		c.Store(fmt.Sprintf("chat-%d", i), "read_file", json.RawMessage(`{}`), "v", time.Hour)
	}
	size, _, _, _ := c.Stats()
	if size > sessionCacheMaxEntries {
		t.Fatalf("容量应封顶 %d, got %d", sessionCacheMaxEntries, size)
	}
}

func TestIsCacheableToolResult(t *testing.T) {
	if IsCacheableToolResult("execute_cmd", "ok") {
		t.Error("execute_cmd 不应缓存")
	}
	if IsCacheableToolResult("read_file", "Error: boom") {
		t.Error("错误结果不应缓存")
	}
	if !IsCacheableToolResult("read_file", "content") {
		t.Error("read_file 正常结果应可缓存")
	}
}

func TestMain(m *testing.M) {
	// 隔离环境变量对 UI 基址/HTTP 代理的影响 (画布工具测试不触网, 仅防串扰)
	os.Unsetenv("SOLOFORGE_UI_BASE_URL")
	os.Exit(m.Run())
}
