// ─────────────────────────────────────────────────────────────────
// llmclient_test.go — function-calling-client / agent-loop 迁移行为自测
//
// 覆盖: 工具 schema 目录与 activeTools 过滤 (稳定缓存前缀)、
// token 估算与状态指纹、多轮工具循环、L1/L2 缓存去重、
// L3 无进展检测、L4 token 预算、429 退避重试、
// 400 降级重试 + 能力学习、熔断器状态机。
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"soloforge/next/internal/llm"
)

// ─── 工具 schema 目录 ────────────────────────────────────────────

func TestSchemaCatalog(t *testing.T) {
	if len(AgentTools) != 14 {
		t.Fatalf("AgentTools 应为 14 个 (5 核心 + 8 画布 + canvas_push_ui), 实际 %d", len(AgentTools))
	}
	if len(ExtendedToolSchemas) != 20 {
		t.Fatalf("ExtendedToolSchemas 应为 20 个 (7 browser + 6 bu + 7 win), 实际 %d", len(ExtendedToolSchemas))
	}
	for _, s := range AgentTools {
		if s.Type != "function" || s.Function.Name == "" || s.Function.Parameters.Type != "object" {
			t.Fatalf("schema 结构不合法: %+v", s)
		}
	}
}

func TestGetToolsForActiveIds(t *testing.T) {
	// 无 activeTools: 只返回核心 + 画布 (稳定缓存前缀)
	base := GetToolsForActiveIds(nil)
	if len(base) != 14 {
		t.Fatalf("无 activeTools 应返回 14 个, 实际 %d", len(base))
	}
	for _, s := range base {
		n := s.Function.Name
		isCore := coreToolNames[n]
		isCanvas := strings.HasPrefix(n, "solo_canvas_")
		if !isCore && !isCanvas {
			t.Fatalf("基础集混入扩展工具: %s", n)
		}
	}

	// 有 activeTools: 核心+画布不变, 追加匹配的扩展工具
	withExt := GetToolsForActiveIds([]string{"browser_screenshot", "win_powershell", "obscura"})
	if len(withExt) != 16 {
		t.Fatalf("选中 2 扩展工具应返回 16 个, 实际 %d", len(withExt))
	}
	// 前缀稳定性: 前 14 个与 base 一致
	for i := 0; i < 14; i++ {
		if withExt[i].Function.Name != base[i].Function.Name {
			t.Fatalf("核心缓存前缀被破坏: idx=%d %s != %s",
				i, withExt[i].Function.Name, base[i].Function.Name)
		}
	}
	// 未选中的扩展工具不出现
	for _, s := range withExt {
		if s.Function.Name == "bu_run_task" {
			t.Fatalf("未选中的 bu_run_task 不应出现")
		}
	}
}

// ─── token 估算 / 指纹 ──────────────────────────────────────────

func TestEstimateTokens(t *testing.T) {
	content := strings.Repeat("a", 350) // 350 chars → (10+350)/3.5 → 103
	msgs := []LLMMessage{{Role: "user", Content: &content}}
	got := estimateTokens(msgs)
	if got != 103 {
		t.Fatalf("estimateTokens = %d, 期望 103", got)
	}
}

func TestComputeToolFingerprint(t *testing.T) {
	mk := func(name, args string) LLMToolCall {
		c := LLMToolCall{ID: "x", Type: "function"}
		c.Function.Name = name
		c.Function.Arguments = args
		return c
	}
	a := []LLMToolCall{mk("read_file", `{"file_path":"a.ts"}`)}
	b := []LLMToolCall{mk("read_file", `{"file_path":"a.ts"}`)}
	if computeToolFingerprint(a) != computeToolFingerprint(b) {
		t.Fatalf("相同调用应产生相同指纹")
	}
	c := []LLMToolCall{mk("list_files", `{}`), mk("read_file", `{"file_path":"a.ts"}`)}
	d := []LLMToolCall{mk("read_file", `{"file_path":"a.ts"}`), mk("list_files", `{}`)}
	if computeToolFingerprint(c) != computeToolFingerprint(d) {
		t.Fatalf("排序后不同顺序应产生相同指纹")
	}
	e := []LLMToolCall{mk("read_file", `{"file_path":"b.ts"}`)}
	if computeToolFingerprint(a) == computeToolFingerprint(e) {
		t.Fatalf("不同参数应产生不同指纹")
	}
}

// ─── 假 LLM 服务 ────────────────────────────────────────────────

// chatRequest 解析请求体的关键字段
type chatRequest struct {
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
	Tools json.RawMessage `json:"tools"`
}

