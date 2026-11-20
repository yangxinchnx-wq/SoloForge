// ─────────────────────────────────────────────────────────────────
// llmclient.go — 支持 OpenAI Function Calling 的 LLM 客户端
// (从 TS src/core/agent/tools/function-calling-client.ts 迁移)
//
// 与简单补全客户端的区别:
//   - 支持 tools + tool_choice 参数
//   - 解析 tool_calls 响应 (非流式)
//   - 支持多轮 tool_calls 循环
//
// 2026-07-08 L3+L4 优化 (Loop Engineering):
//
//	L3: 无进展检测 — 状态指纹追踪, 连续 N 轮相同工具调用触发软退出
//	L4: Token 预算 — 累计 token 估算, 超预算时注入压缩指令或强制退出
//
// 失败重试策略 (callLLMOnce, 对齐 TS):
//   - 429 (Too Many Requests): 优先用 Retry-After 头, 否则指数退避
//   - 5xx (服务端瞬时错误): 指数退避重试
//   - 4xx 其他 (401/403/400): 不重试, 直接抛出 (认证/参数错误不会自愈)
//     但 400/404 + 有 tools 时可能是模型不支持 function calling →
//     学习该事实并降级重试一次 (移除 tools)
//   - 500 + 有 tools: 第 0 次尝试时先降级重试 (可能是不支持 tools)
//   - 上下文取消 (用户取消/超时): 不重试, 立即返回
//   - 网络错误: 指数退避重试
//     上限: 最多 4 次重试, 总等待上限 ~8s (200ms→400ms→800ms→1600ms 基础退避
//   - 0~100ms 抖动, 上限 8s)
//
// 超时分级:
//   - 单次 LLM 请求: 120s (对齐 TS controller.abort 120_000)
//   - execute_cmd 子进程: 30s (见 coretools.go)
//
// 依赖: internal/llm 的熔断器 + 模型能力 + 配置
// ─────────────────────────────────────────────────────────────────
package toolsrelay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"soloforge/next/internal/llm"
)

// ─── 类型定义 ────────────────────────────────────────────────────

// CacheControl Anthropic ephemeral 缓存标记
type CacheControl struct {
	Type string `json:"type"` // 恒为 "ephemeral"
}

// LLMMessage 对话消息 (对齐 TS LLMMessage; 字段顺序/JSON 标签对齐 OpenAI wire 格式)
type LLMMessage struct {
	Role       string        `json:"role"` // system | user | assistant | tool
	Content    *string       `json:"content"`
	ToolCalls  []LLMToolCall `json:"tool_calls,omitempty"`
	ToolCallID string        `json:"tool_call_id,omitempty"`
	Name       string        `json:"name,omitempty"`
	// CacheControl Anthropic cache_control 标记 (仅 Anthropic provider 时注入, 内部用)
	CacheControl *CacheControl `json:"cache_control,omitempty"`
}

// LLMToolCall 模型发起的工具调用
type LLMToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"` // 恒为 "function"
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"` // JSON string
	} `json:"function"`
}

// TokenUsage 真实 token 消耗 (从 LLM usage 字段累加)
type TokenUsage struct {
	PromptTokens     int64 `json:"promptTokens"`
	CompletionTokens int64 `json:"completionTokens"`
	TotalTokens      int64 `json:"totalTokens"`
	CachedTokens     int64 `json:"cachedTokens"`
	LLMCallCount     int   `json:"llmCallCount"`
}

// OnToolCall 工具执行回调 (Agent 循环注入; 对齐 TS opts.onToolCall)
type OnToolCall func(req ToolRequest) ToolCallResult

// OnThinking 纯文本回复回调
type OnThinking func(text string)

// OnRoundStart 每轮 LLM 调用前的 hook。
// 返回的消息会在本轮 LLM 调用前注入到 messages 末尾
// (用于 CommBus poll peer 发现并注入同侪信息)。
type OnRoundStart func(round int) []LLMMessage

// CallWithToolsOptions CallLLMWithTools 的选项 (对齐 TS CallWithToolsOptions)
type CallWithToolsOptions struct {
	Messages []LLMMessage
	Tools    []ToolSchema
	Model    string

	// Temperature/MaxTokens/MaxRounds/TokenBudget 为 nil 时取默认值
	// (0.2 / 4096 / 20 / 50000; TokenBudget 设 0 或 +Inf 可禁用)
	Temperature *float64
	MaxTokens   *int
	MaxRounds   *int
	TokenBudget *float64

	OnToolCall   OnToolCall
	OnThinking   OnThinking
	OnRoundStart OnRoundStart

	// LLMConfig 可选 provider 覆盖 (前端传入的 apiKey + baseUrl + model);
	// 不传时使用 internal/llm 的环境变量配置
	LLMConfig *LLMOverride

	// ChatID 会话 ID, 用于跨 dispatch 工具结果缓存 (L2)。
	// 不传时禁用 session 级缓存 (仅用 in-dispatch 缓存)。
	ChatID string
}

