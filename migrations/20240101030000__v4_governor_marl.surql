-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Migration: v4_governor - 训练与策略链路（MAPPO）
-- Version: v4_governor
-- Description: 建立 MAPPO 强化学习遥测特征历史表与资源调度表
-- Author: Backend Team
-- Created: 2024-01-01
-- Dependencies: v1_base
-- ─────────────────────────────────────────────────────────────────

-- ============================================================
-- v4.1: 建立 MAPPO 控流遥测特征历史表
-- ============================================================
DEFINE TABLE IF NOT EXISTS marlEpisode SCHEMAFULL;

-- 追踪链路标识（核心关联键）
DEFINE FIELD IF NOT EXISTS traceId ON marlEpisode TYPE string;
DEFINE INDEX IF NOT EXISTS marl_episode_trace_id_idx ON marlEpisode FIELDS traceId;

-- 关联决策 ID
DEFINE FIELD IF NOT EXISTS decisionId ON marlEpisode TYPE record<decision>;

-- Episode 序号
DEFINE FIELD IF NOT EXISTS episodeCount ON marlEpisode TYPE int;

-- 全局状态向量
DEFINE FIELD IF NOT EXISTS globalState ON marlEpisode TYPE array;

-- 本地观察向量
DEFINE FIELD IF NOT EXISTS localObs ON marlEpisode TYPE array;

-- CPU 指标
DEFINE FIELD IF NOT EXISTS cpuMetric ON marlEpisode TYPE float;

-- 内存指标
DEFINE FIELD IF NOT EXISTS memoryMetric ON marlEpisode TYPE float;

-- 延迟指标（毫秒）
DEFINE FIELD IF NOT EXISTS latencyMetricMs ON marlEpisode TYPE float;

-- Token 使用指标
DEFINE FIELD IF NOT EXISTS tokenUsed ON marlEpisode TYPE int;
DEFINE FIELD IF NOT EXISTS tokenLimit ON marlEpisode TYPE int;

-- 活跃智能体数
DEFINE FIELD IF NOT EXISTS activeAgentCount ON marlEpisode TYPE int;

-- 活跃工具数
DEFINE FIELD IF NOT EXISTS activeToolCount ON marlEpisode TYPE int;

-- 执行的强化学习动作
DEFINE FIELD IF NOT EXISTS executedAction ON marlEpisode TYPE int;

-- 动作描述
DEFINE FIELD IF NOT EXISTS actionDescription ON marlEpisode TYPE string
    ASSERT $value INSIDE ['NO_OP', 'PERFORMANCE_MODE', 'BALANCED_MODE', 'ECONOMY_MODE', 'EMERGENCY_MODE', 'CIRCUIT_BREAKER']
    DEFAULT 'NO_OP';

-- 奖励值
DEFINE FIELD IF NOT EXISTS reward ON marlEpisode TYPE float DEFAULT 0.0;

-- 策略快照 ID
DEFINE FIELD IF NOT EXISTS policySnapshotId ON marlEpisode TYPE option<string>;

-- 版本控制
DEFINE FIELD IF NOT EXISTS version ON marlEpisode TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD IF NOT EXISTS createdAt ON marlEpisode TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON marlEpisode TYPE datetime DEFAULT time::now();

-- ============================================================
-- v4.2: 建立策略快照表
-- ============================================================
DEFINE TABLE IF NOT EXISTS policySnapshot SCHEMAFULL;

-- 快照标识（ULID）
DEFINE FIELD IF NOT EXISTS snapshotId ON policySnapshot TYPE string;
DEFINE INDEX IF NOT EXISTS policy_snapshot_id_idx ON policySnapshot FIELDS snapshotId UNIQUE;

-- 快照类型
DEFINE FIELD IF NOT EXISTS snapshotType ON policySnapshot TYPE string
    ASSERT $value INSIDE ['training', 'deployment', 'rollback']
    DEFAULT 'training';

-- 策略权重（JSON）
DEFINE FIELD IF NOT EXISTS weights ON policySnapshot TYPE string;

-- 超参数配置（JSON）
DEFINE FIELD IF NOT EXISTS hyperparameters ON policySnapshot TYPE string;

-- Episode 范围
DEFINE FIELD IF NOT EXISTS episodeRangeStart ON policySnapshot TYPE int;
DEFINE FIELD IF NOT EXISTS episodeRangeEnd ON policySnapshot TYPE int;