func textResp(content string) map[string]any {
	return map[string]any{
		"choices": []map[string]any{
			{"message": map[string]any{"content": content, "role": "assistant"}},
		},
		"usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
	}
}

func toolCallResp(name, args, id string) map[string]any {
	return map[string]any{
		"choices": []map[string]any{
			{"message": map[string]any{
				"role": "assistant", "content": nil,
				"tool_calls": []map[string]any{
					{"id": id, "type": "function",
						"function": map[string]any{"name": name, "arguments": args}},
				},
			}},
		},
	}
}

// setupLLM 造一个按 handler 应答的 OpenAI 兼容假服务, 返回覆盖用的 LLMConfig
func setupLLM(t *testing.T, handler func(w http.ResponseWriter, req chatRequest)) *LLMOverride {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var cr chatRequest
		_ = json.NewDecoder(r.Body).Decode(&cr)
		handler(w, cr)
	}))
	t.Cleanup(srv.Close)
	return &LLMOverride{BaseURL: srv.URL, APIKey: "test-key", Model: "test-model"}
}

func writeResp(w http.ResponseWriter, v map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// ─── 多轮工具循环 ────────────────────────────────────────────────

func TestCallLLMWithToolsBasicLoop(t *testing.T) {
	cfg := setupLLM(t, func(w http.ResponseWriter, req chatRequest) {
		// 第 1 轮 (无 tool 消息): 返回 tool_call; 之后: 返回文本
		hasToolMsg := false
		for _, m := range req.Messages {
			if m.Role == "tool" {
				hasToolMsg = true
			}
		}
		if !hasToolMsg {
			writeResp(w, toolCallResp("read_file", `{"file_path":"x.ts"}`, "call-1"))
			return
		}
		writeResp(w, textResp("done"))
	})

	toolRuns := 0
	res, err := CallLLMWithTools(context.Background(), CallWithToolsOptions{
		Messages:  []LLMMessage{userMsg("task")},
		Tools:     GetToolsForActiveIds(nil),
		LLMConfig: cfg,
		OnToolCall: func(req ToolRequest) ToolCallResult {
			toolRuns++
			return ToolCallResult{ToolCallID: req.ID, Name: req.Name, Output: "file-body"}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if toolRuns != 1 || res.ToolCallCount != 1 {
		t.Fatalf("工具应执行 1 次: runs=%d count=%d", toolRuns, res.ToolCallCount)
	}
	if res.FinalMessage.Content == nil || *res.FinalMessage.Content != "done" {
		t.Fatalf("最终回复错误: %+v", res.FinalMessage)
	}
	// 仅携带 usage 的调用计入 (TS: if (u) 累加); tool_call 响应无 usage
	if res.ActualTokenUsage.LLMCallCount != 1 || res.ActualTokenUsage.TotalTokens != 15 {
		t.Fatalf("usage 累加错误: %+v", res.ActualTokenUsage)
	}
	// 消息序: user → assistant(tool_calls) → tool → assistant
	if len(res.AllMessages) != 4 {
		t.Fatalf("消息数应为 4, 实际 %d", len(res.AllMessages))
	}
}

func TestL1InDispatchCache(t *testing.T) {
	cfg := setupLLM(t, func(w http.ResponseWriter, req chatRequest) {
		// 同一轮返回两个相同 tool_call; 第二轮文本
		if len(req.Messages) == 1 {
			writeResp(w, toolCallResp("dup_tool", `{"k":"v"}`, "c1"))
			return
		}
		if len(req.Messages) == 3 {
			writeResp(w, toolCallResp("dup_tool", `{"k":"v"}`, "c2"))
			return
		}
		writeResp(w, textResp("ok"))
	})

	toolRuns := 0
	res, err := CallLLMWithTools(context.Background(), CallWithToolsOptions{
		Messages:  []LLMMessage{userMsg("task")},
		LLMConfig: cfg,
		OnToolCall: func(req ToolRequest) ToolCallResult {
			toolRuns++
			return ToolCallResult{ToolCallID: req.ID, Name: req.Name, Output: "same"}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if toolRuns != 1 {
		t.Fatalf("L1 缓存应命中, 工具只执行 1 次, 实际 %d", toolRuns)
	}
	if res.CacheHits != 1 {
		t.Fatalf("CacheHits 应为 1, 实际 %d", res.CacheHits)
	}
	// 第二次调用的 tool 消息应带 [CACHED] 标记
	found := false
	for _, m := range res.AllMessages {
		if m.Role == "tool" && m.Content != nil && strings.Contains(*m.Content, "[CACHED") {
			found = true
		}
	}
	if !found {
		t.Fatalf("应存在 [CACHED] 标记的 tool 消息")
	}
}

func TestL2SessionCacheCrossDispatch(t *testing.T) {
	cfg := setupLLM(t, func(w http.ResponseWriter, req chatRequest) {
		if len(req.Messages) <= 2 {
			writeResp(w, toolCallResp("my_lookup", `{"k":"v"}`, "c1"))
			return
		}
		writeResp(w, textResp("ok"))
	})
	toolRuns := 0
	onTool := func(req ToolRequest) ToolCallResult {
		toolRuns++
		return ToolCallResult{ToolCallID: req.ID, Name: req.Name, Output: "lookup-result"}
	}
	opts := CallWithToolsOptions{
		Messages:   []LLMMessage{userMsg("task")},
		LLMConfig:  cfg,
		ChatID:     "chat-l2-test",
		OnToolCall: onTool,
	}
	if _, err := CallLLMWithTools(context.Background(), opts); err != nil {
		t.Fatal(err)
	}
	// 第二次 dispatch (同 ChatID): L2 命中, 不再执行工具
	opts2 := opts
	opts2.Messages = []LLMMessage{userMsg("task-again")}
	res2, err := CallLLMWithTools(context.Background(), opts2)
	if err != nil {
		t.Fatal(err)
	}
	if toolRuns != 1 {
		t.Fatalf("L2 会话缓存应命中, 工具仍只执行 1 次, 实际 %d", toolRuns)
	}
	if res2.CacheHits != 1 {
		t.Fatalf("第二次 dispatch CacheHits 应为 1, 实际 %d", res2.CacheHits)
	}
	DefaultSessionToolCache.ClearByChatId("chat-l2-test")
}

func TestStallDetection(t *testing.T) {
	cfg := setupLLM(t, func(w http.ResponseWriter, req chatRequest) {
		if len(req.Tools) > 0 {
			// 每轮返回完全相同的 tool_call → 触发无进展
			writeResp(w, toolCallResp("stuck_tool", `{"k":1}`, "cs"))
			return
		}
		writeResp(w, textResp("give-up"))
	})
	res, err := CallLLMWithTools(context.Background(), CallWithToolsOptions{
		Messages:  []LLMMessage{userMsg("task")},
		Tools:     GetToolsForActiveIds(nil),
		LLMConfig: cfg,
		OnToolCall: func(req ToolRequest) ToolCallResult {
			return ToolCallResult{ToolCallID: req.ID, Name: req.Name, Output: "same"}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.ExitedByStallDetection {
		t.Fatalf("应触发 L3 无进展退出")
	}
	// 连续 3 轮相同 (第 4 次 tool_call 响应) 后移除 tools
	if res.ToolCallCount != 4 {
		t.Fatalf("移除 tools 前应执行 4 次, 实际 %d", res.ToolCallCount)
	}
	if res.FinalMessage.Content == nil || *res.FinalMessage.Content != "give-up" {
		t.Fatalf("最终应为无 tools 的文本回复: %+v", res.FinalMessage)
	}
}

func TestTokenBudget(t *testing.T) {
	cfg := setupLLM(t, func(w http.ResponseWriter, req chatRequest) {
		// 无论有无 tools 都返回 tool_call (模拟不收提示的模型)
		writeResp(w, toolCallResp("heavy_tool", `{"pad":"`+strings.Repeat("x", 200)+`"}`, "cb"))
	})
	budget := 30.0
	res, err := CallLLMWithTools(context.Background(), CallWithToolsOptions{
		Messages:    []LLMMessage{userMsg("task")},
		TokenBudget: &budget,
		LLMConfig:   cfg,
		OnToolCall: func(req ToolRequest) ToolCallResult {
			return ToolCallResult{ToolCallID: req.ID, Name: req.Name, Output: strings.Repeat("y", 300)}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.ExitedByTokenBudget {
		t.Fatalf("应触发 L4 超预算退出")
	}
	// budget nudge 应注入
	foundNudge := false
	for _, m := range res.AllMessages {
		if m.Role == "user" && m.Content != nil && strings.Contains(*m.Content, "Token budget") {
			foundNudge = true
		}
	}
	if !foundNudge {
		t.Fatalf("应注入 budget nudge 消息")
	}
}

// ─── 429 退避重试 ────────────────────────────────────────────────

func TestRetryOn429(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n <= 2 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"message":"rate limited"}}`))
			return
		}
		writeResp(w, textResp("recovered"))
	}))
	defer srv.Close()

	cfg := &LLMOverride{BaseURL: srv.URL, APIKey: "k", Model: "retry-model"}
	res, err := CallLLMWithTools(context.Background(), CallWithToolsOptions{
		Messages:  []LLMMessage{userMsg("task")},
		LLMConfig: cfg,
	})
	if err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&attempts) != 3 {
		t.Fatalf("应重试到第 3 次成功, 实际 %d", attempts)
	}
	if res.ActualTokenUsage.LLMCallCount != 1 {
		t.Fatalf("仅成功的调用计入 usage: %+v", res.ActualTokenUsage)
	}
}

// ─── 400 降级重试 + 能力学习 ─────────────────────────────────────

func TestDegradedRetryLearnsCapability(t *testing.T) {
	llm.SetCapabilitiesPath(t.TempDir() + "/caps.json")
	t.Cleanup(func() { llm.SetCapabilitiesPath("") })

	model := "no-tools-model-xyz"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var cr chatRequest
		_ = json.NewDecoder(r.Body).Decode(&cr)
		if len(cr.Tools) > 0 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"tools not supported"}}`))
			return
		}
		writeResp(w, textResp("no-tools-answer"))
	}))
	defer srv.Close()

	cfg := &LLMOverride{BaseURL: srv.URL, APIKey: "k", Model: model}
	res, err := CallLLMWithTools(context.Background(), CallWithToolsOptions{
		Messages:  []LLMMessage{userMsg("task")},
		Tools:     GetToolsForActiveIds(nil),
		LLMConfig: cfg,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.FinalMessage.Content == nil || *res.FinalMessage.Content != "no-tools-answer" {
		t.Fatalf("降级后应拿到文本回复: %+v", res.FinalMessage)
	}
	// 能力已学习并持久化: supportsTools = false
	if st := llm.SupportsTools(model); st == nil || *st {
		t.Fatalf("应已学习到模型不支持 tools: %+v", st)
	}
}

// ─── 熔断器 ──────────────────────────────────────────────────────

func TestCircuitBreaker(t *testing.T) {
	b := llm.NewBreaker()
	key := "http://fake|model"

	// 5 次连续 429 → OPEN
	for i := 0; i < 5; i++ {
		b.RecordFailure(key, 429)
	}
	d := b.Evaluate(key)
	if d.Action != llm.Reject || d.State != llm.StateOpen {
		t.Fatalf("5 次失败后应 OPEN 拒绝: %+v", d)
	}
	// 4xx (非 429) 不计入
	b2 := llm.NewBreaker()
	for i := 0; i < 10; i++ {
		b2.RecordFailure(key, 401)
	}
	if d := b2.Evaluate(key); d.Action != llm.Proceed {
		t.Fatalf("401 不应计入熔断: %+v", d)
	}
	// 成功重置连续失败
	b3 := llm.NewBreaker()
	for i := 0; i < 4; i++ {
		b3.RecordFailure(key, 500)
	}
	b3.RecordSuccess(key, 10)
	b3.RecordFailure(key, 500)
	if d := b3.Evaluate(key); d.Action != llm.Proceed {
		t.Fatalf("成功应重置连续失败计数: %+v", d)
	}
}

// ─── RunAgentLoop 集成 ───────────────────────────────────────────

func TestRunAgentLoopAuditAndPrompt(t *testing.T) {
	var gotSystem string
	cfg := setupLLM(t, func(w http.ResponseWriter, req chatRequest) {
		// 取第一条 system 消息 = 稳定层 (动态上下文是后续独立 system)
		for _, m := range req.Messages {
			if m.Role == "system" {
				gotSystem = m.Content
				break
			}
		}
		// 出现 tool 消息后返回文本 (不能用消息总数判断, 动态上下文层数可变)
		hasToolMsg := false
		for _, m := range req.Messages {
			if m.Role == "tool" {
				hasToolMsg = true
			}
		}
		if !hasToolMsg {
			writeResp(w, toolCallResp("list_files", `{"dir_path":"."}`, "ca"))
			return
		}
		writeResp(w, textResp("final answer"))
	})

	var events []string
	ec := AgentExecutionContext{
		AgentID:         "agent-1",
		Domain:          "测试",
		Role:            "工程师",
		SystemPrompt:    "你是测试工程师。",
		WorkspaceFolder: t.TempDir(),
		StreamHook: &AgentStreamHook{
			ChatID:    "chat-1",
			SubTaskID: "st-1",
			Emit: func(eventName string, payload map[string]any) {
				events = append(events, eventName)
			},
		},
		LLMConfig: cfg,
	}
	res, err := RunAgentLoop(context.Background(), ec, "列一下文件")
	if err != nil {
		t.Fatal(err)
	}
	// 审计: toolSteps
	if len(res.ToolSteps) != 1 || res.ToolSteps[0].Tool != "list_files" || !res.ToolSteps[0].Success {
		t.Fatalf("toolSteps 审计错误: %+v", res.ToolSteps)
	}
	if res.ToolSteps[0].Round != 1 {
		t.Fatalf("round 编号错误: %+v", res.ToolSteps)
	}
	// 事件序: started → completed (+ stdout/exit 只有 execute_cmd 才有)
	if len(events) != 2 || events[0] != "tool_started" || events[1] != "tool_completed" {
		t.Fatalf("流送事件序错误: %v", events)
	}
	// 稳定 prompt: 角色定义 + 画布 ACL + 画布预览
	if !strings.Contains(gotSystem, "你是测试工程师。") ||
		!strings.Contains(gotSystem, "requesterChatSessionId: chat-1") ||
		!strings.Contains(gotSystem, "## 画布预览") {
		t.Fatalf("稳定 system prompt 缺失组成部分:\n%s", gotSystem)
	}
	// 动态上下文: 工作区段
	foundWs := false
	for _, m := range res.Messages {
		if m.Role == "system" && m.Content != nil && strings.Contains(*m.Content, "## 工作区") {
			foundWs = true
		}
	}
	if !foundWs {
		t.Fatalf("动态上下文应包含工作区段")
	}
	if res.FinalAnswer != "final answer" || !res.UsedTools {
		t.Fatalf("结果错误: answer=%q usedTools=%v", res.FinalAnswer, res.UsedTools)
	}
}

func TestCommBusBroadcastAndInject(t *testing.T) {
	cfg := setupLLM(t, func(w http.ResponseWriter, req chatRequest) {
		// 第 2 轮起 (round>=1 有注入): 检查是否有同侪发现 system 消息
		hasPeer := false
		for _, m := range req.Messages {
			if m.Role == "system" && strings.Contains(m.Content, "同侪发现") {
				hasPeer = true
			}
		}
		if len(req.Messages) <= 2 {
			writeResp(w, toolCallResp("list_files", `{"dir_path":"`+strings.ReplaceAll(t.TempDir(), "\\", "/")+`"}`, "cc"))
			return
		}
		writeResp(w, textResp(fmt.Sprintf("peer=%v", hasPeer)))
	})

	bus := &stubCommBus{}
	// RunAgentLoop 内部固定走 ExecuteToolCall (对齐 TS agent-loop 直调
	// executeToolCall), 故用真实 list_files 工具指向临时目录保证成功
	res, err := RunAgentLoop(context.Background(), AgentExecutionContext{
		AgentID:      "a1",
		SystemPrompt: "s",
		CommBus:      bus,
		PeerAgentIDs: []string{"a2"},
		LLMConfig:    cfg,
	}, "任务")
	if err != nil {
		t.Fatal(err)
	}
	// 广播发生过 (工具成功)
	if len(bus.broadcasts) != 1 || bus.broadcasts[0].performative != "INFORM" {
		t.Fatalf("应广播 1 次 INFORM: %+v", bus.broadcasts)
	}
	if bus.broadcasts[0].content["type"] != "tool_finding" {
		t.Fatalf("广播内容应为 tool_finding: %+v", bus.broadcasts[0].content)
	}
	// 第二轮注入过同侪发现
	if res.FinalAnswer != "peer=true" {
		t.Fatalf("应注入同侪发现 system 消息: %s", res.FinalAnswer)
	}
	if bus.polled != 1 {
		t.Fatalf("round=0 不 poll, 应只 poll 1 次: %d", bus.polled)
	}
}

// stubCommBus 测试桩
type busMsg struct {
	performative string
	content      map[string]any
}

type stubCommBus struct {
	broadcasts []busMsg
	polled     int
}

func (s *stubCommBus) Broadcast(sender, performative string, content map[string]any, receivers []string) {
	s.broadcasts = append(s.broadcasts, busMsg{performative, content})
}

func (s *stubCommBus) Poll(agentID string) []CommBusMessage {
	s.polled++
	return []CommBusMessage{{
		Sender: "a2",
		Content: map[string]any{
			"type":    "tool_finding",
			"tool":    "search_code",
			"args":    json.RawMessage(`{"pattern":"x"}`),
			"summary": "found 3",
		},
	}}
}

// ─── 超时分级 ────────────────────────────────────────────────────

func TestLLMCallTimeoutIs120s(t *testing.T) {
	if llmCallTimeout != 120*time.Second {
		t.Fatalf("单次 LLM 请求超时应为 120s, 实际 %v", llmCallTimeout)
	}
}
