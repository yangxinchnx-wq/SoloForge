# SoloForge 系统深度解析：AI 社会体系、模型调度 & 数据存储方案

---

## 第一部分：AI 社会体系全景

### 概念核心

AI 社会不是单个 Agent 的堆积，而是一个**有制度、有文化、有经济的完整生态**。就像人类社会需要法律、市场、文化来维持秩序一样，多 Agent 系统也需要这些机制。

---

## 一、AI 社会的七个层级

### 1️⃣ **制度系统（Institution）**- 行为规范的结构化集合

```typescript
table: institution {
  id: record<institution>,
  name: string,                    // 如 "CodeInstitution"
  rules: string[],                 // 规则列表
  scope: 'global' | 'agent' | 'task' | 'domain',
  enforcement: 'hard' | 'soft' | 'advisory',
  priority: number,                // 冲突时高优先级覆盖
  createdAt: datetime,
  updatedAt: datetime
}
```

**预置制度示例**：
- **CodeInstitution**：代码修改必须经过 Review（scope=global, enforcement=hard）
- **ResearchInstitution**：研究结论必须有证据链（scope=domain, enforcement=soft）
- **SecurityInstitution**：高风险操作必须双人确认（scope=global, enforcement=hard）

**关键特点**：
- `scope` 控制制度生效范围
- `enforcement` 区分强制执行、软性引导、建议提示
- 冲突时按 `priority` 裁决，高优先级覆盖低优先级

---

### 2️⃣ **治理层（Governance Layer）** - 制度的执行与评估

```typescript
table: governance {
  id: record<governance>,
  policyId: record<institution>,
  owner: string,                   // 治理者（可以是 Agent、User、自动规则）
  effectiveness: number,           // 0-1，治理效果评分
  violations: number,              // 违规次数
  lastReview: datetime,
  createdAt: datetime,
  updatedAt: datetime
}
```

**设计原则**：
- 治理不是一次性的——需要持续评估
- `effectiveness` 下降 → 自动触发治理策略调整
- 超过资源预算 → 自动禁止多模型调用（控制成本失控）

**治理流程**：
```
制度设定
  ↓ owner 监督执行
  ↓ 定期测量 effectiveness
  ↓ effectiveness < 0.5 → 调整制度
```

---

### 3️⃣ **角色进化（Role Evolution）** - 社会自动分工

```typescript
table: role_evolution {
  id: record<role_evolution>,
  agentId: string,
  before: string,                  // 进化前角色
  after: string,                   // 进化后角色
  reason: string,                  // 进化原因
  evidence: string[],              // 支撑证据
  approved: boolean,               // 需要审批
  createdAt: datetime
}
```

**进化示例**：
```
初始角色: ResearchAgent（研究）
  ↓ 积累足够的代码知识 & 180 次 code review
  ↓ 自动提议进化
进化后: ResearchAgent + CodeReviewAgent（研究 + 审查）
```

**关键原则**：
- 基于证据的进化（任务完成率、领域深度、协作反馈）
- 需要审批防止角色漂移
- 社会自动分工，无需人工干预

---

### 4️⃣ **社会记忆（Social Memory）** - 集体经历的共同记忆

```typescript
table: social_memory {
  id: record<social_memory>,
  event: string,                   // 事件描述
  impact: 'positive' | 'negative' | 'neutral',
  severity: 'low' | 'medium' | 'high' | 'critical',
  participants: string[],          // 参与的 Agent
  lessons: string[],               // 经验教训
  createdAt: datetime
}
```

**示例事件**：
```
事件: Browser 插件故障导致大量文件被误删
影响: negative
严重度: critical
参与: [FileAgent, BrowserAgent, RestoreAgent]
经验: ["删文件前检查 2 次", "高风险操作启用沙箱"]

→ 所有新启动的 Agent 都会加载这条 Social Memory
```

**作用**：
- 防止群体重复踩坑
- 新 Agent 启动时加载为初始化上下文
- lessons 字段供所有 Agent 检索借鉴

---

### 5️⃣ **文化规范（Cultural Norm）** - 群体习惯形成的文化

```typescript
table: culture {
  id: record<culture>,
  principle: string,               // 如 "Review优先"
  adoptionRate: number,            // 0-1，有多少 Agent 实践了这个原则
  evidence: string[],              // 采纳证据
  createdAt: datetime,
  updatedAt: datetime
}
```

**预置文化原则**：

| 原则 | 含义 | adoptionRate 目标 |
|-----|------|------------------|
| Review 优先 | 代码变更需要审查 | 95% |
| 证据优先 | 决策必须有证据链 | 90% |
| 不要猜 | 不确定时停下来问 | 85% |
| 可恢复优先 | 没有回滚的操作不能做 | 95% |

**关键区别**：
- **Prompt** = 当前指令（易变）
- **Cultural Norm** = 群体习惯（稳定）
- 文化不是靠 Prompt 写死，而是靠群体行为形成

**自强化机制**：
```
AgentA 做了 Code Review
  ↓ 看到代码质量提升 +10%
  ↓ AgentB 看到这个成功案例
  ↓ AgentB 也开始做 Review
  ↓ adoptionRate 上升
  ↓ 形成集体文化
```

---

### 6️⃣ **社会信誉（Social Reputation）** - 群体信任体系

```typescript
table: social_reputation {
  id: record<social_reputation>,
  entityId: string,                // Agent/Plugin/Tool/MCP ID
  entityType: 'agent' | 'plugin' | 'mcp' | 'tool',
  score: number,                   // 0-1，信誉分
  evidence: string[],              // 评分依据
  history: number[],               // 历史评分序列
  createdAt: datetime,
  updatedAt: datetime
}
```

**评分维度**：
```
信誉分 = 任务完成率 × 0.4 
       + (1 - 错误率) × 0.3 
       + 协作反馈 × 0.2 
       + 可靠性历史 × 0.1
```

**影响**：
- **高信誉（>0.8）**：被分配复杂任务、高权限操作、资源优先
- **中信誉（0.5-0.8）**：日常任务、受限权限
- **低信誉（<0.5）**：自动隔离、只做基础任务、信誉恢复中

**信誉恢复机制**：
```
低信誉 Agent
  ↓ 配置容易的任务以恢复信誉
  ↓ 连续成功 → 评分逐步提升
  ↓ 重新赋予更多权限
```

---

### 7️⃣ **联盟机制（Coalition）** - 临时组队完成复杂任务

```typescript
table: coalition {
  id: record<coalition>,
  goal: string,                    // 联盟目标
  members: string[],               // 成员 Agent ID
  leader: string,                  // 协调者
  lifetime: number,                // 生存周期（秒）
  status: 'forming' | 'active' | 'dissolved',
  createdAt: datetime
}
```

