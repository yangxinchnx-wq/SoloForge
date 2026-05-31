-- ─────────────────────────────────────────────────────────────────
-- SoloForge Migration: Persistent Trash (回收站持久化)
-- Version: v6_trash
-- Path: migrations/20240101050000__v6_persistent_trash.surql
-- Description: 持久化回收站表 - 支持软删除、过期清理、恢复
-- ─────────────────────────────────────────────────────────────────

-- 定义 trash 表
DEFINE TABLE IF NOT EXISTS trash SCHEMAFULL;

-- 字段定义
DEFINE FIELD IF NOT EXISTS originalId  ON trash TYPE string;
DEFINE FIELD IF NOT EXISTS contentType ON trash TYPE string;
DEFINE FIELD IF NOT EXISTS deletedBy   ON trash TYPE string;
DEFINE FIELD IF NOT EXISTS deletedAt   ON trash TYPE datetime;
DEFINE FIELD IF NOT EXISTS purgesAt    ON trash TYPE datetime;
DEFINE FIELD IF NOT EXISTS payload     ON trash TYPE string;
DEFINE FIELD IF NOT EXISTS reason      ON trash TYPE option<string>;
DEFINE FIELD IF NOT EXISTS restored    ON trash TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS restoredAt  ON trash TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS restoredBy  ON trash TYPE option<string>;

-- 索引：按 originalId 加速恢复查询（同一资源可能多次删除/恢复）
DEFINE INDEX IF NOT EXISTS trash_originalId_idx ON trash FIELDS originalId;

-- 索引：按 purgesAt 加速过期清理
DEFINE INDEX IF NOT EXISTS trash_purgesAt_idx   ON trash FIELDS purgesAt;

-- 索引：按 contentType 分类查询
DEFINE INDEX IF NOT EXISTS trash_contentType_idx ON trash FIELDS contentType;

-- 索引：按 restored 筛选未恢复记录
DEFINE INDEX IF NOT EXISTS trash_restored_idx   ON trash FIELDS restored;
