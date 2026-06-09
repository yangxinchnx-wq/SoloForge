-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Migration: v1_base - 基础架构与迁移状态表
-- Version: v1_base
-- Description: 建立迁移版本管理基础设施（migration_history 表）
-- Author: Backend/Data Team
-- Created: 2024-01-01
-- ─────────────────────────────────────────────────────────────────

-- ============================================================
-- v1.1: 建立迁移历史记录表（核心幂等保障）
-- ============================================================
DEFINE TABLE IF NOT EXISTS migration_history SCHEMAFULL;

-- 主键 (SurrealDB 自动管理 id,不需要 DEFINE FIELD id)

-- 迁移版本标识（唯一约束）
DEFINE FIELD IF NOT EXISTS version ON migration_history TYPE string;
DEFINE INDEX IF NOT EXISTS migration_version_idx ON migration_history FIELDS version UNIQUE;

-- 迁移名称
DEFINE FIELD IF NOT EXISTS name ON migration_history TYPE string;

-- 迁移状态枚举
DEFINE FIELD IF NOT EXISTS status ON migration_history TYPE string
    ASSERT $value INSIDE ['pending', 'applied', 'rolled_back', 'failed'];

-- 迁移类型
DEFINE FIELD IF NOT EXISTS direction ON migration_history TYPE string
    ASSERT $value INSIDE ['up', 'down'];

-- 校验和（用于完整性校验）
DEFINE FIELD IF NOT EXISTS checksum ON migration_history TYPE string;

-- 执行时间
DEFINE FIELD IF NOT EXISTS appliedAt ON migration_history TYPE datetime DEFAULT time::now();

-- 回滚时间
DEFINE FIELD IF NOT EXISTS rolledBackAt ON migration_history TYPE datetime;

-- 错误信息（失败时记录）
DEFINE FIELD IF NOT EXISTS errorMessage ON migration_history TYPE option<string>;

-- 执行者
DEFINE FIELD IF NOT EXISTS executedBy ON migration_history TYPE string DEFAULT 'system';

-- 元数据（保留扩展字段）
DEFINE FIELD IF NOT EXISTS metadata ON migration_history TYPE option<object>;

-- 时间戳
DEFINE FIELD IF NOT EXISTS createdAt ON migration_history TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON migration_history TYPE datetime DEFAULT time::now();

-- ============================================================
-- v1.2: 建立命名空间和数据库（首次启动时执行一次）
-- ============================================================
-- 注意：这些命令仅在全新环境执行，已有环境跳过
-- DEFINE NAMESPACE soloforge_core;  -- 已在连接时指定
-- DEFINE DATABASE autonomous_network; -- 已在连接时指定

-- ============================================================
-- v1.3: 验证内省表（SurrealDB 内置）
-- ============================================================
-- SurrealDB 自带内置表用于追踪系统状态，我们复用其能力

-- ============================================================
-- v1.4: 建立系统配置表（全局开关）
-- ============================================================
DEFINE TABLE IF NOT EXISTS system_config SCHEMAFULL;

-- 主键 id 由 SurrealDB 自动管理
DEFINE FIELD IF NOT EXISTS key ON system_config TYPE string;
DEFINE INDEX IF NOT EXISTS system_config_key_idx ON system_config FIELDS key UNIQUE;
DEFINE FIELD IF NOT EXISTS value ON system_config TYPE string;
DEFINE FIELD IF NOT EXISTS description ON system_config TYPE option<string>;
DEFINE FIELD IF NOT EXISTS category ON system_config TYPE string DEFAULT 'general';
DEFINE FIELD IF NOT EXISTS isLocked ON system_config TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS createdAt ON system_config TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON system_config TYPE datetime DEFAULT time::now();
