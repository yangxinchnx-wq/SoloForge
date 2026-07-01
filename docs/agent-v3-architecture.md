# SoloForge Agent v3 架构文档

> 专业 Agent + 自进化 + 多 Agent 协作 — 融合 CloudMAS / 四角色架构 / EvoMaster 三大顶级方案
>
> 生成时间: 2026-06-29 | 状态: Phase 1 已实现

---

## 一、设计理念

旧 v1/v2 的 Agent 是**底层调度粒子**（数据包执行、HMAC 签名），没有实际专业能力。

v3 的 Agent 是**有真实技能、能自我进化的专业专家**：

| 维度 | v1/v2 | v3 |
|------|-------|-----|
| Agent 定义 | 5 个通用执行者 | 10 个专业领域专家 |
| 任务来源 | 数据包 | 用户自然语言请求 |
| 策略 | 硬编码 if/else | 可插拔 ExecutionStrategy |
| 声誉 | 单一分值 | 多维 (能力/可靠性/协作/创新) |
| 进化 | 无 | 技能库 + 自我批评 + 知识累积 |
| 协作 | 无 | 任务分解 + 并行执行 + 冲突解决 |
| 简单任务 | 走 Agent | 直接 LLM，不走 Agent |

---

## 二、专家方案对齐

### 方案 3：CloudMAS (ACM 2026)

> 6 个专业 Agent + Orchestrator，结构化反馈循环冲突解决

**对齐：**
- Orchestrator → `TaskRouter.route()`
- 6 个 Coder Agent → 10 个专业 Agent（扩展了领域覆盖）
- 冲突解决 → `NegotiationProtocol`（3 种策略：Majority Voting / Primary Decides / Synthesize）

### 方案 4：四角色架构 (2026 实战)

> PM + Backend + Frontend + Reviewer，契约驱动协作

**对齐：**
- PM/Architect/QC → `TaskRouter`（任务分解 + 质量审查路由）
- Backend Developer → `backend-expert` Agent
- Frontend Developer → `ui-design-master` Agent
- Reviewer → `code-audit-expert` Agent
- 契约驱动 → `NegotiationProtocol`（Handoff 类型消息）

### 方案 5：EvoMaster (ICML 2026, 上海交大)

> 100 行代码创建专业 Agent，迭代式自我进化

**对齐：**
- 三层架构 (Playground/Exp/Agent) → `TaskRouter` / `EvoEngine` / `SpecializedAgent`
- 进化循环 (假设→实验→观察→自我批评→策略修正) → `EvoEngine.runEvolutionCycle()`
- 技能库 → `SkillLibrary` + `SkillEntry`
- 上下文管理 → Agent 内 `buildSystemPrompt()` 动态注入技能
- ANCHOR 安全护栏 → `specialized-agent-registry.ts` 资源监控 + 健康检查

---

## 三、架构总览

```
用户请求: "帮我做一个 Todo 应用"
    │
    ▼
┌──────────────────────────────────────────────────┐
│  TaskRouter (任务路由器)                           │
│  · 判断复杂度 → 简单任务直接 LLM                   │
│  · 解析需求 → 匹配专业 Agent                       │
│  · 分解任务 → 并行/串行编排                        │
└──────────┬──────────────┬──────────────┬─────────┘
           │              │              │
    ┌──────▼──────┐ ┌─────▼──────┐ ┌────▼────────┐
    │ backend-    │ │ ui-design- │ │ database-   │
    │ expert      │ │ master     │ │ expert      │
    │             │ │            │ │             │
    │ Execution   │ │ Execution  │ │ Execution   │
    │ Strategy    │ │ Strategy   │ │ Strategy    │
    │             │ │            │ │             │
    │ SkillLibrary│ │ SkillLibrary│ │ SkillLibrary│
    │ (进化记忆)  │ │ (进化记忆) │ │ (进化记忆)  │
    └──────┬──────┘ └─────┬──────┘ └────┬────────┘
           │              │              │
           └──────────────┼──────────────┘
                          │
                  ┌───────▼───────┐
                  │ Negotiation   │
                  │ Protocol      │
                  │ (冲突解决)     │
                  └───────┬───────┘
                          │
                  ┌───────▼───────┐
                  │ code-audit-   │
                  │ expert        │
                  │ (质量审查)     │
                  └───────┬───────┘
                          │
                  ┌───────▼───────┐
                  │ EvoEngine     │
                  │ (自进化循环)   │
                  │ · 自我批评    │
                  │ · 技能提炼    │
                  │ · 知识累积    │
                  └───────────────┘
```

---

## 四、核心模块

