# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Governance Service

治理服务
"""

import logging
from datetime import datetime
from typing import List, Optional

from ..database.manager import DatabaseManager
from ..models.governance import Governance, GovernanceRecord
from ..models.institution import Institution

logger = logging.getLogger(__name__)


class GovernanceService:
    """
    治理服务

    管理制度的执行和效果评估
    """

    def __init__(self, db_manager: DatabaseManager):
        self.db_manager = db_manager
        self._init_table()

    def _init_table(self) -> None:
        """初始化表"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()

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

        # 创建索引
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_governance_institution ON governance(institution_id)
        """)

        conn.commit()

    def create(
        self,
        institution_id: str,
        owner: str,
        description: Optional[str] = None,
    ) -> Governance:
        """创建治理记录"""
        governance = Governance(
            institution_id=institution_id,
            owner=owner,
            description=description,
        )

        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO governance (id, institution_id, owner, effectiveness, violations, last_review, description, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                governance.id,
                governance.institution_id,
                governance.owner,
                governance.effectiveness,
                governance.violations,
                governance.last_review.isoformat(),
                governance.description,
                governance.notes,
                governance.created_at.isoformat(),
                governance.updated_at.isoformat(),
            ),
        )
        conn.commit()

        logger.info(f"Created governance: {governance.id} for institution {institution_id}")
        return governance

    def get(self, governance_id: str) -> Optional[Governance]:
        """获取治理记录"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM governance WHERE id = ?", (governance_id,))
        row = cursor.fetchone()

        if not row:
            return None

        return Governance(
            id=row["id"],
            institution_id=row["institution_id"],
            owner=row["owner"],
            effectiveness=row["effectiveness"],
            violations=row["violations"],
            last_review=datetime.fromisoformat(row["last_review"]),
            description=row["description"],
            notes=row["notes"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    def get_by_institution(self, institution_id: str) -> Optional[Governance]:
        """根据制度 ID 获取治理记录"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM governance WHERE institution_id = ?",
            (institution_id,),
        )
        row = cursor.fetchone()

        if not row:
            return None

        return Governance(
            id=row["id"],
            institution_id=row["institution_id"],
            owner=row["owner"],
            effectiveness=row["effectiveness"],
            violations=row["violations"],
            last_review=datetime.fromisoformat(row["last_review"]),
            description=row["description"],
            notes=row["notes"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    def record_compliance(
        self,
        governance_id: str,
        agent_id: str,
        compliant: bool,
        action_taken: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> GovernanceRecord:
        """
        记录合规性检查

        Args:
            governance_id: 治理记录 ID
            agent_id: Agent ID
            compliant: 是否合规
            action_taken: 采取的行动
            notes: 备注

        Returns:
            记录
        """
        record = GovernanceRecord(
            governance_id=governance_id,
            agent_id=agent_id,
            compliant=compliant,
            action_taken=action_taken,
            notes=notes,
        )

        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()

        cursor.execute(
            """
            INSERT INTO governance_record (id, governance_id, agent_id, compliant, action_taken, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record.id,
                record.governance_id,
                record.agent_id,
                1 if record.compliant else 0,
                record.action_taken,
                record.notes,
                record.created_at.isoformat(),
            ),
        )

        # 更新治理统计
        if not compliant:
            cursor.execute(
                """
                UPDATE governance SET violations = violations + 1, last_review = ?, updated_at = ?
                WHERE id = ?
                """,
                (datetime.now().isoformat(), datetime.now().isoformat(), governance_id),
            )

        conn.commit()

        logger.info(
            f"Recorded compliance check: {agent_id} - {'compliant' if compliant else 'violation'}"
        )
        return record

    def update_effectiveness(self, governance_id: str, effectiveness: float) -> None:
        """更新治理效果"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE governance SET effectiveness = ?, last_review = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                max(0.0, min(1.0, effectiveness)),
                datetime.now().isoformat(),
                datetime.now().isoformat(),
                governance_id,
            ),
        )
        conn.commit()

    def get_all(self) -> List[Governance]:
        """获取所有治理记录"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM governance ORDER BY created_at DESC")

        governances = []
        for row in cursor.fetchall():
            governances.append(
                Governance(
                    id=row["id"],
                    institution_id=row["institution_id"],
                    owner=row["owner"],
                    effectiveness=row["effectiveness"],
                    violations=row["violations"],
                    last_review=datetime.fromisoformat(row["last_review"]),
                    description=row["description"],
                    notes=row["notes"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                    updated_at=datetime.fromisoformat(row["updated_at"]),
                )
            )

        return governances
