# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Memory Service (Qdrant + BadgerDB 后端)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
升级 (2026-07-01): 从 LanceDB + TFIDF 切换到 Qdrant + MiniLM 384-dim
升级 (2026-07-13): 接入 BadgerDB 做最近事件快速日志 (BatchedWriter 异步写入)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

数据存储：
- SQLite：social_memory 表（结构化数据，持久存储）
- Qdrant：ai_society_events collection（向量 + 语义搜索）
- BadgerDB：最近事件日志（高吞吐写入 + TTL 自动过期 + 快速读取）

兼容：
- 旧 API (search / create / get_by_id / get_lessons / count) 保持不变
- 新增 API: get_recent_events(limit) — 从 BadgerDB 读最近事件
- 内部用 QdrantVectorSearch 替换 VectorSearch (LanceDB)
- BadgerDB 不可用时优雅降级，不影响主流程
"""

import json
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from ..database.manager import DatabaseManager
from ..models.social_memory import SocialMemory, MemorySeverity, MemoryImpact
from ..vector.qdrant_adapter import QdrantVectorSearch
from ..vector.factory import get_embedder
from soloforge_ai_society.services.qdrant_client import QdrantUnavailable

logger = logging.getLogger(__name__)

# BadgerDB 事件日志的 key 前缀和默认 TTL
_EVENT_KEY_PREFIX = "event:"
_DEFAULT_EVENT_TTL = 7 * 24 * 3600  # 7 天自动过期


class MemoryService:
    """
    社会记忆服务（Qdrant + BadgerDB 后端）

    管理 Social Memory 的创建、搜索和删除
    - SQLite: 持久结构化存储
    - Qdrant: 语义向量搜索
    - BadgerDB: 最近事件快速日志 (BatchedWriter 异步写入, TTL 7天)
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

        # BadgerDB 事件日志 (BatchedWriter 异步写入)
        self._badger_writer = None
        self._badger_client = None
        try:
            from soloforge_ai_society.services.badger_grpc_client import (
                BatchedWriter, BatchedWriterConfig, get_default_client,
            )
            self._badger_client = get_default_client()
            if self._badger_client.is_alive():
                self._badger_writer = BatchedWriter(
                    self._badger_client,
                    BatchedWriterConfig(size_threshold=200, flush_interval_ms=100),
                )
                self._badger_writer.start()
                logger.info("[MemoryService] BadgerDB event log enabled (BatchedWriter)")
            else:
                logger.warning("[MemoryService] BadgerDB gateway not reachable, event log disabled")
        except Exception as e:
            logger.warning(f"[MemoryService] BadgerDB init failed, event log disabled: {e}")

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

        # 写入 BadgerDB 事件日志 (异步, 不阻塞主流程)
        if self._badger_writer is not None:
            try:
                ts = int(memory.created_at.timestamp())
                event_key = f"{_EVENT_KEY_PREFIX}{ts:010d}:{memory.id}"
                event_val = json.dumps({
                    "id": memory.id,
                    "event": memory.event,
                    "impact": memory.impact.value,
                    "severity": memory.severity.value,
                    "participants": memory.participants,
                    "domain": memory.domain or "",
                    "outcome": memory.outcome or "",
                    "created_at": memory.created_at.isoformat(),
                }, ensure_ascii=False)
                self._badger_writer.put(event_key, event_val, ttl_seconds=_DEFAULT_EVENT_TTL)
            except Exception as e:
                logger.debug(f"[MemoryService] BadgerDB event log write failed: {e}")

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

    # ── BadgerDB 事件日志 ──────────────────────────────────────────

    def get_recent_events(self, limit: int = 20) -> List[Dict[str, Any]]:
        """从 BadgerDB 读取最近的事件日志（快速路径, 不查 SQLite）

        BadgerDB key 格式: event:{timestamp}:{memory_id}
        按 key 前缀扫描 + 逐条 get, 返回按时间倒序排列的事件列表。

        Args:
            limit: 最多返回条数

        Returns:
            [{id, event, impact, severity, participants, domain, outcome, created_at}, ...]
            BadgerDB 不可用时返回空列表
        """
        if self._badger_client is None:
            return []
        try:
            # 先 flush 写入队列, 确保最新事件已落盘
            if self._badger_writer is not None:
                self._badger_writer.flush()

            # 按前缀扫描 key (BadgerDB key 按字节序排列, timestamp 前缀保证时间顺序)
            list_result = self._badger_client.list_keys(prefix=_EVENT_KEY_PREFIX, limit=limit)
            events = []
            # list_keys 返回按 key 排序, 最近的在最后, 倒序取
            for key in reversed(list_result.keys):
                result = self._badger_client.get(key)
                if result.found:
                    try:
                        events.append(json.loads(result.value_str))
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        continue
                if len(events) >= limit:
                    break
            return events
        except Exception as e:
            logger.warning(f"[MemoryService] get_recent_events failed: {e}")
            return []

    def get_event_log_stats(self) -> Dict[str, Any]:
        """获取 BadgerDB 事件日志统计信息"""
        if self._badger_writer is not None:
            s = self._badger_writer.stats()
            s["enabled"] = True
            return s
        return {"enabled": False}

    def close(self) -> None:
        """关闭服务, 刷新 BadgerDB 写入队列"""
        if self._badger_writer is not None:
            try:
                self._badger_writer.stop(drain=True)
                logger.info("[MemoryService] BadgerDB BatchedWriter stopped")
            except Exception as e:
                logger.warning(f"[MemoryService] BatchedWriter stop failed: {e}")