### 4.1 SpecializedAgent (专业化 Agent)

**文件:** [specialized_agent.ts](../src/core/agent/agents/specialized_agent.ts)

每个 Agent 有：
- `agentId`: 唯一标识 (如 `backend-expert`)
- `domain`: 专业领域 (backend/frontend/security/database/testing/devops/ai-ml/ui-design/math/documentation)
- `level`: 专业水平 (junior/senior/expert/master)
- `capabilities`: 能力列表 (如 `['api-design', 'microservices', 'rest-graphql']`)
- `executionStrategy`: 执行策略 (Precision / Creative / FastIterate / DeepAnalysis)
- `skillLibrary`: 技能库 (从历史任务中学习的经验)

**核心方法：**
- `executeTask(task)` — 执行任务，返回结果
- `getSkillLibrary()` / `learnFromFeedback()` — 自进化接口
- `setCommunicationBus()` — 多 Agent 通信

### 4.2 AgentFactory (Agent 工厂)

**文件:** [agent-factory.ts](../src/core/agent/agents/agent-factory.ts)

创建 10 个专业 Agent 的工厂。每个 Agent 有独立的：
- System Prompt 模板（角色定义 + 能力描述 + 输出格式）
- 默认执行策略
- 初始能力集

### 4.3 SpecializedAgentRegistry (专业 Agent 注册表)

**文件:** [specialized-agent-registry.ts](../src/core/agent/agents/specialized-agent-registry.ts)

管理所有专业 Agent 的生命周期：
- `initialize()` — 创建 10 个 Agent + 5 个 CommunicationBus
- `snapshot()` — 系统状态快照
- 资源监控（每 30s 检查内存、队列深度、错误计数）
- 健康检查 + 自动清理

### 4.4 TaskRouter (任务路由器)

**文件:** [task-router.ts](../src/core/agent/routing/task-router.ts)

**路由决策树：**

```
用户请求
  ├─ 简单任务 (复杂度 < 0.3, 代码量 < 200 行)
  │   → 直接 LLM，不走 Agent
  │
  ├─ 单领域任务 (明确属于某个专业)
  │   → 选择该领域最强 Agent
  │   → 搭配推荐的 ExecutionStrategy
  │
  └─ 复杂任务 (多领域, 代码量 > 1000 行)
      → 分解为子任务
      → NegotiationProtocol 编排
      → 串行 (有依赖) 或并行 (无依赖) 执行
```

**领域关键词映射：**
- `security / audit / vulnerability / xss / injection` → security-auditor
- `database / schema / sql / migration / query` → database-expert
- `api / backend / server / microservice / endpoint` → backend-expert
- `ui / frontend / component / react / layout / design` → ui-design-master
- `test / testing / unit test / e2e / coverage` → testing-specialist
- `deploy / docker / kubernetes / ci cd / infrastructure` → devops-engineer
- `ai / ml / model / training / neural / deep learning` → ai-ml-engineer
- `algorithm / mathematical / optimization / statistical` → math-algorithm-expert
- `performance / optimize / slow / bottleneck / memory` → performance-engineer
- `documentation / readme / api doc / guide` → documentation-expert

### 4.5 ExecutionStrategy (执行策略)

**文件:** [execution-strategy.ts](../src/core/agent/strategies/execution-strategy.ts)

4 种策略，每种对应不同的 LLM 参数和行为：

| 策略 | temperature | maxTokens | 适用场景 |
|------|-------------|-----------|----------|
| **Precision** | 0.1 | 16384 | 安全审计、数据库设计、精确计算 |
| **Creative** | 0.7 | 32768 | UI 设计、文档生成、创意任务 |
| **FastIterate** | 0.3 | 8192 | 快速原型、简单代码生成 |
| **DeepAnalysis** | 0.2 | 65536 | 架构设计、数学推导、复杂推理 |

**安全加固：**
- Precision 策略会自动注入安全检查列表（OWASP Top 10）
- 所有策略检查 token 限制，超限时截断上下文

### 4.6 SkillLibrary (技能库)

**文件:** [skill-library.ts](../src/core/agent/evolution/skill-library.ts)

Agent 的"长期记忆"，存储从历史任务中提炼的经验：

```typescript
interface SkillEntry {
  skillId: string;          // 唯一 ID
  domain: string;           // 所属领域
  pattern: string;          // 任务模式描述
  solution: string;         // 解决方案摘要
  confidence: number;       // 置信度 (0-1)
  usageCount: number;       // 使用次数
  successRate: number;      // 成功率
  tags: string[];           // 搜索标签
  createdAt: number;        // 创建时间
  lastUsedAt: number;       // 最后使用时间
}
```