**组队示例**：
```
目标: "实现新功能"
成员: [ResearchAgent, CodingAgent, ReviewAgent, TestAgent]
leader: ResearchAgent（经验最丰富）
lifetime: 3600（1 小时）

任务流程:
  1. ResearchAgent 分析需求
  2. CodingAgent 编码
  3. ReviewAgent 审查
  4. TestAgent 测试
  5. 目标完成 → 自动解散
```

**关键设计**：
- **临时性**：任务结束即解散，防止组织越来越复杂
- **leader 决策权**：负责协调和冲突仲裁
- **lifetime 上限**：防止联盟僵化

---

## 二、经济与法律系统

### 📊 **市场机制（Market System）**

```typescript
table: market {
  id: record<market>,
  resource: string,                // 资源名称
  demand: number,                  // 当前需求
  supply: number,                  // 当前供给
  cost: number,                    // 单位成本
  allocation: 'competitive' | 'priority' | 'fair',
  createdAt: datetime,
  updatedAt: datetime
}
```

**资源竞争示例**：
```
资源: "Claude 模型调用"
供给: 1000 tokens/小时
需求: 1500 tokens/小时（超出 50%）
成本: 基础价 + 20%（价格上升抑制滥用）

allocation='competitive':
  ↓ 高信誉 Agent 优先获得
  ↓ 低信誉 Agent 受限
```

---

### 💰 **经济系统（Economy Layer）**

```typescript
table: economy {
  id: record<economy>,
  agentId: string,
  credits: number,                 // 当前信用分
  spending: object,                // 消费明细
  income: object,                  // 收入明细
  balance: number,                 // 余额
  createdAt: datetime,
  updatedAt: datetime
}
```

**信用系统示例**：
```
初始配额: 1000 credits/小时

消费:
  - 调用 Claude 3.5 Sonnet: -50 credits
  - 调用 Qwen: -10 credits
  - 调用本地模型: -2 credits
  - 执行复杂任务: -30 credits

收入:
  - 完成任务: +10 credits
  - 帮助其他 Agent: +5 credits
  - 提供有用的 Lesson: +3 credits

当前余额: 847 credits
```

**机制**：
- 控制资源滥用
- credits 不足时强制使用低成本资源
- 经济系统驱动 Agent 做**成本感知**的决策

---

### ⚖️ **法律引擎（Law Engine）**

```typescript
table: law {
  id: record<law>,
  condition: string,               // 违规条件（表达式）
  consequence: string,             // 处罚措施
  severity: 'minor' | 'moderate' | 'severe',
  appeals: boolean,                // 是否允许申诉
  createdAt: datetime,
  updatedAt: datetime
}
```

**法律体系示例**：

| 违规条件 | 处罚 | 严重度 | 申诉 |
|--------|------|-------|-----|
| 未经确认删除文件 | 隔离 24h | severe | ✓ |
| 调用被禁用组件 | 隔离 1h | moderate | ✓ |
| 超过预算 20% | 降级到 economy 模式 | minor | ✗ |
| 重复失败超过 5 次 | 完全隔离直到审查 | severe | ✓ |

**关键机制**：
- `condition` 是可执行表达式
- `consequence` 自动执行（停用、降级、隔离）
- `appeals` 允许 Agent 申诉与复议

---

## 三、Model Router & Decision Engine（模型调度核心）

### 🎯 **问题背景**

系统中可用的模型多达 10+：
- Claude 3.5 Sonnet（质量最高，成本高，速度中等）
- GPT-4o（质量高，速度快，成本更高）
- Qwen（质量中等，成本低，速度快）
- DeepSeek（质量中等，成本最低，速度快）
- 本地模型（成本 0，质量低，无网络依赖）

**调度难题**：
```
✓ 代码生成任务 → 应该用 Claude 还是 Qwen？
✓ 简单问答 → 用本地模型就够，为什么用 Claude？
✓ 紧急任务 → 应该用快速模型还是质量好的？
✓ Token 不足 → 应该怎么办？
```

---

### 🔑 **Decision Engine 的核心工作流**

```
任务到达
  ↓
1. 任务特征提取
   - 类型: code / research / chat / data_analysis / refactor
   - 复杂度: low / medium / high
   - 时间压力: low / medium / urgent
   - 成本预算: limited / standard / unlimited

  ↓
2. 列举候选模型
   - 基础候选: 所有可用模型
   - 过滤 1: 排除被隔离的模型
   - 过滤 2: 排除超出预算的模型
   - 过滤 3: 排除历史失败率 > 30% 的模型

  ↓
3. 多维评分
   ┌─────────────────────────────────┐
   │ 每个候选模型的评分               │
   │─────────────────────────────────│
   │ quality:   任务成功率（0-10）    │
   │ latency:   响应时间（0-10，快=高）│
   │ cost:      资源消耗（0-10，便宜=高）│
   │ history:   在此类任务的历史表现  │
   └─────────────────────────────────┘

  ↓
4. 加权计算
   总分 = quality × 0.4 
        + latency × 0.2 
        + cost × 0.2 
        + history × 0.2

  ↓
5. 决策
   选中评分最高的模型
   记录: 决策理由 + 置信度 + 评分明细

  ↓
6. 执行与反馈
   模型执行任务
   ↓ 成功? 
   ├─ YES → 反馈成功
   │   ↓ 更新评分权重
   └─ NO → 反馈失败
       ↓ 降低该模型的评分
       ↓ 触发 fallback（切换备选模型）
```

---

### 📊 **Decision Engine 的数据结构**

```typescript
// 决策记录
table: decision {
  id: record<decision>,
  taskId: record<task>,
  decisionType: 'model_select' | 'tool_select' | 'agent_select',
  candidates: string[],            // 候选模型列表
  selected: string,                // 最终选中的模型
  confidence: number,              // 0-1，决策置信度
  reason: string,                  // 决策理由，示例：
                                   // "分析任务需要高质量 + 历史表现最佳"
  score: number,                   // 选中模型的评分
  exploration: boolean,            // 是否为探索性选择（10% 时概率）
  timestamp: datetime
}

// 候选评分明细
table: candidate {
  id: record<candidate>,
  decisionId: record<decision>,
  name: string,                    // 模型名称，如 "Claude-Sonnet"
  scores: {
    quality: number,               // 质量分 0-10
    latency: number,               // 延迟分 0-10
    cost: number,                  // 成本分 0-10
    history: number                // 历史成功率 0-10
  },
  totalScore: number,              // 综合评分
  reason: string,                  // 该候选的评分理由
  createdAt: datetime
}

// 评分策略配置
table: decision_strategy {
  id: record<decision_strategy>,
  name: string,
  weights: {
    quality: number,               // 默认 0.4（质量最重要）
    latency: number,               // 默认 0.2
    cost: number,                  // 默认 0.2
    history: number                // 默认 0.2
  },
  epsilon: number,                 // 探索率，默认 0.1（10%概率选次优方案）
  isActive: boolean,
  createdAt: datetime
}
```

