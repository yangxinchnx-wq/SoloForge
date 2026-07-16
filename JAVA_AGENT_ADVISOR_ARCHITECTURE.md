# Java Agent Advisor 链架构设计文档

> 状态：已确认，待实施
> 创建日期：2026-07-16
> 参与者：用户 + CatPaw

---

## 一、总体架构

### 1.1 两层分工

```
用户消息
  ↓
RACER (Node.js 3001) — 总调度 / 裁判
  ├─ 经验缓存命中 → callLLMWithTools(无工具, 1轮) → 返回
  ├─ L1 简单任务 → callLLMWithTools(无工具, 1轮) → 返回
  ├─ 需要Agent → TCP Socket → Java 8771
  │    ├─ Java 不可用 → 报错，不降级
  │    ↓
  │    Java (Spring AI 2.0, 8770+8771) — 执行引擎 / 运动员
  │    ├─ 创建/获取 MessagePool (ConcurrentHashMap, 绑定 chatId)
  │    ├─ 并行启动 N 个 worker
  │    │    每个 worker 的 Advisor 链:
  │    │    SystemPrompt → PoolInject → RAG → ToolCalling → PoolWrite → RateLimit → Audit
  │    ├─ SSE 事件流 → TCP Socket → RACER → 前端
  │    └─ 全部完成 → 返回聚合结果
  └─ RACER 聚合 + 经验保存 → 返回用户
```

### 1.2 职责边界

| 职责 | 归属 | 说明 |
|---|---|---|
| 经验缓存（命中/保存） | RACER | 已实现，不动 |
| L1 简单任务分流 | RACER | 已实现，不动 |
| Agent 选择（RACER 选路） | RACER | 多 worker 并行选路 |
| Provider 分配 | RACER | 主模型/副模型分配 |
| **System Prompt 拼装** | **Java** | 12 层拼装，从旧代码恢复 |
| **工具调用循环** | **Java** | Spring AI 2.0 ToolCallingAdvisor |
| **RAG 案例检索** | **Java** | 从 experience_case 表查相似案例 |
| **多 worker 协调** | **Java** | MessagePool 共享 + 裁判指令接收 |
| **裁判打分** | **RACER** | 实时看 worker 输出，打分，分低可喊停 |
| **限流/重试** | **Java** | RateLimitAdvisor |
| **审计/token 追踪** | **Java** | AuditAdvisor |
| 多 worker 聚合 | RACER | Java 只管单次 dispatch 执行 |
| 可视化 | 自己做 | 不引入 Alibaba Graph |

---

## 二、通信方案

### 2.1 方案选型：Raw TCP Socket

- **端口**：8771（独立于 Spring Boot HTTP 的 8770）
- **绑定**：127.0.0.1（仅本地，外部不可见）
- **协议**：newline-delimited JSON（和 Rust 调度器一致）
- **依赖**：零新增（Java `ServerSocket` + Node.js `net.Socket`）

### 2.2 端口分配

```
8770 — Spring Boot HTTP REST (训练 API + Agent CRUD + 健康检查)
8771 — Raw TCP Socket (RACER ↔ Java 实时通信)
```

### 2.3 协议格式

所有消息为 JSON + `\n` 结尾，按行切割。

**RACER → Java（下行）**：

```jsonc
// 启动 dispatch
{"type":"dispatch","dispatchId":"pkt_abc","chatId":"chat_123","workers":[...],"prompt":"...","history":[...],"settings":{...},"tools":[...],"permissionMode":"normal"}

// 裁判评判（实时注入）
{"type":"evaluate","dispatchId":"pkt_abc","workerIdx":1,"score":0.3,"action":"stop","reason":"输出质量过低"}

// 工具执行请求（Java → RACER，通过同一 TCP 连接）
{"type":"tool_execute","dispatchId":"pkt_abc","workerIdx":0,"tool":"browser_devtools","args":{"url":"http://example.com"}}
```

**Java → RACER（上行）**：

```jsonc
// worker 启动
{"type":"worker_started","dispatchId":"pkt_abc","workerIdx":0,"agentId":"code_agent"}

// worker 流式输出
{"type":"worker_chunk","dispatchId":"pkt_abc","workerIdx":0,"content":"根据分析..."}

// 工具调用通知
{"type":"tool_call","dispatchId":"pkt_abc","workerIdx":0,"tool":"read_file","args":{"path":"config.ts"}}

// 工具执行结果（RACER 返回）
{"type":"tool_result","dispatchId":"pkt_abc","workerIdx":0,"result":"文件内容...","cached":false}

// worker 完成
{"type":"worker_done","dispatchId":"pkt_abc","workerIdx":0,"output":"最终回复","tokenUsage":{...}}

// 池子共享通知
{"type":"pool_share","dispatchId":"pkt_abc","workerIdx":0,"tool":"read_file","toolArgs":{"path":"config.ts"},"summary":"读取了配置文件"}

// dispatch 完成
{"type":"dispatch_done","dispatchId":"pkt_abc","winnerIdx":0,"allOutputs":[...]}
```

### 2.4 连接管理

- **连接方案**：RACER 与 Java 之间维持**单条 TCP 长连接**（8771），多个 dispatch 复用该连接，靠 `dispatchId` 做消息路由。
- RACER 侧：重试连接（连不上等 2s 重试，最多 10 次）
- Java 侧：accept 后保持长连接，断开后等待重连
- 粘包处理：RACER 侧 Buffer 拼接器按 `\n` 切割
- 心跳：每 30s 一次 `{"type":"ping"}` / `{"type":"pong"}`

### 2.5 被否决的通信方案

| 方案 | 否决理由 |
|---|---|
| HTTP SSE | 走 HTTP 栈有额外开销，容易被代理/防火墙干扰，单向推送不适合双工通信 |
| WebSocket | 需要引入 ws 依赖（Java 侧 spring-boot-starter-websocket），且握手流程复杂，过度设计 |
| Named Pipes (Windows) | 平台绑定（仅 Windows），跨平台不可用，且 Java 侧 API 复杂 |

### 2.6 TCP 已知缺点及应对

| 缺点 | 应对 | 代价 |
|---|---|---|
| 断线重连 | 两边各写连接状态管理 | ~50 行/侧 |
| 断线重试策略 | 启动阶段 RACER 重试 3 次（每次间隔 2s），运行阶段 Java 侧重试 3 次（每次间隔 1s），失败后直接报错并返回具体错误信息 | ~20 行/侧 |
| 粘包切割 | RACER 侧 Buffer 拼接器 | ~20 行 |
| 启动顺序 | RACER 侧重试逻辑 | ~15 行 |

参照实现：项目内 Rust 调度器（`SoloForgeRustSchedulerClient`）已有完整的断线重连 + readline 解析 + pendingRequests 管理。

