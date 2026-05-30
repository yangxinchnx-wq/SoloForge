# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Memory Service

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  AI 社会专用服务 ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

社会记忆服务 - 核心服务

数据存储：
- SQLite：social_memory 表（结构化数据）
- LanceDB：social_memory 向量表（语义搜索）

注意：Social Memory 同时使用 SQLite 和 LanceDB
- SQLite 存储完整记录（可关联查询）
- LanceDB 存储向量（语义相似度搜索）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import json
import logging
from datetime import datetime
from typing import List, Optional

import sqlite3

from ..database.manager import DatabaseManager
from ..models.social_memory import SocialMemory, MemorySeverity, MemoryImpact
from ..vector.embedder import TFIDFEmbedder, get_embedder
from ..vector.search import VectorSearch

logger = logging.getLogger(__name__)


class MemoryService:
    """
    社会记忆服务

    管理 Social Memory 的创建、搜索和删除
    """

    def __init__(
        self,
        db_manager: DatabaseManager,
        embedder: Optional[TFIDFEmbedder] = None,
    ):
        """
        初始化

        Args:
            db_manager: 数据库管理器
            embedder: 向量生成器
        """
        self.db_manager = db_manager
        self.embedder = embedder or get_embedder()
        self.vector_search = VectorSearch(
            db=db_manager.get_lancedb(),
            embedder=self.embedder,
        )
        self._init_memory_table()

    def _init_memory_table(self) -> None:
        """初始化表 - 表已由 DatabaseManager 统一创建"""
        pass

    def create(
        self,
        event: str,
        impact: str,
        severity: str,
        participants: Optional[List[str]] = None,
        lessons: Optional[List[str]] = None,
        task_id: Optional[str] = None,
        domain: Optional[str] = None,
        outcome: Optional[str] = None,
    ) -> SocialMemory:
        """
        创建社会记忆

        Args:
            event: 事件描述
            impact: 影响类型
            severity: 严重度
            participants: 参与者
            lessons: 经验教训
            task_id: 任务 ID
            domain: 领域
            outcome: 结果

        Returns:
            创建的记忆
        """
        memory = SocialMemory(
            event=event,
            impact=MemoryImpact(impact),
            severity=MemorySeverity(severity),
            participants=participants or [],
            lessons=lessons or [],
            task_id=task_id,
            domain=domain,
            outcome=outcome,
        )

        # 保存到 SQLite
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO social_memory (id, event, impact, severity, participants, lessons, task_id, domain, outcome, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                memory.id,
                memory.event,
                memory.impact.value,
                memory.severity.value,
                ",".join(memory.participants),
                ",".join(memory.lessons),
                memory.task_id,
                memory.domain,
                memory.outcome,
                memory.created_at.isoformat(),
            ),
        )
        conn.commit()

        # 保存到向量数据库
        vector = self.embedder.embed(event).tolist()
        self.vector_search.add(
            id=memory.id,
            event=memory.event,
            vector=vector,
            impact=memory.impact.value,
            severity=memory.severity.value,
            participants=",".join(memory.participants),
            lessons=",".join(memory.lessons),
            task_id=memory.task_id or "",
            domain=memory.domain or "",
            outcome=memory.outcome or "",
            created_at=int(memory.created_at.timestamp()),
        )

        logger.info(f"Created social memory: {memory.id}")
        return memory

    def search(
        self,
        query: str,
        top_k: int = 5,
        severity: Optional[List[str]] = None,
        since_days: Optional[int] = None,
    ) -> List[SocialMemory]:
        """
        搜索相似记忆

        Args:
            query: 查询文本
            top_k: 返回数量
            severity: 严重度过滤
            since_days: 时间过滤（天数）

        Returns:
            匹配的记录
        """
        since = None
        if since_days:
            import time
            since = int(time.time()) - since_days * 86400

        results = self.vector_search.search(
            query=query,
            top_k=top_k,
            severity_filter=severity,
            since=since,
        )

        memories = []
        for r in results:
            memory = self.get_by_id(r["id"])
            if memory:
                memories.append(memory)

        return memories

    def get_by_id(self, memory_id: str) -> Optional[SocialMemory]:
        """根据 ID 获取记忆"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM social_memory WHERE id = ?", (memory_id,))
        row = cursor.fetchone()

        if not row:
            return None

        return SocialMemory(
            id=row["id"],
            event=row["event"],
            impact=MemoryImpact(row["impact"]),
            severity=MemorySeverity(row["severity"]),
            participants=row["participants"].split(",") if row["participants"] else [],
            lessons=row["lessons"].split(",") if row["lessons"] else [],
            task_id=row["task_id"],
            domain=row["domain"],
            outcome=row["outcome"],
            created_at=datetime.fromisoformat(row["created_at"]),
        )

    def get_lessons(self, domain: Optional[str] = None) -> List[str]:
        """
        获取所有经验教训

        Args:
            domain: 领域过滤

        Returns:
            经验教训列表
        """
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()

        if domain:
            cursor.execute(
                "SELECT lessons FROM social_memory WHERE domain = ? AND lessons != ''",
                (domain,),
            )
        else:
            cursor.execute("SELECT lessons FROM social_memory WHERE lessons != ''")

        lessons = set()
        for row in cursor.fetchall():
            if row["lessons"]:
                for lesson in row["lessons"].split(","):
                    if lesson.strip():
                        lessons.add(lesson.strip())

        return list(lessons)

    def count(self) -> int:
        """获取记忆总数"""
        return self.vector_search.count()
