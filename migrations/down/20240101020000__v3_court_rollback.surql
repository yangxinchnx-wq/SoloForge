-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Migration Rollback: v3_court - 法庭治理链路回滚
-- Version: v3_court
-- Description: 回滚 v3_court 的所有变更
-- ─────────────────────────────────────────────────────────────────

-- 删除 v3.4: 法庭陪审团成员表
REMOVE TABLE courtJuror;

-- 删除 v3.3: 法庭裁决表
REMOVE TABLE courtVerdict;

-- 删除 v3.2: 法庭盲审提交表
REMOVE TABLE courtSubmission;

-- 删除 v3.1: 证据表
REMOVE TABLE evidence;
