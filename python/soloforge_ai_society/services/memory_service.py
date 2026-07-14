# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Memory Service (Qdrant 后端)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
升级 (2026-07-14): 移除降级逻辑，Qdrant 为硬性依赖
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

数据存储：
- SQLite：social_memory 表（结构化数据）
- Qdrant：ai_society_events collection（向量 + 语义搜索）

依赖：
- qdrant-client（Python 客户端）
- sentence-transformers（MiniLM 嵌入模型）
- Qdrant 服务必须运行在 127.0.0.1:6333

无降级：
- Qdrant 不可用时直接报错，不再静默返回空结果
- MiniLM 嵌入器为唯一选项，不再 fallback 到 HeuristicEmbedder
"""

import logging
from datetime import datetime
from typing import List, Optional

from ..database.manager import DatabaseManager
from ..models.social_memory import SocialMemory, MemorySeverity, MemoryImpact
from ..vector.qdrant_adapter import QdrantVectorSearch
from ..vector.factory import get_embedder

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
        # Qdrant is mandatory — no degradation. If Qdrant is not running,
        # this will raise QdrantUnavailable and the caller must fix the environment.
        self.vector_search = QdrantVectorSearch(embedder=self.embedder)
        self._qdrant_available = True
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

        # Qdrant upsert — mandatory, no silent failure
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
        # Qdrant search — mandatory, no degradation
        hits = self.vector_search.search(query, limit=top_k)

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