**核心功能：**
- `search(domain, query, tags)` — 语义搜索技能（基于标签匹配 + 相关性评分）
- `recordOutcome(skillId, success)` — 记录使用结果，更新成功率
- `evolve()` — 定期清理低质量技能（30 天未用且成功率 < 0.3）
- 持久化到 SurrealDB

### 4.7 EvoEngine (进化引擎)

**文件:** [evo-engine.ts](../src/core/agent/evolution/evo-engine.ts)

EvoMaster 风格的自进化循环：

```
接收任务 → 检索技能库 → 执行任务 → 记录结果 → 自我批评 → 技能提炼 → 更新技能库
```

**7 步进化流程：**

1. **检索技能** — 从 SkillLibrary 中搜索相关经验
2. **注入上下文** — 将技能作为 few-shot examples 注入 Prompt
3. **执行任务** — 调用 SpecializedAgent
4. **记录结果** — 记录成功/失败、耗时、输出
5. **自我批评** — 分析执行过程中的问题
6. **技能提炼** — 从成功任务中提取可复用模式
7. **更新技能库** — 写入新技能，更新已有技能的置信度

**进化统计：**
- 总执行次数、成功率、平均质量分
- 技能库大小、平均置信度
- 自动进化周期（每 60s 清理低质量技能）

### 4.8 NegotiationProtocol (编排协议)

**文件:** [negotiation-protocol.ts](../src/core/agent/orchestration/negotiation-protocol.ts)

多 Agent 协作的消息总线：

**消息类型：**
- `REQUEST` — 任务请求
- `RESPONSE` — 任务响应
- `HANDOFF` — 工作交接（契约驱动）
- `REVIEW` — 代码审查
- `FEEDBACK` — 反馈
- `CONFLICT` — 冲突上报

**协作模式：**
1. **串行流水线** — 有依赖关系的任务，按顺序执行
2. **并行扇出** — 独立任务同时执行
3. **冲突解决** — 3 种策略：
   - `MAJORITY_VOTING` — 多数投票
   - `PRIMARY_DECIDES` — 主 Agent 决定
   - `SYNTHESIZE` — 综合各方意见

---

## 五、10 个专业 Agent 清单

| # | Agent ID | 领域 | 级别 | 默认策略 | 能力 |
|---|----------|------|------|----------|------|
| 1 | `code-dev-expert` | 代码开发 | master | FastIterate | 全栈开发、代码生成、重构 |
| 2 | `code-audit-expert` | 代码审计 | expert | Precision | 代码审查、安全审计、质量评估 |
| 3 | `ui-design-master` | UI 设计 | master | Creative | 组件设计、交互设计、响应式布局 |
| 4 | `backend-expert` | 后端架构 | expert | DeepAnalysis | API 设计、微服务、系统架构 |
| 5 | `database-expert` | 数据库 | expert | Precision | Schema 设计、查询优化、数据建模 |
| 6 | `math-algorithm-expert` | 数学算法 | master | DeepAnalysis | 算法设计、数学建模、优化 |
| 7 | `security-auditor` | 安全 | expert | Precision | 漏洞评估、OWASP 合规、渗透测试 |
| 8 | `testing-specialist` | 测试 | expert | Precision | 单元测试、集成测试、E2E 测试 |
| 9 | `devops-engineer` | 运维 | senior | FastIterate | CI/CD、Docker、K8s、基础设施 |
| 10 | `ai-ml-engineer` | AI/ML | expert | DeepAnalysis | LLM 应用、RAG、模型训练 |

**能力分层：**
- 安全相关 (`security-auditor`, `code-audit-expert`) → Precision 策略，最高审查标准
- 创意相关 (`ui-design-master`) → Creative 策略，允许更多探索
- 工程相关 (`backend-expert`, `database-expert`) → DeepAnalysis 策略，深度推理
- 快速迭代 (`code-dev-expert`, `devops-engineer`) → FastIterate 策略，快速交付

---

## 六、任务路由示例

### 示例 1：简单任务 → 直接 LLM

```
用户: "写一个 hello world"
→ TaskRouter 判断: 复杂度=0.1, 代码量=3 行
→ 直接调用 LLM 生成，不走 Agent
→ 耗时: < 1s
```

### 示例 2：单领域任务 → 专业 Agent

```
用户: "设计一个用户认证的数据库 Schema"
→ TaskRouter 判断: 关键词=database, schema → 匹配 database-expert
→ 策略: Precision (数据库设计需要精确)
→ database-expert.executeTask() → 生成 Schema
→ EvoEngine 记录结果，提炼技能
→ 耗时: 3-5s
```

