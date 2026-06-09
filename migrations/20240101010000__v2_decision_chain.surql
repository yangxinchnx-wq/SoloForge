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
DEFINE TABLE IF NOT EXISTS decision SCHEMAFULL;

-- 主键（SurrealDB 自动生成 record ID,无需 DEFINE FIELD id）

-- 追踪链路标识（核心关联键，用于全链路查询）
DEFINE FIELD IF NOT EXISTS traceId ON decision TYPE string;
DEFINE INDEX IF NOT EXISTS decision_trace_id_idx ON decision FIELDS traceId;

-- 决策类型
DEFINE FIELD IF NOT EXISTS decisionType ON decision TYPE string
    ASSERT $value INSIDE ['model_select', 'tool_select', 'agent_select']
    DEFAULT 'model_select';

-- 选中策略
DEFINE FIELD IF NOT EXISTS selectedStrategy ON decision TYPE string;

-- 决策理由
DEFINE FIELD IF NOT EXISTS strategyReason ON decision TYPE string;

-- 预算使用情况
DEFINE FIELD IF NOT EXISTS budgetUsed ON decision TYPE float DEFAULT 0.0;
DEFINE FIELD IF NOT EXISTS budgetLimit ON decision TYPE float DEFAULT 1.0;

-- 置信度层级（小写枚举约束）
DEFINE FIELD IF NOT EXISTS confidenceTier ON decision TYPE string
    ASSERT $value INSIDE ['high', 'medium', 'low'];

-- 置信度数值
DEFINE FIELD IF NOT EXISTS confidenceScore ON decision TYPE float DEFAULT 0.0;

-- 子集大小（多路径探索时）
DEFINE FIELD IF NOT EXISTS subsetSize ON decision TYPE int DEFAULT 1;

-- 聚合方法
DEFINE FIELD IF NOT EXISTS aggregationMethod ON decision TYPE string
    ASSERT $value INSIDE ['none', 'plurality_vote', 'weighted_average', 'max_score']
    DEFAULT 'none';

-- 聚合候选列表
DEFINE FIELD IF NOT EXISTS aggregatedCandidates ON decision TYPE array;

-- 候选评分详情（JSON 字符串存储）
DEFINE FIELD IF NOT EXISTS candidateScores ON decision TYPE option<string>;

-- 执行结果
DEFINE FIELD IF NOT EXISTS executionResult ON decision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS executionLatencyMs ON decision TYPE option<int>;
DEFINE FIELD IF NOT EXISTS executionSuccess ON decision TYPE bool DEFAULT true;

-- 版本控制（乐观锁）
DEFINE FIELD IF NOT EXISTS version ON decision TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD IF NOT EXISTS createdAt ON decision TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON decision TYPE datetime DEFAULT time::now();

-- ============================================================
-- v2.2: 建立候选模型评分表
-- ============================================================
DEFINE TABLE IF NOT EXISTS candidate SCHEMAFULL;

-- 关联决策 ID
DEFINE FIELD IF NOT EXISTS decisionId ON candidate TYPE record<decision>;
DEFINE INDEX IF NOT EXISTS candidate_decision_idx ON candidate FIELDS decisionId;

-- 候选名称（模型/工具/智能体）
DEFINE FIELD IF NOT EXISTS name ON candidate TYPE string;
DEFINE FIELD IF NOT EXISTS entityType ON candidate TYPE string
    ASSERT $value INSIDE ['model', 'tool', 'agent']
    DEFAULT 'model';

-- 多维评分
DEFINE FIELD IF NOT EXISTS qualityScore ON candidate TYPE float;
DEFINE FIELD IF NOT EXISTS latencyScore ON candidate TYPE float;
DEFINE FIELD IF NOT EXISTS costScore ON candidate TYPE float;
DEFINE FIELD IF NOT EXISTS historyScore ON candidate TYPE float;
DEFINE FIELD IF NOT EXISTS totalScore ON candidate TYPE float;

-- 推理策略
DEFINE FIELD IF NOT EXISTS reasoningStrategy ON candidate TYPE string
    ASSERT $value INSIDE ['direct', 'chain_of_thought', 'few_shot', 'decompose', 'self_refine']
    DEFAULT 'direct';

-- 是否被选中
DEFINE FIELD IF NOT EXISTS selected ON candidate TYPE bool DEFAULT false;

-- 评分理由
DEFINE FIELD IF NOT EXISTS scoreReason ON candidate TYPE option<string>;

-- 版本控制
DEFINE FIELD IF NOT EXISTS version ON candidate TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD IF NOT EXISTS createdAt ON candidate TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON candidate TYPE datetime DEFAULT time::now();

-- ============================================================
-- v2.3: 建立决策策略配置表
-- ============================================================
DEFINE TABLE IF NOT EXISTS decision_strategy SCHEMAFULL;

-- 策略名称（唯一）
DEFINE FIELD IF NOT EXISTS name ON decision_strategy TYPE string;
DEFINE INDEX IF NOT EXISTS decision_strategy_name_idx ON decision_strategy FIELDS name UNIQUE;

-- 权重配置
DEFINE FIELD IF NOT EXISTS weightQuality ON decision_strategy TYPE float DEFAULT 0.4;
DEFINE FIELD IF NOT EXISTS weightLatency ON decision_strategy TYPE float DEFAULT 0.2;
DEFINE FIELD IF NOT EXISTS weightCost ON decision_strategy TYPE float DEFAULT 0.2;
DEFINE FIELD IF NOT EXISTS weightHistory ON decision_strategy TYPE float DEFAULT 0.2;

-- 探索率（ε-greedy）
DEFINE FIELD IF NOT EXISTS epsilon ON decision_strategy TYPE float DEFAULT 0.1;

-- 策略激活状态
DEFINE FIELD IF NOT EXISTS isActive ON decision_strategy TYPE bool DEFAULT true;

-- 适用场景
DEFINE FIELD IF NOT EXISTS applicableScopes ON decision_strategy TYPE array;

-- 版本控制
DEFINE FIELD IF NOT EXISTS version ON decision_strategy TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD IF NOT EXISTS createdAt ON decision_strategy TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON decision_strategy TYPE datetime DEFAULT time::now();