// LLMOverride LLM provider 覆盖 (对齐 TS llmConfig)
type LLMOverride struct {
	BaseURL string
	APIKey  string
	Model   string
}

// CallWithToolsResult CallLLMWithTools 的结果 (对齐 TS CallWithToolsResult)
type CallWithToolsResult struct {
	FinalMessage           LLMMessage
	AllMessages            []LLMMessage // 完整的多轮对话历史
	ToolCallCount          int
	TotalDurationMs        int64
	TotalTokensEstimated   int  // L4: 累计估算 token 消耗
	ExitedByStallDetection bool // L3: 循环是否因无进展而提前退出
	ExitedByTokenBudget    bool // L4: 循环是否因超预算而提前退出
	CacheHits              int  // 本次 dispatch 内去重命中次数
	ActualTokenUsage       TokenUsage
}

// ─── L3+L4 内部工具函数 ──────────────────────────────────────────

// estimateTokens 粗略估算消息列表的 token 数 (对齐 TS estimateTokens)。
// 精度不高但足够做预算控制 (误差 ±30%)。
// 规则: 英文约 4 字符/token, 中文约 2 字符/token, JSON 结构有额外开销;
// 用 3.5 字符/token 作为混合估算中位数。
func estimateTokens(messages []LLMMessage) int {
	totalChars := 0
	for i := range messages {
		m := &messages[i]
		totalChars += 10 // role 开销
		if m.Content != nil {
			totalChars += len(*m.Content)
		}
		for _, tc := range m.ToolCalls {
			totalChars += len(tc.Function.Name) + len(tc.Function.Arguments) + 20
		}
	}
	return int(math.Ceil(float64(totalChars) / 3.5))
}

// computeToolFingerprint L3: 计算本轮工具调用的状态指纹 (对齐 TS)。
// 将本轮所有 tool_call 的 (name, arguments) 排序后 hash,
// 用于检测 LLM 是否卡在同一个操作上反复调用。
// hash 固定 16 字符, 比较和日志都方便。
func computeToolFingerprint(toolCalls []LLMToolCall) string {
	sig := make([]string, 0, len(toolCalls))
	for _, tc := range toolCalls {
		sig = append(sig, tc.Function.Name+":"+tc.Function.Arguments)
	}
	sort.Strings(sig)
	sum := sha256.Sum256([]byte(strings.Join(sig, "|")))
	return hex.EncodeToString(sum[:])[:16]
}

// budgetNudgeText L4: nudge 消息内容 — 鼓励 LLM 基于已有信息给出最终回答
// (参考 Claude Code 的 token_budget_continuation 机制)
const budgetNudgeText = "[System: Token budget approaching limit. Please synthesize your findings so far " +
	"and provide a final answer based on the information you have gathered. " +
	"Do NOT call any more tools. Give your best answer now.]"

// stallNudgeText L3: stall nudge 消息内容 — 告知 LLM 它在重复, 请给出最终回答
const stallNudgeText = "[System: You have been making the same tool calls repeatedly without progress. " +
	"Please stop calling tools and provide your final answer based on what you have gathered so far.]"

func userMsg(content string) LLMMessage { return LLMMessage{Role: "user", Content: &content} }

// ─── 核心函数 ────────────────────────────────────────────────────

