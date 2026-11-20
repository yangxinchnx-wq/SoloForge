// ─────────────────────────────────────────────────────────────────
// agentloop.go — Agent 循环引擎 (从 TS agent-loop.ts 迁移)
//
// 核心循环: think → call tool → observe → think → ... → 最终回复
//
// 这是真正让 Agent "活" 起来的模块:
//  1. 接收用户任务
//  2. 构建 System Prompt (角色 + 技能库经验 + 工具说明)
//  3. 调用 LLM, LLM 可以选择调用工具或直接回复
//  4. 工具结果自动追加到上下文, LLM 继续推理
//  5. 重复直到 LLM 给出最终文本回复 (或达到最大轮数)
//  6. (经验提炼写入技能库由 evolution 包负责)
//
// 工具调用审计细节 (对齐 TS):
//   - 每步记录 ToolStep {round, tool, args(前 200 字符), success}
//   - tool_started 在执行前 emit (让 UI 立即看到"开始调用")
//   - tool_completed 在执行后 emit (结果/耗时/成败; result 截 500 字符)
//   - execute_cmd 的 stdout/stderr 经 Stream 钩子透传实时外发
//   - CommBus: 并行执行时把工具发现广播给 peer agent,
//     每轮 LLM 调用前 poll 注入 peer 的发现 (避免重复探索)
//
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// ─── CommBus 抽象 (对齐 TS ctx.commBus) ──────────────────────────

// CommBusMessage 同侪消息 (poll 返回)
type CommBusMessage struct {
	Sender  string
	Content map[string]any
}

// CommBus Agent 通信总线最小接口。
// 并行执行时, 工具发现通过 Broadcast 共享给 peer agent;
// 每轮 LLM 调用前 Poll 注入 peer 的发现。
// (agents 包的 ACLBus 经适配器实现此接口)
type CommBus interface {
	Broadcast(sender, performative string, content map[string]any, receivers []string)
	Poll(agentID string) []CommBusMessage
}

// ─── Agent 执行上下文 ────────────────────────────────────────────

// AgentStreamHook 流送区事件注入点 (对齐 TS ctx.streamHook)
type AgentStreamHook struct {
	ChatID    string
	SubTaskID string
	Emit      LoopStreamHook // nil 表示无钩子
}

// LoopStreamHook 流送事件回调。
// eventName ∈ tool_started / tool_completed / tool_stdout / tool_stderr / tool_exit
type LoopStreamHook func(eventName string, payload map[string]any)

// AgentExecutionContext Agent 执行上下文 (对齐 TS AgentExecutionContext)
type AgentExecutionContext struct {
	AgentID      string
	Domain       string
	Role         string
	SystemPrompt string
	Skills       []string

	MaxRounds   *int
	Model       string
	Temperature *float64
	MaxTokens   *int

	// StreamHook 可选流送区事件注入点
	StreamHook *AgentStreamHook

	// LLMConfig 可选 LLM provider 覆盖 (前端传入的 apiKey + baseUrl + model);
	// 不传时使用 internal/llm 的环境变量配置
	LLMConfig *LLMOverride

	// WorkspaceFolder 工作区文件夹路径 (用于路径强制校验)
	WorkspaceFolder string

	// ActiveTools 前端选中的工具 ID 列表 (控制 LLM 可用的 tools)
	ActiveTools []string
	// ActiveSkills 前端选中的技能 ID 列表
	ActiveSkills []string
	// ActiveKnowledge 前端选中的知识库 ID 列表
	ActiveKnowledge []string

	// TokenBudget L4: Token 预算上限 (估算值)。
	// 默认 50000 token; 设为 0 可禁用预算控制。
	TokenBudget *float64

	// CommBus Agent 通信总线 (并行执行时共享工具发现)
	CommBus CommBus
	// PeerAgentIDs 并行执行时的 peer agent ID 列表 (Broadcast 的接收方)
	PeerAgentIDs []string
}