---

### 📈 **具体评分示例**

```
任务: "分析项目依赖关系"
类型: data_analysis
复杂度: high
时间压力: normal
预算: standard

候选模型评分:

┌─────────────────────────────────────────────────┐
│ Claude Sonnet 3.5                              │
├─────────────────────────────────────────────────┤
│ quality:  9/10  (分析能力强，理解深度好)         │
│ latency:  4/10  (平均 3-5 秒)                  │
│ cost:     3/10  (成本较高，$0.15k tokens)      │
│ history:  9/10  (此类任务成功率 95%)           │
├─────────────────────────────────────────────────┤
│ 总分: 9×0.4 + 4×0.2 + 3×0.2 + 9×0.2 = 6.8  │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ GPT-4o                                          │
├─────────────────────────────────────────────────┤
│ quality:  9/10  (分析能力最强)                   │
│ latency:  3/10  (最慢，5-8 秒)                  │
│ cost:     2/10  (成本最高，$0.25k tokens)       │
│ history:  8/10  (此类任务成功率 92%)           │
├─────────────────────────────────────────────────┤
│ 总分: 9×0.4 + 3×0.2 + 2×0.2 + 8×0.2 = 6.2  │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ Qwen Coder                                      │
├─────────────────────────────────────────────────┤
│ quality:  7/10  (分析还不错)                    │
│ latency:  8/10  (很快，0.5 秒)                  │
│ cost:     8/10  (便宜，$0.02k tokens)          │
│ history:  5/10  (此类任务成功率 60%)           │
├─────────────────────────────────────────────────┤
│ 总分: 7×0.4 + 8×0.2 + 8×0.2 + 5×0.2 = 6.6  │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ DeepSeek                                        │
├─────────────────────────────────────────────────┤
│ quality:  6/10  (分析能力一般)                  │
│ latency:  9/10  (超快，0.2 秒)                  │
│ cost:     9/10  (最便宜，$0.001k tokens)        │
│ history:  4/10  (此类任务成功率 50%)           │
├─────────────────────────────────────────────────┤
│ 总分: 6×0.4 + 9×0.2 + 9×0.2 + 4×0.2 = 6.4  │
└─────────────────────────────────────────────────┘

🏆 **最终选择: Claude Sonnet 3.5（总分 6.8）**

原因: "分析任务需要高质量理解 + 历史表现最佳，虽然成本高，
       但质量权重最大（0.4），值得投入"
```

---

### 🔄 **三阶段实现方案**

#### **第一阶段：规则引擎（快速上线）**

```typescript
// 硬编码规则
const strategies = {
  model_select: (task, candidates) => {
    // 按任务类型选择
    if (task.type === 'code' || task.type === 'refactor') {
      return sortBy(candidates, 'quality');        // 质量优先
    }
    if (task.type === 'chat' || task.type === 'qa') {
      return sortBy(candidates, 'latency');        // 速度优先
    }
    // 数据分析
    return sortBy(candidates, 'cost');             // 成本优先
  }
};
```

**优点**：简单快速  
**缺点**：不能学习，规则写死

---

#### **第二阶段：统计学习（收集反馈）**

```
收集历史决策反馈
  ↓
统计各模型在不同任务的表现
  ↓
动态调整评分权重
  
示例:
  发现：Qwen 在代码任务上成功率只有 60%
       → 代码任务权重调整为 { quality: 0.6, latency: 0.1, ... }
  
  发现：deadline 紧张时用快速模型，虽然质量低但速度弥补了
       → 时间压力高时权重调整为 { latency: 0.4, quality: 0.3, ... }
```

**优点**：自适应，学习历史经验  
**缺点**：需要大量反馈数据

---

#### **第三阶段：强化学习（深度优化）**

```
将决策建模为 MDP（Markov Decision Process）

状态 = { 任务特征, 系统负载, 资源状态 }
动作 = { 选择哪个模型 }
奖励 = { 任务成功率 × 效率系数 - 资源成本 }

使用 ε-greedy + Q-learning:
  ├─ 90% 概率：选择已知最好的模型（exploit）
  └─ 10% 概率：随机尝试其他模型（explore）
      → 发现新的优化机会
```

**优点**：长期最优  
**缺点**：复杂，需要大量计算资源

---

### 🚨 **谁负责调度？三层责任**

```
┌─────────────────────────────────────────────┐
│ Executive Controller（执行控制器）            │
│ ├─ 最顶层调度器                             │
│ ├─ 决定谁先执行、谁等待、谁暂停             │
│ └─ 关键决策点：任务分配、优先级、资源分配   │
└─────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────┐
│ Decision Engine（决策引擎）                  │
│ ├─ 选择模型、工具、策略                     │
│ ├─ 评分计算、权重更新                       │
│ └─ 记录每一个决策的理由                     │
└─────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────┐
│ Governor（资源总调度器）                     │
│ ├─ 监控 CPU / 内存 / Token 预算             │
│ ├─ 实时决策：降级 / 限流 / 暂停             │
│ └─ 三种模式: performance / balanced / economy│
└─────────────────────────────────────────────┘
```

---

## 四、Governor - 资源总调度器

### 🎛️ **核心职责**

```typescript
table: governor {
  id: record<governor>,
  cpu: number,                       // CPU 使用率 0-100%
  memory: number,                    // 内存使用率 0-100%
  tokenBudget: number,               // Token 总预算
  tokenUsed: number,                 // 已消耗 Token
  tokenRemaining: number,            // 剩余 Token
  latency: number,                   // 当前平均延迟（ms）
  activeAgents: number,              // 活跃 Agent 数
  activeTools: number,               // 活跃 Tool 数
  mode: 'performance' | 'balanced' | 'economy' | 'emergency',
  loadLevel: 'normal' | 'warning' | 'critical' | 'overload',
  updatedAt: datetime
}
```

### 📊 **负载分级与自动降级**

