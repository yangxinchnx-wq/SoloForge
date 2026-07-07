# Agent Loop 优化设计文档

> 2026-07-08 | 4 层优化，参考 Claude Code Agent Loop + Loop Engineering + Orchestrator 模式

---

## 背景

Agent Loop 的核心问题：**简单任务复杂化（token 浪费），复杂任务空转（无限循环）。**

- 简单任务如 "你好" 也会走完整 RACER 选路 + Agent 工具循环，消耗 ~2500 token
- 复杂任务可能卡在同一操作上反复调用，烧掉 20 轮 LLM 调用后才停止

---

## 优化总览

```
用户请求
  │
  ▼
┌─────────────────────────────────────┐
│ L1: 入口分流 (Orchestrator 模式)     │  ← 确定性规则,零 LLM 消耗
│ shouldUseAgent() → true/false       │
│ false → 直接 LLM 单次调用 (~500 tok) │
│ true  → 进入 Agent Loop             │
└──────────┬──────────────────────────┘
           │
           ▼
┌─────────────────────────────────────┐
│ L2: 工具结果预算裁剪                  │  ← 每个工具结果限制字符数
│ read_file: 4000 / execute_cmd: 3000 │
│ search_code: 2000 / 其他: 4000      │
│ 超出时截断 + 分页提示                 │
└──────────┬──────────────────────────┘
           │
           ▼
┌─────────────────────────────────────┐
│ L3: 无进展检测 (状态指纹)             │  ← SHA256(name+args)
│ 连续 2 轮相同 → 注入 stall nudge     │
│ 连续 3 轮相同 → 移除 tools,强制回答   │
└──────────┬──────────────────────────┘
           │
           ▼
┌─────────────────────────────────────┐
│ L4: Token 预算 (累计估算)             │  ← 3.5 字符/token 估算
│ 累计 > 80% 预算 → 注入 budget nudge  │
│ 累计 > 100% 预算 → 移除 tools        │
│ 移除后仍无回答 → 强制退出             │
└─────────────────────────────────────┘
```

---

## L1: 入口分流 — Orchestrator 模式

**文件**: `src/core/agent/agent-decision-orchestrator.ts`

**设计**: 参考 Orchestrator vs AgenticLoop 架构，用确定性规则做路由决策（零 LLM 消耗），类似 Wayfinder Router 思路。

**分类器 `shouldUseAgent()` 的 7 个维度**:

| 维度 | 信号 | 判断 |
|------|------|------|
| 文件路径引用 | `src/foo.ts`, `./config.json` | → 走 Agent |
| 代码操作动词 | 修改/创建/重构/fix/refactor | → 走 Agent |
| 多步骤指令 | 然后/接着/第一步/step 1 | → 走 Agent |
| 文件上下文 | activeFile.content > 50 字符 | → 走 Agent |
| 活跃工具 | activeTools.length > 0 | → 走 Agent |
| 纯问答句式 | "什么是X", "你好", "hello" | → 跳过 Agent |
| 短消息 | < 80 字符且无操作意图 | → 跳过 Agent |

**直连 LLM 路径 `executeDirectLLM()`**:
- 不注入 Agent 角色 prompt
- 不发送工具定义
- 单次 LLM 调用，maxRounds=1
- token 消耗: ~500（vs Agent 路径 ~2500+）

---

## L2: 工具结果预算裁剪

**文件**: `src/core/agent/tools/tool-definitions.ts`

**设计**: 参考 Claude Code Agent Loop 的 tool result budget 机制（L1 压缩层）。

**预算表**:

| 工具 | 预算 (字符) | 约 token | 截断策略 |
|------|-----------|---------|---------|
| `read_file` | 4000 | ~1000 | 截头部，提示用 `offset/limit` 分页 |
| `execute_cmd` | 3000 | ~750 | 截头部保留尾部（错误通常在最后） |
| `search_code` | 2000 | ~500 | 截头部 |
| `list_files` | 3000 | ~750 | 截头部 |
| 其他/画布/扩展 | 4000 | ~1000 | 截头部 |

**截断提示格式**:
```
... [TRUNCATED by Agent Loop Budget] showing first 120 of ~350 lines (15000 chars total).
Use offset=121 and limit=100 to read the next section.
```

---

## L3: 无进展检测 — 状态指纹

**文件**: `src/core/agent/tools/function-calling-client.ts`

**设计**: 参考 Loop Engineering 的 No-Progress Detection 要素。每轮计算工具调用的 SHA256 指纹，检测 LLM 是否卡在同一操作上。

