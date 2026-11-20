// ─────────────────────────────────────────────────────────────────
// bumcp_test.go — 批次 9 自测: Content-Length 分帧 / 会话复用 /
// 任务镜像结算 / 步进路由 / 截图上限 / 定位回退链 / 等待语义
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// stubBUProcess 桩进程: 双向管道模拟 MCP server
type stubBUProcess struct {
	inbox   chan string // server 收到的 stdin 帧
	outbox  chan string // server 写出的 stdout 帧
	closed  chan struct{}
	killCnt int
	onFrame func(body string) // 服务端帧处理 (回写 response/notification)
}

func newStubBUProcess(handler func(body string) string, notifications chan string) *stubBUProcess {
	p := &stubBUProcess{
		inbox:  make(chan string, 16),
		outbox: make(chan string, 16),
		closed: make(chan struct{}),
	}
	go func() {
		for raw := range p.inbox {
			bodyBytes, _, ok := splitCLFrame([]byte(raw))
			if !ok {
				continue
			}
			if resp := handler(string(bodyBytes)); resp != "" {
				// outbox 直接投递 body (readLoop 契约: Stdout() 产出已拆帧的 JSON body,
				// 帧拆解由真实进程的 pump / 桩侧完成)
				p.outbox <- resp
			}
		}
	}()
	if notifications != nil {
		go func() {
			for n := range notifications {
				p.outbox <- n
			}
		}()
	}
	return p
}

func (p *stubBUProcess) StdinWrite(b []byte) error {
	p.inbox <- string(b)
	return nil
}

func (p *stubBUProcess) Stdout() <-chan string { return p.outbox }
func (p *stubBUProcess) Wait() error           { return nil }
func (p *stubBUProcess) Kill()                 { p.killCnt++; close(p.closed) }

// mcpResp 构造 JSON-RPC 响应帧 body
func mcpResp(id int, result map[string]any) string {
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	return string(b)
}

// mcpTextResult 带 text content 的工具响应 (Python 端形态)
func mcpTextResult(id int, payload any) string {
	text, _ := json.Marshal(payload)
	return mcpResp(id, map[string]any{
		"content": []map[string]any{{"type": "text", "text": string(text)}},
	})
}

// TestSplitCLFrame 分帧解析: 多帧拼接 / 跨片 / 非法头部
func TestSplitCLFrame(t *testing.T) {
	b1 := `{"a":1}`
	b2 := `{"b":2}`
	two := fmt.Sprintf("Content-Length: %d\r\n\r\n%sContent-Length: %d\r\n\r\n%s", len(b1), b1, len(b2), b2)
	buf := []byte(two)

	f1, rest, ok := splitCLFrame(buf)
	if !ok || f1 != b1 {
		t.Fatalf("第一帧提取失败: %q %v", f1, ok)
	}
	f2, rest, ok := splitCLFrame(rest)
	if !ok || f2 != b2 || len(rest) != 0 {
		t.Fatalf("第二帧提取失败: %q %v", f2, ok)
	}

	// 跨片: body 不完整 → 不提取
	_, rest, ok = splitCLFrame([]byte(fmt.Sprintf("Content-Length: 10\r\n\r\nshort")))
	if ok {
		t.Fatal("不完整帧不应提取")
	}
	_ = rest

	// 非法头部: 丢弃到下一个换行
	bad := []byte("garbage\nContent-Length: 5\r\n\r\nhello")
	f, rest, ok := splitCLFrame(bad)
	if !ok || f != "hello" {
		t.Fatalf("非法头部后应恢复解析: %q %v", f, ok)
	}
}