// ─── Agent 执行结果 ──────────────────────────────────────────────

// ToolStep 每步工具调用的摘要 (审计)
type ToolStep struct {
	Round   int    `json:"round"`
	Tool    string `json:"tool"`
	Args    string `json:"args"`
	Success bool   `json:"success"`
}

// AgentLoopResult Agent 循环执行结果 (对齐 TS AgentLoopResult)
type AgentLoopResult struct {
	// FinalAnswer LLM 最终的文本回复
	FinalAnswer string
	// Messages 完整的多轮对话历史 (含工具调用)
	Messages []LLMMessage
	// ToolCallCount 工具调用次数
	ToolCallCount int
	// DurationMs 总耗时
	DurationMs int64
	// UsedTools Agent 是否使用了工具
	UsedTools bool
	// ToolSteps 每步工具调用的摘要
	ToolSteps []ToolStep
	// TotalTokensEstimated L4: 累计估算 token 消耗
	TotalTokensEstimated int
	// ExitedByStallDetection L3: 是否因无进展检测提前退出
	ExitedByStallDetection bool
	// ExitedByTokenBudget L4: 是否因超预算提前退出
	ExitedByTokenBudget bool
	// CacheHits 工具结果缓存命中次数
	CacheHits int
	// ActualTokenUsage 真实 token 消耗 (从 LLM usage 字段累加)
	ActualTokenUsage TokenUsage
}

// ─── 核心循环 ────────────────────────────────────────────────────

