-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Migration: v3_court - 法庭治理链路
-- Version: v3_court
-- Description: 建立司法共识盲审决议表、证据表与裁决表
-- Author: Backend Team
-- Created: 2024-01-01
-- Dependencies: v1_base, v2_decision
-- ─────────────────────────────────────────────────────────────────

-- ============================================================
-- v3.1: 建立证据表（真实物理证据链表）
-- ============================================================
DEFINE TABLE evidence SCHEMAFULL;

DEFINE FIELD id ON evidence TYPE record<evidence>;

-- 追踪链路标识
DEFINE FIELD traceId ON evidence TYPE string;
DEFINE INDEX evidence_trace_id_idx ON evidence FIELDS traceId;

-- 证据来源（智能体 ID）
DEFINE FIELD originatingAgentId ON evidence TYPE string;
DEFINE INDEX evidence_agent_idx ON evidence FIELDS originatingAgentId;

-- 可信度指数（0-1）
DEFINE FIELD credibilityIndex ON evidence TYPE float;

-- 关联权重（0-1）
DEFINE FIELD relevanceWeight ON evidence TYPE float;

-- 时间衰减值（0-1，越新越高）
DEFINE FIELD temporalRecencyValue ON evidence TYPE float;

-- 原始内容
DEFINE FIELD rawContent ON evidence TYPE string;

-- 证据类型
DEFINE FIELD evidenceType ON evidence TYPE string
    ASSERT $value INSIDE ['execution_result', 'reasoning_chain', 'external_knowledge', 'system_metric']
    DEFAULT 'execution_result';

-- 证据状态
DEFINE FIELD status ON evidence TYPE string
    ASSERT $value INSIDE ['active', 'retracted', 'challenged', 'superseded']
    DEFAULT 'active';

-- 挑战记录
DEFINE FIELD challengeRecord ON evidence TYPE option<string>;

-- 版本控制
DEFINE FIELD version ON evidence TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD createdAt ON evidence TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON evidence TYPE datetime DEFAULT time::now();

-- ============================================================
-- v3.2: 建立法庭盲审提交表
-- ============================================================
DEFINE TABLE courtSubmission SCHEMAFULL;

DEFINE FIELD id ON courtSubmission TYPE record<courtSubmission>;

-- 追踪链路标识（核心关联键）
DEFINE FIELD traceId ON courtSubmission TYPE string;
DEFINE INDEX court_submission_trace_id_idx ON courtSubmission FIELDS traceId;

-- 提交方智能体
DEFINE FIELD submittingAgentId ON courtSubmission TYPE string;

-- 法庭阶段
DEFINE FIELD phase ON courtSubmission TYPE string
    ASSERT $value INSIDE ['phase_1', 'phase_2', 'complete']
    DEFAULT 'phase_1';

-- Phase 1 截止时间
DEFINE FIELD phase1Deadline ON courtSubmission TYPE datetime;

-- Phase 1 完成时间
DEFINE FIELD phase1CompletedAt ON courtSubmission TYPE option<datetime>;

-- 争辩声明
DEFINE FIELD disputedClaimStatement ON courtSubmission TYPE string;

-- 关联证据 ID 列表
DEFINE FIELD linkedEvidenceRegistry ON courtSubmission TYPE array;

-- 判决依据
DEFINE FIELD judgmentBasis ON courtSubmission TYPE option<string>;

-- 胜者评分
DEFINE FIELD winnerScore ON courtSubmission TYPE float;

-- 败者评分
DEFINE FIELD loserScore ON courtSubmission TYPE float;

-- 是否升级到人工
DEFINE FIELD escalatedToHuman ON courtSubmission TYPE bool DEFAULT false;

-- 升级原因
DEFINE FIELD escalationReason ON courtSubmission TYPE option<string>;

-- 升级目标
DEFINE FIELD escalationTarget ON courtSubmission TYPE option<string>;

-- 争议级别
DEFINE FIELD disputeLevel ON courtSubmission TYPE string
    ASSERT $value INSIDE ['low', 'medium', 'high', 'critical']
    DEFAULT 'medium';

-- 版本控制
DEFINE FIELD version ON courtSubmission TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD createdAt ON courtSubmission TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON courtSubmission TYPE datetime DEFAULT time::now();

-- ============================================================
-- v3.3: 建立法庭裁决表
-- ============================================================
DEFINE TABLE courtVerdict SCHEMAFULL;

DEFINE FIELD id ON courtVerdict TYPE record<courtVerdict>;

-- 追踪链路标识
DEFINE FIELD traceId ON courtVerdict TYPE string;
DEFINE INDEX court_verdict_trace_id_idx ON courtVerdict FIELDS traceId;

-- 关联提交 ID
DEFINE FIELD submissionId ON courtVerdict TYPE record<courtSubmission>;
DEFINE INDEX court_verdict_submission_idx ON courtVerdict FIELDS submissionId;

-- 裁决状态
DEFINE FIELD verdictStatus ON courtVerdict TYPE string
    ASSERT $value INSIDE ['DECIDED_LEGITIMATE', 'CONSERVATIVE_DEADLOCK_TRIGGER', 'ESCAPE_ROUTING_TO_HUMAN', 'PENDING']
    DEFAULT 'PENDING';

-- 胜出智能体签名
DEFINE FIELD winningAgentSignature ON courtVerdict TYPE option<string>;

-- 裁决评分
DEFINE FIELD adjudicatedMetricScore ON courtVerdict TYPE float;

-- 裁决类型
DEFINE FIELD verdictType ON courtVerdict TYPE string
    ASSERT $value INSIDE ['CONSENSUS', 'DEADLOCK', 'ESCALATION', 'SPLIT']
    DEFAULT 'CONSENSUS';

-- 裁决理由
DEFINE FIELD verdictReason ON courtVerdict TYPE option<string>;

-- 参与裁决的智能体列表
DEFINE FIELD participatingAgents ON courtVerdict TYPE array;

-- LLM 升级裁决内容（如果走了 LLM 终审）
DEFINE FIELD llmVerdictContent ON courtVerdict TYPE option<string>;

-- 执行动作
DEFINE FIELD executedAction ON courtVerdict TYPE option<int>;

-- 版本控制
DEFINE FIELD version ON courtVerdict TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD createdAt ON courtVerdict TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON courtVerdict TYPE datetime DEFAULT time::now();

-- ============================================================
-- v3.4: 建立法庭陪审团成员表
-- ============================================================
DEFINE TABLE courtJuror SCHEMAFULL;

DEFINE FIELD id ON courtJuror TYPE record<courtJuror>;

-- 陪审团成员 ID
DEFINE FIELD agentId ON courtJuror TYPE string;
DEFINE INDEX court_juror_agent_idx ON courtJuror FIELDS agentId;

-- 陪审团成员类型
DEFINE FIELD jurorType ON courtJuror TYPE string
    ASSERT $value INSIDE ['autonomous', 'llm', 'human']
    DEFAULT 'autonomous';

-- 能力评分
DEFINE FIELD capabilityScore ON courtJuror TYPE float;

-- 历史裁决准确率
DEFINE FIELD historicalAccuracy ON courtJuror TYPE float;

-- 状态
DEFINE FIELD status ON courtJuror TYPE string
    ASSERT $value INSIDE ['active', 'inactive', 'disqualified']
    DEFAULT 'active';

-- 版本控制
DEFINE FIELD version ON courtJuror TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD createdAt ON courtJuror TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON courtJuror TYPE datetime DEFAULT time::now();
