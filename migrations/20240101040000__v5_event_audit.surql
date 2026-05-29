-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Migration: v5_events - 事件审计链路
-- Version: v5_events
-- Description: 建立内核事件审计日志表与可追溯性基础设施
-- Author: Backend Team
-- Created: 2024-01-01
-- Dependencies: v1_base, v2_decision, v3_court
-- ─────────────────────────────────────────────────────────────────

-- ============================================================
-- v5.1: 建立内核事件审计日志表
-- ============================================================
DEFINE TABLE eventLog SCHEMAFULL;

DEFINE FIELD id ON eventLog TYPE record<eventLog>;

-- 追踪链路标识（核心关联键，用于全链路查询）
DEFINE FIELD traceId ON eventLog TYPE string;
DEFINE INDEX event_log_trace_id_idx ON eventLog FIELDS traceId;

-- 事件类型
DEFINE FIELD event ON eventLog TYPE string;
DEFINE INDEX event_log_type_idx ON eventLog FIELDS event;

-- 事件域
DEFINE FIELD domain ON eventLog TYPE string;

-- 事件源
DEFINE FIELD source ON eventLog TYPE string;

-- 调用者
DEFINE FIELD caller ON eventLog TYPE string;

-- 事件负载（JSON 字符串）
DEFINE FIELD payload ON eventLog TYPE string;

-- 事件状态
DEFINE FIELD status ON eventLog TYPE string
    ASSERT $value INSIDE ['pending', 'processed', 'failed', 'ignored']
    DEFAULT 'processed';

-- 错误信息（如果失败）
DEFINE FIELD errorMessage ON eventLog TYPE option<string>;

-- 处理延迟（毫秒）
DEFINE FIELD processingLatencyMs ON eventLog TYPE option<int>;

-- 版本控制
DEFINE FIELD version ON eventLog TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD timestamp ON eventLog TYPE datetime DEFAULT time::now();
DEFINE FIELD createdAt ON eventLog TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON eventLog TYPE datetime DEFAULT time::now();

-- ============================================================
-- v5.2: 建立决策-提交-裁决-事件全链路追踪表
-- ============================================================
DEFINE TABLE traceLinkage SCHEMAFULL;

DEFINE FIELD id ON traceLinkage TYPE record<traceLinkage>;

-- 主追踪链路 ID
DEFINE FIELD traceId ON traceLinkage TYPE string;
DEFINE INDEX trace_linkage_trace_id_idx ON traceLinkage FIELDS traceId UNIQUE;

-- 决策记录 ID
DEFINE FIELD decisionId ON traceLinkage TYPE record<decision>;

-- 法庭提交 ID
DEFINE FIELD courtSubmissionId ON traceLinkage TYPE record<courtSubmission>;

-- 法庭裁决 ID
DEFINE FIELD courtVerdictId ON traceLinkage TYPE record<courtVerdict>;

-- MARL Episode ID
DEFINE FIELD marlEpisodeId ON traceLinkage TYPE record<marlEpisode>;

-- 起始事件 ID
DEFINE FIELD startEventId ON traceLinkage TYPE record<eventLog>;

-- 结束事件 ID
DEFINE FIELD endEventId ON traceLinkage TYPE record<eventLog>;

-- 链路状态
DEFINE FIELD status ON traceLinkage TYPE string
    ASSERT $value INSIDE ['IN_PROGRESS', 'COMPLETED', 'FAILED', 'ROLLED_BACK']
    DEFAULT 'IN_PROGRESS';

-- 完成时间
DEFINE FIELD completedAt ON traceLinkage TYPE option<datetime>;

-- 总耗时（毫秒）
DEFINE FIELD totalDurationMs ON traceLinkage TYPE option<int>;

-- 版本控制
DEFINE FIELD version ON traceLinkage TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD createdAt ON traceLinkage TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON traceLinkage TYPE datetime DEFAULT time::now();

-- ============================================================
-- v5.3: 建立全链路事件序列表（用于回放）
-- ============================================================
DEFINE TABLE eventSequence SCHEMAFULL;

DEFINE FIELD id ON eventSequence TYPE record<eventSequence>;

-- 追踪链路 ID
DEFINE FIELD traceId ON eventSequence TYPE string;
DEFINE INDEX event_sequence_trace_idx ON eventSequence FIELDS traceId;

-- 序列序号（保证顺序）
DEFINE FIELD sequenceIndex ON eventSequence TYPE int;

