-- SoloForge baseline migration (up)
-- Version: 202605281200
-- Note: 版本追踪由 v1 在 migration_history 表完成,本文件不再建影子表
-- 全部用 IF NOT EXISTS 兜底,跟 v2~v5 重名表/字段不会冲突

-- decision
DEFINE TABLE IF NOT EXISTS decision SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS traceId ON decision TYPE string;
DEFINE FIELD IF NOT EXISTS selectedStrategy ON decision TYPE string;
DEFINE FIELD IF NOT EXISTS strategyReason ON decision TYPE string;
DEFINE FIELD IF NOT EXISTS budgetUsed ON decision TYPE number;
DEFINE FIELD IF NOT EXISTS budgetLimit ON decision TYPE number;
DEFINE FIELD IF NOT EXISTS confidenceTier ON decision TYPE string ASSERT $value INSIDE ['high', 'medium', 'low'];
DEFINE FIELD IF NOT EXISTS subsetSize ON decision TYPE number;
DEFINE FIELD IF NOT EXISTS aggregationMethod ON decision TYPE string;
DEFINE FIELD IF NOT EXISTS aggregatedCandidates ON decision TYPE array;
DEFINE FIELD IF NOT EXISTS version ON decision TYPE number;
DEFINE FIELD IF NOT EXISTS createdAt ON decision TYPE datetime;
DEFINE FIELD IF NOT EXISTS updatedAt ON decision TYPE datetime;

-- courtSubmission
DEFINE TABLE IF NOT EXISTS courtSubmission SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS traceId ON courtSubmission TYPE string;
DEFINE FIELD IF NOT EXISTS phase ON courtSubmission TYPE string ASSERT $value INSIDE ['phase_1', 'phase_2', 'complete'];
DEFINE FIELD IF NOT EXISTS phase1Deadline ON courtSubmission TYPE datetime;
DEFINE FIELD IF NOT EXISTS judgmentBasis ON courtSubmission TYPE string;
DEFINE FIELD IF NOT EXISTS winnerScore ON courtSubmission TYPE number;
DEFINE FIELD IF NOT EXISTS loserScore ON courtSubmission TYPE number;
DEFINE FIELD IF NOT EXISTS escalatedToHuman ON courtSubmission TYPE bool;
DEFINE FIELD IF NOT EXISTS escalationReason ON courtSubmission TYPE string;
DEFINE FIELD IF NOT EXISTS version ON courtSubmission TYPE number;
DEFINE FIELD IF NOT EXISTS createdAt ON courtSubmission TYPE datetime;
DEFINE FIELD IF NOT EXISTS updatedAt ON courtSubmission TYPE datetime;

-- marlEpisode
DEFINE TABLE IF NOT EXISTS marlEpisode SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS traceId ON marlEpisode TYPE string;
DEFINE FIELD IF NOT EXISTS episodeCount ON marlEpisode TYPE number;
DEFINE FIELD IF NOT EXISTS cpuMetric ON marlEpisode TYPE number;
DEFINE FIELD IF NOT EXISTS memoryMetric ON marlEpisode TYPE number;
DEFINE FIELD IF NOT EXISTS executedAction ON marlEpisode TYPE number;
DEFINE FIELD IF NOT EXISTS version ON marlEpisode TYPE number;
DEFINE FIELD IF NOT EXISTS createdAt ON marlEpisode TYPE datetime;
DEFINE FIELD IF NOT EXISTS updatedAt ON marlEpisode TYPE datetime;

-- eventLog
DEFINE TABLE IF NOT EXISTS eventLog SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS traceId ON eventLog TYPE string;
DEFINE FIELD IF NOT EXISTS event ON eventLog TYPE string;
DEFINE FIELD IF NOT EXISTS payload ON eventLog TYPE string;
DEFINE FIELD IF NOT EXISTS timestamp ON eventLog TYPE datetime;
