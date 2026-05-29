-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Migration Rollback: v2_decision - 决策链路回滚
-- Version: v2_decision
-- Description: 回滚 v2_decision 的所有变更
-- ─────────────────────────────────────────────────────────────────

-- 删除 v2.3: 决策策略配置表
REMOVE TABLE decision_strategy;

-- 删除 v2.2: 候选模型评分表
REMOVE TABLE candidate;

-- 删除 v2.1: 流控决策主表
REMOVE TABLE decision;