### 2.7 当前状态

> **注意**：当前 `application.yml` 标记为 `TRAINING-ONLY STATUS`，所有聊天/执行/Advisor/orchestrator 模块已删除。
> 本次实施需要**恢复**这些运行时模块，并将 `application.yml` 的注释从 training-only 改为 dual-mode（训练 + 运行时）。
> 具体来说：`controller/ChatController` 的聊天端点需要恢复、`advisor/*` 需要用 Spring AI 2.0 重新实现、`executor/*` 需要新建。

---

## 三、消息池子（MessagePool）

### 3.1 存储

- **方案**：纯内存 `ConcurrentHashMap`
- **不使用** Garnet / SQLite / Redis
- **不跨进程**：池子只在 Java 进程内

### 3.2 生命周期

| 事件 | 行为 |
|---|---|
| 用户发第一条消息 | 自动创建池子 |
| 对话进行中 | 池子持续存在 |
| 用户新建对话不动 | 池子不主动销毁 |
| 应用关闭 | 池子清空 |
| 断电 | 池子清空 |
| 用户重新打开软件 | 加载对话，发第一条消息时池子默默创建 |
| 不需要超时清理 | — |

### 3.3 数据结构

```java
// 每个对话一个池子，用 chatId 做 key
ConcurrentHashMap<String, MessagePool> pools;

class MessagePool {
    String conversationId;                              // 绑定到对话
    long createdAt;                                      // 创建时间
    ConcurrentLinkedQueue<PoolEntry> entries;            // 所有 worker 的消息流（按时间排序）
    ConcurrentHashMap<String, String> toolResults;       // 工具结果缓存（去重用，key = toolName + toolArgs hash）
    ConcurrentHashMap<Integer, WorkerState> workerStates; // 各 worker 的状态
    ConcurrentHashMap<String, PoolEntry> ragEntries;     // RAG 检索结果（每个 dispatch 只检索一次，共享给所有 worker）
}

record PoolEntry(
    long timestamp,
    int workerIdx,           // 哪个 worker 产生的
    String agentId,          // 哪个 agent
    EntryType type,          // TOOL_CALL / TOOL_RESULT / THINKING / OUTPUT / PEER_NOTICE
    String content,          // 内容
    String toolName,         // 如果是工具调用
    String toolArgs          // 工具参数
) {}
```

### 3.4 注入时机（Advisor 链）

```
请求进来
  ↓
PoolInjectAdvisor → 从 Pool 读取其他 worker 的最近消息 + RAG 检索结果，注入当前 worker 上下文
  ↓
ToolCallingAdvisor → 执行工具前先查 Pool 的 toolResults 缓存（去重，避免重复 IO）
  ↓
LLM 调用
  ↓
PoolWriteAdvisor → 把本轮工具调用、推理、输出写回 Pool（只保留关键结果，重复任务去重）
```

### 3.5 共享规则

- **对话隔离**：不同 `chatId` 的 MessagePool 完全隔离，互不可见。
- **RAG 共享**：每个 dispatch 开始时，RAGAdvisor 只检索一次相似案例，结果写入 Pool 的 `ragEntries`，当前对话所有 worker 都能看到。
- **工具结果去重**：worker A 调用 `read_file("config.ts")` → 结果以 `toolName + toolArgs hash` 为 key 写入 Pool；worker B 再调用相同工具时，先查 Pool，命中则直接复用，跳过真实 IO。
- **保留关键结果**：只保留工具执行结果、推理结论、最终输出；中间过程的低价值消息不写入 Pool。
- **无限容量**：Pool 本身不设上限，纯内存存储；通过去重机制避免冗余，关键结果由 Advisor 链决定是否写入。

---

## 四、Advisor 链设计

### 4.1 链顺序

```
SystemPromptAdvisor   — 12 层 prompt 拼装（从旧代码恢复）
  ↓
PoolInjectAdvisor     — 从池子读其他 worker 的消息，注入当前 worker 上下文
  ↓
RAGAdvisor            — 从 experience_case 表查相似案例做 few-shot
  ↓
ToolCallingAdvisor    — Spring AI 2.0 内置，工具调用前先查池子缓存
  ↓
PoolWriteAdvisor      — 把本轮工具调用、推理、输出写回池子
  ↓
RateLimitAdvisor      — 共享限流配额（多 worker 共用一个 RPM 池）
  ↓
AuditAdvisor          — token 追踪 + 进度上报
  ↓
LLM 调用
```

### 4.2 各 Advisor 职责

| Advisor | 职责 | 数据来源 |
|---|---|---|
| SystemPromptAdvisor | 12 层 system prompt 拼装 | agent_identity 表 + 前端 settings + 规则文件 |
| PoolInjectAdvisor | 读取 Pool 中其他 worker 消息，注入上下文 | ConcurrentHashMap |
| RAGAdvisor | 检索相似案例做 few-shot 注入 | experience_case 表 |
| ToolCallingAdvisor | 工具调用循环 + 工具结果缓存查 Pool | Spring AI 2.0 内置 + Pool |
| PoolWriteAdvisor | 写回本轮工具调用和推理到 Pool | ConcurrentHashMap |
| RateLimitAdvisor | 动态配额检测 + 429 重试 | 服务端按 provider/model 返回的配额限制 |
| AuditAdvisor | token 追踪 + 进度上报 | SSE 事件 |

---

## 五、SystemPromptBuilder（12 层）

### 5.1 层定义

| 层 | 名称 | 数据来源 | 状态 |
|---|---|---|---|
| [1] Identity | Agent 身份 | `agent_identity` 表 | ✅ |
| [2] Personality | 人格 | 前端 settings.personality | ✅ |
| [3] Tone | 语气 | 前端 settings.tone | ✅ |
| [4] Emoji | emoji 偏好 | 前端 settings.emojiMode | ✅ |
| [5] Capability | 能力列表 | `agent_identity.capabilities` | ✅ |
| [6] Workspace | 工作区限制 | 前端 workspaceFolder | ✅ |
| [7] Tools | 工具说明 | 内置工具 + RACER 传来的远程工具 | ✅ |
| [8] Canvas | 画布上下文 | 前端 canvasContext | ✅ |
| [9] Skills | 启用的 Skill 内容 | `UI/resources/skills/` 动态读取 SKILL.md | ✅ |
| [10] Knowledge | 知识库 ID | 前端 activeKnowledge（目前仅 ID 列表） | ✅ 占位 |
| [11] Experience | 历史经验 | **改为 `experience_case` 表**（旧代码查 social_memory 已删除） | ✅ |
| [12] Behavior | 行为规则 | 按权限模式从规则文件动态读取 | ✅ |

### 5.2 规则文件（第 12 层）

#### 目录

