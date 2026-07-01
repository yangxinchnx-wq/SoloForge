# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Database Manager

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  AI 社会专用数据库 ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

本模块使用的数据库与主项目（SurrealDB）完全隔离，仅供 AI 社会模块使用。

┌─────────────────────────────────────────────────────────────────────────────┐
│  数据隔离架构                                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   SoloForge 主项目                                                          │
│   ├── SurrealDB (surrealkv://)  ← 决策、仲裁、审计、事件日志               │
│   │                                                                          │
│   └── AI 社会模块（独立）                                                    │
│       ├── SQLite (ai_society.db)     ← 制度/信誉/经济/法律/联盟            │
│       └── Qdrant (6333/6334)         ← 社会记忆向量搜索 (MiniLM 384-dim)  │
│                                                                             │
│   隔离原则：                                                                 │
│   • AI 社会数据库禁止被主项目直接访问                                         │
│   • 主项目通过 Node.js ↔ Python IPC 通信获取数据                             │
│   • 数据存储路径独立：data/ai_society/                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

技术选型理由：
- SQLite + ConnectionPool：嵌入式 OLTP，零配置，高可靠，适合结构化业务数据
- Qdrant：生产级向量数据库（外置进程 6333/6334），支持 int8 量化 (P7)，适合语义检索社会记忆

新特性：
- 连接池：多连接复用，提升并发性能
- 迁移系统：Schema 版本管理，支持升级/回滚
- 健康检查：数据库状态监控
- 自动备份：定时备份机制

升级 2026-07-01: 移除 LanceDB / TF-IDF 全部代码
- 旧 import lancedb / get_lancedb() / _init_lancedb() / _lancedb 已删除
- 向量检索改用 QdrantVectorSearch (services/qdrant_client.py + vector/qdrant_adapter.py)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import logging
from pathlib import Path
from typing import Optional

from ..config import AISocietyConfig, get_config
from ..models.institution import Institution, PRESET_INSTITUTIONS
from ..models.culture import Culture, PRESET_CULTURES

from .pool import ConnectionPool, get_pool, close_pool
from .migration import run_migrations, get_migration_status

logger = logging.getLogger(__name__)


class DatabaseManager:
    """
    数据库管理器

    统一管理：
    - SQLite：结构化数据（Institution/Governance/Reputation/Culture/Economy/Law/Coalition）
    - ConnectionPool：连接池管理
    - Migration：Schema 迁移
    """

    def __init__(self, config: Optional[AISocietyConfig] = None):
        self.config = config or get_config()
        self._pool: Optional[ConnectionPool] = None

    # =========================================================================
    # 连接池管理
    # =========================================================================

    @property
    def pool(self) -> ConnectionPool:
        """获取连接池"""
        if self._pool is None:
            self._init_pool()
        return self._pool

    def _init_pool(self) -> None:
        """初始化连接池"""
        self._pool = ConnectionPool(
            db_path=self.config.sqlite_path,
            max_connections=5,
            timeout=30.0,
        )

        # 启动自动 WAL 检查点（每 5 分钟）
        self._pool.start_auto_checkpoint(interval_seconds=300)

        logger.info(f"Connection pool initialized: {self.config.sqlite_path}")

    def get_sqlite_connection(self):
        """获取 SQLite 连接（兼容旧接口）"""
        return self.pool.get_connection()

    # =========================================================================
    # 迁移管理
    # =========================================================================

    def run_migrations(self) -> int:
        """运行待处理的迁移"""
        return run_migrations(self.config.sqlite_path)

    def get_migration_status(self) -> dict:
        """获取迁移状态"""
        return get_migration_status(self.config.sqlite_path)

    # =========================================================================
    # Schema 初始化
    # =========================================================================

    def _create_tables(self) -> None:
        """创建所有表"""
        cursor = self.pool.execute("SELECT 1")

        with self.pool.connection() as conn:
            cursor = conn.cursor()

            # Institution 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS institution (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    rules TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    enforcement TEXT NOT NULL,
                    priority INTEGER DEFAULT 50,
                    agent_id TEXT,
                    task_type TEXT,
                    domain TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            # Governance 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS governance (
                    id TEXT PRIMARY KEY,
                    institution_id TEXT NOT NULL,
                    owner TEXT NOT NULL,
                    effectiveness REAL DEFAULT 1.0,
                    violations INTEGER DEFAULT 0,
                    last_review TEXT NOT NULL,
                    description TEXT,
                    notes TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (institution_id) REFERENCES institution(id)
                )
            """)

            # Reputation 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS reputation (
                    id TEXT PRIMARY KEY,
                    entity_id TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    score REAL DEFAULT 1.0,
                    evidence TEXT NOT NULL,
                    history TEXT NOT NULL,
                    name TEXT,
                    description TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            # Culture 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS culture (
                    id TEXT PRIMARY KEY,
                    principle TEXT NOT NULL UNIQUE,
                    adoption_rate REAL DEFAULT 0.0,
                    evidence TEXT NOT NULL,
                    description TEXT,
                    target_rate REAL DEFAULT 0.9,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            # Economy 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS economy (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL UNIQUE,
                    credits REAL DEFAULT 1000.0,
                    balance REAL DEFAULT 0.0,
                    spending TEXT NOT NULL,
                    income TEXT NOT NULL,
                    name TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            # Law 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS law (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    description TEXT,
                    condition TEXT NOT NULL,
                    consequence TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    appeals INTEGER DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            # Law Violation 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS law_violation (
                    id TEXT PRIMARY KEY,
                    law_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    violation_context TEXT NOT NULL,
                    consequence_applied TEXT NOT NULL,
                    status TEXT DEFAULT 'active',
                    appeal_reason TEXT,
                    appeal_result TEXT,
                    created_at TEXT NOT NULL,
                    resolved_at TEXT,
                    FOREIGN KEY (law_id) REFERENCES law(id)
                )
            """)

            # Coalition 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS coalition (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    description TEXT,
                    goal TEXT NOT NULL,
                    members TEXT NOT NULL,
                    leader TEXT NOT NULL,
                    lifetime INTEGER DEFAULT 3600,
                    status TEXT DEFAULT 'forming',
                    dissolved_reason TEXT,
                    created_at TEXT NOT NULL
                )
            """)

            # Social Memory 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS social_memory (
                    id TEXT PRIMARY KEY,
                    event TEXT NOT NULL,
                    impact TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    participants TEXT NOT NULL,
                    lessons TEXT NOT NULL,
                    task_id TEXT,
                    domain TEXT,
                    outcome TEXT,
                    created_at TEXT NOT NULL
                )
            """)

            # 创建索引
            self._create_indexes(cursor)

            conn.commit()

    def _create_indexes(self, cursor) -> None:
        """创建索引"""
        indexes = [
            ("idx_reputation_entity", "reputation", "entity_id, entity_type"),
            ("idx_memory_severity", "social_memory", "severity"),
            ("idx_memory_impact", "social_memory", "impact"),
            ("idx_governance_institution", "governance", "institution_id"),
            ("idx_economy_agent", "economy", "agent_id"),
            ("idx_law_violation_law", "law_violation", "law_id"),
            ("idx_law_violation_agent", "law_violation", "agent_id"),
            ("idx_coalition_status", "coalition", "status"),
        ]

        for idx_name, table, columns in indexes:
            cursor.execute(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table}({columns})")

    # =========================================================================
    # 预设数据
    # =========================================================================

    def _init_preset_data(self) -> None:
        """初始化预设数据"""
        with self.pool.connection() as conn:
            cursor = conn.cursor()

            # 初始化预置制度
            for inst in PRESET_INSTITUTIONS:
                cursor.execute(
                    """INSERT OR IGNORE INTO institution
                       (id, name, rules, scope, enforcement, priority, agent_id, task_type, domain, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        inst.id,
                        inst.name,
                        ",".join(inst.rules),
                        inst.scope.value,
                        inst.enforcement.value,
                        inst.priority,
                        inst.agent_id,
                        inst.task_type,
                        inst.domain,
                        inst.created_at.isoformat(),
                        inst.updated_at.isoformat(),
                    ),
                )

            # 初始化预置文化
            for culture in PRESET_CULTURES:
                cursor.execute(
                    """INSERT OR IGNORE INTO culture
                       (id, principle, adoption_rate, evidence, description, target_rate, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        culture.id,
                        culture.principle,
                        culture.adoption_rate,
                        ",".join(culture.evidence),
                        culture.description,
                        culture.target_rate,
                        culture.created_at.isoformat(),
                        culture.updated_at.isoformat(),
                    ),
                )

            conn.commit()

    # =========================================================================
    # 初始化
    # =========================================================================

    def initialize(self) -> None:
        """初始化所有数据库"""
        # 确保数据目录存在
        self.config.data_dir.mkdir(parents=True, exist_ok=True)

        # 1. 运行迁移
        migrated = self.run_migrations()
        if migrated > 0:
            logger.info(f"Applied {migrated} migration(s)")

        # 2. 初始化连接池
        _ = self.pool

        # 3. 创建表
        self._create_tables()

        # 4. 初始化预设数据
        self._init_preset_data()

        # 5. 向量检索由 QdrantVectorSearch (services/qdrant_client.py) 懒初始化
        #    AI Society 进程启动时已通过独立初始化保证 Qdrant 可用, 此处不重复连接

        logger.info("All databases initialized successfully")

    # =========================================================================
    # 资源清理
    # =========================================================================

    def close(self) -> None:
        """关闭所有数据库连接"""
        if self._pool:
            self._pool.close_all()
            self._pool = None

        logger.info("Databases closed")

    def vacuum(self) -> None:
        """整理数据库"""
        if self._pool:
            self._pool.vacuum()
            logger.info("Database vacuumed")

    def checkpoint(self) -> None:
        """执行 WAL 检查点"""
        if self._pool:
            self._pool.checkpoint()

    def get_pool_stats(self) -> dict:
        """获取连接池统计"""
        if self._pool:
            return self._pool.get_stats()
        return {}


# =============================================================================
# 全局实例
# =============================================================================

_db_manager: Optional[DatabaseManager] = None


def get_db_manager() -> DatabaseManager:
    """获取全局数据库管理器"""
    global _db_manager
    if _db_manager is None:
        _db_manager = DatabaseManager()
        _db_manager.initialize()
    return _db_manager