// CallLLMWithTools 调用 LLM, 支持 Function Calling 多轮循环
// (对齐 TS callLLMWithTools)。
//
// 流程:
//  1. 发送 messages + tools 给 LLM
//  2. 如果 LLM 返回 tool_calls → 执行工具 → 将结果追加到 messages → 回到 1
//  3. 如果 LLM 返回纯文本 → 结束
//  4. 最多循环 maxRounds 轮
//
// L3 优化 — 无进展检测:
//   - 每轮计算工具调用的状态指纹 (name+arguments hash)
//   - 连续 2 轮指纹相同 → 注入 stall nudge (软提示)
//   - 连续 3 轮 → 移除 tools, 强制最终回答 (防止 LLM 卡在同一操作上反复空转)
//
// L4 优化 — Token 预算:
//   - 每轮估算累计 token 消耗
//   - 超过预算的 80% → 注入 budget nudge, 提示 LLM 收尾
//   - 超过预算 → 移除 tools, 强制最终回答
//
// 工具执行 (对齐 TS 2026-07-09):
//  1. L1 缓存 (in-dispatch): 相同 toolName+args 不重复执行
//  2. L2 缓存 (cross-dispatch session, 需 ChatID)
//  3. 并行执行: 一次返回多个 tool_calls 时并行跑
//  4. 缓存命中时标记 [CACHED], 让 LLM 知道这是复用结果
func CallLLMWithTools(ctx context.Context, opts CallWithToolsOptions) (*CallWithToolsResult, error) {
	// 优先使用传入的 llmConfig, 否则回退到环境变量配置
	var baseURL, apiKey, model string
	if opts.LLMConfig != nil && opts.LLMConfig.APIKey != "" {
		baseURL = strings.TrimRight(opts.LLMConfig.BaseURL, "/")
		apiKey = opts.LLMConfig.APIKey
		model = cmpStr(opts.Model, opts.LLMConfig.Model)
	} else {
		cfg := llm.GetConfig()
		baseURL = strings.TrimRight(cfg.BaseURL, "/")
		apiKey = cfg.APIKey
		model = cmpStr(opts.Model, cfg.DefaultModel)
	}

	// hardCap 作为安全网防止 LLM 死循环, 正常情况 LLM 答完 (不调工具) 就停
	hardCap := 20
	if opts.MaxRounds != nil {
		hardCap = *opts.MaxRounds
	}
	// L4: Token 预算上限 (默认 50000 token, 设为 0 或 +Inf 禁用)
	tokenBudget := 50000.0
	if opts.TokenBudget != nil {
		tokenBudget = *opts.TokenBudget
	}
	budgetEnabled := tokenBudget > 0 && !math.IsInf(tokenBudget, 1)

	if apiKey == "" {
		return nil, fmt.Errorf("LLM API key not configured (neither in request nor env)")
	}
	if model == "" {
		return nil, fmt.Errorf("LLM model not configured")
	}

	// ── 能力预检: 本地查询模型是否支持 tools (零网络请求) ──────────
	// 如果已知模型不支持 function calling, 直接跳过 tools, 避免 400/404/500
	toolsStripped := false
	if hasTools := len(opts.Tools) > 0; hasTools {
		if st := llm.SupportsTools(model); st != nil && !*st {
			slog.Info("模型已知不支持 function calling, 跳过 tools",
				"model", model, "capabilities", llm.DescribeCapabilities(model))
			toolsStripped = true
		}
	}

	allMessages := make([]LLMMessage, len(opts.Messages))
	copy(allMessages, opts.Messages)
	start := time.Now()
	toolCallCount := 0

	// ── 工具结果缓存: 本次 dispatch 内去重 (L1) ─────────────────────
	// key = toolName + ":" + JSON.stringify(args), value = output string
	// 生命周期: 单次 CallLLMWithTools 调用, 不跨 dispatch
	// 实测 50% 工具调用是重复的, 缓存后直接砍掉重复 IO + 对应 LLM 推理轮次
	toolResultCache := make(map[string]string)
	cacheHits := 0

	// ── 真实 token 累加器 (从 LLM usage 字段) ──────────────────────
	var actualUsage TokenUsage

	// ── L3 状态: 无进展检测 ──
	var previousFingerprint string // 上一轮工具调用的指纹
	consecutiveStallRounds := 0    // 连续无进展轮数
	stallNudgeSent := false        // 是否已发送 stall nudge (只发一次)
	exitedByStallDetection := false

	// ── L4 状态: Token 预算 ──
	cumulativeTokens := estimateTokens(allMessages) // 初始消息的 token
	budgetNudgeSent := false                        // 是否已发送 budget nudge (只发一次)
	exitedByTokenBudget := false

	// 当前使用的工具定义 (L3/L4 可能在中途移除 tools)
	// 如果能力预检发现模型不支持 tools, 直接清空
	currentTools := opts.Tools
	if toolsStripped {
		currentTools = nil
	}

	temperature := 0.2
	if opts.Temperature != nil {
		temperature = *opts.Temperature
	}
	maxTokens := 4096
	if opts.MaxTokens != nil {
		maxTokens = *opts.MaxTokens
	}

	for round := 0; round < hardCap; round++ {
		// ── L4: 预算检查 (在调用 LLM 之前) ──
		if budgetEnabled && float64(cumulativeTokens) > tokenBudget {
			// 超出预算: 移除 tools 强制最终回答 (如果还没移除的话)
			if len(currentTools) > 0 {
				currentTools = nil
				if !budgetNudgeSent {
					allMessages = append(allMessages, userMsg(budgetNudgeText))
					budgetNudgeSent = true
				}
				// 不 break, 让 LLM 用剩余上下文给一个最终回答 (不带 tools)
			} else {
				// 已经没有 tools 了, LLM 还没回答 → 强制退出
				exitedByTokenBudget = true
				break
			}
		}

		// ── CommBus: 每轮 LLM 调用前注入 peer 发现 ────────────────────
		if opts.OnRoundStart != nil {
			injected := opts.OnRoundStart(round) // 失败不影响主流程 (由回调自行兜底)
			if len(injected) > 0 {
				allMessages = append(allMessages, injected...)
			}
		}

		response, usage, err := callLLMOnce(ctx, callOnceOptions{
			baseURL:     baseURL,
			apiKey:      apiKey,
			model:       model,
			messages:    allMessages,
			tools:       currentTools,
			temperature: temperature,
			maxTokens:   maxTokens,
		})
		if err != nil {
			return nil, err
		}

		// 累加真实 token usage
		actualUsage.PromptTokens += usage.PromptTokens
		actualUsage.CompletionTokens += usage.CompletionTokens
		actualUsage.TotalTokens += usage.TotalTokens
		actualUsage.CachedTokens += usage.CachedTokens
		if usage.Seen {
			actualUsage.LLMCallCount++
		}

		// ── L4: 估算本轮 token 消耗 ──
		cumulativeTokens += estimateTokens([]LLMMessage{response})

		// 检查是否有 tool_calls
		if len(response.ToolCalls) == 0 {
			// 纯文本回复, 结束循环
			allMessages = append(allMessages, response)
			if opts.OnThinking != nil && response.Content != nil {
				opts.OnThinking(*response.Content)
			}
			return &CallWithToolsResult{
				FinalMessage:           response,
				AllMessages:            allMessages,
				ToolCallCount:          toolCallCount,
				TotalDurationMs:        time.Since(start).Milliseconds(),
				TotalTokensEstimated:   cumulativeTokens,
				ExitedByStallDetection: exitedByStallDetection,
				ExitedByTokenBudget:    exitedByTokenBudget,
				CacheHits:              cacheHits,
				ActualTokenUsage:       actualUsage,
			}, nil
		}

		// 有 tool_calls, 记录并推进
		allMessages = append(allMessages, response)
		toolCallCount += len(response.ToolCalls)

		// ── L3: 无进展检测 ──
		currentFingerprint := computeToolFingerprint(response.ToolCalls)
		if currentFingerprint == previousFingerprint {
			consecutiveStallRounds++
		} else {
			consecutiveStallRounds = 0
		}
		previousFingerprint = currentFingerprint

		// 连续 2 轮相同工具调用 → 注入 stall nudge (软提示)
		if consecutiveStallRounds == 2 && !stallNudgeSent {
			allMessages = append(allMessages, userMsg(stallNudgeText))
			stallNudgeSent = true
		}

		// 连续 3 轮相同工具调用 → 移除 tools, 强制最终回答
		if consecutiveStallRounds >= 3 && len(currentTools) > 0 {
			currentTools = nil
			exitedByStallDetection = true
		}

		// ── 工具执行: 缓存优先 + 并行执行 ──────────────────────────────
		results := make([]ToolCallResult, len(response.ToolCalls))
		var wg sync.WaitGroup
		for i := range response.ToolCalls {
			tc := response.ToolCalls[i]
			wg.Add(1)
			go func(idx int, tc LLMToolCall) {
				defer wg.Done()
				results[idx] = execToolCallCached(ctx, tc, opts, toolResultCache, &cacheHits)
			}(i, tc)
		}
		wg.Wait()

		// 将所有工具结果追加到消息列表
		for i := range results {
			r := results[i]
			allMessages = append(allMessages, LLMMessage{
				Role:       "tool",
				ToolCallID: r.ToolCallID,
				Name:       r.Name,
				Content:    &r.Output,
			})
			cumulativeTokens += estimateTokens([]LLMMessage{{Role: "tool", Content: &r.Output}})
		}

		// ── L4: 预算预警 (80% 阈值) — 注入 nudge 提示 LLM 收尾 ──
		if budgetEnabled && !budgetNudgeSent && float64(cumulativeTokens) > tokenBudget*0.8 {
			allMessages = append(allMessages, userMsg(budgetNudgeText))
			budgetNudgeSent = true
		}

		// 继续下一轮, 让 LLM 看到工具结果
	}

	// 超过最大轮数或 L3/L4 强制退出, 返回最后一条消息
	lastMsg := allMessages[len(allMessages)-1]
	return &CallWithToolsResult{
		FinalMessage:           lastMsg,
		AllMessages:            allMessages,
		ToolCallCount:          toolCallCount,
		TotalDurationMs:        time.Since(start).Milliseconds(),
		TotalTokensEstimated:   cumulativeTokens,
		ExitedByStallDetection: exitedByStallDetection,
		ExitedByTokenBudget:    exitedByTokenBudget,
		CacheHits:              cacheHits,
		ActualTokenUsage:       actualUsage,
	}, nil
}