```
UI/resources/rules/
  ├── normal.md          — 普通模式（安全常态）
  ├── performance.md     — 性能模式（半自动）
  ├── expert.md          — 专家模式（自动感知）
  └── ultimate.md        — 极致模式（全域自动）
```

#### 4 个权限模式

| 模式 | ID | 安全级别 | execute_cmd 策略 |
|---|---|---|---|
| 普通模式 | `normal` | 最高 | 所有命令需用户确认，阻止危险命令 |
| 性能模式 | `performance` | 中 | 半自动，阻止系统级危险命令 |
| 专家模式 | `expert` | 低 | 允许大部分命令，AST 扫描 |
| 极致模式 | `ultimate` | 无 | 不限制 |

#### 前端编辑功能保留

- 前端 `SkillsRulesTab.tsx` 的 UI 完全保留
- 路径从 `BlogSystem/rules/` 改为 `UI/resources/rules/`
- 「创建并快速打开规则文件」按钮改为真实落盘（通过后端 API 创建文件）
- 用户在编辑器中编辑后保存到磁盘
- Java 侧每次 dispatch 动态读取对应模式的 `.md` 文件注入 system prompt

#### 参考方案

参考 Codex / Claude Code 的权限模式设计，每个规则文件包含：
1. 执行权限（哪些命令需确认/自动执行/禁止）
2. 文件访问范围（工作区限制、敏感路径保护）
3. 网络策略（是否允许外部请求）
4. 工具限制（哪些工具可用/禁用）
5. 审计级别（日志详细度）

---

## 六、工具集

### 6.1 内置工具（Java 直接执行）

| 工具 | 方法 | 说明 |
|---|---|---|
| `read_file` | `readFile(path)` | 读取文件内容 |
| `write_file` | `writeFile(path, content)` | 写入文件 |
| `execute_cmd` | `executeCmd(command)` | 执行命令（Windows: `cmd.exe /c`） |
| `search_code` | `searchCode(pattern, fileGlob)` | 搜索代码 |
| `list_files` | `listFiles(dirPath)` | 列出目录 |
| `canvas_push_ui` | `canvasPushUi(sessionId, dslJson, language)` | 后端工具，不显示给用户，前端自动翻译代码块 |

### 6.2 远程工具（RACER 透传执行）

| 工具组 | 子工具 | 执行端 |
|---|---|---|
| Obscura | browser_devtools, console, network, dom_inspect, screenshot, perf_trace, cookies | RACER → Obscura CDP |
| Browser-Use | bu_run_task, pause, resume, state, screenshot, history | RACER → Python browser_use_service |
| Windows-MCP | win_reg_read, service_ctrl, task_scheduler, event_log, powershell, firewall, perfmon | RACER → Windows MCP Server |

### 6.3 Java 侧如何知道有哪些工具

**路线 A（已确认）**：RACER 传过来。

RACER 已加载 `UI/resources/tools/manifest.json`，dispatch 请求中直接把用户选中的工具 schema 带过来：

```jsonc
{
  "tools": [
    {
      "id": "browser_devtools",
      "type": "remote",
      "description": "打开 Chrome DevTools 调试指定网页",
      "schema": {
        "type": "object",
        "properties": {
          "url": { "type": "string", "description": "要调试的网页 URL" }
        },
        "required": ["url"]
      }
    }
  ]
}
```

Java 侧：
- 内置工具 → 自动注册，Java 直接执行
- `type: "remote"` → 用 RACER 传来的 schema 注册到 LLM，LLM 调用时转发给 RACER

### 6.4 RACER 工具执行端点

RACER 作为纯中转商，不调 LLM，不判断意图，不修改参数。

#### ⚠️ 关键约束：防空转

用户明确提出的 failure mode：
> 「java 侧要这个工具去读书，但是 RACER 光调用工具了，要求没传给 llm，然后空信息在传给 java，导致报错和空转」

**防止方案**：
1. RACER 收到 `tool_execute` 后，**只执行工具**，不调任何 LLM
2. 工具执行的输入参数完全来自 Java 侧的 LLM 决策（Java 的 ToolCallingAdvisor 已决定调什么工具、传什么参数）
3. RACER 返回的 `tool_result` 是工具的**原始输出**，不做任何 LLM 加工
4. Java 侧拿到 `tool_result` 后，由自己的 LLM 在下一轮决定如何使用
5. 如果 RACER 端工具执行失败，返回 `{"type":"tool_result","error":"...","code":"EXEC_FAILED"}`，Java 侧 LLM 自行处理错误

**一句话**：RACER 是哑管道，Java 是大脑。工具调用的决策权和结果解释权全在 Java。

```
Java (LLM决策调read_file) → RACER (执行read_file, 不调LLM) → 原始结果 → Java (LLM解释结果)
```

#### 协议格式

```
Java → RACER (TCP Socket):
  {"type":"tool_execute","tool":"browser_dom_inspect","args":{"url":"http://example.com"}}

RACER:
  收到 → 按 manifest.json 的 endpoint 配置转发 → 执行器执行 → 原封不动返回

RACER → Java (TCP Socket):
  {"type":"tool_result","result":"<html>...</html>","metadata":{"durationMs":340}}
```

### 6.5 热插拔

**技能热插拔**：
- `UI/resources/skills/manifest.json` 定义技能清单
- 用户加新条目 + 创建 SKILL.md → 下次对话自动生效
- 删掉条目 → 下次对话自动消失
- 不需要重启

**工具热插拔**：
- `UI/resources/tools/manifest.json` 定义工具清单
- 用户在资源管理器勾选/取消工具 → 下次对话自动生效
- RACER 传什么 Java 用什么，不需要重启

---

## 七、技能系统

### 7.1 目录结构

```
UI/resources/skills/
  ├── manifest.json           ← 技能清单（ID + 名称 + contentPath）
  ├── bug-fix/
  │   └── SKILL.md            ← 技能内容
  ├── code-review/
  │   └── SKILL.md
  ├── doc-write/
  │   └── SKILL.md
  ├── feature-implement/
  │   └── SKILL.md
  ├── refactor/
  │   └── SKILL.md
  └── test-coverage/
      └── SKILL.md
```

### 7.2 现状

- `manifest.json` 已存在，定义了 6 个技能
- SKILL.md 文件**全部不存在**，需要创建
- 创建时参考顶级方案（Codex / Claude Code）的 skill 格式

### 7.3 Java 侧读取逻辑

1. 读 `manifest.json` → 拿到技能清单
2. 按前端传来的 `activeSkills` ID 列表过滤
3. 读对应 `contentPath` 的 SKILL.md 文件内容
4. 注入 system prompt 第 9 层

---

## 八、多 Worker 协调

### 8.1 裁判-运动员模型