// RunAgentLoop 执行 Agent 循环 (对齐 TS runAgentLoop)。
//
// LLM 被赋予工具后, 会自主决定: 先读文件了解现有代码? 搜索代码找参考?
// 直接写文件生成代码? 执行命令验证结果? 整个过程由 LLM 自主驱动,
// Agent 框架只负责: 提供工具 / 执行工具 / 管理上下文 / 控制最大轮数。
func RunAgentLoop(ctx context.Context, ec AgentExecutionContext, userTask string) (*AgentLoopResult, error) {
	var toolSteps []ToolStep

	// 根据 activeTools 动态构建工具列表
	effectiveTools := GetToolsForActiveIds(ec.ActiveTools)

	// 构建消息列表 (按稳定性严格排序, 配合 Prompt Caching)
	// 顺序: system(稳定) → system(动态: 技能/知识库) → user(任务)
	stableSystemPrompt := buildStableSystemPrompt(ec)
	dynamicContext := buildDynamicContext(ec)

	messages := []LLMMessage{
		// 第 1 层: 稳定 system prompt (角色 + 画布ACL + 预览指令) — 构成缓存前缀
		{Role: "system", Content: &stableSystemPrompt},
	}
	// 第 2 层: 动态上下文 (技能/知识库/工作区) — 独立 system message,
	// 变化不影响第 1 层缓存
	if dynamicContext != nil {
		messages = append(messages, LLMMessage{Role: "system", Content: dynamicContext})
	}
	// 第 3 层: 用户任务 (每轮变化)
	messages = append(messages, userMsg(userTask))

	slog.Info("AgentLoop 启动", "agentId", ec.AgentID, "task", truncate(userTask, 80))

	// 调用 LLM + 工具循环
	hook := ec.StreamHook
	result, err := CallLLMWithTools(ctx, CallWithToolsOptions{
		Messages:    messages,
		Tools:       effectiveTools,
		Model:       ec.Model,
		Temperature: ec.Temperature,
		MaxTokens:   ec.MaxTokens,
		MaxRounds:   ec.MaxRounds,
		TokenBudget: ec.TokenBudget,
		LLMConfig:   ec.LLMConfig,
		ChatID:      hookChatID(hook), // 传入 chatId 启用跨 dispatch 缓存
		OnToolCall: func(call ToolRequest) ToolCallResult {
			slog.Info("AgentLoop 工具调用", "agentId", ec.AgentID,
				"tool", call.Name, "args", truncate(string(call.Arguments), 100))
			argsJSON := truncate(string(call.Arguments), 200)

			// 流送区: tool_started (在执行工具前 emit, 让 UI 立即看到"开始调用")
			if hook != nil && hook.Emit != nil {
				hook.Emit("tool_started", map[string]any{
					"chatId":     hook.ChatID,
					"subTaskId":  hook.SubTaskID,
					"agentId":    ec.AgentID,
					"tool":       call.Name,
					"toolCallId": call.ID,
					"args":       argsJSON,
					"ts":         time.Now().UnixMilli(),
				})
			}

			// 透传 Stream 钩子给 ExecuteToolCall,
			// 让 execute_cmd 的 stdout/stderr 流式 emit
			toolStart := time.Now()
			call.Stream = nil
			if hook != nil && hook.Emit != nil {
				h := hook
				call.Stream = func(eventName string, payload map[string]any) {
					// 补齐 chatId/subTaskId (对齐 TS streamHook 适配层)
					payload["chatId"] = h.ChatID
					payload["subTaskId"] = h.SubTaskID
					h.Emit(eventName, payload)
				}
			}
			call.WorkspaceFolder = ec.WorkspaceFolder
			toolResult := ExecuteToolCall(ctx, call)
			toolDurationMs := time.Since(toolStart).Milliseconds()

			loopMu.Lock()
			toolSteps = append(toolSteps, ToolStep{
				Round:   len(toolSteps) + 1,
				Tool:    call.Name,
				Args:    argsJSON,
				Success: !toolResult.IsError,
			})
			loopMu.Unlock()
			slog.Info("AgentLoop 工具完成", "agentId", ec.AgentID, "tool", call.Name,
				"status", map[bool]string{true: "ERROR", false: "OK"}[toolResult.IsError],
				"durationMs", toolResult.DurationMs)

			// 流送区: tool_completed (执行后 emit, UI 看到结果/耗时/成败)
			if hook != nil && hook.Emit != nil {
				payload := map[string]any{
					"chatId":     hook.ChatID,
					"subTaskId":  hook.SubTaskID,
					"agentId":    ec.AgentID,
					"tool":       call.Name,
					"toolCallId": call.ID,
					"args":       argsJSON,
					"success":    !toolResult.IsError,
					"durationMs": toolDurationMs,
					"ts":         time.Now().UnixMilli(),
				}
				if toolResult.Output != "" {
					payload["result"] = truncate(toolResult.Output, 500)
				}
				if toolResult.IsError {
					payload["error"] = toolResult.Output
				}
				hook.Emit("tool_completed", payload)
			}

			// ── CommBus: 广播工具发现给 peer agent ─────────────────────
			// 并行执行时, 把工具发现 (工具名+参数+结果摘要) 广播给 peer;
			// peer 在下一轮 LLM 调用前 poll 注入, 避免重复探索相同文件
			if ec.CommBus != nil && len(ec.PeerAgentIDs) > 0 && !toolResult.IsError {
				summary := ""
				if len(toolResult.Output) > 500 {
					summary = toolResult.Output[:500]
				} else {
					summary = toolResult.Output
				}
				ec.CommBus.Broadcast(ec.AgentID, "INFORM", map[string]any{
					"type":    "tool_finding",
					"tool":    call.Name,
					"args":    json.RawMessage(call.Arguments),
					"summary": summary,
				}, ec.PeerAgentIDs)
			}

			return toolResult
		},
		OnThinking: func(text string) {
			slog.Info("AgentLoop 思考", "agentId", ec.AgentID, "text", truncate(text, 100))
		},
		// ── CommBus: 每轮 LLM 调用前 poll peer 发现并注入 ──────────────
		OnRoundStart: func(round int) []LLMMessage {
			if ec.CommBus == nil || round == 0 {
				return nil
			}
			peerMsgs := ec.CommBus.Poll(ec.AgentID)
			if len(peerMsgs) == 0 {
				return nil
			}
			// 把 peer 的工具发现汇总成一条 system 消息注入
			var findings []string
			for _, m := range peerMsgs {
				if c, ok := m.Content["type"].(string); !ok || c != "tool_finding" {
					continue
				}
				tool, _ := m.Content["tool"].(string)
				args := stringArgs(m.Content["args"])
				if len(args) > 80 {
					args = args[:80]
				}
				summary := stringArgs(m.Content["summary"])
				if len(summary) > 200 {
					summary = summary[:200]
				}
				findings = append(findings, fmt.Sprintf("[%s] %s(%s) → %s", m.Sender, tool, args, summary))
			}
			if len(findings) == 0 {
				return nil
			}
			content := fmt.Sprintf("[同侪发现 %d]\n其他 agent 已探索的工具结果,你可以参考但不必重复调用:\n%s",
				round, strings.Join(findings, "\n"))
			return []LLMMessage{{Role: "system", Content: &content}}
		},
	})
	if err != nil {
		return nil, err
	}

	finalAnswer := ""
	if result.FinalMessage.Content != nil {
		finalAnswer = *result.FinalMessage.Content
	}

	// L3/L4 日志: 记录退出原因, 方便调试和监控
	exitReason := "NORMAL"
	if result.ExitedByStallDetection {
		exitReason = "STALL_DETECTION"
	} else if result.ExitedByTokenBudget {
		exitReason = "TOKEN_BUDGET"
	}
	slog.Info("AgentLoop 完成",
		"agentId", ec.AgentID,
		"toolCalls", result.ToolCallCount,
		"durationMs", result.TotalDurationMs,
		"tokensEstimated", result.TotalTokensEstimated,
		"exit", exitReason,
		"answerChars", len(finalAnswer))

	return &AgentLoopResult{
		FinalAnswer:            finalAnswer,
		Messages:               result.AllMessages,
		ToolCallCount:          result.ToolCallCount,
		DurationMs:             result.TotalDurationMs,
		UsedTools:              result.ToolCallCount > 0,
		ToolSteps:              toolSteps,
		TotalTokensEstimated:   result.TotalTokensEstimated,
		ExitedByStallDetection: result.ExitedByStallDetection,
		ExitedByTokenBudget:    result.ExitedByTokenBudget,
		CacheHits:              result.CacheHits,
		ActualTokenUsage:       result.ActualTokenUsage,
	}, nil
}