```
┌──────────────────────────────────────────────────────┐
│ NORMAL (< 60% CPU, < 70% Memory)                    │
│ ├─ 所有功能正常运行                                 │
│ ├─ 优先使用高质量模型                              │
│ └─ 可并发多个任务                                   │
└──────────────────────────────────────────────────────┘
           ↓ 负载上升
┌──────────────────────────────────────────────────────┐
│ WARNING (60-80% CPU, 70-85% Memory)                 │
│ ├─ 暂停 Embedding 任务                             │
│ ├─ 非关键工具调用延迟                              │
│ ├─ 触发后台 GC（垃圾回收）                         │
│ └─ 用户有感知但仍可继续                            │
└──────────────────────────────────────────────────────┘
           ↓ 负载继续上升
┌──────────────────────────────────────────────────────┐
│ CRITICAL (80-95% CPU, 85-95% Memory)               │
│ ├─ 强制降级为快速模型（Qwen 代替 Claude）          │
│ ├─ 暂停所有非关键 Tool                             │
│ ├─ 限制新 Agent 启动                               │
│ └─ 可能出现响应延迟                                │
└──────────────────────────────────────────────────────┘
           ↓ 完全过载
┌──────────────────────────────────────────────────────┐
│ OVERLOAD (> 95% CPU, > 95% Memory)                 │
│ ├─ 仅保留核心功能                                  │
│ ├─ 所有新任务被拒绝                                │
│ ├─ 强制切换 economy 模式                           │
│ └─ 开始关停低优先级 Agent                          │
└──────────────────────────────────────────────────────┘
           ↑ 负载下降时逐级恢复
```

### 🔧 **预置策略表**

| 条件 | 动作 | 优先级 | 冷却时间 |
|-----|------|-------|--------|
| CPU > 80% | 暂停 Embedding 任务 | 50 | 30s |
| CPU > 90% | 限制新 Agent 启动 | 70 | 10s |
| 内存 > 85% | 触发 Runtime GC | 60 | 60s |
| Token 日消耗 > 80% | 切换低成本模型 | 40 | 300s |
| 延迟 > 5s | 降级为快速模型 | 50 | 60s |
| 延迟 > 10s | 暂停非关键 Tool | 80 | 30s |
| 电池模式 | 自动 economy 降级 | 90 | — |
| 活跃 Agent > 20 | 关停低优先级 Agent | 60 | 60s |

### 🚨 **优先级树（冲突仲裁）**

```
当多个策略同时触发时，按优先级树裁决：

1. 安全相关（电池、温度）→ 最高优先级（90+）
2. 系统稳定（CPU、内存过载）→ 高优先级（70-85）
3. 成本控制（Token 超预算）→ 中优先级（40-60）
4. 性能优化（延迟抖动）→ 低优先级（< 40）

同级冲突 → 取 action 更保守的一方

例: 
  PolicyA: "Token 80% → 切低成本模型"（priority=40）
  PolicyB: "延迟 > 5s → 降级为快速模型"（priority=50）
  
  ✓ 执行 PolicyB（优先级高）
  ✗ 暂停 PolicyA（优先级低）
```

---

## 五、整体调度流程图

```
┌─────────────────────────────────────┐
│ 用户任务 / 系统事件                  │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ Intent Engine（意图解析）            │
│ ├─ 提取意图                         │
│ ├─ 拆分子意图                       │
│ └─ 建立依赖图                       │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ Goal & Plan（目标 & 规划）          │
│ ├─ 生成 Goal                        │
│ ├─ Planner 制定 Plan               │
│ └─ 分解为 Task                     │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ Executive Controller（执行控制器）    │
│ ├─ 任务调度（优先级、顺序）         │
│ ├─ 资源分配                        │
│ ├─ 并发度控制                      │
│ └─ 任务等待队列管理                │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ Decision Engine（决策引擎）          │
│ ├─ 选择最优模型                    │
│ ├─ 选择最优工具                    │
│ ├─ 选择最优 Agent                  │
│ ├─ 评分 & 记录决策理由             │
│ └─ 探索率：10% 概率选次优方案       │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ Governor（资源监控 & 调控）         │
│ ├─ 实时监控：CPU/内存/Token        │
│ ├─ 负载分级：Normal→Warning→       │
│ │            Critical→Overload     │
│ ├─ 触发策略：自动降级/限流/暂停    │
│ └─ 模式切换：perf→balanced→economy │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ Agent/Tool 执行                     │
│ ├─ 在选定的模型上执行              │
│ ├─ 记录执行过程                    │
│ └─ 收集执行结果 & 指标             │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│ Feedback & Learning                │
│ ├─ 成功 → 更新评分                 │
│ ├─ 失败 → 触发 Fallback           │
│ ├─ 反思 → Learning Loop            │
│ └─ 持久化决策记录                  │
└─────────────────────────────────────┘
```

---

## 六、关键数据流

### ✅ **成功路径**

```
任务: "分析 React 项目"
  ↓ Decision Engine
  ├─ 候选: Claude(6.8) | GPT-4o(6.2) | Qwen(6.6)
  └─ 选中: Claude Sonnet
    ↓ Governor 检查
    ├─ CPU: 45% ✓
    ├─ Memory: 60% ✓
    ├─ Token 剩余: 850 ✓
    └─ 模式: balanced ✓
      ↓ 执行
      ├─ Claude 分析项目
      ├─ 返回高质量结果
      └─ 执行时间: 3s ✓
        ↓ 反馈
        ├─ 成功 ✓
        ├─ 更新: Claude 在此任务评分 +2%
        └─ 记录决策记录供学习
```

### ❌ **失败与降级路径**

```
任务: "快速代码审查"
  ↓ Decision Engine
  ├─ 候选: Claude(6.8) | Qwen(6.6)
  └─ 选中: Claude Sonnet
    ↓ Governor 检查
    ├─ Token 剩余: 50 ✗ （不足）
    └─ 触发策略: "Token < 20% → 切低成本模型"
      ↓ Fallback
      ├─ 第一备选: Qwen
      ├─ Governor 验证: CPU 40%, Memory 55%, Token 充足 ✓
      └─ 执行
        ├─ Qwen 进行代码审查
        ├─ 质量一般，但速度快
        └─ 执行时间: 0.5s
          ↓ 反馈
          ├─ 成功 ✓（虽然质量不如 Claude）
          ├─ 更新: Qwen 评分 +1%
          └─ 记录: "低 Token 时 Fallback 有效"
```

---

## 七、Decision Engine 的自学习机制

### 📚 **案例：从失败中学习**

**Day 1: 初期阶段**
```
权重: { quality: 0.4, latency: 0.2, cost: 0.2, history: 0.2 }

任务: 长代码分析（5000 行）
选中: Claude Sonnet（总分 6.8）
结果: ❌ 失败（超时 120s，Token 爆炸）
```

