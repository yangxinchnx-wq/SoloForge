-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Migration Rollback: v5_events - 事件审计链路回滚
-- Version: v5_events
-- Description: 回滚 v5_events 的所有变更
-- ─────────────────────────────────────────────────────────────────

-- 回滚顺序：先删除依赖表，再删除基础表

-- 删除 v5.5: 审计合规表
REMOVE TABLE auditCompliance;

-- 删除 v5.4: 回放会话表
REMOVE TABLE replaySession;

-- 删除 v5.3: 全链路事件序列表
REMOVE TABLE eventSequence;

-- 删除 v5.2: 全链路追踪表
REMOVE TABLE traceLinkage;

-- 删除 v5.1: 内核事件审计日志表
REMOVE TABLE eventLog;