```
Java: 跑所有 worker（运动员）
  ↓ TCP Socket 实时上报
RACER: 看着各 worker 的输出，打分评判（裁判）
  ↓ 分最低的行为不允许做 → 可中途喊停
RACER: 所有 worker 跑完，选 winner，聚合返回
```

### 8.2 RACER 评判指令

RACER 通过 TCP Socket 实时发送评判：

```jsonc
// 继续执行
{"type":"evaluate","dispatchId":"pkt_abc","workerIdx":0,"score":0.8,"action":"continue"}

// 提前终止某个 worker
{"type":"evaluate","dispatchId":"pkt_abc","workerIdx":1,"score":0.2,"action":"stop","reason":"输出质量过低"}
```

Java 侧收到 `action: "stop"` 后，**立即终止**对应 worker 的 ChatClient 调用，不等待当前轮次返回。

### 8.3 接口设计

```
POST /api/chat/execute (HTTP 8770, 仅启动)
Body: {
  dispatchId: "pkt_abc123",
  chatId: "chat_123",
  workers: [
    { workerIdx: 0, agentId: "code_agent", provider: {...}, maxRounds: 20 },
    { workerIdx: 1, agentId: "debug_agent", provider: {...}, maxRounds: 10 },
    { workerIdx: 2, agentId: "review_agent", provider: {...}, maxRounds: 6 }
  ],
  prompt: "用户消息",
  history: [...],
  settings: { personality, tone, emojiMode, workspaceFolder, ... },
  permissionMode: "normal",
  tools: [...],
  activeSkills: ["bug-fix", "refactor"],
  activeKnowledge: ["kb_001"],
  workspaceFolder: "C:/Users/..."
}

后续通信走 TCP Socket 8771
```

### 8.4 流式输出

方案 A（已确认）：Java → RACER（TCP 透传）→ 前端

前端实时看到各 worker 的进度、工具调用、池子共享。

---

## 九、callLLMWithTools

### 9.1 保留

RACER 侧 `callLLMWithTools` 保留，但用途收窄：

| RACER 路径 | 是否用 callLLMWithTools | 是否调 Java |
|---|---|---|
| 经验缓存命中 | ✅ 用（`tools:[]`, `maxRounds:1`） | ❌ 不调 |
| L1 简单任务 | ✅ 用（`tools:[]`, `maxRounds:1`） | ❌ 不调 |
| 复杂任务（需要工具） | ❌ 不用 | ✅ 调 Java |
| Java 不可用 | ❌ 不降级 | 直接报错 |

### 9.2 定义

`callLLMWithTools` 是纯 LLM 调用通道，不带工具循环。工具循环的活只在 Java 侧。

---

## 十、Spring AI 2.0 API 迁移备忘

> 项目已从 Spring AI 1.0.0 + Spring Boot 3.5.3 升级到 Spring AI 2.0.0 + Spring Boot 4.0.0，编译通过。

### 10.1 关键 API 变更

| 变更项 | 1.0.0 (旧) | 2.0.0 (新) |
|---|---|---|
| Provider 类 | `OpenAiApi` / `AnthropicApi` | **已移除**，baseUrl 和 apiKey 直接放入 ChatOptions |
| Builder 模式 | `.openAiApi(api).defaultOptions(opts)` | `.options(opts)` （apiKey/baseUrl 在 options 内） |
| Advisor API | `RequestResponseAdvisor` 接口 | `CallAdvisor` / `StreamAdvisor` 接口（Spring AI 2.0 原生） |
| 工具定义 | `@Bean Function<ToolInput, ToolOutput>` | `@Tool` 注解 + 自动注册 |

### 10.2 当前 LlmConfig 实现参考

```java
// OpenAI 兼容 (GPT-4o / DeepSeek / GLM / 通义千问)
OpenAiChatModel.builder()
    .options(OpenAiChatOptions.builder()
        .apiKey(apiKey)
        .baseUrl(baseUrl)
        .model(model)
        .temperature(0.3)
        .build())
    .build();

// Anthropic Claude
AnthropicChatModel.builder()
    .options(AnthropicChatOptions.builder()
        .apiKey(apiKey)
        .model(model)
        .temperature(0.3)
        .build())
    .build();
```

### 10.3 DynamicChatModelResolver

- 已实现：按 provider 名称路由到对应的 ChatModel Bean
- 运行时支持请求级动态 baseUrl/apiKey/model 注入
- 新增的运行时聊天路径复用此 resolver

---

## 十一、不引入的技术

| 技术 | 原因 |
|---|---|
| Alibaba Graph | 不要了，可视化自己做 |
| GraalVM Native Image | 不引入，训练服务不需要快速冷启动 |
| **替代方案** | **改用 Spring Boot `spring.main.lazy-initialization=true`**，按需初始化 Bean，降低冷启动时间，零额外配置 |
| Spring AI Advisor 链（旧版） | 旧版已删除，用 Spring AI 2.0 原生 Advisor API 重新实现 |
| Redis / spring-boot-starter-data-redis | 不引入，消息池子纯内存 |
| Garnet（用于消息池子） | 不使用，消息池子纯内存 ConcurrentHashMap |

---

## 十二、文件清单

### 12.1 需要创建的 Java 文件

| 文件 | 说明 |
|---|---|
| `advisor/SystemPromptAdvisor.java` | 12 层 system prompt 拼装 |
| `advisor/PoolInjectAdvisor.java` | 从池子读其他 worker 消息注入 |
| `advisor/PoolWriteAdvisor.java` | 写回池子 |
| `advisor/RAGAdvisor.java` | 从 experience_case 表查相似案例 |
| `advisor/RateLimitAdvisor.java` | 共享限流 + 429 重试 |
| `advisor/AuditAdvisor.java` | token 追踪 + 进度上报 |
| `tools/SoloForgeTools.java` | 6 个内置 @Tool 方法（从 git 恢复 + Windows 适配） |
| `tools/RemoteToolExecutor.java` | 远程工具转发到 RACER |
| `pool/MessagePool.java` | 消息池子数据结构 |
| `pool/PoolManager.java` | 池子管理（创建/获取/销毁） |
| `transport/TcpServer.java` | Raw TCP Socket 服务端 (8771) |
| `transport/MessageProtocol.java` | newline JSON 协议编解码 |
| `executor/MultiWorkerExecutionService.java` | 多 worker 并行执行 + 协调 |
| `executor/WorkerConfig.java` | Worker 配置 DTO |
| `controller/ChatExecuteController.java` | `/api/chat/execute` HTTP 端点（仅启动 dispatch） |

### 12.2 需要创建的资源文件