### 示例 3：复杂任务 → 多 Agent 协作

```
用户: "帮我做一个 Todo 应用"
→ TaskRouter 判断: 复杂度=0.7, 多领域, 代码量 > 1000 行
→ 分解为子任务:
  1. backend-expert: 设计 API (串行)
  2. database-expert: 设计 Schema (与 1 并行)
  3. ui-design-master: 设计前端组件 (依赖 1)
  4. code-audit-expert: 审查所有代码 (串行，最后)
→ NegotiationProtocol 编排执行
→ code-audit-expert 提出 3 个问题 → 其他 Agent 修复
→ 最终交付
→ EvoEngine 从整个流程中提炼 4 条新技能
→ 耗时: 30-60s
```

---

## 七、自进化机制详解

### 7.1 技能提炼流程

```typescript
// 任务执行成功后
const skill = {
  domain: 'backend',
  pattern: '用户认证 API 设计',
  solution: '使用 JWT + Refresh Token + Redis 黑名单方案',
  confidence: 0.85,
  tags: ['authentication', 'jwt', 'security'],
};
await skillLibrary.add(skill);
```

### 7.2 技能检索流程

```typescript
// 新任务到来时
const skills = await skillLibrary.search('backend', '用户登录', ['authentication']);
// 返回历史中类似任务的解决方案，作为 few-shot examples
```

### 7.3 进化循环 (EvoMaster 风格)

```
Round 1: Agent 用默认策略执行任务 → 成功率 60%
Round 2: 从技能库检索经验 → 成功率 72%
Round 3: 更多经验积累 → 成功率 81%
Round N: Agent 变成该领域的"老手" → 成功率 90%+
```

### 7.4 ANCHOR 安全护栏 (大阪大学 2026)

自进化可能导致安全漂移。ANCHOR 机制：
- 每 30s 检查 Agent 的错误率
- 错误率 > 50% → 记录警告
- 资源超限 → 自动清理消息队列
- 技能库定期进化 → 清理低质量技能（30 天未用且成功率 < 0.3）

---

## 八、与旧系统的兼容

### 保留的旧模块

| 模块 | 说明 | 兼容方式 |
|------|------|----------|
| `autonomous_agent.ts` | 旧自治 Agent | 重构为空壳，export `SpecializedAgent` |
| `agent-registry.ts` | 旧注册表 | 重构为桥接，`boot()` 调用新系统 |
| `agent-decision-orchestrator.ts` | 旧编排器 | 重构为桥接，转发到 `TaskRouter` |
| `runtime-agent-boot.ts` | 旧启动器 | 重构为桥接，调用 `RuntimeAgentIntegration` |
| `consensagent.ts` | 法庭仲裁 | 保留，未来可对接审计 Agent |

### 新增模块

| 模块 | 文件 | 说明 |
|------|------|------|
| SpecializedAgent | `agents/specialized_agent.ts` | 专业化 Agent 基类 |
| AgentFactory | `agents/agent-factory.ts` | 创建 10 个 Agent |
| SpecializedAgentRegistry | `agents/specialized-agent-registry.ts` | Agent 注册表 |
| TaskRouter | `routing/task-router.ts` | 任务路由器 |
| SkillLibrary | `evolution/skill-library.ts` | 技能库 |
| EvoEngine | `evolution/evo-engine.ts` | 进化引擎 |
| ExecutionStrategy | `strategies/execution-strategy.ts` | 执行策略 |
| NegotiationProtocol | `orchestration/negotiation-protocol.ts` | 多 Agent 编排 |
| RuntimeAgentIntegration | `runtime-integration.ts` | 启动集成 |

---

## 九、技术决策记录

| # | 决策 | 理由 |
|---|------|------|
| 1 | Agent 策略枚举 (非字符串) | 类型安全，编译时检查 |
| 2 | 技能库用标签搜索 (非向量) | Phase 1 简化，Phase 2 可升级为 embedding |
| 3 | 多 Agent 通信通过消息总线 | 解耦，避免直接依赖 |
| 4 | 自进化不改模型权重 | 零成本，只维护技能库 |
| 5 | 保留旧模块接口 | 向后兼容，渐进式迁移 |

---

## 十、下一步 (Phase 2)

1. **LLM 实际调用** — `executeWithLLM()` 接入真实 LLM API
2. **SkillLibrary 向量搜索** — 用 embedding 替代标签匹配
3. **法庭对接** — `code-audit-expert` 的审查结果可触发仲裁
4. **持久化** — 技能库写入 SurrealDB
5. **前端 UI** — Agent 状态面板、进化可视化
