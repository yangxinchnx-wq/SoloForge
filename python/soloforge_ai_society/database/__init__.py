# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Database Package

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  AI 社会专用数据库 ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

本模块使用的数据库与主项目（SurrealDB）完全隔离，仅供 AI 社会模块使用。

架构：
- ConnectionPool: 连接池管理
- DatabaseManager: 数据库管理器
- MigrationManager: 迁移系统
- HealthChecker: 健康检查
- BackupManager: 备份管理

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

from .manager import DatabaseManager, get_db_manager
from .pool import ConnectionPool, get_pool, close_pool
from .migration import MigrationManager, run_migrations, get_migration_status, CURRENT_VERSION
from .health import (
    HealthChecker,
    BackupManager,
    HealthStatus,
    BackupInfo,
    run_health_check,
    create_backup,
)

__all__ = [
    # 核心
    "DatabaseManager",
    "get_db_manager",
    # 连接池
    "ConnectionPool",
    "get_pool",
    "close_pool",
    # 迁移
    "MigrationManager",
    "run_migrations",
    "get_migration_status",
    "CURRENT_VERSION",
    # 健康与备份
    "HealthChecker",
    "BackupManager",
    "HealthStatus",
    "BackupInfo",
    "run_health_check",
    "create_backup",
]