| 文件 | 说明 |
|---|---|
| `UI/resources/rules/normal.md` | 普通模式行为规则 |
| `UI/resources/rules/performance.md` | 性能模式行为规则 |
| `UI/resources/rules/expert.md` | 专家模式行为规则 |
| `UI/resources/rules/ultimate.md` | 极致模式行为规则 |
| `UI/resources/skills/bug-fix/SKILL.md` | Bug 修复技能 |
| `UI/resources/skills/code-review/SKILL.md` | 代码审查技能 |
| `UI/resources/skills/doc-write/SKILL.md` | 文档撰写技能 |
| `UI/resources/skills/feature-implement/SKILL.md` | 功能实现技能 |
| `UI/resources/skills/refactor/SKILL.md` | 重构技能 |
| `UI/resources/skills/test-coverage/SKILL.md` | 测试覆盖技能 |

### 12.3 需要修改的文件

| 文件 | 改动 |
|---|---|
| `solo-forge-agent/pom.xml` | 无新增依赖（Spring AI 2.0 + Spring Boot 4.0 已有） |
| `solo-forge-agent/src/main/resources/application.yml` | 添加 TCP 端口配置 + `spring.main.lazy-initialization=true` + 从 training-only 改为 dual-mode |
| `UI/src/components/settingsTabs/SkillsRulesTab.tsx` | 规则文件路径改为 `UI/resources/rules/`，真实落盘 |
| `src/server/routes-system.ts` | 添加 `/api/internal/tool-execute` 端点（RACER 工具中转） |
| `src/core/agent/agent-decision-orchestrator.ts` | 复杂任务路径改为调 Java TCP 8771 |
| `start-all.mjs` | 无改动（Java 和 Node 独立 spawn 不变） |

---

## 十三、实际项目对照与遗漏项

### 12.1 现有基础设施（文档未充分提及）

| 现有项 | 位置 | 说明 |
|---|---|---|
| Java Agent HTTP 代理 | `src/server/routes-system.ts` | `/api/java-agent/*` 已实现，正向代理到 Java 8770 |
| Java Agent SSE 代理 | `src/server/routes-system.ts` | `/api/java-agent/api/chat/stream` 已实现，但 Java 侧 `/api/chat/stream` 端点已删除，当前是断开的 |
| 工具定义（TS） | `src/core/agent/tools/tool-definitions.ts` | 内置工具 + 扩展工具 schema 已定义，但执行逻辑在 Node.js |
| 工具清单（JSON） | `UI/resources/tools/manifest.json` | Obscura / Browser-Use / Windows-MCP 三组工具已配置 |
| 技能清单（JSON） | `UI/resources/skills/manifest.json` | 6 个技能已定义，但 SKILL.md 文件全部不存在 |
| HTTP 限流器 | `src/security/auth.ts` | Token Bucket 限流，作用于 HTTP API，与 LLM 限流是两套独立机制 |
| 经验缓存（Node.js） | `src/core/agent/evolution/experience-cache.ts` | 文件持久化到 `data/agent-experience.jsonl`，与 Java 侧 `experience_case` 表是两套系统 |
| Rust 调度器 | `src/kernel/scheduler-client.ts` | 已有 TCP 通信实现，但协议是 stdin/stdout text + request ID，不是 JSON newline-delimited |
| 前端 permissionMode | `UI/src/types/streaming.ts` | 已有 `normal` / `performance` / `expert` / `ultimate` 四种模式 |
| 前端 SSE 流式 | `UI/src/services/aiBackend.ts` | 当前通过 `/api/java-agent/api/chat/stream` 调用 Java SSE |

### 12.2 文档遗漏的关键细节

#### 1. 现有 Java Agent 代理未纳入新架构

文档未提及 `/api/java-agent/*` 代理的存在。新架构需要明确：
- 保留 `/api/java-agent/*` 作为 Java HTTP 管理的代理
- `/api/chat/execute` 是**新增**端点，不走现有代理
- 现有 `/api/java-agent/api/chat/stream` 代理在 Java 恢复 `/api/chat/stream` 后可继续使用，但新架构优先用 TCP 8771 流式

#### 2. SSE 代理：旧的废弃，改用 TCP 8771 流式

Java 侧 `ChatController` 的聊天/流式端点已删除，RACER 原有的 `handleJavaAgentSSE` 代理废弃，不再使用。

新架构直接通过 **TCP 8771** 传输 `worker_chunk` / `worker_done` 等事件，RACER 收到后转发给前端。不保留旧 SSE 代理链路。

#### 3. 工具执行路径需要拆分

当前 `executeToolCall()` 在 Node.js 直接执行。新架构需要拆分：

| 工具类型 | 当前执行端 | 新架构执行端 |
|---|---|---|
| `read_file`, `write_file`, `execute_cmd`, `search_code`, `list_files` | Node.js | **Java 侧 @Tool** |
| `canvas_push_ui` | Node.js → HTTP `/api/canvas/relay/push-ui` | **Java 侧 @Tool**（或保持远程工具） |
| `browser_*`, `bu_*`, `win_*` | Node.js → 远程服务 | **RACER 远程工具透传** |

**工作量评估**：Java 侧实现 6 个内置工具属于**中等工作量**，主要是样板代码：
- 文件操作类（read/write/list/search）：直接调用 Java NIO，约 2-3 天
- `execute_cmd`：Windows 用 `cmd.exe /c`，需要 ProcessBuilder 封装，约 1 天
- `canvas_push_ui`：转发到现有 HTTP relay，约 0.5 天

**迁移策略**：Phase 2 先实现 Java 内置工具，Phase 4 再切 RACER 远程工具。Node.js 侧保留工具 schema 定义，执行逻辑逐步迁移。

#### 4. 经验缓存双系统（已确认）

| 系统 | 存储 | 用途 | 优先级 |
|---|---|---|---|
| Node.js `experience-cache.ts` | `data/agent-experience.jsonl` | L1 快速命中（当前 RACER 经验命中） | 高 |
| Java `experience_case` 表 | SQLite | L2 持久化案例库（RAG 检索） | 低 |

**触发条件**：
- Node.js 经验缓存：每次用户消息先查，命中且成功率 >= 0.7 直接复用
- Java `experience_case` 表：复杂任务走 Advisor 链时，RAGAdvisor 检索相似案例做 few-shot

两套系统独立运行，互不干扰。

#### 5. RateLimitAdvisor 与现有 HTTP 限流器的关系（已确认：三层独立，不合并）

项目已有两层限流机制，但它们都不管 LLM provider 级别的限流：

| 层级 | 负责人 | 数据来源 | 作用 |
|---|---|---|---|
| **HTTP API 限流** | `src/security/auth.ts` 的 `RateLimiter` | 写死的 `defaultRateLimit`（burst=120, refill=10/s） | 保护 RACER API 不被刷爆 |
| **前端 LLM 限流（未实现）** | 前端 `rateLimitProfile` 字段 | 模型服务配置页面（用户填写 maxRpm/maxTpm/maxConcurrent） | 传给后端，但后端目前直接忽略 |
| **LLM Provider 限流（新）** | Java 侧 `RateLimitAdvisor` | 前端传来的 `rateLimitProfile` + probe 探测 + 运行时 429 动态校准 | 保护 LLM provider 不被 429 |

