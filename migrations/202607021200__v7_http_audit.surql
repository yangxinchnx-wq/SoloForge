-- ─────────────────────────────────────────────────────────────────
-- SoloForge Database Migration: v7_http_audit
-- Version: v7_http_audit
-- Description: HTTP 请求审计日志持久化表 (替代 stdout sink)
-- Author: Backend Team
-- Created: 2026-07-02
-- Dependencies: v5_event_audit
--
-- 设计动机:
--   之前 AuditSink 默认只输出到 stdout, 生产环境无法检索/告警
--   现在 AuditSinkSurreal 写本表 + 同时 mirror 到 stdout (双写)
--
-- 与 v5 auditCompliance 的区别:
--   - auditCompliance: 业务层审计 (data_access / config_change 等)
--   - httpAuditLog:    HTTP 层审计 (auth.fail / rate.limit 等)
-- ─────────────────────────────────────────────────────────────────

-- ============================================================
-- v7.1: HTTP 请求审计日志
-- ============================================================
DEFINE TABLE IF NOT EXISTS httpAuditLog SCHEMAFULL;

-- 请求唯一 ID (X-Request-Id 或自动生成)
DEFINE FIELD IF NOT EXISTS id ON httpAuditLog TYPE string;
DEFINE INDEX IF NOT EXISTS http_audit_id_idx ON httpAuditLog FIELDS id UNIQUE;

-- 时间戳 (ms epoch, 与 AuditEvent.timestamp 对齐)
DEFINE FIELD IF NOT EXISTS timestamp ON httpAuditLog TYPE datetime;
DEFINE INDEX IF NOT EXISTS http_audit_timestamp_idx ON httpAuditLog FIELDS timestamp;

-- 事件动作 (auth.ok / auth.fail / rate.limit.* / vault.read / etc.)
DEFINE FIELD IF NOT EXISTS action ON httpAuditLog TYPE string;
DEFINE INDEX IF NOT EXISTS http_audit_action_idx ON httpAuditLog FIELDS action;

-- 路由 (e.g. /api/agents/snapshot)
DEFINE FIELD IF NOT EXISTS route ON httpAuditLog TYPE string;
DEFINE INDEX IF NOT EXISTS http_audit_route_idx ON httpAuditLog FIELDS route;

-- HTTP method
DEFINE FIELD IF NOT EXISTS method ON httpAuditLog TYPE string;

-- 响应状态码
DEFINE FIELD IF NOT EXISTS status ON httpAuditLog TYPE int;
DEFINE INDEX IF NOT EXISTS http_audit_status_idx ON httpAuditLog FIELDS status;

-- 主体身份 (operator / admin / loopback / anonymous)
DEFINE FIELD IF NOT EXISTS principalId ON httpAuditLog TYPE option<string>;
DEFINE FIELD IF NOT EXISTS principalRole ON httpAuditLog TYPE option<string>;
DEFINE FIELD IF NOT EXISTS principalSource ON httpAuditLog TYPE option<string>;
DEFINE FIELD IF NOT EXISTS principalKid ON httpAuditLog TYPE option<string>;

-- 来源 (已 hash, 不存原始 IP, 防 PII 泄露)
DEFINE FIELD IF NOT EXISTS remoteAddressHash ON httpAuditLog TYPE option<string>;
DEFINE FIELD IF NOT EXISTS userAgent ON httpAuditLog TYPE option<string>;

-- 失败/告警原因
DEFINE FIELD IF NOT EXISTS reason ON httpAuditLog TYPE option<string>;

-- 复用检测相关 (来自 v2 token family)
DEFINE FIELD IF NOT EXISTS reuseDetected ON httpAuditLog TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS autoRevokedTokens ON httpAuditLog TYPE option<int>;

-- 任意附加字段 (JSON 字符串, 供未来扩展)
DEFINE FIELD IF NOT EXISTS extra ON httpAuditLog TYPE option<string>;

-- 租户 ID (multi-tenant isolation, 缺省 = '_default')
DEFINE FIELD IF NOT EXISTS tenantId ON httpAuditLog TYPE string DEFAULT '_default';
DEFINE INDEX IF NOT EXISTS http_audit_tenant_idx ON httpAuditLog FIELDS tenantId;
DEFINE INDEX IF NOT EXISTS http_audit_tenant_ts_idx ON httpAuditLog FIELDS tenantId, timestamp;

-- 审计自身元数据
DEFINE FIELD IF NOT EXISTS sinkSource ON httpAuditLog TYPE string DEFAULT 'surreal';
DEFINE FIELD IF NOT EXISTS writtenAt ON httpAuditLog TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS http_audit_written_at_idx ON httpAuditLog FIELDS writtenAt;