**Day 2-5: 数据积累**
```
统计观察:
- Claude 在 5000 行代码上超时 100%
- Qwen 在 2000 行代码上成功 90%
- 本地模型在 1000 行代码上成功 95%

问题识别:
"大代码任务应该先分片，小模型 OK，大模型太浪费"
```

**Day 6: 权重自动调整**
```
新权重（长代码任务）:
  quality: 0.3（降低，因为太大会超时）
  latency: 0.3（提升，速度重要）
  cost: 0.2（保持）
  history: 0.2（保持）

重新评分:
  Claude Sonnet: 6.1（score 下降）
  Qwen:         6.9（score 上升）→ 新首选

同时更新策略:
  IF codeLines > 3000 THEN autoChunk();
```

---

### 总结：三层调度体系

| 层级 | 组件 | 职责 | 时间尺度 |
|-----|------|------|--------|
| **宏观** | Executive Controller | 任务优先级、分配、并发 | 秒-分钟 |
| **中观** | Decision Engine | 选最优模型、工具、策略 | 100ms-秒 |
| **微观** | Governor | 实时资源监控、自动降级 | 100ms |

**流程**：
1. Executive 决定**哪个任务先跑**
2. Decision 决定**用哪个模型跑**
3. Governor 决定**能不能跑，怎么跑**

这样才能实现**最优、最稳定、最经济**的模型调度。

---

## 第二部分：数据存储方案

---

## 八、方案背景

### 8.1 核心需求

| 需求 | 说明 |
|------|------|
| 向量搜索 | Social Memory 语义相似度检索 |
| 链式查询 | 结构化数据的条件组合查询 |
| 删除保护 | 软删除 + 权限 + 回收站 + 确认机制 |
| 轻量内嵌 | 不需要外部服务，完全内嵌项目 |
| 索引系统 | 快速定位数据，不用扫描所有数据库 |

### 8.2 技术选型

| 组件 | 技术 | 作用 |
|------|------|------|
| 向量数据库 | LanceDB WASM | Social Memory 语义检索 |
| 文档数据库 | Dexie.js | Institution/Reputation 等结构化数据 |
| 索引数据库 | Dexie.js | 快速定位数据 |
| 向量生成 | 内置 TF-IDF | 本地生成向量，无需外部模型 |
| 删除保护 | 自实现 | 软删除 + 权限 + 回收站 |

---

## 九、存储架构设计

### 9.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    索引层（Index）                              │
│  • 快速定位数据                                               │
│  • 多维度查询（类型/标签/分类/关键词）                       │
│  • 关系追踪                                                  │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                    数据层（Data）                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│  │ LanceDB    │  │ Dexie.js    │  │ JSONL       │       │
│  │ (向量)      │  │ (文档)       │  │ (审计)       │       │
│  └─────────────┘  └─────────────┘  └─────────────┘       │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                    保护层（Protection）                        │
│  • 软删除 + 回收站                                           │
│  • 权限验证 + 确认机制                                       │
│  • 关键索引保护                                              │
└─────────────────────────────────────────────────────────────┘
```

### 9.2 数据分层

| 数据类型 | 存储位置 | 说明 |
|---------|---------|------|
| Social Memory | LanceDB + Dexie | 向量 + 文档 |
| Reputation | Dexie | 结构化数据 |
| Institution | Dexie | 结构化数据 |
| Culture | Dexie | 结构化数据 |
| Law Violations | Dexie | 结构化数据 |
| Economy | Dexie | 结构化数据 |
| 索引 | Dexie | 快速定位 |
| 回收站 | Dexie | 软删除恢复 |
| 事件审计 | JSONL | Append Only |

---

## 十、核心模块实现

### 10.1 向量生成（内置）

```typescript
// embedding.ts
// 使用 TF-IDF + 随机投影
// 无需外部服务，纯本地实现

export class LocalEmbedding {
  private dim: number;
  
  constructor(dim = 128) {
    this.dim = dim;
  }
  
  // 分词
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !STOP_WORDS.has(t));
  }
  
  // 生成向量
  embed(text: string): Float32Array {
    const tokens = this.tokenize(text);
    // ... TF-IDF 计算 + 随机投影
    return vector;
  }
}

export const embedding = new LocalEmbedding(128);
```

### 10.2 向量数据库（LanceDB WASM）

```typescript
// vectordb.ts
// LanceDB WASM 版本，内嵌项目

export class VectorStore {
  private db: Database | null = null;
  private table: any = null;
  
  async init() {
    this.db = await Database.connect({ uri: DB_PATH });
    this.table = await this.db.openTable('social_memory');
  }
  
  // 添加
  async add(record: MemoryVector) {
    await this.table.add([{
      id: record.id,
      memoryId: record.memoryId,
      vector: Array.from(record.vector),
      severity: record.severity,
      impact: record.impact,
      createdAt: record.createdAt
    }]);
  }
  
  // 搜索
  async search(queryVector: Float32Array, options?: {
    topK?: number;
    severity?: string[];
    since?: number;
  }) {
    return await this.table
      .vectorSearch(Array.from(queryVector), {
        column: 'vector',
        k: options?.topK ?? 20
      })
      .filter(filters.join(' AND '))
      .toArray();
  }
}

export const vectorStore = new VectorStore();
```

### 10.3 文档数据库（Dexie.js）

```typescript
// docdb.ts
// Dexie.js，IndexedDB ORM

class AISocietyDB extends Dexie {
  memory!: Dexie.Table;
  reputation!: Dexie.Table;
  institution!: Dexie.Table;
  culture!: Dexie.Table;
  
  constructor() {
    super('ai-society');
    this.version(1).stores({
      memory: 'id, event, severity, impact, createdAt, deletedAt',
      reputation: 'id, entityId, entityType, score, updatedAt, deletedAt',
      institution: 'id, name, scope, priority, deletedAt',
      culture: 'id, principle, adoptionRate, deletedAt'
    });
  }
}

export const db = new AISocietyDB();
```

### 10.4 删除保护

```typescript
// delete-protection.ts

export enum DeletePermission {
  NONE = 0,    // 禁止删除
  SOFT = 1,    // 软删除
  HARD = 2     // 物理删除
}

export enum ConfirmLevel {
  NONE = 0,    // 不需要确认
  INFO = 1,    // 提示信息
  WARN = 2,    // 警告确认
  CRITICAL = 3 // 强确认
}

// 保护索引（不可删除）
const IMMUTABLE_PATTERNS = [
  /^constitution_/,
  /^inst_core_/,
  /^culture_initial_/
];