// execToolCallCached 单个工具调用的缓存优先执行 (对齐 TS Promise.all 内的
// async 回调)。toolResultCache / cacheHits 为共享状态, 由 loopMu 保护
// (TS 的 JS 单线程事件循环天然串行, Go 并行执行需显式锁)。
func execToolCallCached(ctx context.Context, tc LLMToolCall, opts CallWithToolsOptions,
	toolResultCache map[string]string, cacheHits *int) ToolCallResult {

	var args json.RawMessage
	if strings.TrimSpace(tc.Function.Arguments) != "" {
		if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
			// TS 版 JSON.parse 抛错会整体失败; Go 版降级为错误结果, 循环不中断
			return ToolCallResult{
				ToolCallID: tc.ID,
				Name:       tc.Function.Name,
				Output:     "Error: 工具参数 JSON 解析失败: " + err.Error(),
				IsError:    true,
			}
		}
	}
	request := ToolRequest{ID: tc.ID, Name: tc.Function.Name, Arguments: args}

	// 缓存 key: toolName + 参数 JSON
	cacheKey := request.Name + ":" + canonicalArgsJSON(request.Arguments)

	// L1 缓存命中 (In-Dispatch): 直接复用, 不执行工具, 不消耗 IO
	loopMu.Lock()
	cached, cachedOK := toolResultCache[cacheKey]
	if cachedOK {
		*cacheHits++
	}
	loopMu.Unlock()
	if cachedOK {
		return ToolCallResult{
			ToolCallID: request.ID,
			Name:       request.Name,
			Output:     cached + "\n[CACHED: 此结果由前次相同调用复用,无需再次请求]",
		}
	}

	// P2: L2 缓存查询 (Cross-Dispatch Session)
	if opts.ChatID != "" && IsCacheableToolResult(request.Name, "") {
		if sessionCached, ok := DefaultSessionToolCache.Lookup(opts.ChatID, request.Name, request.Arguments); ok {
			loopMu.Lock()
			*cacheHits++
			loopMu.Unlock()
			// 回填 L1 缓存, 避免同 dispatch 内再次查 L2
			loopMu.Lock()
			toolResultCache[cacheKey] = sessionCached
			loopMu.Unlock()
			return ToolCallResult{
				ToolCallID: request.ID,
				Name:       request.Name,
				Output:     sessionCached + "\n[CACHED: 此结果由会话级缓存复用,无需再次请求]",
			}
		}
	}

	// 缓存未命中: 执行工具
	var result ToolCallResult
	if opts.OnToolCall != nil {
		result = opts.OnToolCall(request)
	} else {
		result = ExecuteToolCall(ctx, request)
	}

	// 写入 L1 缓存 (仅缓存成功的结果, 错误结果不缓存)
	if !strings.HasPrefix(result.Output, "Error:") && !strings.HasPrefix(result.Output, "Tool error:") {
		loopMu.Lock()
		toolResultCache[cacheKey] = result.Output
		loopMu.Unlock()
		// P2: 同时写入 L2 会话级缓存 (跨 dispatch 复用)
		if opts.ChatID != "" && IsCacheableToolResult(request.Name, result.Output) {
			DefaultSessionToolCache.Store(opts.ChatID, request.Name, request.Arguments, result.Output, 10*time.Minute)
		}
	}

	return result
}

func cmpStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// loopMu 保护 CallLLMWithTools 的共享可变状态 (L1 缓存 map / cacheHits /
// AgentLoop 的 toolSteps) 跨 goroutine 的并发访问。TS 的 JS 单线程事件循环
// 天然串行, Go 并行执行需显式锁。
var loopMu sync.Mutex

// ─── 单次 LLM 调用 (非流式, 支持 tool_calls 解析) ─────────────────

// onceUsage 单次调用的 usage (Seen 标记响应是否携带 usage)
type onceUsage struct {
	TokenUsage
	Seen bool
}

// callOnceOptions callLLMOnce 的入参
type callOnceOptions struct {
	baseURL     string
	apiKey      string
	model       string
	messages    []LLMMessage
	tools       []ToolSchema
	temperature float64
	maxTokens   int
}

// 重试配置 (对齐 TS)
const (
	llmMaxRetries    = 4                 // 最多 4 次重试
	llmBaseBackoffMs = 200               // 基础退避 200ms
	llmMaxBackoffMs  = 8000              // 退避上限 8s
	llmCallTimeout   = 120 * time.Second // 单次请求 2 分钟超时
)

var llmHTTPClient = &http.Client{} // 超时由 per-attempt ctx 控制

func callLLMOnce(ctx context.Context, o callOnceOptions) (LLMMessage, onceUsage, error) {
	// ── Circuit Breaker: 调用前检查 ──────────────────────────────────
	cbKey := llm.ProviderKey(o.baseURL, o.model)
	cbDecision := llm.DefaultBreaker.Evaluate(cbKey)
	switch cbDecision.Action {
	case llm.Reject:
		return LLMMessage{}, onceUsage{}, fmt.Errorf("LLM circuit breaker OPEN: %s model=%s — %s",
			o.baseURL, o.model, cbDecision.Reason)
	case llm.Wait:
		select {
		case <-time.After(time.Duration(cbDecision.WaitMs) * time.Millisecond):
		case <-ctx.Done():
			return LLMMessage{}, onceUsage{}, ctx.Err()
		}
	}

	t0 := time.Now()
	url := o.baseURL + "/chat/completions"

	// 检测 Anthropic provider (baseUrl 含 anthropic 或 claude)。
	// OpenAI 自动缓存 tools 参数, 无需显式标记; Anthropic 需显式 cache_control
	isAnthropic := containsAnyFold(o.baseURL, []string{"anthropic", "claude"})

	// 按稳定性排序 messages: system(稳定) → user(不稳定)。
	// Anthropic cache_control 标记在 system prompt (第 0 条) 上
	messagesForBody := o.messages
	if isAnthropic && len(o.messages) > 0 && o.messages[0].Role == "system" {
		messagesForBody = make([]LLMMessage, len(o.messages))
		copy(messagesForBody, o.messages)
		cc := CacheControl{Type: "ephemeral"}
		messagesForBody[0].CacheControl = &cc
	}

	// tools 数组: Anthropic 在最后一个工具标记 cache_control。
	// wireTool 为线格式包装 (ToolSchema + cache_control)
	type wireTool struct {
		ToolSchema
		CacheControl *CacheControl `json:"cache_control,omitempty"`
	}
	var toolsForBody []wireTool
	for i := range o.tools {
		toolsForBody = append(toolsForBody, wireTool{ToolSchema: o.tools[i]})
	}
	if isAnthropic && len(toolsForBody) > 0 {
		toolsForBody[len(toolsForBody)-1].CacheControl = &CacheControl{Type: "ephemeral"}
	}

	// body: 仅在有实际 tools 时携带 tools/tool_choice。
	// 部分兼容服务 (如 MiMo) 在 tools:[] + tool_choice:'auto' 时返回空响应
	toolsPayload, err := json.Marshal(toolsForBody)
	if err != nil {
		return LLMMessage{}, onceUsage{}, fmt.Errorf("tools 序列化失败: %w", err)
	}
	hasTools := len(toolsForBody) > 0

	makeBody := func(withTools bool) []byte {
		body := map[string]any{
			"model":       o.model,
			"messages":    messagesForBody,
			"temperature": o.temperature,
			"max_tokens":  o.maxTokens,
		}
		if withTools && hasTools {
			body["tools"] = json.RawMessage(toolsPayload)
			body["tool_choice"] = "auto"
		}
		b, _ := json.Marshal(body)
		return b
	}
	bodyBytes := makeBody(true)

	// ── 429/5xx 指数退避重试 ──────────────────────────────────────────
	// 避免单次限流导致整个 Agent Loop 失败 (已积累的工具调用历史会全部丢失)
	var lastErr error

	for attempt := 0; attempt <= llmMaxRetries; attempt++ {
		// 每次重试新建超时 ctx (上一次的已超时或完成)
		attemptCtx, cancel := context.WithTimeout(ctx, llmCallTimeout)

		resp, doErr := doRequest(attemptCtx, url, o.apiKey, bodyBytes)
		if doErr == nil {
			// ── HTTP 响应处理 ──
			if resp.StatusCode >= 400 {
				errText := readBodyString(resp)
				status := resp.StatusCode
				resp.Body.Close()

				// 不可重试: 4xx (除 429) — 认证/参数错误不会自愈。
				// 但 400/404 + 有 tools 时可能是模型不支持 function calling → 降级重试
				if status >= 400 && status < 500 && status != 429 {
					// 降级请求复用本次 attemptCtx (对齐 TS 共用同一 controller.signal)
					degraded, u, dErr := tryDegraded(attemptCtx, url, o, makeBody, status, 400, 404)
					cancel()
					if dErr == nil && degraded != nil {
						return *degraded, u, nil
					}
					return LLMMessage{}, onceUsage{}, fmt.Errorf("LLM HTTP %d: %s", status, truncate(errText, 300))
				}

				// 可重试: 429 / 5xx。
				// 500 + 有 tools 时, 先尝试降级 (可能是模型不支持 tools 导致的 500)
				degraded := false
				var dMsg *LLMMessage
				var dUsage onceUsage
				if status == 500 && hasTools && attempt == 0 {
					dMsg, dUsage, _ = tryDegraded(attemptCtx, url, o, makeBody, status, 500)
					degraded = dMsg != nil
					if degraded {
						cancel()
						return *dMsg, dUsage, nil
					}
				}

				if attempt < llmMaxRetries {
					// 解析 Retry-After 头 (秒; 这里只处理秒格式)
					waitMs := backoffWaitMs(resp.Header.Get("Retry-After"), attempt)
					lastErr = fmt.Errorf("LLM HTTP %d: %s", status, truncate(errText, 300))
					if attempt == 0 {
						slog.Info("LLM 限流/服务端错误, 退避重试",
							"status", status, "attempt", fmt.Sprintf("%d/%d", attempt+1, llmMaxRetries+1),
							"waitMs", waitMs)
					}
					cancel()
					if sleepErr := sleepCtx(ctx, time.Duration(waitMs)*time.Millisecond); sleepErr != nil {
						return LLMMessage{}, onceUsage{}, sleepErr
					}
					continue
				}

				cancel()
				// ── Circuit Breaker: 重试耗尽记录失败 ──────────────────
				llm.DefaultBreaker.RecordFailure(cbKey, status)
				return LLMMessage{}, onceUsage{}, fmt.Errorf("LLM HTTP %d: %s", status, truncate(errText, 300))
			}

			// ── 2xx: 解析响应 ──
			msg, usage, perr := parseCompletionResponse(resp)
			resp.Body.Close()
			cancel()
			if perr != nil {
				return LLMMessage{}, onceUsage{}, perr
			}

			// ── Circuit Breaker: 记录成功 ─────────────────────────────
			llm.DefaultBreaker.RecordSuccess(cbKey, time.Since(t0).Milliseconds())
			return msg, usage, nil
		}

		cancel()
		// ── 网络错误 / 上下文取消 ──
		if ctx.Err() != nil {
			// 用户取消: 不重试, 立即返回 (对齐 TS AbortError 直抛)
			return LLMMessage{}, onceUsage{}, ctx.Err()
		}
		// 网络错误 (ECONNRESET / connection refused 等): 可重试
		// ── Circuit Breaker: 记录网络错误 ────────────────────────────
		llm.DefaultBreaker.RecordFailure(cbKey, 0)
		if attempt < llmMaxRetries {
			waitMs := backoffWaitMs("", attempt)
			lastErr = doErr
			if attempt == 0 {
				slog.Info("LLM 网络错误, 退避重试",
					"attempt", fmt.Sprintf("%d/%d", attempt+1, llmMaxRetries+1),
					"err", truncate(doErr.Error(), 100), "waitMs", waitMs)
			}
			if sleepErr := sleepCtx(ctx, time.Duration(waitMs)*time.Millisecond); sleepErr != nil {
				return LLMMessage{}, onceUsage{}, sleepErr
			}
			continue
		}
		return LLMMessage{}, onceUsage{}, doErr
	}

	// 所有重试耗尽 (理论上不会走到这里, for 循环内已 return)
	if lastErr != nil {
		return LLMMessage{}, onceUsage{}, lastErr
	}
	return LLMMessage{}, onceUsage{}, fmt.Errorf("LLM call failed after all retries")
}