-- 事件类型
DEFINE FIELD eventType ON eventSequence TYPE string;

-- 事件域
DEFINE FIELD domain ON eventSequence TYPE string;

-- 事件数据（JSON）
DEFINE FIELD eventData ON eventSequence TYPE string;

-- 前置事件 ID（用于构建事件链）
DEFINE FIELD previousEventId ON eventSequence TYPE option<record<eventSequence>>;

-- 后置事件 ID（用于构建事件链）
DEFINE FIELD nextEventId ON eventSequence TYPE option<record<eventSequence>>;

-- 版本控制
DEFINE FIELD version ON eventSequence TYPE int DEFAULT 1;

-- 事件时间戳
DEFINE FIELD timestamp ON eventSequence TYPE datetime DEFAULT time::now();
DEFINE FIELD createdAt ON eventSequence TYPE datetime DEFAULT time::now();

-- ============================================================
-- v5.4: 建立回放会话表
-- ============================================================
DEFINE TABLE replaySession SCHEMAFULL;

DEFINE FIELD id ON replaySession TYPE record<replaySession>;

-- 回放会话 ID
DEFINE FIELD sessionId ON replaySession TYPE string;
DEFINE INDEX replay_session_id_idx ON replaySession FIELDS sessionId UNIQUE;

-- 回放的追踪链路 ID
DEFINE FIELD traceId ON replaySession TYPE record<traceLinkage>;

-- 回放模式
DEFINE FIELD replayMode ON replaySession TYPE string
    ASSERT $value INSIDE ['NORMAL', 'REPLAY', 'FORK', 'SANDBOX']
    DEFAULT 'REPLAY';

-- 回放状态
DEFINE FIELD status ON replaySession TYPE string
    ASSERT $value INSIDE ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']
    DEFAULT 'PENDING';

-- 起始事件索引
DEFINE FIELD startSequenceIndex ON replaySession TYPE int DEFAULT 0;

-- 结束事件索引
DEFINE FIELD endSequenceIndex ON replaySession TYPE option<int>;

-- 当前事件索引
DEFINE FIELD currentSequenceIndex ON replaySession TYPE int DEFAULT 0;

-- 回放速率
DEFINE FIELD replaySpeed ON replaySession TYPE float DEFAULT 1.0;

-- 版本控制
DEFINE FIELD version ON replaySession TYPE int DEFAULT 1;

-- 开始时间
DEFINE FIELD startedAt ON replaySession TYPE option<datetime>;

-- 结束时间
DEFINE FIELD completedAt ON replaySession TYPE option<datetime>;

-- 时间戳
DEFINE FIELD createdAt ON replaySession TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON replaySession TYPE datetime DEFAULT time::now();

-- ============================================================
-- v5.5: 建立审计合规表
-- ============================================================
DEFINE TABLE auditCompliance SCHEMAFULL;

DEFINE FIELD id ON auditCompliance TYPE record<auditCompliance>;

-- 合规标识
DEFINE FIELD complianceId ON auditCompliance TYPE string;
DEFINE INDEX audit_compliance_id_idx ON auditCompliance FIELDS complianceId UNIQUE;

-- 追踪链路 ID
DEFINE FIELD traceId ON auditCompliance TYPE string;
DEFINE INDEX audit_compliance_trace_idx ON auditCompliance FIELDS traceId;

-- 合规类型
DEFINE FIELD complianceType ON auditCompliance TYPE string
    ASSERT $value INSIDE ['data_access', 'data_modification', 'deletion', 'security_event', 'config_change']
    DEFAULT 'data_access';

-- 合规状态
DEFINE FIELD status ON auditCompliance TYPE string
    ASSERT $value INSIDE ['pending', 'compliant', 'violation', 'remediated']
    DEFAULT 'pending';

-- 执行者
DEFINE FIELD actor ON auditCompliance TYPE string;

-- 操作
DEFINE FIELD action ON auditCompliance TYPE string;

-- 资源
DEFINE FIELD resource ON auditCompliance TYPE string;

-- 合规检查结果
DEFINE FIELD checkResult ON auditCompliance TYPE option<string>;

-- 版本控制
DEFINE FIELD version ON auditCompliance TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD timestamp ON auditCompliance TYPE datetime DEFAULT time::now();
DEFINE FIELD createdAt ON auditCompliance TYPE datetime DEFAULT time::now();