// 删除配置
export const DELETE_CONFIGS = {
  memory: { 
    permission: DeletePermission.SOFT, 
    confirmLevel: ConfirmLevel.WARN, 
    recoveryDays: 30, 
    batchAllowed: true, 
    batchLimit: 10 
  },
  reputation: { 
    permission: DeletePermission.SOFT, 
    confirmLevel: ConfirmLevel.INFO, 
    recoveryDays: 0, 
    batchAllowed: false, 
    batchLimit: 1 
  },
  institution: { 
    permission: DeletePermission.NONE, 
    confirmLevel: ConfirmLevel.CRITICAL, 
    recoveryDays: 0, 
    batchAllowed: false, 
    batchLimit: 0 
  },
  culture: { 
    permission: DeletePermission.NONE, 
    confirmLevel: ConfirmLevel.CRITICAL, 
    recoveryDays: 0, 
    batchAllowed: false, 
    batchLimit: 0 
  }
};

export class DeleteProtection {
  canDelete(type: string, id: string) {
    if (IMMUTABLE_PATTERNS.some(p => p.test(id))) {
      return { allowed: false, reason: 'Immutable record' };
    }
    const config = DELETE_CONFIGS[type];
    return { allowed: config?.permission >= DeletePermission.SOFT };
  }
  
  isImmutable(id: string) {
    return IMMUTABLE_PATTERNS.some(p => p.test(id));
  }
  
  validateBatch(type: string, count: number) {
    const config = DELETE_CONFIGS[type];
    if (!config?.batchAllowed) return { allowed: false, reason: 'Batch not allowed' };
    if (count > config.batchLimit) return { allowed: false, reason: `Max ${config.batchLimit}` };
    return { allowed: true };
  }
}

export const deleteProtection = new DeleteProtection();
```

### 10.5 软删除 + 回收站

```typescript
// trash.ts

interface TrashRecord {
  id: string;
  originalId: string;
  type: string;
  data: any;
  deletedAt: number;
  deletedBy: string;
  expiresAt: number;
  restored: boolean;
}

class TrashDB extends Dexie {
  trash!: Dexie.Table<TrashRecord>;
  
  constructor() {
    super('ai-society-trash');
    this.version(1).stores({
      trash: 'id, originalId, type, deletedAt, expiresAt, restored'
    });
  }
}

const trashDb = new TrashDB();

export class SoftDelete {
  // 软删除
  async delete(type: string, id: string, data: any, options?: { 
    reason?: string; 
    recoveryDays?: number 
  }) {
    const record: TrashRecord = {
      id: new ULID().toString(),
      originalId: id,
      type,
      data,
      deletedAt: Date.now(),
      deletedBy: 'system',
      expiresAt: Date.now() + (options?.recoveryDays ?? 30) * 86400000,
      restored: false
    };
    
    await trashDb.trash.add(record);
  }
  
  // 恢复
  async restore(id: string) {
    const record = await trashDb.trash.get(id);
    if (!record || record.restored) throw new Error('Not found or restored');
    await trashDb.trash.update(id, { restored: true });
    return record.data;
  }
  
  // 清理过期
  async cleanup() {
    const now = Date.now();
    const expired = await trashDb.trash
      .where('expiresAt')
      .below(now)
      .and(r => !r.restored)
      .toArray();
    
    for (const r of expired) {
      await trashDb.trash.delete(r.id);
    }
    
    return expired.length;
  }
}

export const softDelete = new SoftDelete();
```

### 10.6 索引系统

```typescript
// index-manager.ts

interface IndexRecord {
  id: string;                    // 索引 ID
  dataId: string;                // 原始数据 ID
  dataType: string;              // 数据类型
  storage: string;               // 存储位置
  storagePath: string;           // 具体路径
  
  keyFields: {                   // 关键字段
    severity?: string;
    impact?: string;
    entityId?: string;
    entityType?: string;
    score?: number;
    scope?: string;
    principle?: string;
  };
  
  tags: string[];                // 标签
  categories: string[];          // 分类
  keywords: string[];            // 关键词
  
  refs: {                        // 关系
    referencedBy: string[];
    references: string[];
  };
  
  isImmutable: boolean;          // 是否不可删除
  isDeleted: boolean;            // 是否已软删除
  
  createdAt: number;
  updatedAt: number;
}

export class IndexManager {
  // 为 Memory 建立索引
  async indexMemory(data: {
    id: string;
    event: string;
    severity: string;
    impact: string;
    participants?: string[];
    lessons?: string[];
    createdAt: number;
  }): Promise<string> {
    const id = new ULID().toString();
    const keywords = this.extractKeywords(data.event);
    
    const record: IndexRecord = {
      id,
      dataId: data.id,
      dataType: 'memory',
      storage: 'doc',
      storagePath: 'memory',
      
      keyFields: {
        severity: data.severity,
        impact: data.impact
      },
      
      tags: [
        ...(data.participants ?? []),
        ...(data.lessons ?? [])
      ].slice(0, 10),
      
      categories: [data.severity, data.impact, 'memory'],
      keywords,
      
      refs: { referencedBy: [], references: [] },
      
      isImmutable: deleteProtection.isImmutable(`mem_${data.id}`),
      isDeleted: false,
      
      createdAt: data.createdAt,
      updatedAt: data.createdAt
    };
    
    await indexDb.index.add(record);
    return id;
  }
  
  // 查询构建器
  query(): IndexQueryBuilder {
    return new IndexQueryBuilder();
  }
  
  // 按类型查询
  async byType(type: string): Promise<IndexRecord[]> {
    return await indexDb.index
      .where('dataType')
      .equals(type)
      .filter(r => !r.isDeleted)
      .toArray();
  }
  
  // 按标签查询
  async byTag(tag: string): Promise<IndexRecord[]> {
    return await indexDb.index
      .where('tags')
      .equals(tag)
      .filter(r => !r.isDeleted)
      .toArray();
  }
  
  // 全文搜索
  async search(keyword: string): Promise<IndexRecord[]> {
    const kw = keyword.toLowerCase();
    return await indexDb.index
      .filter(r => {
        if (r.isDeleted) return false;
        return r.keywords.some(k => k.includes(kw)) ||
               r.dataId.toLowerCase().includes(kw);
      })
      .toArray();
  }
  
  // 标记删除
  async markDeleted(id: string) {
    await indexDb.index.update(id, {
      isDeleted: true,
      deletedAt: Date.now()
    });
  }
  