**机制**:
```
轮次 1: read_file("src/foo.ts")  → 指纹 A → stall=0
轮次 2: read_file("src/foo.ts")  → 指纹 A → stall=1
轮次 3: read_file("src/foo.ts")  → 指纹 A → stall=2 → 注入 stall nudge
轮次 4: read_file("src/foo.ts")  → 指纹 A → stall=3 → 移除 tools,强制回答
轮次 5: LLM 无 tools → 直接给出最终回答 → 退出
```

**为什么用 hash 而不是直接比较字符串**:
- `write_file` 的 arguments 可能包含整个文件内容（几千字符），直接比较性能差
- SHA256 前 16 字符固定长度，比较和日志都方便

**软退出策略（不是粗暴截断）**:
1. stall=2: 注入 nudge 消息，告诉 LLM "你在重复，请给最终回答"
2. stall=3: 移除 tools，LLM 只能给文本回答
3. 参考 Claude Code 的 `stop_hook_blocking`: 先拦住，再纠正

---

## L4: Token 预算硬限制

**文件**: `src/core/agent/tools/function-calling-client.ts` + `src/core/agent/tools/agent-loop.ts`

**设计**: 参考 Claude Code Agent Loop 的 token_budget_continuation 机制 + Loop Engineering 的 Budget Management 要素。

**token 估算**: `estimateTokens()` — 3.5 字符/token（中英文混合中位数，误差 ±30%，足够做预算控制）

**阈值**:
- 默认预算: 50000 token（约 200k 字符）
- 80% 阈值（40000 token）: 注入 budget nudge，提示 LLM 收尾
- 100% 阈值（50000 token）: 移除 tools
- 移除 tools 后仍无回答: 强制退出

**退出路径**:
```
累计 token < 40000  → 正常运行
累计 token = 40000  → 注入 budget nudge (只发一次)
累计 token = 50000  → 移除 tools,LLM 只能给文本回答
LLM 仍不回答       → 强制退出,返回最后一条消息
```

**`AgentLoopResult` 新增字段**:
- `totalTokensEstimated: number` — 累计估算 token 消耗
- `exitedByStallDetection: boolean` — 是否因 L3 退出
- `exitedByTokenBudget: boolean` — 是否因 L4 退出

---

## 配置

### `CallWithToolsOptions` 新增参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `tokenBudget` | `number` | `50000` | L4 token 预算上限，设为 `0` 或 `Infinity` 禁用 |

### `AgentExecutionContext` 新增参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `tokenBudget` | `number` | `50000` | 透传给 `callLLMWithTools` |

---

## 效果预估

| 场景 | 优化前 | 优化后 | 节省 |
|------|--------|--------|------|
| "你好" (简单问答) | ~2500 token (走 Agent) | ~500 token (L1 直连) | **80%** |
| "写一个排序算法" | ~3500 token (Agent 1 轮) | ~3500 (走 Agent, 合理) | 0% |
| "重构这个文件" (正常) | ~15000 token (5 轮) | ~10000 (L2 裁剪) | **33%** |
| "重构这个文件" (空转) | ~25000 token (20 轮) | ~8000 (L3 检测停止) | **68%** |
| 长对话复杂任务 | 无上限 | 最多 50000 token (L4) | 有上限 |

---

## 日志示例

### L1 分流日志
```
AgentDecisionOrchestrator: L1 bypass: simple task detected, direct LLM call (prompt=8 chars)
AgentDecisionOrchestrator: L1 direct: 1200ms, ~450 tokens
```

### L2 裁剪日志（工具结果中）
```
... [TRUNCATED by Agent Loop Budget] showing first 120 of ~350 lines (15000 chars total).
Use offset=121 and limit=100 to read the next section.
```

### L3+L4 退出日志
```
AgentLoop: [agent_alpha_fast_edge] Done: 6 tool calls, 8500ms, ~8200 tokens, exit=STALL_DETECTION, answer=320 chars
AgentLoop: [agent_beta_deep_reasoner] Done: 12 tool calls, 25000ms, ~48000 tokens, exit=TOKEN_BUDGET, answer=180 chars
```

---

## 参考资料

- **Claude Code Agent Loop**: 5 级上下文压缩（tool result budget → history snip → microcompact → context collapse → autocompact），显式状态机（State 10 字段），7 种继续原因 + 7 种终止原因
- **Orchestrator vs AgenticLoop**: LLM 只做两次调用（路由 + 合成），中间全是确定性执行，比 Agentic Loop 省 70% token
- **Loop Engineering** (OpenClaw + Anthropic): 5 大要素 — Goal/Termination/Verification/No-Progress/Budget
- **Wayfinder Router**: 确定性路由（零 LLM 消耗），基于 prompt 结构特征分类
- **RouteLLM** (Stanford): 轻量分类器决定走便宜模型还是贵模型