三层各管各的，不合并。

---

##### 5.1 每个模型配额的来源（三层递进）

每个模型的 RPM/TPM 各不相同，配额来源分三层，优先级从高到低：

```
用户保存模型 → probe 探测 → 前端 rateLimitProfile → Java RateLimitAdvisor → 运行时 429 动态校准
```

**第一层：用户手填（兜底）**

用户在模型配置页面手动填写 `rateLimitProfile`（maxRpm/maxTpm/maxConcurrent）。问题是用户不一定知道准确值，容易填错。作为兜底数据来源。

**第二层：probe 探测时从 LLM 响应头自动读取（新增，优先于手填）**

现有 probe 机制（`/api/providers/probe-cache/:providerId`）只检测连通性和能力（streaming/embeddings/chat），不读取限流信息。**需要增强**：在 probe 探测时从 HTTP 响应头提取限流字段，写入 `rateLimitProfile`，覆盖用户手填值。

不同 provider 的限流响应头格式：

| Provider | RPM 限流头 | TPM 限流头 |
|---|---|---|
| OpenAI | `X-RateLimit-Limit-Requests` | `X-RateLimit-Limit-Tokens` |
| Anthropic | `anthropic-ratelimit-requests-limit` | `anthropic-ratelimit-tokens-limit` |
| DeepSeek | `X-RateLimit-Limit-Requests`（兼容 OpenAI 格式） | `X-RateLimit-Limit-Tokens` |
| 其他 OpenAI 兼容 | 大多不返回，用用户手填值兜底 | 同左 |

probe 增强逻辑（实现时备注清楚）：
```typescript
// === 限流响应头提取（probe 增强部分）===
// 目的：从 LLM provider 的 HTTP 响应头中自动读取限流信息，
//       写入 rateLimitProfile，覆盖用户手填值。
//       这样保存模型时自动拿到真实配额，不需要用户手填。
//
// 注意事项：
//   1. 不同 provider 的响应头字段名不同（见上表），需要逐个尝试
//   2. 有些 provider 不返回限流头，此时保留用户手填值
//   3. 探测时可能命中低频限流窗口，读取的值可能偏小，
//      取 max(探测值, 用户手填值) 作为保守策略
//   4. 探测结果持久化到 probe-cache，下次打开配置页不重复探测
function extractRateLimitFromHeaders(
  headers: Record<string, string>,
  providerId: string,
  fallback: RateLimitProfile | null,
): RateLimitProfile {
  // OpenAI 格式
  const openaiRpm = headers['x-ratelimit-limit-requests'];
  const openaiTpm = headers['x-ratelimit-limit-tokens'];

  // Anthropic 格式
  const anthropicRpm = headers['anthropic-ratelimit-requests-limit'];
  const anthropicTpm = headers['anthropic-ratelimit-tokens-limit'];

  const detectedRpm = Number(openaiRpm || anthropicRpm || 0);
  const detectedTpm = Number(openaiTpm || anthropicTpm || 0);

  // 取 max(探测值, 用户手填值)，保守策略
  return {
    maxRpm: detectedRpm || fallback?.maxRpm || undefined,
    maxTpm: detectedTpm || fallback?.maxTpm || undefined,
    maxConcurrent: fallback?.maxConcurrent || undefined, // 响应头里没有，保留用户手填
    contextWindow: fallback?.contextWindow || undefined,
    maxOutputTokens: fallback?.maxOutputTokens || undefined,
  };
}
```

**第三层：运行时 429 动态校准（RateLimitAdvisor 做）**

LLM 返回 429 时，读取 `Retry-After` 响应头，动态调低内存中的配额池，下次请求自动避开。窗口期过后自动恢复。

---

##### 5.2 RateLimitAdvisor 配额池设计

配额池按 `provider + model` 维度创建，每个模型一个独立池：

```java
// === RateLimitAdvisor 配额池（实现时备注清楚）===
// 数据来源优先级（从高到低）：
//   1. 运行时 429 动态校准值（最准，实时调整）
//   2. probe 探测值（从 LLM 响应头读取，保存模型时自动获取）
//   3. 用户手填值（rateLimitProfile.fallback，兜底）
//
// 注意事项：
//   - 每个模型的 RPM/TPM 各不相同，必须按 provider+model 建池
//   - 多 worker 共用同一个池（同一模型的所有 worker 共享配额）
//   - 429 收到后动态调低，不是永久调低，窗口期（60s）后恢复原值
//   - 如果探测值和手填值冲突，取 max（保守策略，避免过度限制）
class RateLimitPool {
    String provider;           // "openai" / "anthropic"
    String model;              // "gpt-4o" / "claude-3-5-sonnet"
    int rpmLimit;              // 每分钟请求数限制（来源：max(探测值, 手填值)）
    int tpmLimit;              // 每分钟 token 数限制
    int maxConcurrent;         // 最大并发数（来源：用户手填）
    AtomicInteger currentRpm;  // 当前分钟已用请求数
    AtomicInteger currentTpm;  // 当前分钟已用 token 数
    AtomicInteger currentConcurrent; // 当前并发数
    long windowStart;          // 当前窗口开始时间（毫秒）
    volatile int dynamicRpmLimit;    // 429 动态调低后的临时 RPM 限制
    volatile long dynamicRpmResetAt; // 动态限制恢复时间戳
}
```

##### 5.3 RateLimitAdvisor 决策逻辑

放在 Advisor 链的**倒数第二层**（AuditAdvisor 之前）：

1. **请求前检查**：
   - 查询当前模型对应的配额池
   - 如果 `currentRpm >= dynamicRpmLimit`（或 `rpmLimit`）→ 等待或返回 `RATE_LIMIT_EXCEEDED`
   - 如果 `currentTpm >= tpmLimit` → 等待或返回 `RATE_LIMIT_EXCEEDED`
   - 如果 `currentConcurrent >= maxConcurrent` → 排队等待

2. **请求后更新**：
   - LLM 返回后，从响应中提取 `tokenUsage`
   - 原子性地增加 `currentRpm` 和 `currentTpm`

3. **窗口滑动**：
   - 每次检查时，如果 `now - windowStart > 60000`，重置计数器

4. **429 动态校准**：
   - 如果 LLM 返回 429，读取 `Retry-After` 头
   - 等待指定时间后重试（最多 3 次）
   - 重试期间阻塞该 worker，不阻塞其他 worker
   - 动态调低 `dynamicRpmLimit`（例如降为原值的 50%），60s 后恢复

