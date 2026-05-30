# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Reputation Service

社会信誉服务
"""

import logging
from datetime import datetime
from typing import List, Optional

from ..database.manager import DatabaseManager
from ..models.reputation import Reputation, ReputationRecord, EntityType

logger = logging.getLogger(__name__)


class ReputationService:
    """
    信誉服务

    管理 Agent/Plugin/Tool/MCP 的信誉评分
    """

    def __init__(self, db_manager: DatabaseManager):
        self.db_manager = db_manager
        self._init_table()

    def _init_table(self) -> None:
        """初始化表 - 表已由 DatabaseManager 统一创建"""
        pass

    def create(
        self,
        entity_id: str,
        entity_type: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
    ) -> Reputation:
        """
        创建信誉记录

        Args:
            entity_id: 实体 ID
            entity_type: 实体类型
            name: 名称
            description: 描述

        Returns:
            创建的信誉记录
        """
        reputation = Reputation(
            entity_id=entity_id,
            entity_type=EntityType(entity_type),
            name=name,
            description=description,
        )

        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO reputation (id, entity_id, entity_type, score, evidence, history, name, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                reputation.id,
                reputation.entity_id,
                reputation.entity_type.value,
                reputation.score,
                ",".join(reputation.evidence),
                ",".join(str(h) for h in reputation.history),
                reputation.name,
                reputation.description,
                reputation.created_at.isoformat(),
                reputation.updated_at.isoformat(),
            ),
        )
        conn.commit()

        logger.info(f"Created reputation: {reputation.id} for {entity_id}")
        return reputation

    def get(self, entity_id: str, entity_type: str) -> Optional[Reputation]:
        """获取信誉记录"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM reputation WHERE entity_id = ? AND entity_type = ?",
            (entity_id, entity_type),
        )
        row = cursor.fetchone()

        if not row:
            return None

        return Reputation(
            id=row["id"],
            entity_id=row["entity_id"],
            entity_type=EntityType(row["entity_type"]),
            score=row["score"],
            evidence=row["evidence"].split(",") if row["evidence"] else [],
            history=[float(h) for h in row["history"].split(",")] if row["history"] else [],
            name=row["name"],
            description=row["description"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    def update_score(
        self,
        entity_id: str,
        entity_type: str,
        delta: float,
        reason: str,
        source: str,
    ) -> Optional[Reputation]:
        """
        更新信誉分

        Args:
            entity_id: 实体 ID
            entity_type: 实体类型
            delta: 变化量
            reason: 原因
            source: 来源

        Returns:
            更新后的记录
        """
        reputation = self.get(entity_id, entity_type)
        if not reputation:
            return None

        # 更新分数
        old_score = reputation.score
        reputation.score = max(0.0, min(1.0, reputation.score + delta))
        reputation.history.append(reputation.score)
        reputation.updated_at = datetime.now()

        # 记录变更
        record = ReputationRecord(
            reputation_id=reputation.id,
            delta=delta,
            reason=reason,
            source=source,
        )

        # 保存到数据库
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()

        cursor.execute(
            """
            UPDATE reputation SET score = ?, history = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                reputation.score,
                ",".join(str(h) for h in reputation.history),
                reputation.updated_at.isoformat(),
                reputation.id,
            ),
        )

        cursor.execute(
            """
            INSERT INTO reputation_record (id, reputation_id, delta, reason, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                record.id,
                record.reputation_id,
                record.delta,
                record.reason,
                record.source,
                record.created_at.isoformat(),
            ),
        )

        conn.commit()

        logger.info(
            f"Updated reputation: {entity_id} score {old_score:.2f} -> {reputation.score:.2f} ({delta:+.2f})"
        )
        return reputation

    def get_history(
        self,
        entity_id: str,
        entity_type: str,
        limit: int = 10,
    ) -> List[ReputationRecord]:
        """获取信誉变更历史"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT r.id, r.reputation_id, r.delta, r.reason, r.source, r.created_at
            FROM reputation_record r
            JOIN reputation rep ON r.reputation_id = rep.id
            WHERE rep.entity_id = ? AND rep.entity_type = ?
            ORDER BY r.created_at DESC
            LIMIT ?
            """,
            (entity_id, entity_type, limit),
        )

        return [
            ReputationRecord(
                id=row["id"],
                reputation_id=row["reputation_id"],
                delta=row["delta"],
                reason=row["reason"],
                source=row["source"],
                created_at=datetime.fromisoformat(row["created_at"]),
            )
            for row in cursor.fetchall()
        ]

    def get_all_by_type(self, entity_type: str) -> List[Reputation]:
        """获取指定类型的所有信誉记录"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM reputation WHERE entity_type = ? ORDER BY score DESC",
            (entity_type,),
        )

        reputations = []
        for row in cursor.fetchall():
            reputations.append(
                Reputation(
                    id=row["id"],
                    entity_id=row["entity_id"],
                    entity_type=EntityType(row["entity_type"]),
                    score=row["score"],
                    evidence=row["evidence"].split(",") if row["evidence"] else [],
                    history=[float(h) for h in row["history"].split(",")] if row["history"] else [],
                    name=row["name"],
                    description=row["description"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                    updated_at=datetime.fromisoformat(row["updated_at"]),
                )
            )

        return reputations