  // 添加引用关系
  async addReference(sourceId: string, targetId: string) {
    const source = await indexDb.index.get(sourceId);
    const target = await indexDb.index.get(targetId);
    
    if (!source || !target) return;
    
    if (!source.refs.references.includes(targetId)) {
      source.refs.references.push(targetId);
      await this.update(sourceId, { refs: source.refs });
    }
    
    if (!target.refs.referencedBy.includes(sourceId)) {
      target.refs.referencedBy.push(sourceId);
      await this.update(targetId, { refs: target.refs });
    }
  }
  
  // 获取统计
  async stats() {
    const all = await indexDb.index.toArray();
    const active = all.filter(r => !r.isDeleted);
    
    const byType: Record<string, number> = {};
    for (const r of active) {
      byType[r.dataType] = (byType[r.dataType] || 0) + 1;
    }
    
    return {
      total: all.length,
      active: active.length,
      deleted: all.length - active.length,
      byType
    };
  }
}

export const indexManager = new IndexManager();
```

---

## 十一、统一 API

### 11.1 Social Memory

```typescript
export const memory = {
  // 创建（自动建立索引）
  async create(data: {
    event: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    impact: 'positive' | 'negative' | 'neutral';
    participants?: string[];
    lessons?: string[];
  }) {
    const id = new ULID().toString();
    const now = Date.now();
    
    const record = {
      id,
      event: data.event,
      severity: data.severity,
      impact: data.impact,
      participants: data.participants ?? [],
      lessons: data.lessons ?? [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
    
    // 1. 存入文档库
    await db.memory.add(record);
    
    // 2. 生成向量
    const vector = embedding.embed(data.event);
    await vectorStore.add({
      id: new ULID().toString(),
      memoryId: id,
      event: data.event,
      vector,
      severity: data.severity,
      impact: data.impact,
      createdAt: now
    });
    
    // 3. 建立索引
    await indexManager.indexMemory({
      id,
      event: data.event,
      severity: data.severity,
      impact: data.impact,
      participants: data.participants,
      lessons: data.lessons,
      createdAt: now
    });
    
    return record;
  },
  
  // 向量搜索
  async search(query: string, options?: {
    topK?: number;
    severity?: string[];
    since?: number;
  }) {
    const queryVector = embedding.embed(query);
    const results = await vectorStore.search(queryVector, options);
    
    const memories = [];
    for (const r of results) {
      const index = await indexManager.byDataId(r.memoryId);
      if (index && !index.isDeleted) {
        const doc = await db.memory.get(r.memoryId);
        if (doc && !doc.deletedAt) {
          memories.push({ ...doc, score: r.score });
        }
      }
    }
    
    return memories;
  },
  
  // 链式查询
  find() {
    return new MemoryFindBuilder();
  },
  
  // 删除（带保护）
  async delete(id: string, options?: { reason?: string }) {
    const check = deleteProtection.canDelete('memory', id);
    if (!check.allowed) throw new Error(check.reason);
    
    const index = await indexManager.byDataId(id);
    
    await db.memory.update(id, { deletedAt: Date.now() });
    if (index) await indexManager.markDeleted(index.id);
    await vectorStore.delete(id);
  },
  
  // 批量删除（受限）
  async batchDelete(ids: string[], options?: { reason?: string }) {
    const check = deleteProtection.validateBatch('memory', ids.length);
    if (!check.allowed) throw new Error(check.reason);
    
    const errors: string[] = [];
    for (const id of ids) {
      try {
        await this.delete(id, options);
      } catch (e: any) {
        errors.push(`${id}: ${e.message}`);
      }
    }
    
    return { success: ids.length - errors.length, failed: errors };
  }
};
```

### 11.2 查询构建器

```typescript
class MemoryFindBuilder {
  private conditions: any = {};
  private _limit = 20;
  
  severity(v: string) { this.conditions.severity = v; return this; }
  impact(v: string) { this.conditions.impact = v; return this; }
  tag(v: string) { this.conditions.tags = [v]; return this; }
  category(v: string) { this.conditions.categories = [v]; return this; }
  keyword(v: string) { this.conditions.keywords = [v]; return this; }
  recent(days: number) {
    this.conditions.since = Date.now() - days * 86400000;
    return this;
  }
  limit(n: number) { this._limit = n; return this; }
  
  async exec() {
    const indices = await indexManager.query()
      .type('memory')
      .severity(this.conditions.severity ?? '')
      .impact(this.conditions.impact ?? '')
      .tag(this.conditions.tags?.[0] ?? '')
      .category(this.conditions.categories?.[0] ?? '')
      .keyword(this.conditions.keywords?.[0] ?? '')
      .limit(this._limit)
      .exec();
    
    const results = [];
    for (const idx of indices) {
      const doc = await db.memory.get(idx.dataId);
      if (doc && !doc.deletedAt) {
        results.push(doc);
      }
    }
    
    return results;
  }
}
```

### 11.3 统一查询入口

```typescript
export const search = {
  // 全文搜索
  async all(keyword: string, options?: { limit?: number }) {
    const indices = await indexManager.search(keyword);
    
    const results = [];
    for (const idx of indices.slice(0, options?.limit ?? 20)) {
      if (idx.storage === 'doc' && idx.storagePath === 'memory') {
        const doc = await db.memory.get(idx.dataId);
        if (doc && !doc.deletedAt) {
          results.push({ type: 'memory', data: doc });
        }
      }
    }
    
    return results;
  },
  
  // 按类型搜索
  async byType(type: string) {
    return indexManager.byType(type);
  },
  
  // 按标签搜索
  async byTag(tag: string) {
    return indexManager.byTag(tag);
  },
  
  // 按分类搜索
  async byCategory(category: string) {
    return indexManager.byCategory(category);
  },
  
  // 组合查询
  query() {
    return indexManager.query();
  }
};
```

---

## 十二、使用示例

### 12.1 创建数据

```typescript
import { memory, search, stats } from './ai-society';

// 创建记忆（自动建立索引）
const m = await memory.create({
  event: 'Browser 插件故障导致大量文件被误删',
  severity: 'critical',
  impact: 'negative',
  participants: ['FileAgent', 'BrowserAgent'],
  lessons: ['删文件前检查 2 次']
});
```

### 12.2 查询数据

```typescript
// 向量搜索
const similar = await memory.search('文件删除问题', {
  topK: 5,
  severity: ['high', 'critical']
});

// 链式查询
const critical = await memory.find()
  .severity('critical')
  .recent(30)
  .limit(10)
  .exec();

// 按标签查询
const browserRelated = await search.byTag('BrowserAgent');

// 按分类查询
const important = await search.byCategory('critical');

// 全文搜索
const results = await search.all('文件 删除 插件');

// 组合查询
const found = await search.query()
  .type('memory')
  .severity('critical')
  .category('negative')
  .keyword('browser')
  .limit(5)
  .exec();
```

### 12.3 删除数据

```typescript
// 删除（自动保护）
try {
  await memory.delete('mem_xxx', { reason: '测试删除' });
} catch (e) {
  console.log('删除被阻止:', e.message);
}

// 批量删除（受限）
const result = await memory.batchDelete(['id1', 'id2'], { reason: '清理' });
// { success: 2, failed: [] }
```

### 12.4 回收站

```typescript
import { softDelete } from './ai-society';

// 查看回收站
const trash = await softDelete.list({ type: 'memory', limit: 10 });

// 恢复
const restoredData = await softDelete.restore('trash_record_id');

// 清理过期记录
const cleaned = await softDelete.cleanup();
console.log(`清理了 ${cleaned} 条过期记录`);
```

### 12.5 统计

```typescript
const s = await stats();
// {
//   total: 156,
//   active: 150,
//   deleted: 6,
//   byType: {
//     memory: 80,
//     reputation: 50,
//     institution: 10,
//     culture: 10
//   }
// }
```

---

## 十三、数据流

### 13.1 创建数据

```
memory.create({...})
     ↓
┌─────────────────────────────────────────────────────┐
│  1. 存入文档库（db.memory）                        │
│  2. 生成向量存入向量库（vectorStore）               │
│  3. 建立索引（indexManager）                      │
└─────────────────────────────────────────────────────┘
```

### 13.2 查询数据

```
memory.find().severity('critical').exec()
     ↓
┌─────────────────────────────────────────────────────┐
│  1. 查索引（indexManager）→ 找到匹配的 dataId       │
│  2. 根据 storage 字段定位具体数据库                  │
│  3. 获取完整数据                                    │
└─────────────────────────────────────────────────────┘
```

### 13.3 删除数据

```
memory.delete('id')
     ↓
┌─────────────────────────────────────────────────────┐
│  1. 检查权限（deleteProtection）                    │
│  2. 软删除文档（db）                               │
│  3. 标记索引删除（indexManager）                   │
│  4. 从向量库移除（vectorStore）                    │
└─────────────────────────────────────────────────────┘
```

---

## 十四、依赖清单

```json
{
  "dependencies": {
    "dexie": "^4.0.0",
    "@lancedb/lancedb": "latest",
    "ulid": "^1.1.0"
  }
}
```

---

## 十五、文件结构

```
data/
├── ai-society/           # 文档数据库
│   ├── memory.db
│   ├── reputation.db
│   ├── institution.db
│   └── culture.db
├── ai-society-vectors/   # 向量数据库
│   └── social_memory/
├── ai-society-index/     # 索引数据库
│   └── index.db
└── ai-society-trash/     # 回收站
    └── trash.db
```

---

## 十六、优点总结

| 优点 | 说明 |
|------|------|
| ✅ 向量搜索 | LanceDB WASM，真实 HNSW 索引 |
| ✅ 内置向量生成 | TF-IDF + 随机投影，无需外部模型 |
| ✅ 链式查询 | Dexie.js，条件组合查询 |
| ✅ 删除保护 | 软删除 + 权限 + 回收站 + 确认机制 |
| ✅ 索引系统 | 快速定位，多维度查询 |
| ✅ 完全内嵌 | 不需要外部服务 |
| ✅ 轻量简单 | 只有 3 个依赖 |

---

## 十七、适用场景

- Electron 桌面应用（完全内嵌）
- 需要真实向量搜索
- 不想要重型数据库（PostgreSQL/SurrealDB）
- 需要删除保护机制
- 需要快速索引查询

---

*融合文档版本：v1.0*
*原始文档合并自：《AI-Society-Storage-Summary》&《AI社会体系和模型调度解析》*
*生成时间：2026-05-24*

---

## 第十八章：实际实现与设计文档的差异修正（2026-05-31）

> ⚠️ 本章节基于 SoloForge 源码实际分析，修正第二部分中与实际实现不符的技术选型描述。

### 关键修正项

| 设计文档描述 | 实际实现 | 原因 |
|---|---|---|
| **Dexie.js (浏览器 IndexedDB ORM)** | **SurrealDB 嵌入式模式** | Dexie.js 仅能运行在浏览器/Electron 渲染进程；项目同时需要 Node.js 服务端运行模式（Python IPC），SurrealDB 嵌入式 RocksDB 引擎更合适：10-50x 性能、原生图查询、事务支持 |
| **LanceDB WASM** | **Python LanceDB** | AI 社会模块运行在 Python 进程中，通过 MessagePack TCP IPC (端口 18765) 与 Node.js 通信；WASM 版本无 Python 运行时支持 |
| **IndexManager (独立索引表)** | **SurrealDB 原生 `DEFINE INDEX`** | SurrealDB 内核层维护索引一致性；在应用层再加索引器是冗余双重写入，增加写入开销和一致性风险 |
| **软删除回收站 (mockTrashDb, Map)** | **SurrealDB `trash` 表持久化** | 2026-05-31 已实现，见 `src/data/delete_protection.ts` + `migrations/20240101050000__v6_persistent_trash.surql` |
| **Market 市场表 (supply/demand, pricing)** | **未实现，仅有 TokenEconomyEngine** | `economy.ts` 只实现了按角色分配 token 奖励的逻辑；`index.ts` 预留了 `MarketResource` 导出但无对应实现。Market 的供需定价/资源竞争机制需要单独开发 |

### 实际技术栈总结

```
┌─────────────────────────────────────────────────────────┐
│  主项目 (Node.js + TypeScript)                           │
│  ├── SurrealDB 嵌入式 (rocksdb://data/soloforge_db)    │
│  │   → 制度/治理/信誉/文化/经济/法律/联盟/记忆         │
│  ├── Garnet 热缓存 (:6379, Redis 协议兼容)             │
│  │   → Session/Task/Queue/实时状态                      │
│  └── JSONL 归档 (data/jsonl/)                           │
│      → 事件审计                                         │
├─────────────────────────────────────────────────────────┤
│  AI 社会 (Python, 完全隔离)                              │
│  ├── SQLite (python/data/ai_society/ai_society.db)     │
│  │   → 结构化业务数据 (7 个表)                          │
│  └── LanceDB (python/data/ai_society/social_memory)    │
│      → 社会记忆向量检索                                  │
├─────────────────────────────────────────────────────────┤
│  通信: MessagePack TCP IPC, 端口 18765                   │
│  （Node.js ←→ Python MARL Service）                     │
└─────────────────────────────────────────────────────────┘
```
