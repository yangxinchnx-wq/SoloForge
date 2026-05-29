-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Migration: v2_decision - 决策链路
-- Version: v2_decision
-- Description: 建立流控决策结果表与关联索引
-- Author: Backend Team
-- Created: 2024-01-01
-- Dependencies: v1_base
-- ─────────────────────────────────────────────────────────────────

-- ============================================================
-- v2.1: 建立流控决策主表
-- ============================================================
DEFINE TABLE decision SCHEMAFULL;

-- 主键（SurrealDB 自动生成 record ID）
DEFINE FIELD id ON decision TYPE record<decision>;

-- 追踪链路标识（核心关联键，用于全链路查询）
DEFINE FIELD traceId ON decision TYPE string;
DEFINE INDEX decision_trace_id_idx ON decision FIELDS traceId;

-- 决策类型
DEFINE FIELD decisionType ON decision TYPE string
    ASSERT $value INSIDE ['model_select', 'tool_select', 'agent_select']
    DEFAULT 'model_select';

-- 选中策略
DEFINE FIELD selectedStrategy ON decision TYPE string;

-- 决策理由
DEFINE FIELD strategyReason ON decision TYPE string;

-- 预算使用情况
DEFINE FIELD budgetUsed ON decision TYPE float DEFAULT 0.0;
DEFINE FIELD budgetLimit ON decision TYPE float DEFAULT 1.0;

-- 置信度层级（小写枚举约束）
DEFINE FIELD confidenceTier ON decision TYPE string
    ASSERT $value INSIDE ['high', 'medium', 'low'];

-- 置信度数值
DEFINE FIELD confidenceScore ON decision TYPE float DEFAULT 0.0;

-- 子集大小（多路径探索时）
DEFINE FIELD subsetSize ON decision TYPE int DEFAULT 1;

-- 聚合方法
DEFINE FIELD aggregationMethod ON decision TYPE string
    ASSERT $value INSIDE ['none', 'plurality_vote', 'weighted_average', 'max_score']
    DEFAULT 'none';

-- 聚合候选列表
DEFINE FIELD aggregatedCandidates ON decision TYPE array;

-- 候选评分详情（JSON 字符串存储）
DEFINE FIELD candidateScores ON decision TYPE option<string>;

-- 执行结果
DEFINE FIELD executionResult ON decision TYPE option<string>;
DEFINE FIELD executionLatencyMs ON decision TYPE option<int>;
DEFINE FIELD executionSuccess ON decision TYPE bool DEFAULT true;

-- 版本控制（乐观锁）
DEFINE FIELD version ON decision TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD createdAt ON decision TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON decision TYPE datetime DEFAULT time::now();

-- ============================================================
-- v2.2: 建立候选模型评分表
-- ============================================================
DEFINE TABLE candidate SCHEMAFULL;

DEFINE FIELD id ON candidate TYPE record<candidate>;

-- 关联决策 ID
DEFINE FIELD decisionId ON candidate TYPE record<decision>;
DEFINE INDEX candidate_decision_idx ON candidate FIELDS decisionId;

-- 候选名称（模型/工具/智能体）
DEFINE FIELD name ON candidate TYPE string;
DEFINE FIELD entityType ON candidate TYPE string
    ASSERT $value INSIDE ['model', 'tool', 'agent']
    DEFAULT 'model';

-- 多维评分
DEFINE FIELD qualityScore ON candidate TYPE float;
DEFINE FIELD latencyScore ON candidate TYPE float;
DEFINE FIELD costScore ON candidate TYPE float;
DEFINE FIELD historyScore ON candidate TYPE float;
DEFINE FIELD totalScore ON candidate TYPE float;

-- 推理策略
DEFINE FIELD reasoningStrategy ON candidate TYPE string
    ASSERT $value INSIDE ['direct', 'chain_of_thought', 'few_shot', 'decompose', 'self_refine']
    DEFAULT 'direct';

-- 是否被选中
DEFINE FIELD selected ON candidate TYPE bool DEFAULT false;

-- 评分理由
DEFINE FIELD scoreReason ON candidate TYPE option<string>;

-- 版本控制
DEFINE FIELD version ON candidate TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD createdAt ON candidate TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON candidate TYPE datetime DEFAULT time::now();

-- ============================================================
-- v2.3: 建立决策策略配置表
-- ============================================================
DEFINE TABLE decision_strategy SCHEMAFULL;

DEFINE FIELD id ON decision_strategy TYPE record<decision_strategy>;

-- 策略名称（唯一）
DEFINE FIELD name ON decision_strategy TYPE string;
DEFINE INDEX decision_strategy_name_idx ON decision_strategy FIELDS name UNIQUE;

-- 权重配置
DEFINE FIELD weightQuality ON decision_strategy TYPE float DEFAULT 0.4;
DEFINE FIELD weightLatency ON decision_strategy TYPE float DEFAULT 0.2;
DEFINE FIELD weightCost ON decision_strategy TYPE float DEFAULT 0.2;
DEFINE FIELD weightHistory ON decision_strategy TYPE float DEFAULT 0.2;

-- 探索率（ε-greedy）
DEFINE FIELD epsilon ON decision_strategy TYPE float DEFAULT 0.1;

-- 策略激活状态
DEFINE FIELD isActive ON decision_strategy TYPE bool DEFAULT true;

-- 适用场景
DEFINE FIELD applicableScopes ON decision_strategy TYPE array;

-- 版本控制
DEFINE FIELD version ON decision_strategy TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD createdAt ON decision_strategy TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON decision_strategy TYPE datetime DEFAULT time::now();