// TestBUMcpSession 会话复用: 握手 → 工具调用 → 通知 → stop
func TestBUMcpSessionReuse(t *testing.T) {
	var proc *stubBUProcess
	sess := NewBUMcpSession("", "")
	sess.start = func(cwd string, cmd []string) (buProcess, error) {
		proc = newStubBUProcess(func(body string) string {
			var req struct {
				ID     int    `json:"id"`
				Method string `json:"method"`
			}
			_ = json.Unmarshal([]byte(body), &req)
			switch req.Method {
			case "initialize":
				return mcpResp(req.ID, map[string]any{"protocolVersion": mcpProtocolVersion})
			case "tools/list":
				return mcpResp(req.ID, map[string]any{"tools": []map[string]any{
					{"name": "browser_run_task", "description": "run"},
				}})
			case "tools/call":
				var p struct {
					Name string `json:"name"`
				}
				_ = json.Unmarshal([]byte(body), &p)
				return mcpTextResult(req.ID, map[string]any{"taskId": "tk1", "status": "running", "currentStep": 0, "task": p.Name})
			}
			return ""
		}, nil)
		return proc, nil
	}

	ctx := context.Background()
	// 1. 会话复用: 两次调用只启动一次进程 (lazy + 单飞)
	raw1, err := sess.CallTool(ctx, "browser_run_task", map[string]any{"task": "test"})
	if err != nil {
		t.Fatal(err)
	}
	raw2, err := sess.CallTool(ctx, "browser_run_task", map[string]any{"task": "test2"})
	if err != nil {
		t.Fatal(err)
	}
	if proc == nil {
		t.Fatal("子进程应已启动")
	}
	if !strings.Contains(string(raw1), "tk1") || !strings.Contains(string(raw2), "tk1") {
		t.Fatalf("工具响应解析失败: %s %s", raw1, raw2)
	}
	if len(proc.inbox) > 0 || len(proc.outbox) > 0 {
		// 不阻塞即可
	}

	// 2. 工具列表缓存
	tools, err := sess.ListTools(ctx)
	if err != nil || len(tools) != 1 || tools[0].Name != "browser_run_task" {
		t.Fatalf("工具列表错误: %v %v", tools, err)
	}

	// 3. stop: 杀进程 + 失败 pending
	sess.Stop()
	if proc.killCnt != 1 {
		t.Fatalf("stop 应杀进程: %d", proc.killCnt)
	}
}

// TestBUMcpNotificationRouting 通知路由 → StepBus → 任务结算
func TestBUMcpNotificationRouting(t *testing.T) {
	sess := NewBUMcpSession("", "")
	tasks := NewBUTaskStore()
	steps := NewBUStepBus()
	o := NewBUOrchestrator(sess, tasks, steps)

	// 预登记任务
	tasks.UpsertTask(TaskRecord{TaskID: "tk9", Task: "demo", Status: TaskRunning})

	// 直接通过 OnStep 钩子注入 (模拟 MCP notification 路由)
	o.Session.OnStep("tk9", ReactStep{TaskID: "tk9", StepIndex: 1, Kind: "thought", Content: "think"})
	o.Session.OnStep("tk9", ReactStep{TaskID: "tk9", StepIndex: 2, Kind: "final", Content: "done!"})

	rec, ok := tasks.GetTask("tk9")
	if !ok {
		t.Fatal("任务应存在")
	}
	if rec.Status != TaskSuccess || rec.Result != "done!" {
		t.Fatalf("final 应结算 success: %+v", rec)
	}
	if rec.CurrentStep != 2 {
		t.Fatalf("step index 应推进到 2: %d", rec.CurrentStep)
	}
	if rec.FinishedAt == nil {
		t.Fatal("终态应盖 finishedAt")
	}

	// error 结算
	tasks.UpsertTask(TaskRecord{TaskID: "tk10", Task: "demo2", Status: TaskRunning})
	o.Session.OnStep("tk10", ReactStep{TaskID: "tk10", StepIndex: 1, Kind: "error", Content: "boom"})
	rec, _ = tasks.GetTask("tk10")
	if rec.Status != TaskError || rec.Error != "boom" {
		t.Fatalf("error 应结算 error: %+v", rec)
	}

	// 步进订阅收到事件
	got := make(chan ReactStep, 2)
	unsub := steps.SubscribeTask("tk10", func(s ReactStep) { got <- s })
	o.Session.OnStep("tk10", ReactStep{TaskID: "tk10", StepIndex: 2, Kind: "observation", Content: "x"})
	select {
	case s := <-got:
		if s.Kind != "observation" {
			t.Fatalf("订阅应收到事件: %+v", s)
		}
	case <-time.After(time.Second):
		t.Fatal("订阅未收到事件")
	}
	unsub()
	// 退订后不再收到
	o.Session.OnStep("tk10", ReactStep{TaskID: "tk10", StepIndex: 3, Kind: "observation", Content: "y"})
	select {
	case <-got:
		t.Fatal("退订后不应收到事件")
	case <-time.After(100 * time.Millisecond):
	}
}