// doRequest 发起单次 HTTP 请求
func doRequest(ctx context.Context, url, apiKey string, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	return llmHTTPClient.Do(req)
}

// tryDegraded 能力降级重试: 移除 tools 后重试一次 (不计入正常重试次数)。
// 仅当 status 命中 triggerStatuses 且请求带 tools 时触发; 触发时学习
// "该模型不支持 tools" 并持久化 (对齐 TS learnCapability)。
// degraded 命中时返回响应消息; 未触发/失败返回 nil。
func tryDegraded(ctx context.Context, url string, o callOnceOptions,
	makeBody func(bool) []byte, status int, triggerStatuses ...int) (*LLMMessage, onceUsage, error) {

	triggered := false
	for _, s := range triggerStatuses {
		if status == s {
			triggered = true
			break
		}
	}
	if !triggered || len(o.tools) == 0 {
		return nil, onceUsage{}, fmt.Errorf("degradation not triggered")
	}

	llm.LearnCapability(o.model, llm.FeatureTools, false)
	slog.Info("从 HTTP 状态学习模型能力, 尝试降级重试 (无 tools)", "model", o.model, "status", status)

	resp, err := doRequest(ctx, url, o.apiKey, makeBody(false))
	if err != nil {
		slog.Info("降级重试也失败", "err", err)
		return nil, onceUsage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, onceUsage{}, fmt.Errorf("degraded HTTP %d", resp.StatusCode)
	}
	msg, usage, perr := parseCompletionResponse(resp)
	if perr != nil {
		return nil, onceUsage{}, perr
	}
	msg.ToolCalls = nil // 降级后无 tool_calls
	slog.Info("降级重试成功 (无 tools)", "model", o.model)
	return &msg, usage, nil
}

