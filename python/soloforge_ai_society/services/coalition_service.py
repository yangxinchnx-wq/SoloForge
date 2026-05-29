# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Coalition Service

联盟服务
"""

import logging
from datetime import datetime
from typing import List, Optional

from ..config import get_config
from ..database.manager import DatabaseManager
from ..models.coalition import Coalition, CoalitionMember, CoalitionStatus

logger = logging.getLogger(__name__)


class CoalitionService:
    """
    联盟服务

    管理临时组队协作
    """

    def __init__(self, db_manager: DatabaseManager):
        self.db_manager = db_manager
        self.config = get_config()
        self._init_table()

    def _init_table(self) -> None:
        """初始化表"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()

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

    def create(
        self,
        goal: str,
        leader: str,
        initial_members: Optional[List[str]] = None,
        name: Optional[str] = None,
        description: Optional[str] = None,
        lifetime: Optional[int] = None,
    ) -> Coalition:
        """
        创建联盟

        Args:
            goal: 目标
            leader: 领导者
            initial_members: 初始成员
            name: 名称
            description: 描述
            lifetime: 生命周期（秒）

        Returns:
            创建的联盟
        """
        members = [CoalitionMember(agent_id=leader, role="leader")]
        if initial_members:
            for agent_id in initial_members:
                if agent_id != leader:
                    members.append(CoalitionMember(agent_id=agent_id, role="member"))

        coalition = Coalition(
            goal=goal,
            members=members,
            leader=leader,
            name=name,
            description=description,
            lifetime=lifetime or self.config.coalition_max_lifetime,
        )

        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO coalition (id, name, description, goal, members, leader, lifetime, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                coalition.id,
                coalition.name,
                coalition.description,
                coalition.goal,
                str([m.to_dict() for m in coalition.members]),
                coalition.leader,
                coalition.lifetime,
                coalition.status.value,
                coalition.created_at.isoformat(),
            ),
        )
        conn.commit()

        logger.info(f"Created coalition: {coalition.id} - {goal}")
        return coalition

    def get(self, coalition_id: str) -> Optional[Coalition]:
        """获取联盟"""
        import json

        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM coalition WHERE id = ?", (coalition_id,))
        row = cursor.fetchone()

        if not row:
            return None

        members_data = json.loads(row["members"])
        members = [CoalitionMember.from_dict(m) for m in members_data]

        coalition = Coalition(
            id=row["id"],
            name=row["name"],
            description=row["description"],
            goal=row["goal"],
            members=members,
            leader=row["leader"],
            lifetime=row["lifetime"],
            status=CoalitionStatus(row["status"]),
            dissolved_reason=row["dissolved_reason"],
            created_at=datetime.fromisoformat(row["created_at"]),
        )

        # 检查是否过期
        if coalition.is_expired() and coalition.status == CoalitionStatus.ACTIVE:
            coalition.dissolve("lifetime expired")
            self._update_status(coalition)

        return coalition

    def add_member(self, coalition_id: str, agent_id: str, role: str = "member") -> bool:
        """添加成员"""
        coalition = self.get(coalition_id)
        if not coalition:
            return False

        if coalition.status != CoalitionStatus.ACTIVE:
            coalition.status = CoalitionStatus.ACTIVE

        coalition.add_member(agent_id, role)
        self._save(coalition)
        return True

    def remove_member(self, coalition_id: str, agent_id: str) -> bool:
        """移除成员"""
        coalition = self.get(coalition_id)
        if not coalition:
            return False

        if coalition.remove_member(agent_id):
            self._save(coalition)
            return True
        return False

    def dissolve(self, coalition_id: str, reason: Optional[str] = None) -> bool:
        """解散联盟"""
        coalition = self.get(coalition_id)
        if not coalition:
            return False

        coalition.dissolve(reason)
        self._update_status(coalition)
        logger.info(f"Dissolved coalition: {coalition_id}")
        return True

    def _save(self, coalition: Coalition) -> None:
        """保存联盟"""
        import json

        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE coalition SET name = ?, description = ?, goal = ?, members = ?, leader = ?, lifetime = ?, status = ?, dissolved_reason = ?
            WHERE id = ?
            """,
            (
                coalition.name,
                coalition.description,
                coalition.goal,
                str([m.to_dict() for m in coalition.members]),
                coalition.leader,
                coalition.lifetime,
                coalition.status.value,
                coalition.dissolved_reason,
                coalition.id,
            ),
        )
        conn.commit()

    def _update_status(self, coalition: Coalition) -> None:
        """更新状态"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE coalition SET status = ?, dissolved_reason = ? WHERE id = ?",
            (coalition.status.value, coalition.dissolved_reason, coalition.id),
        )
        conn.commit()

    def get_active_coalitions(self) -> List[Coalition]:
        """获取活跃联盟"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM coalition WHERE status IN ('forming', 'active') ORDER BY created_at DESC"
        )

        coalitions = []
        for row in cursor.fetchall():
            coalition = self.get(row["id"])
            if coalition:
                coalitions.append(coalition)

        return coalitions

    def get_member_coalitions(self, agent_id: str) -> List[Coalition]:
        """获取成员所在的联盟"""
        all_coalitions = self.get_active_coalitions()
        return [
            c for c in all_coalitions
            if any(m.agent_id == agent_id for m in c.members)
        ]
