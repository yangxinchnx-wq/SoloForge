-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Migration Rollback: v4_governor - 训练与策略链路回滚
-- Version: v4_governor
-- Description: 回滚 v4_governor 的所有变更
-- ─────────────────────────────────────────────────────────────────

-- 删除 v4.4: 调度策略规则表
REMOVE TABLE governorPolicy;

-- 删除 v4.3: 资源调度状态表
REMOVE TABLE governorState;

-- 删除 v4.2: 策略快照表
REMOVE TABLE policySnapshot;

-- 删除 v4.1: MAPPO 控流遥测特征历史表
REMOVE TABLE marlEpisode;
