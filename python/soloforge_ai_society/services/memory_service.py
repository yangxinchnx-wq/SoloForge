# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Memory Service (Qdrant 后端)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
升级 (2026-07-01): 从 LanceDB + TFIDF 切换到 Qdrant + MiniLM 384-dim
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

数据存储：
- SQLite：social_memory 表（结构化数据）
- Qdrant：ai_society_events collection（向量 + 语义搜索）

兼容：
- 旧 API (search / create / get_by_id / get_lessons / count) 保持不变
- 内部用 QdrantVectorSearch 替换 VectorSearch (LanceDB)
- VectorSearch.count() 不再支持，已被 SQLite 直接 COUNT 替代
"""

import logging
from datetime import datetime
from typing import List, Optional

from ..database.manager import DatabaseManager
from ..models.social_memory import SocialMemory, MemorySeverity, MemoryImpact
from ..vector.qdrant_adapter import QdrantVectorSearch
from ..vector.factory import get_embedder
from soloforge_ai_society.services.qdrant_client import QdrantUnavailable

logger = logging.getLogger(__name__)


class MemoryService:
    """
    社会记忆服务（Qdrant 后端）

    管理 Social Memory 的创建、搜索和删除
    """

    def __init__(
        self,
        db_manager: DatabaseManager,
        embedder=None,
    ):
        """
        Args:
            db_manager: 数据库管理器 (SQLite)
            embedder: 可选嵌入器（默认走 factory.get_embedder() — MiniLM）
        """
        self.db_manager = db_manager
        self.embedder = embedder or get_embedder()
        try:
            self.vector_search = QdrantVectorSearch(embedder=self.embedder)
            self._qdrant_available = True
        except QdrantUnavailable as e:
            logger.warning(f"[MemoryService] Qdrant unavailable, semantic search disabled: {e}")
            self.vector_search = None
            self._qdrant_available = False
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
        """创建社会记忆（同时写 SQLite 结构化 + Qdrant 向量）"""
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

        if self._qdrant_available and self.vector_search is not None:
            try:
                self.vector_search.upsert(
                    text=memory.event,
                    payload={
                        "memory_id": memory.id,
                        "impact": memory.impact.value,
                        "severity": memory.severity.value,
                        "participants": ",".join(memory.participants),
                        "lessons": ",".join(memory.lessons),
                        "task_id": memory.task_id or "",
                        "domain": memory.domain or "",
                        "outcome": memory.outcome or "",
                        "created_at": int(memory.created_at.timestamp()),
                    },
                )
            except Exception as e:
                logger.warning(f"[MemoryService] Qdrant upsert failed: {e}")

        logger.info(f"Created social memory: {memory.id}")
        return memory

    def search(
        self,
        query: str,
        top_k: int = 5,
        severity: Optional[List[str]] = None,
        since_days: Optional[int] = None,
    ) -> List[SocialMemory]:
        """搜索相似记忆"""
        if not self._qdrant_available or self.vector_search is None:
            logger.warning("[MemoryService] Qdrant unavailable, search returns empty")
            return []

        try:
            hits = self.vector_search.search(query, limit=top_k)
        except Exception as e:
            logger.warning(f"[MemoryService] Qdrant search failed: {e}")
            return []

        since_ts = None
        if since_days:
            import time
            since_ts = int(time.time()) - since_days * 86400

        memories: List[SocialMemory] = []
        for h in hits:
            pl = h.get("payload", {}) or {}
            mid = pl.get("memory_id") or h.get("id")
            if severity and pl.get("severity") not in severity:
                continue
            if since_ts is not None and pl.get("created_at", 0) < since_ts:
                continue
            memory = self.get_by_id(mid) if mid else None
            if memory:
                memories.append(memory)
        return memories

    def get_by_id(self, memory_id: str) -> Optional[SocialMemory]:
        """根据 ID 获取记忆（仅查 SQLite）"""
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
        """获取所有经验教训（仅 SQLite）"""
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
        """获取记忆总数（直接查 SQLite）"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        row = cursor.execute("SELECT COUNT(*) AS c FROM social_memory").fetchone()
        return row["c"] if row else 0