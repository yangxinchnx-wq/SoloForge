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
DEFINE TABLE IF NOT EXISTS evidence SCHEMAFULL;

-- 追踪链路标识
DEFINE FIELD IF NOT EXISTS traceId ON evidence TYPE string;
DEFINE INDEX IF NOT EXISTS evidence_trace_id_idx ON evidence FIELDS traceId;

-- 证据来源（智能体 ID）
DEFINE FIELD IF NOT EXISTS originatingAgentId ON evidence TYPE string;
DEFINE INDEX IF NOT EXISTS evidence_agent_idx ON evidence FIELDS originatingAgentId;

-- 可信度指数（0-1）
DEFINE FIELD IF NOT EXISTS credibilityIndex ON evidence TYPE float;

-- 关联权重（0-1）
DEFINE FIELD IF NOT EXISTS relevanceWeight ON evidence TYPE float;

-- 时间衰减值（0-1，越新越高）
DEFINE FIELD IF NOT EXISTS temporalRecencyValue ON evidence TYPE float;

-- 原始内容
DEFINE FIELD IF NOT EXISTS rawContent ON evidence TYPE string;

-- 证据类型
DEFINE FIELD IF NOT EXISTS evidenceType ON evidence TYPE string
    ASSERT $value INSIDE ['execution_result', 'reasoning_chain', 'external_knowledge', 'system_metric']
    DEFAULT 'execution_result';

-- 证据状态
DEFINE FIELD IF NOT EXISTS status ON evidence TYPE string
    ASSERT $value INSIDE ['active', 'retracted', 'challenged', 'superseded']
    DEFAULT 'active';

-- 挑战记录
DEFINE FIELD IF NOT EXISTS challengeRecord ON evidence TYPE option<string>;

-- 版本控制
DEFINE FIELD IF NOT EXISTS version ON evidence TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD IF NOT EXISTS createdAt ON evidence TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON evidence TYPE datetime DEFAULT time::now();

-- ============================================================
-- v3.2: 建立法庭盲审提交表
-- ============================================================
DEFINE TABLE IF NOT EXISTS courtSubmission SCHEMAFULL;

-- 追踪链路标识（核心关联键）
DEFINE FIELD IF NOT EXISTS traceId ON courtSubmission TYPE string;
DEFINE INDEX IF NOT EXISTS court_submission_trace_id_idx ON courtSubmission FIELDS traceId;

-- 提交方智能体
DEFINE FIELD IF NOT EXISTS submittingAgentId ON courtSubmission TYPE string;

-- 法庭阶段
DEFINE FIELD IF NOT EXISTS phase ON courtSubmission TYPE string
    ASSERT $value INSIDE ['phase_1', 'phase_2', 'complete']
    DEFAULT 'phase_1';

-- Phase 1 截止时间
DEFINE FIELD IF NOT EXISTS phase1Deadline ON courtSubmission TYPE datetime;

-- Phase 1 完成时间
DEFINE FIELD IF NOT EXISTS phase1CompletedAt ON courtSubmission TYPE option<datetime>;

-- 争辩声明
DEFINE FIELD IF NOT EXISTS disputedClaimStatement ON courtSubmission TYPE string;

-- 关联证据 ID 列表
DEFINE FIELD IF NOT EXISTS linkedEvidenceRegistry ON courtSubmission TYPE array;

-- 判决依据
DEFINE FIELD IF NOT EXISTS judgmentBasis ON courtSubmission TYPE option<string>;

-- 胜者评分
DEFINE FIELD IF NOT EXISTS winnerScore ON courtSubmission TYPE float;

-- 败者评分
DEFINE FIELD IF NOT EXISTS loserScore ON courtSubmission TYPE float;

-- 是否升级到人工
DEFINE FIELD IF NOT EXISTS escalatedToHuman ON courtSubmission TYPE bool DEFAULT false;

-- 升级原因
DEFINE FIELD IF NOT EXISTS escalationReason ON courtSubmission TYPE option<string>;

-- 升级目标
DEFINE FIELD IF NOT EXISTS escalationTarget ON courtSubmission TYPE option<string>;