func hookChatID(h *AgentStreamHook) string {
	if h == nil {
		return ""
	}
	return h.ChatID
}

// stringArgs 把 CommBus content 中的 args/summary 归一为字符串
func stringArgs(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case json.RawMessage:
		return string(t)
	case nil:
		return ""
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return fmt.Sprint(t)
		}
		return string(b)
	}
}

// ─── System Prompt 构建 ──────────────────────────────────────────
// 2026-07-07 重构: 拆分为稳定/动态两部分, 配合 Prompt Caching
//   - buildStableSystemPrompt: 角色定义 + 画布ACL + 预览指令 (极少变化, 构成缓存前缀)
//   - buildDynamicContext: 技能/知识库/工作区 (可能变化, 独立 system message)

// buildStableSystemPrompt 构建稳定的 system prompt (构成 Prompt Caching 前缀)。
// 只包含极少变化的内容: 1. 角色定义 2. 画布 ACL (chatId, 每对话固定) 3. 预览触发指令
func buildStableSystemPrompt(ec AgentExecutionContext) string {
	var parts []string

	// 1. 角色定义
	parts = append(parts, ec.SystemPrompt)

	// 2. 画布 ACL (必需, 否则 LLM 会编造 chatId)
	chatID := ""
	if ec.StreamHook != nil {
		chatID = ec.StreamHook.ChatID
	}
	if chatID != "" {
		parts = append(parts, fmt.Sprintf(`## 画布上下文
requesterChatSessionId: %s
调用 solo_canvas_* 工具时,必须把 requesterChatSessionId 参数填成上面这个值。canvasId 参数可选,不传时系统自动用当前对话绑定的画布。`, chatID))
	}

	// 3. 预览触发指令 (P1 瘦身: ~300 token → ~120 token, 保留核心信息)
	canvasID := chatID
	if canvasID == "" {
		canvasID = "当前对话ID"
	}
	parts = append(parts, fmt.Sprintf(`## 画布预览
前端内置本地翻译器,自动渲染回复中的 UI 代码块 (html/tsx/vue/dart/swift/kotlin/xml/xaml/qml/python/c)。
- 生成 UI 时直接用 markdown 代码块返回,无需调工具或加标记
- canvas_push_ui 工具用于直接推送 Universal AST 到画布 (sessionId 参数填 %s)
  - 适用场景: svg/流程图/图标等代码块无法表达的 UI, 或用户明确要求实时推送
  - dsl 参数格式: {"type":"column","children":[{"type":"text","props":{"data":"Hello"}}]}`, canvasID))

	return strings.Join(parts, "\n\n")
}