##### 5.4 需要改的地方

| 改动位置 | 说明 |
|---|---|
| `src/server/routes-system.ts` probe 处理 | 增强：从 HTTP 响应头提取限流信息，写入 probe 结果 |
| `UI/src/components/settingsTabs/ModelAddTab.tsx` | 把 probe 返回的限流信息同步到 `rateLimitProfile` |
| Java 侧 `RateLimitAdvisor`（新） | 读取 `rateLimitProfile` 建池，运行时按 429 动态校准 |

#### 6. Rust 调度器与 Java 的关系

**Rust 是指挥官，指挥全局；Java 只管自己的执行。**

- Rust 调度器（`scheduler_daemon.exe`）优先级高于 Java
- Rust 负责全局任务调度、优先级排序、Aging 因子计算
- Java 只负责接收 dispatch 请求，执行 Advisor 链 + 工具调用
- 两者通过 TCP 通信，但职责完全分离

**协议差异已确认**：
- Rust 调度器用 **stdin/stdout text protocol**（`PUSH task priority aging` + request ID）
- 新架构用 **TCP Socket + JSON newline-delimited**
- 两者都是 newline-delimited，但格式完全不同

**设计原则**：参考 Rust 调度器的连接管理思路（pendingRequests、重连、readline），但协议格式独立设计。Rust 和 Java 之间**不需要直接通信**，RACER 作为中间层协调。

#### 7. 启动脚本需要加入 Java

`UI/start.mjs` 只启动 Garnet + RACER Core + Node.js dev server + Electron，**不启动 Java**。

需要补充：
- Java 服务的启动方式：**`mvnw spring-boot:run`**（开发模式）或 **`java -jar`**（生产模式）
- 健康检查依赖：RACER 等待 **8770 端口**（Java HTTP）和 **8771 端口**（Java TCP）可用
- 修改 `start.mjs` 加入 Java 启动逻辑，并在启动后等待端口就绪

**建议启动顺序**：
1. Garnet (6379)
2. Java Agent (8770 + 8771) — 新增
3. Rust Scheduler（如果存在）
4. RACER Core (3001)
5. Node.js dev server (3000)
6. Electron 壳子

#### 8. 前端改动范围不明确

文档只提到 `SkillsRulesTab.tsx` 需要修改，但实际可能涉及：
- `aiBackend.ts` — 当前 SSE 流式逻辑需要适配新 TCP 通道
- `useChatStore.ts` — 可能需要处理新的消息类型（worker_chunk、pool_share 等）
- `ChatPanel.tsx` — 多 worker 并行展示需要 UI 支持

#### 9. MCP Server 依赖与感知

`pom.xml` 中 `spring-ai-starter-mcp-server-webflux` 被注释掉。如果 Java 需要作为 MCP Server 提供远程工具，需要取消注释。

**MCP Server 感知方案**：
- **Java**：如需提供 MCP 工具，取消注释 `pom.xml` 中的 MCP Server 依赖，实现 `@Tool` 方法
- **Rust**：Rust 调度器不需要直接感知 MCP Server，RACER 作为中间层处理工具分发
- **RACER**：读取 `UI/resources/tools/manifest.json`，在 dispatch 时把工具 schema 传给 Java，Java 按需注册为远程工具

数据库迁移：`experience_case` 表是否需要新增向量字段？这数据库先不管

---

## 十四、实施顺序

```
Phase 1: 基础设施
  ├── 1.1 TCP Socket 服务端 + 协议编解码 (Java + Node.js)
  ├── 1.2 MessagePool 数据结构 + PoolManager
  └── 1.3 规则文件创建 (4 个 .md)

Phase 2: Advisor 链
  ├── 2.1 SystemPromptAdvisor (12 层, 从旧代码恢复)
  ├── 2.2 SoloForgeTools (6 个 @Tool, 从 git 恢复 + Windows 适配)
  ├── 2.3 RAGAdvisor (experience_case 表检索)
  ├── 2.4 PoolInjectAdvisor + PoolWriteAdvisor
  ├── 2.5 RateLimitAdvisor + AuditAdvisor
  └── 2.6 RemoteToolExecutor (转发 RACER)

Phase 3: 执行引擎
  ├── 3.1 MultiWorkerExecutionService (并行启动 + 协调)
  ├── 3.2 ChatExecuteController (HTTP 启动端点)
  ├── 3.3 裁判指令接收 (TCP 上行处理)
  └── 3.4 流式输出 (TCP 下行, worker_chunk 事件)

Phase 4: RACER 集成
  ├── 4.1 TCP 客户端 (Node.js net.Socket)
  ├── 4.2 /api/internal/tool-execute 端点 (工具中转)
  ├── 4.3 agent-decision-orchestrator 改造 (复杂任务走 Java)
  └── 4.4 裁判打分逻辑 (实时评判 + 喊停)

Phase 5: 技能 + 前端
  ├── 5.1 创建 6 个 SKILL.md 文件
  ├── 5.2 SkillsRulesTab.tsx 规则文件路径修改 + 真实落盘
  └── 5.3 测试验证
```

---

## 十五、关键技术决策汇总

| 决策项 | 选择 | 理由 |
|---|---|---|
| 通信方案 | Raw TCP Socket (8771) | 不走 HTTP 栈，全双工，零依赖，和 Rust 调度器一致 |
| 消息池子存储 | ConcurrentHashMap 纯内存 | 跟对话走，断电清空，零依赖 |
| Java 侧工具发现 | RACER 传 schema | Java 不读文件，不关心 manifest 格式 |
| RACER 工具角色 | 纯中转（哑管道） | 不调 LLM，不判断意图，防空转，原封不动透传 |
| 多 worker 协调 | Java 感知 + RACER 裁判 | Java 跑（运动员），RACER 打分（裁判） |
| 流式输出 | TCP 透传 | Java → RACER → 前端 |
| 规则文件路径 | `UI/resources/rules/` | 和 skills/tools 同级 |
| 规则文件读取 | 动态读取 .md 文件 | 按权限模式选择，用户可编辑 |
| execute_cmd | `cmd.exe /c` | Windows 最稳定 |
| Skills 热插拔 | 读 manifest.json + SKILL.md | 加条目即生效，不需重启 |
| Tools 热插拔 | RACER 传 schema | 勾选即生效，不需重启 |
| Alibaba Graph | 不引入 | 可视化自己做 |
| GraalVM | 不引入 | 训练服务不需要，改用 lazy-initialization |
| callLLMWithTools | 保留 | 仅用于无工具单轮调用 |
| Java 不可用 | 报错不降级 | RACER 是总调度，Java 是唯一执行路径 |
| 冷启动优化 | lazy-initialization | 替代 GraalVM，零额外配置 |
## 十六、日志规范