// parseCompletionResponse 解析 /chat/completions 响应
func parseCompletionResponse(resp *http.Response) (LLMMessage, onceUsage, error) {
	var out struct {
		Choices []struct {
			Message struct {
				Content   *string `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Type     string `json:"type"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens        int64 `json:"prompt_tokens"`
			CompletionTokens    int64 `json:"completion_tokens"`
			TotalTokens         int64 `json:"total_tokens"`
			PromptTokensDetails *struct {
				CachedTokens int64 `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			PromptCacheHitTokens int64 `json:"prompt_cache_hit_tokens"`
		} `json:"usage"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return LLMMessage{}, onceUsage{}, fmt.Errorf("LLM 响应解码失败: %w", err)
	}
	if out.Error != nil {
		return LLMMessage{}, onceUsage{}, fmt.Errorf("LLM 错误: %s", out.Error.Message)
	}
	if len(out.Choices) == 0 {
		return LLMMessage{}, onceUsage{}, fmt.Errorf("LLM returned empty choices")
	}

	msg := out.Choices[0].Message
	assistant := LLMMessage{
		Role:    "assistant",
		Content: msg.Content,
	}
	for _, tc := range msg.ToolCalls {
		call := LLMToolCall{ID: tc.ID, Type: "function"}
		call.Function.Name = tc.Function.Name
		call.Function.Arguments = tc.Function.Arguments
		assistant.ToolCalls = append(assistant.ToolCalls, call)
	}

	usage := onceUsage{}
	if out.Usage != nil {
		usage.Seen = true
		usage.PromptTokens = out.Usage.PromptTokens
		usage.CompletionTokens = out.Usage.CompletionTokens
		usage.TotalTokens = out.Usage.TotalTokens
		// 缓存命中 token: OpenAI prompt_tokens_details.cached_tokens,
		// DeepSeek prompt_cache_hit_tokens
		if out.Usage.PromptTokensDetails != nil {
			usage.CachedTokens = out.Usage.PromptTokensDetails.CachedTokens
		}
		if usage.CachedTokens == 0 {
			usage.CachedTokens = out.Usage.PromptCacheHitTokens
		}
	}
	return assistant, usage, nil
}

// backoffWaitMs 计算退避等待: 优先 Retry-After (秒, 上限 8s),
// 否则指数退避 200 * 2^attempt + 抖动 0~100ms (避免同步重试风暴)
func backoffWaitMs(retryAfter string, attempt int) int64 {
	if retryAfter != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(retryAfter)); err == nil && n >= 0 {
			w := int64(n) * 1000
			if w > llmMaxBackoffMs {
				w = llmMaxBackoffMs
			}
			return w
		}
	}
	jitter := rand.Int63n(100)
	w := int64(llmBaseBackoffMs)*(1<<attempt) + jitter
	if w > llmMaxBackoffMs {
		w = llmMaxBackoffMs
	}
	return w
}

// sleepCtx 可取消的 sleep
func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// readBodyString 读取响应体 (失败返回空串)
func readBodyString(resp *http.Response) string {
	if resp.Body == nil {
		return ""
	}
	buf := new(bytes.Buffer)
	_, _ = buf.ReadFrom(io.LimitReader(resp.Body, 1<<20))
	return buf.String()
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func containsAnyFold(s string, keys []string) bool {
	for _, k := range keys {
		if strings.Contains(strings.ToLower(s), strings.ToLower(k)) {
			return true
		}
	}
	return false
}