-- 争议级别
DEFINE FIELD IF NOT EXISTS disputeLevel ON courtSubmission TYPE string
    ASSERT $value INSIDE ['low', 'medium', 'high', 'critical']
    DEFAULT 'medium';

-- 版本控制
DEFINE FIELD IF NOT EXISTS version ON courtSubmission TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD IF NOT EXISTS createdAt ON courtSubmission TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON courtSubmission TYPE datetime DEFAULT time::now();

-- ============================================================
-- v3.3: 建立法庭裁决表
-- ============================================================
DEFINE TABLE IF NOT EXISTS courtVerdict SCHEMAFULL;

-- 追踪链路标识
DEFINE FIELD IF NOT EXISTS traceId ON courtVerdict TYPE string;
DEFINE INDEX IF NOT EXISTS court_verdict_trace_id_idx ON courtVerdict FIELDS traceId;

-- 关联提交 ID
DEFINE FIELD IF NOT EXISTS submissionId ON courtVerdict TYPE record<courtSubmission>;
DEFINE INDEX IF NOT EXISTS court_verdict_submission_idx ON courtVerdict FIELDS submissionId;

-- 裁决状态
DEFINE FIELD IF NOT EXISTS verdictStatus ON courtVerdict TYPE string
    ASSERT $value INSIDE ['DECIDED_LEGITIMATE', 'CONSERVATIVE_DEADLOCK_TRIGGER', 'ESCAPE_ROUTING_TO_HUMAN', 'PENDING']
    DEFAULT 'PENDING';

-- 胜出智能体签名
DEFINE FIELD IF NOT EXISTS winningAgentSignature ON courtVerdict TYPE option<string>;

-- 裁决评分
DEFINE FIELD IF NOT EXISTS adjudicatedMetricScore ON courtVerdict TYPE float;

-- 裁决类型
DEFINE FIELD IF NOT EXISTS verdictType ON courtVerdict TYPE string
    ASSERT $value INSIDE ['CONSENSUS', 'DEADLOCK', 'ESCALATION', 'SPLIT']
    DEFAULT 'CONSENSUS';

-- 裁决理由
DEFINE FIELD IF NOT EXISTS verdictReason ON courtVerdict TYPE option<string>;

-- 参与裁决的智能体列表
DEFINE FIELD IF NOT EXISTS participatingAgents ON courtVerdict TYPE array;

-- LLM 升级裁决内容（如果走了 LLM 终审）
DEFINE FIELD IF NOT EXISTS llmVerdictContent ON courtVerdict TYPE option<string>;

-- 执行动作
DEFINE FIELD IF NOT EXISTS executedAction ON courtVerdict TYPE option<int>;

-- 版本控制
DEFINE FIELD IF NOT EXISTS version ON courtVerdict TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD IF NOT EXISTS createdAt ON courtVerdict TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON courtVerdict TYPE datetime DEFAULT time::now();

-- ============================================================
-- v3.4: 建立法庭陪审团成员表
-- ============================================================
DEFINE TABLE IF NOT EXISTS courtJuror SCHEMAFULL;

-- 陪审团成员 ID
DEFINE FIELD IF NOT EXISTS agentId ON courtJuror TYPE string;
DEFINE INDEX IF NOT EXISTS court_juror_agent_idx ON courtJuror FIELDS agentId;

-- 陪审团成员类型
DEFINE FIELD IF NOT EXISTS jurorType ON courtJuror TYPE string
    ASSERT $value INSIDE ['autonomous', 'llm', 'human']
    DEFAULT 'autonomous';

-- 能力评分
DEFINE FIELD IF NOT EXISTS capabilityScore ON courtJuror TYPE float;

-- 历史裁决准确率
DEFINE FIELD IF NOT EXISTS historicalAccuracy ON courtJuror TYPE float;

-- 状态
DEFINE FIELD IF NOT EXISTS status ON courtJuror TYPE string
    ASSERT $value INSIDE ['active', 'inactive', 'disqualified']
    DEFAULT 'active';

-- 版本控制
DEFINE FIELD IF NOT EXISTS version ON courtJuror TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD IF NOT EXISTS createdAt ON courtJuror TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON courtJuror TYPE datetime DEFAULT time::now();
