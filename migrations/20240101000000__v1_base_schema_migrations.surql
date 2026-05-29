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
DEFINE TABLE migration_history SCHEMAFULL;

-- 主键
DEFINE FIELD id ON migration_history TYPE record<migration_history>;

-- 迁移版本标识（唯一约束）
DEFINE FIELD version ON migration_history TYPE string;
DEFINE INDEX migration_version_idx ON migration_history FIELDS version UNIQUE;

-- 迁移名称
DEFINE FIELD name ON migration_history TYPE string;

-- 迁移状态枚举
DEFINE FIELD status ON migration_history TYPE string
    ASSERT $value INSIDE ['pending', 'applied', 'rolled_back', 'failed'];

-- 迁移类型
DEFINE FIELD direction ON migration_history TYPE string
    ASSERT $value INSIDE ['up', 'down'];

-- 校验和（用于完整性校验）
DEFINE FIELD checksum ON migration_history TYPE string;

-- 执行时间
DEFINE FIELD appliedAt ON migration_history TYPE datetime DEFAULT time::now();

-- 回滚时间
DEFINE FIELD rolledBackAt ON migration_history TYPE datetime;

-- 错误信息（失败时记录）
DEFINE FIELD errorMessage ON migration_history TYPE option<string>;

-- 执行者
DEFINE FIELD executedBy ON migration_history TYPE string DEFAULT 'system';

-- 元数据（保留扩展字段）
DEFINE FIELD metadata ON migration_history TYPE option<object>;

-- 时间戳
DEFINE FIELD createdAt ON migration_history TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON migration_history TYPE datetime DEFAULT time::now();

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
DEFINE TABLE system_config SCHEMAFULL;

DEFINE FIELD id ON system_config TYPE record<system_config>;
DEFINE FIELD key ON system_config TYPE string;
DEFINE INDEX system_config_key_idx ON system_config FIELDS key UNIQUE;
DEFINE FIELD value ON system_config TYPE string;
DEFINE FIELD description ON system_config TYPE option<string>;
DEFINE FIELD category ON system_config TYPE string DEFAULT 'general';
DEFINE FIELD isLocked ON system_config TYPE bool DEFAULT false;
DEFINE FIELD createdAt ON system_config TYPE datetime DEFAULT time::now();
DEFINE FIELD updatedAt ON system_config TYPE datetime DEFAULT time::now();