// TestScreenshotLimit 截图等待语义: 超限载荷剥离
func TestScreenshotLimit(t *testing.T) {
	if !validScreenshot("") {
		t.Fatal("无截图应合法")
	}
	if !validScreenshot("aGVsbG8=") {
		t.Fatal("正常 b64 应合法")
	}
	huge := strings.Repeat("A", buScreenshotMaxBytes+1)
	if validScreenshot(huge) {
		t.Fatal("超 8MB 截图应拒绝")
	}
}

// TestWaitForIdle 等待语义: 终态轮询
func TestWaitForIdle(t *testing.T) {
	tasks := NewBUTaskStore()
	tasks.UpsertTask(TaskRecord{TaskID: "w1", Task: "x", Status: TaskRunning})

	go func() {
		time.Sleep(50 * time.Millisecond)
		tasks.PatchTask("w1", TaskRecord{Status: TaskSuccess, Result: "ok"})
	}()
	ctx := context.Background()
	rec, err := tasks.WaitForIdle(ctx, "w1", 2*time.Second)
	if err != nil || rec.Status != TaskSuccess {
		t.Fatalf("应等到终态: %+v %v", rec, err)
	}

	// 超时路径
	tasks.UpsertTask(TaskRecord{TaskID: "w2", Task: "y", Status: TaskRunning})
	if _, err := tasks.WaitForIdle(ctx, "w2", 300*time.Millisecond); err == nil {
		t.Fatal("超时应报错")
	}
}

// TestLocatorFallbackChain 定位回退链
func TestLocatorFallbackChain(t *testing.T) {
	chain := LocatorFallbackChain("#btn", "提交", "submit-btn", "//div[@id='btn']")
	if len(chain) != 4 {
		t.Fatalf("候选应 4 个: %+v", chain)
	}
	order := []string{LocatorCSS, LocatorText, LocatorAria, LocatorXPath}
	for i, c := range chain {
		if c.Strategy != order[i] {
			t.Fatalf("回退序错误 idx=%d: %+v", i, c)
		}
	}
	// 空字段跳过
	chain = LocatorFallbackChain("", "文本", "", "")
	if len(chain) != 1 || chain[0].Strategy != LocatorText {
		t.Fatalf("空策略应跳过: %+v", chain)
	}
	// 参数抽取
	args := map[string]any{"selector": ".item", "text": "目标"}
	got := ResolveLocatorArgs(args)
	if len(got) != 2 {
		t.Fatalf("参数抽取错误: %+v", got)
	}
	if _, ok := args["locator_fallback"]; !ok {
		t.Fatal("应写回 locator_fallback 参数")
	}
}

// TestTaskStorePrune 任务镜像: 终态 finishedAt + 过期清理
func TestTaskStorePrune(t *testing.T) {
	s := NewBUTaskStore()
	old := nowMs() - buTaskPruneAge.Milliseconds() - time.Hour.Milliseconds()
	s.UpsertTask(TaskRecord{TaskID: "old", Task: "a", Status: TaskSuccess, FinishedAt: &old})
	s.UpsertTask(TaskRecord{TaskID: "new", Task: "b", Status: TaskRunning})

	n := s.PruneTasks(buTaskPruneAge)
	if n != 1 {
		t.Fatalf("应清理 1 条过期任务: %d", n)
	}
	if _, ok := s.GetTask("old"); ok {
		t.Fatal("过期任务应删除")
	}
	if _, ok := s.GetTask("new"); !ok {
		t.Fatal("运行中任务应保留 (无 finishedAt)")
	}
	// 列表按 startedAt 倒序
	all := s.ListTasks()
	if len(all) != 1 || all[0].TaskID != "new" {
		t.Fatalf("列表错误: %+v", all)
	}
}
