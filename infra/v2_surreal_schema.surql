-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Schema Layer (Strict SCHEMAFULL, CamelCase)
-- Path: infra/v2_surreal_schema.surql
-- ─────────────────────────────────────────────────────────────────

-- 1. 路由决策主表
DEFINE TABLE decision SCHEMAFULL;
DEFINE FIELD id ON TABLE decision TYPE record<decision>;
DEFINE FIELD createdAt ON TABLE decision TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON TABLE decision TYPE datetime DEFAULT time::now();
DEFINE FIELD version ON TABLE decision TYPE int DEFAULT 1;
DEFINE FIELD selectedStrategy ON TABLE decision TYPE string;
DEFINE FIELD strategyReason ON TABLE decision TYPE string;
DEFINE FIELD budgetUsed ON TABLE decision TYPE float DEFAULT 0.0;
DEFINE FIELD budgetLimit ON TABLE decision TYPE float DEFAULT 1.0;
DEFINE FIELD confidenceTier ON TABLE decision TYPE string ASSERT $value INSIDE ['high', 'medium', 'low']; -- ✅ 小写对齐代码
DEFINE FIELD subsetSize ON TABLE decision TYPE int;
DEFINE FIELD aggregationMethod ON TABLE decision TYPE string;
DEFINE FIELD aggregatedCandidates ON TABLE decision TYPE array;

-- 2. 真实物理证据链表
DEFINE TABLE evidence SCHEMAFULL;
DEFINE FIELD id ON TABLE evidence TYPE record<evidence>;
DEFINE FIELD createdAt ON TABLE evidence TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON TABLE evidence TYPE datetime DEFAULT time::now();
DEFINE FIELD version ON TABLE evidence TYPE int DEFAULT 1;
DEFINE FIELD credibilityIndex ON TABLE evidence TYPE float;
DEFINE FIELD relevanceWeight ON TABLE evidence TYPE float;
DEFINE FIELD temporalRecencyValue ON TABLE evidence TYPE float;
DEFINE FIELD rawContent ON TABLE evidence TYPE string;

-- 3. 法庭盲审决议记录表
DEFINE TABLE courtSubmission SCHEMAFULL;
DEFINE FIELD id ON TABLE courtSubmission TYPE record<courtSubmission>;
DEFINE FIELD createdAt ON TABLE courtSubmission TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON TABLE courtSubmission TYPE datetime DEFAULT time::now();
DEFINE FIELD version ON TABLE courtSubmission TYPE int DEFAULT 1;
DEFINE FIELD phase ON TABLE courtSubmission TYPE string ASSERT $value INSIDE ['phase_1', 'phase_2', 'complete'];
DEFINE FIELD phase1Deadline ON TABLE courtSubmission TYPE datetime;
DEFINE FIELD judgmentBasis ON TABLE courtSubmission TYPE string;
DEFINE FIELD winnerScore ON TABLE courtSubmission TYPE float;
DEFINE FIELD loserScore ON TABLE courtSubmission TYPE float;
DEFINE FIELD escalatedToHuman ON TABLE courtSubmission TYPE bool DEFAULT false;
DEFINE FIELD escalationReason ON TABLE courtSubmission TYPE string;

-- 4. MAPPO 控流时序特征日志表
DEFINE TABLE marlEpisode SCHEMAFULL;
DEFINE FIELD id ON TABLE marlEpisode TYPE record<marlEpisode>;
DEFINE FIELD createdAt ON TABLE marlEpisode TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON TABLE marlEpisode TYPE datetime DEFAULT time::now();
DEFINE FIELD version ON TABLE marlEpisode TYPE int DEFAULT 1;
DEFINE FIELD episodeCount ON TABLE marlEpisode TYPE int;
DEFINE FIELD cpuMetric ON TABLE marlEpisode TYPE float;
DEFINE FIELD memoryMetric ON TABLE marlEpisode TYPE float;
DEFINE FIELD executedAction ON TABLE marlEpisode TYPE int;