// buildDynamicContext 构建动态上下文 (作为独立 system message, 变化不影响稳定层缓存)。
// 包含: 1. 工作区限制 2. 技能库历史经验 3. 前端选中的技能 4. 前端选中的知识库
func buildDynamicContext(ec AgentExecutionContext) *string {
	var parts []string

	// 1. 工作区限制
	if ec.WorkspaceFolder != "" {
		parts = append(parts, fmt.Sprintf(`## 工作区
当前对话已绑定工作区: %s
文件操作限制在此文件夹范围内。路径校验由工具执行时强制检查,无需手动判断。`, ec.WorkspaceFolder))
	}

	// 2. 技能库历史经验
	if len(ec.Skills) > 0 {
		var lines []string
		for i, s := range ec.Skills {
			lines = append(lines, fmt.Sprintf("%d. %s", i+1, s))
		}
		parts = append(parts, "## 历史经验\n"+strings.Join(lines, "\n"))
	}

	// 3. 前端选中的技能
	if len(ec.ActiveSkills) > 0 {
		var lines []string
		for i, s := range ec.ActiveSkills {
			lines = append(lines, fmt.Sprintf("%d. %s", i+1, s))
		}
		parts = append(parts, "## 用户启用的技能\n"+strings.Join(lines, "\n"))
	}

	// 4. 前端选中的知识库
	if len(ec.ActiveKnowledge) > 0 {
		var lines []string
		for i, k := range ec.ActiveKnowledge {
			lines = append(lines, fmt.Sprintf("%d. %s", i+1, k))
		}
		parts = append(parts, "## 用户启用的知识库\n"+strings.Join(lines, "\n"))
	}

	if len(parts) == 0 {
		return nil
	}
	joined := strings.Join(parts, "\n\n")
	return &joined
}

// ─── 便捷函数 ────────────────────────────────────────────────────

// QuickAgentTask 快速执行一个 Agent 任务 (一行调用, 对齐 TS quickAgentTask)
func QuickAgentTask(ctx context.Context, agentID, domain, role, task string,
	options *QuickAgentOptions) (*AgentLoopResult, error) {

	systemPrompt := fmt.Sprintf(`你是 %s，专业领域：%s。
你是一个能够使用工具的真实 Agent，不是单纯的文本生成器。
请主动使用工具来完成任务，而不是只给出文字描述。`, role, domain)

	ec := AgentExecutionContext{
		AgentID:      agentID,
		Domain:       domain,
		Role:         role,
		SystemPrompt: systemPrompt,
	}
	if options != nil {
		ec.Skills = options.Skills
		ec.Model = options.Model
		ec.MaxRounds = options.MaxRounds
	}
	return RunAgentLoop(ctx, ec, task)
}

// QuickAgentOptions QuickAgentTask 的可选项
type QuickAgentOptions struct {
	Skills    []string
	Model     string
	MaxRounds *int
}