采用 **JSON Lines** 格式，每行一条日志，方便 ELK/Greptime 等工具采集。

### 15.1 日志格式

```json
{
  "timestamp": "2026-07-16T10:30:00.123Z",
  "level": "INFO",
  "component": "RateLimitAdvisor",
  "dispatchId": "pkt_abc",
  "workerIdx": 0,
  "event": "rate_limit_check",
  "provider": "openai",
  "model": "gpt-4o",
  "currentRpm": 45,
  "rpmLimit": 500,
  "decision": "proceed"
}
```

### 15.2 关键日志点

| 组件 | 必须记录的日志点 |
|---|---|
| **TcpServer** | 连接建立/断开、粘包切割、消息解析失败、心跳超时 |
| **MessageProtocol** | 消息类型、dispatchId、解析错误、反序列化失败 |
| **Advisor 链** | 每个 Advisor 的进入/退出、注入内容摘要、异常 |
| **RateLimitAdvisor** | 配额检查结果、429 重试次数、等待时长 |
| **MultiWorkerExecutionService** | worker 启动/完成/失败/终止、聚合结果 |
| **PoolManager** | 池子创建/销毁、缓存命中/未命中 |

### 15.3 MDC 上下文

使用 SLF4J MDC，自动注入 `dispatchId` 和 `workerIdx`，同一 dispatch 的所有日志可以串联。

```java
MDC.put("dispatchId", dispatchId);
MDC.put("workerIdx", String.valueOf(workerIdx));
// 后续日志自动携带这两个字段
```

---

## 十七、补充设计

### 17.1 健康检查与进程监控

RACER 通过 TCP 8771 心跳判断 Java 是否存活（已有 30s ping/pong）。

- Java crash 后，RACER 的 TCP 连接会断开，触发重试 3 次
- 3 次失败后，RACER 返回 `JavaAgentUnavailableError`，前端提示"执行引擎未启动"
- `start.mjs` 需要加 Java 进程监控：Java crash 后自动重启（像 Garnet 一样）

**start.mjs Java 启动逻辑**：
```javascript
// === Java Agent 启动（实现时备注清楚）===
// 职责：启动 Java Spring Boot 服务，监听 8770（HTTP）+ 8771（TCP）
// 健康检查：等待 8770 端口可用后再继续启动 RACER Core
// 自动重启：Java crash 后等 2s 重启，最多重启 3 次
// 启动命令：mvnw spring-boot:run（开发模式）
//         java -jar solo-forge-agent.jar（生产模式）
function startJavaAgent() {
  // spawn java 进程，监听 stdout/stderr
  // crash 后自动重启
  // 通过 waitForPort(8770) 做健康检查
}
```

### 17.2 超时处理

| 操作 | 超时时间 | 超时后行为 |
|---|---|---|
| LLM 调用 | **40 秒** | 标记 worker 为 `TIMEOUT`，发送 `worker_failed` 事件 |
| 工具执行（所有工具） | **20 秒** | `Process.destroyForcibly()` 强制终止，返回 `TOOL_TIMEOUT` 错误 |
| TCP 连接重试 | 每次 1-2 秒间隔，3 次 | 返回 `JavaAgentUnavailableError` |

超时时间通过 dispatch 的 `settings` 传入，可按任务调整。默认值写死在 Java 侧配置中。

### 17.3 线程池设计（动态，非强制约束）

不强制约束核心/最大线程数，根据系统资源和任务负载动态调整：

```java
// === 线程池设计（实现时备注清楚）===
// 设计原则：动态弹性，而非强制约束
//   - 核心线程数：根据 CPU 核心数动态计算（Runtime.getRuntime().availableProcessors()）
//   - 最大线程数：核心线程数的 2 倍，上限 16
//   - 队列：LinkedBlockingQueue，容量 64（足够缓冲，不过度堆积）
//   - 拒绝策略：CallerRunsPolicy（队列满时在调用线程执行，不丢任务）
//   - 空闲回收：60s 空闲的核心线程会被回收，需要时重新创建
//
// 动态调整依据：
//   - CPU 使用率 > 80% → 不再扩容
//   - 内存使用率 > 85% → 不再扩容
//   - 当前活跃 worker 数 < 核心线程数 → 缩减到当前需求
class DynamicWorkerThreadPool {
    // 基于 ThreadPoolExecutor，但 corePoolSize 和 maxPoolSize 动态调整
    // 每 10s 检查一次系统资源，调整池大小
    // setCorePoolSize() / setMaximumPoolSize() 在运行时调整
}
```

### 17.4 Java 侧工具安全（按四种权限模式）

Java 不做独立的上下文管理（Java 是 agent，干活的，要上下文没意义）。工具安全按前端已有的四种 `permissionMode` 控制：

| 权限模式 | 工具限制 | 适用场景 |
|---|---|---|
| `normal` | 只读工具可用（read_file, list_files, search_code）；`write_file` 和 `execute_cmd` 需确认 | 日常对话，安全优先 |
| `performance` | 全部工具可用；`execute_cmd` 需确认 | 开发模式，平衡效率和安全 |
| `expert` | 全部工具可用，无需确认 | 专家模式，全权委托 |
| `ultimate` | 全部工具可用，无需确认；**无任何限制** | 终极模式，完全自主 |

**实现方式**：
- RACER 在 dispatch 时把 `permissionMode` 传给 Java
- Java 侧 `ToolCallingAdvisor` 根据当前 `permissionMode` 过滤可用工具
- `normal` 模式下 `write_file` / `execute_cmd` 执行前发送 `tool_confirmation_request` 事件给 RACER，等前端确认后再执行
- `expert` / `ultimate` 模式下直接执行，不等待确认

**工具安全黑名单（所有模式通用，除 ultimate 外）**：
- `rm -rf /`、`format`、`del /f /s /q C:\*` 等危险命令直接拒绝
- `execute_cmd` 工作目录锁定在 `workspaceFolder` 下
- 超时强制终止：20s 后 `Process.destroyForcibly()`
- 审计日志：每次工具调用都记录到 AuditAdvisor

### 17.5 流式输出顺序保证（接入现成前端）

前端已有 `SubTaskNode` 组件和 `ChatPanel.tsx` 的多 worker 分流显示，直接接入即可，无需新开发。

**接入方式**：
- 每个 `worker_chunk` 事件带 `workerIdx`，RACER 按 `dispatchId + workerIdx` 分组转发给前端
- winner（workerIdx=0）的 chunk 优先显示在主对话区
- 其他 worker 的 chunk 折叠到 `SubTaskNode` 子任务区域
- 前端 `useChatStore.ts` 已有 `phase1_worker_start` / `phase1_worker_done` 事件处理，直接复用
- `ChatPanel.tsx` 已有多 worker 渲染逻辑，不需要改动
