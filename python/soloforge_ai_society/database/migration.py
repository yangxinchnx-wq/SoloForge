# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Database Migration System

数据库迁移系统

功能：
- Schema 版本管理
- 自动迁移检测
- 支持升级/回滚
- 迁移历史记录
"""

import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

# M1 修复 (2026-07-01, audit P1): raw sqlite3.connect 后调 apply_p6_baseline
# 7 个 PRAGMA 一次性到位, 与 ConnectionPool 同源. 避免散落 5-PRAGMA 模式
from soloforge_ai_society.database.pool import apply_p6_baseline

logger = logging.getLogger(__name__)

# 当前 Schema 版本
CURRENT_VERSION = 3


@dataclass
class Migration:
    """迁移定义"""
    version: int
    description: str
    upgrade: Callable[[sqlite3.Connection], None]
    downgrade: Optional[Callable[[sqlite3.Connection], None]] = None


# =============================================================================
# 迁移脚本
# =============================================================================

def upgrade_to_v2(conn: sqlite3.Connection) -> None:
    """升级到 v2: 添加治理记录表和索引优化"""
    cursor = conn.cursor()

    # Governance Record 表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS governance_record (
            id TEXT PRIMARY KEY,
            governance_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            compliant INTEGER NOT NULL,
            action_taken TEXT,
            notes TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (governance_id) REFERENCES governance(id)
        )
    """)

    # Transaction 表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS credit_transaction (
            id TEXT PRIMARY KEY,
            economy_id TEXT NOT NULL,
            amount REAL NOT NULL,
            transaction_type TEXT NOT NULL,
            category TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (economy_id) REFERENCES economy(id)
        )
    """)

    # Reputation Record 表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS reputation_record (
            id TEXT PRIMARY KEY,
            reputation_id TEXT NOT NULL,
            delta REAL NOT NULL,
            reason TEXT NOT NULL,
            source TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (reputation_id) REFERENCES reputation(id)
        )
    """)

    # Economy Record 表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS economy_record (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            event TEXT NOT NULL,
            credits_change REAL NOT NULL,
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)

    # 添加索引
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_governance_record ON governance_record(governance_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_transaction_economy ON credit_transaction(economy_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_reputation_record ON reputation_record(reputation_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_economy_record_agent ON economy_record(agent_id)")

    conn.commit()
    logger.info("Database upgraded to v2")


def downgrade_from_v2(conn: sqlite3.Connection) -> None:
    """从 v2 回滚"""
    cursor = conn.cursor()

    # 删除新增的表
    cursor.execute("DROP TABLE IF EXISTS governance_record")
    cursor.execute("DROP TABLE IF EXISTS credit_transaction")
    cursor.execute("DROP TABLE IF EXISTS reputation_record")
    cursor.execute("DROP TABLE IF EXISTS economy_record")

    # 删除索引
    cursor.execute("DROP INDEX IF EXISTS idx_governance_record")
    cursor.execute("DROP INDEX IF EXISTS idx_transaction_economy")
    cursor.execute("DROP INDEX IF EXISTS idx_reputation_record")
    cursor.execute("DROP INDEX IF EXISTS idx_economy_record_agent")

    conn.commit()
    logger.info("Database rolled back from v2")


# =============================================================================
# v3 迁移: Agent 身份表 + 训练历史表 + 4 个预置 Agent
# =============================================================================

def upgrade_to_v3(conn: sqlite3.Connection) -> None:
    """升级到 v3: 添加 agent_identity + agent_training_history 表 + 预置 4 个 Agent"""
    cursor = conn.cursor()

    # Agent 身份表 (Java AgentConfig 的权威源)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS agent_identity (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            model_binding TEXT NOT NULL,
            system_prompt TEXT DEFAULT '',
            system_prompt_version INTEGER DEFAULT 0,
            current_checkpoint_path TEXT,
            checkpoint_version INTEGER DEFAULT 0,
            task_count INTEGER DEFAULT 0,
            reputation_id TEXT,
            status TEXT DEFAULT 'active',
            name TEXT,
            avatar TEXT,
            domain TEXT,
            capabilities TEXT DEFAULT '[]',
            strategy TEXT DEFAULT 'direct',
            level TEXT DEFAULT 'senior',
            temperature REAL DEFAULT 0.3,
            max_rounds INTEGER DEFAULT 8,
            enabled INTEGER DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)

    # Agent 训练历史表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS agent_training_history (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            trained_at TEXT NOT NULL,
            trigger_reason TEXT NOT NULL,
            sample_count INTEGER,
            reward_before REAL,
            reward_after REAL,
            prompt_version_before INTEGER,
            prompt_version_after INTEGER,
            checkpoint_path TEXT,
            notes TEXT,
            created_at TEXT NOT NULL
        )
    """)

    # 索引
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_agent_identity_role ON agent_identity(role)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_agent_identity_status ON agent_identity(status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_agent_training_history_agent ON agent_training_history(agent_id)")

    # 预置 4 个默认 Agent (与 Java AgentConfig 对齐)
    now = datetime.now().isoformat()
    preset_agents = [
        {
            "id": "code_agent",
            "role": "EXECUTOR",
            "model_binding": "gpt-4o",
            "system_prompt": "你是 SoloForge 的代码工程师 Agent。专精代码编写、重构、调试、架构设计。优先使用工具查看真实代码,不要猜测。",
            "name": "代码工程师",
            "avatar": "💻",
            "domain": "code-dev",
            "capabilities": '["read","write","search","execute","analyze"]',
            "strategy": "direct",
            "level": "senior",
            "temperature": 0.3,
            "max_rounds": 8,
        },
        {
            "id": "plan_agent",
            "role": "PLANNER",
            "model_binding": "gpt-4o",
            "system_prompt": "你是 SoloForge 的规划师 Agent。专精任务拆解、方案设计、技术选型。先理解需求再给方案,避免直接编码。",
            "name": "规划师",
            "avatar": "📋",
            "domain": "planning",
            "capabilities": '["read","search","analyze"]',
            "strategy": "chain_of_thought",
            "level": "master",
            "temperature": 0.2,
            "max_rounds": 12,
        },
        {
            "id": "debug_agent",
            "role": "REVIEWER",
            "model_binding": "gpt-4o",
            "system_prompt": "你是 SoloForge 的调试专家 Agent。专精 bug 定位、根因分析、修复验证。系统化排查,不要瞎猜。",
            "name": "调试专家",
            "avatar": "🔍",
            "domain": "debugging",
            "capabilities": '["read","search","execute","analyze"]',
            "strategy": "chain_of_thought",
            "level": "expert",
            "temperature": 0.1,
            "max_rounds": 10,
        },
        {
            "id": "doc_agent",
            "role": "EXECUTOR",
            "model_binding": "gpt-4o",
            "system_prompt": "你是 SoloForge 的文档作家 Agent。专精文档撰写、注释、README。语言简洁清晰。",
            "name": "文档作家",
            "avatar": "📝",
            "domain": "documentation",
            "capabilities": '["read","write","search"]',
            "strategy": "direct",
            "level": "senior",
            "temperature": 0.5,
            "max_rounds": 6,
        },
    ]

    # 旧库兼容: 若 agent_identity 表缺少 avatar 列则补上
    try:
        cursor.execute("SELECT avatar FROM agent_identity LIMIT 1")
    except Exception:
        cursor.execute("ALTER TABLE agent_identity ADD COLUMN avatar TEXT")

    for agent in preset_agents:
        cursor.execute("""
            INSERT OR IGNORE INTO agent_identity
            (id, role, model_binding, system_prompt, system_prompt_version,
             task_count, status, name, avatar, domain, capabilities, strategy, level,
             temperature, max_rounds, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, 0, 0, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        """, (
            agent["id"], agent["role"], agent["model_binding"],
            agent["system_prompt"], agent["name"], agent["avatar"], agent["domain"],
            agent["capabilities"], agent["strategy"], agent["level"],
            agent["temperature"], agent["max_rounds"], now, now
        ))

    conn.commit()
    logger.info("Database upgraded to v3: agent_identity + agent_training_history tables created, 4 preset agents inserted")


def downgrade_from_v3(conn: sqlite3.Connection) -> None:
    """从 v3 回滚"""
    cursor = conn.cursor()
    cursor.execute("DROP TABLE IF EXISTS agent_identity")
    cursor.execute("DROP TABLE IF EXISTS agent_training_history")
    cursor.execute("DROP INDEX IF EXISTS idx_agent_identity_role")
    cursor.execute("DROP INDEX IF EXISTS idx_agent_identity_status")
    cursor.execute("DROP INDEX IF EXISTS idx_agent_training_history_agent")
    conn.commit()
    logger.info("Database rolled back from v3")


# 迁移注册表
MIGRATIONS: list[Migration] = [
    Migration(
        version=2,
        description="添加治理记录表、交易表、索引优化",
        upgrade=upgrade_to_v2,
        downgrade=downgrade_from_v2,
    ),
    Migration(
        version=3,
        description="添加 Agent 身份表、训练历史表 + 4 个预置 Agent",
        upgrade=upgrade_to_v3,
        downgrade=downgrade_from_v3,
    ),
]


class MigrationManager:
    """迁移管理器"""

    def __init__(self, db_path: Path):
        self.db_path = db_path

    def _get_current_version(self, conn: sqlite3.Connection) -> int:
        """获取当前数据库版本"""
        cursor = conn.cursor()

        # 检查 schema_version 表是否存在
        cursor.execute("""
            SELECT name FROM sqlite_master
            WHERE type='table' AND name='schema_version'
        """)

        if not cursor.fetchone():
            # 表不存在，这是新数据库
            return 0

        cursor.execute("SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1")
        row = cursor.fetchone()
        return row["version"] if row else 0

    def _ensure_version_table(self, conn: sqlite3.Connection) -> None:
        """确保版本表存在"""
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                description TEXT NOT NULL,
                applied_at TEXT NOT NULL
            )
        """)
        conn.commit()

    def _record_migration(self, conn: sqlite3.Connection, migration: Migration) -> None:
        """记录迁移（修复 2026-07-01: 用 OR IGNORE 兼容已存在的 schema_version 行）"""
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)",
            (migration.version, migration.description, datetime.now().isoformat())
        )
        conn.commit()

    def migrate(self, target_version: int = CURRENT_VERSION) -> int:
        """
        执行迁移

        Args:
            target_version: 目标版本

        Returns:
            迁移的版本数
        """
        conn = sqlite3.connect(str(self.db_path))
        apply_p6_baseline(conn)
        conn.row_factory = sqlite3.Row

        try:
            current_version = self._get_current_version(conn)
            self._ensure_version_table(conn)

            if current_version == target_version:
                logger.info(f"Database already at version {target_version}")
                return 0

            if current_version > target_version:
                # 需要降级
                return self._downgrade(conn, current_version, target_version)
            else:
                # 需要升级
                return self._upgrade(conn, current_version, target_version)

        finally:
            conn.close()

    def _upgrade(self, conn: sqlite3.Connection, from_ver: int, to_ver: int) -> int:
        """升级数据库"""
        applied = 0

        for migration in MIGRATIONS:
            if migration.version > from_ver and migration.version <= to_ver:
                logger.info(f"Applying migration v{migration.version}: {migration.description}")
                migration.upgrade(conn)
                self._record_migration(conn, migration)
                applied += 1

        logger.info(f"Database upgraded from v{from_ver} to v{to_ver}")
        return applied

    def _downgrade(self, conn: sqlite3.Connection, from_ver: int, to_ver: int) -> int:
        """降级数据库"""
        applied = 0

        # 按版本倒序执行
        for migration in reversed(MIGRATIONS):
            if migration.version <= from_ver and migration.version > to_ver:
                if migration.downgrade:
                    logger.info(f"Rolling back migration v{migration.version}: {migration.description}")
                    migration.downgrade(conn)
                    applied += 1

        logger.info(f"Database rolled back from v{from_ver} to v{to_ver}")
        return applied

    def get_status(self) -> dict:
        """获取迁移状态"""
        conn = sqlite3.connect(str(self.db_path))
        apply_p6_baseline(conn)
        conn.row_factory = sqlite3.Row

        try:
            current_version = self._get_current_version(conn)
            self._ensure_version_table(conn)

            cursor = conn.cursor()
            cursor.execute("SELECT * FROM schema_version ORDER BY applied_at DESC")
            history = [dict(row) for row in cursor.fetchall()]

            return {
                "current_version": current_version,
                "target_version": CURRENT_VERSION,
                "needs_migration": current_version < CURRENT_VERSION,
                "history": history,
            }

        finally:
            conn.close()


# 便捷函数
def run_migrations(db_path: Path) -> int:
    """运行所有待处理的迁移"""
    manager = MigrationManager(db_path)
    return manager.migrate()


def get_migration_status(db_path: Path) -> dict:
    """获取迁移状态"""
    manager = MigrationManager(db_path)
    return manager.get_status()
