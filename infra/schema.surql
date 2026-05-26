-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Migration: Unified SCHEMAFULL Table Definitions
-- Path: infra/schema.surql
-- ─────────────────────────────────────────────────────────────────

-- 1. 建立流控决策结果表
DEFINE TABLE decision SCHEMAFULL;
DEFINE FIELD traceId ON decision TYPE string;
DEFINE FIELD selectedStrategy ON decision TYPE string;
DEFINE FIELD strategyReason ON decision TYPE string;
DEFINE FIELD budgetUsed ON decision TYPE number;
DEFINE FIELD budgetLimit ON decision TYPE number;
DEFINE FIELD confidenceTier ON decision TYPE string ASSERT $value INSIDE ['high', 'medium', 'low'];
DEFINE FIELD subsetSize ON decision TYPE number;
DEFINE FIELD aggregationMethod ON decision TYPE string;
DEFINE FIELD aggregatedCandidates ON decision TYPE array;
DEFINE FIELD version ON decision TYPE number;
DEFINE FIELD createdAt ON decision TYPE datetime;
DEFINE FIELD updatedAt ON decision TYPE datetime;

-- 2. 建立司法共识盲审决议表
DEFINE TABLE courtSubmission SCHEMAFULL;
DEFINE FIELD traceId ON courtSubmission TYPE string;
DEFINE FIELD phase ON courtSubmission TYPE string ASSERT $value INSIDE ['phase_1', 'phase_2', 'complete'];
DEFINE FIELD phase1Deadline ON courtSubmission TYPE datetime;
DEFINE FIELD judgmentBasis ON courtSubmission TYPE string;
DEFINE FIELD winnerScore ON courtSubmission TYPE number;
DEFINE FIELD loserScore ON courtSubmission TYPE number;
DEFINE FIELD escalatedToHuman ON courtSubmission TYPE bool;
DEFINE FIELD escalationReason ON courtSubmission TYPE string;
DEFINE FIELD version ON courtSubmission TYPE number;
DEFINE FIELD createdAt ON courtSubmission TYPE datetime;
DEFINE FIELD updatedAt ON courtSubmission TYPE datetime;

-- 3. 建立 MAPPO 控流遥测特征历史表
DEFINE TABLE marlEpisode SCHEMAFULL;
DEFINE FIELD traceId ON marlEpisode TYPE string;
DEFINE FIELD episodeCount ON marlEpisode TYPE number;
DEFINE FIELD cpuMetric ON marlEpisode TYPE number;
DEFINE FIELD memoryMetric ON marlEpisode TYPE number;
DEFINE FIELD executedAction ON marlEpisode TYPE number;
DEFINE FIELD version ON marlEpisode TYPE number;
DEFINE FIELD createdAt ON marlEpisode TYPE datetime;
DEFINE FIELD updatedAt ON marlEpisode TYPE datetime;

-- 4. 📜 追加：内核事件审计日志表（对应 v5_events 演进规范）
DEFINE TABLE eventLog SCHEMAFULL;
DEFINE FIELD traceId ON eventLog TYPE string;
DEFINE FIELD event ON eventLog TYPE string;
DEFINE FIELD payload ON eventLog TYPE string;
DEFINE FIELD timestamp ON eventLog TYPE datetime;