-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Migration Rollback: v1_base - 基础架构回滚
-- Version: v1_base
-- Description: 回滚 v1_base 的所有变更（谨慎操作！）
-- 注意：此回滚仅在完全清空环境时使用
-- ─────────────────────────────────────────────────────────────────

-- 删除 v1.4: 系统配置表
REMOVE TABLE system_config;

-- 删除 v1.1: 迁移历史记录表
REMOVE TABLE migration_history;
