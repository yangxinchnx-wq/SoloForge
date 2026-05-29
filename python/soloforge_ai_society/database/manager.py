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
│       └── LanceDB (social_memory)    ← 社会记忆向量搜索                    │
│                                                                             │
│   隔离原则：                                                                 │
│   • AI 社会数据库禁止被主项目直接访问                                         │
│   • 主项目通过 Node.js ↔ Python IPC 通信获取数据                             │
│   • 数据存储路径独立：data/ai_society/                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

技术选型理由：
- SQLite：嵌入式 OLTP，零配置，高可靠，适合结构化业务数据
- LanceDB：嵌入式向量数据库，支持语义搜索，适合社会记忆检索

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import logging
from pathlib import Path
from typing import Optional

import sqlite3

import lancedb

from ..config import AISocietyConfig, get_config
from ..models.institution import Institution, PRESET_INSTITUTIONS
from ..models.culture import Culture, PRESET_CULTURES

logger = logging.getLogger(__name__)


class DatabaseManager:
    """
    数据库管理器

    统一管理：
    - SQLite：结构化数据（Institution/Governance/Reputation/Culture/Economy/Law/Coalition）
    - LanceDB：向量数据（Social Memory）
    """

    def __init__(self, config: Optional[AISocietyConfig] = None):
        self.config = config or get_config()
        self._sqlite_conn: Optional[sqlite3.Connection] = None
        self._lancedb: Optional[lancedb.LanceDB] = None

    # =========================================================================
    # SQLite 管理
    # =========================================================================

    def get_sqlite_connection(self) -> sqlite3.Connection:
        """获取 SQLite 连接"""
        if self._sqlite_conn is None:
            self._init_sqlite()
        return self._sqlite_conn

    def _init_sqlite(self) -> None:
        """初始化 SQLite 数据库"""
        conn = sqlite3.connect(str(self.config.sqlite_path))
        conn.row_factory = sqlite3.Row

        # 启用 WAL 模式和优化配置
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA cache_size = -64000")  # 64MB
        conn.execute("PRAGMA foreign_keys = ON")

        # 创建表
        self._create_tables(conn)

        self._sqlite_conn = conn
        logger.info(f"SQLite initialized: {self.config.sqlite_path}")

    def _create_tables(self, conn: sqlite3.Connection) -> None:
        """创建所有表"""
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

        conn.commit()

    # =========================================================================
    # LanceDB 管理
    # =========================================================================

    def get_lancedb(self) -> lancedb.LanceDB:
        """获取 LanceDB 实例"""
        if self._lancedb is None:
            self._init_lancedb()
        return self._lancedb

    def _init_lancedb(self) -> None:
        """初始化 LanceDB 数据库"""
        db = lancedb.connect(str(self.config.lancedb_path))
        self._lancedb = db
        logger.info(f"LanceDB initialized: {self.config.lancedb_path}")

    # =========================================================================
    # 初始化
    # =========================================================================

    def initialize(self) -> None:
        """初始化所有数据库"""
        # 初始化 SQLite
        self.get_sqlite_connection()

        # 初始化 LanceDB
        self.get_lancedb()

        # 初始化预设数据
        self._init_preset_data()

        logger.info("All databases initialized successfully")

    def _init_preset_data(self) -> None:
        """初始化预设数据"""
        conn = self.get_sqlite_connection()
        cursor = conn.cursor()

        # 初始化预置制度
        for inst in PRESET_INSTITUTIONS:
            cursor.execute(
                "INSERT OR IGNORE INTO institution (id, name, rules, scope, enforcement, priority, agent_id, task_type, domain, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                "INSERT OR IGNORE INTO culture (id, principle, adoption_rate, evidence, description, target_rate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
    # 资源清理
    # =========================================================================

    def close(self) -> None:
        """关闭所有数据库连接"""
        if self._sqlite_conn:
            self._sqlite_conn.close()
            self._sqlite_conn = None

        if self._lancedb:
            # LanceDB 是嵌入式，不需要显式关闭
            self._lancedb = None

        logger.info("Databases closed")


# 全局实例
_db_manager: Optional[DatabaseManager] = None


def get_db_manager() -> DatabaseManager:
    """获取全局数据库管理器"""
    global _db_manager
    if _db_manager is None:
        _db_manager = DatabaseManager()
        _db_manager.initialize()
    return _db_manager