-- 性能指标
DEFINE FIELD IF NOT EXISTS meanReward ON policySnapshot TYPE float;
DEFINE FIELD IF NOT EXISTS successRate ON policySnapshot TYPE float;
DEFINE FIELD IF NOT EXISTS avgLatencyMs ON policySnapshot TYPE float;

-- 状态
DEFINE FIELD IF NOT EXISTS status ON policySnapshot TYPE string
    ASSERT $value INSIDE ['training', 'validated', 'deployed', 'archived']
    DEFAULT 'training';

-- 版本控制
DEFINE FIELD IF NOT EXISTS version ON policySnapshot TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD IF NOT EXISTS createdAt ON policySnapshot TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON policySnapshot TYPE datetime DEFAULT time::now();

-- ============================================================
-- v4.3: 建立资源调度状态表
-- ============================================================
DEFINE TABLE IF NOT EXISTS governorState SCHEMAFULL;

-- 状态标识
DEFINE FIELD IF NOT EXISTS stateId ON governorState TYPE string;
DEFINE INDEX IF NOT EXISTS governor_state_id_idx ON governorState FIELDS stateId UNIQUE;

-- CPU 使用率
DEFINE FIELD IF NOT EXISTS cpuUsage ON governorState TYPE float;

-- 内存使用率
DEFINE FIELD IF NOT EXISTS memoryUsage ON governorState TYPE float;

-- Token 预算
DEFINE FIELD IF NOT EXISTS tokenBudget ON governorState TYPE float;
DEFINE FIELD IF NOT EXISTS tokenUsed ON governorState TYPE float;
DEFINE FIELD IF NOT EXISTS tokenRemaining ON governorState TYPE float;

-- 当前延迟（毫秒）
DEFINE FIELD IF NOT EXISTS latencyMs ON governorState TYPE float;

-- 活跃智能体数
DEFINE FIELD IF NOT EXISTS activeAgents ON governorState TYPE int;

-- 活跃工具数
DEFINE FIELD IF NOT EXISTS activeTools ON governorState TYPE int;

-- 运行模式
DEFINE FIELD IF NOT EXISTS mode ON governorState TYPE string
    ASSERT $value INSIDE ['performance', 'balanced', 'economy', 'emergency']
    DEFAULT 'balanced';

-- 负载等级
DEFINE FIELD IF NOT EXISTS loadLevel ON governorState TYPE string
    ASSERT $value INSIDE ['normal', 'warning', 'critical', 'overload']
    DEFAULT 'normal';

-- 负载指标
DEFINE FIELD IF NOT EXISTS loadScore ON governorState TYPE float DEFAULT 0.0;

-- 版本控制
DEFINE FIELD IF NOT EXISTS version ON governorState TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD IF NOT EXISTS createdAt ON governorState TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON governorState TYPE datetime DEFAULT time::now();

-- ============================================================
-- v4.4: 建立调度策略规则表
-- ============================================================
DEFINE TABLE IF NOT EXISTS governorPolicy SCHEMAFULL;

-- 策略名称
DEFINE FIELD IF NOT EXISTS name ON governorPolicy TYPE string;
DEFINE INDEX IF NOT EXISTS governor_policy_name_idx ON governorPolicy FIELDS name UNIQUE;

-- 触发条件（JSON）
DEFINE FIELD IF NOT EXISTS condition ON governorPolicy TYPE string;

-- 执行动作
DEFINE FIELD IF NOT EXISTS action ON governorPolicy TYPE string;

-- 优先级
DEFINE FIELD IF NOT EXISTS priority ON governorPolicy TYPE int;

-- 冷却时间（秒）
DEFINE FIELD IF NOT EXISTS cooldownSeconds ON governorPolicy TYPE int DEFAULT 0;

-- 状态
DEFINE FIELD IF NOT EXISTS status ON governorPolicy TYPE string
    ASSERT $value INSIDE ['active', 'inactive', 'cooldown']
    DEFAULT 'active';

-- 上次触发时间
DEFINE FIELD IF NOT EXISTS lastTriggeredAt ON governorPolicy TYPE option<datetime>;

-- 版本控制
DEFINE FIELD IF NOT EXISTS version ON governorPolicy TYPE int DEFAULT 1;

-- 时间戳
DEFINE FIELD IF NOT EXISTS createdAt ON governorPolicy TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON governorPolicy TYPE datetime DEFAULT time::now();
