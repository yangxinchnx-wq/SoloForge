# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Vector Search

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  AI 社会专用向量数据库 ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

本模块使用 LanceDB 存储社会记忆向量，与主项目完全隔离。

用途：
- Social Memory（社会记忆）向量存储和检索
- 语义相似度搜索

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import logging
from typing import List, Optional

import lancedb

from .embedder import TFIDFEmbedder, get_embedder

logger = logging.getLogger(__name__)


class VectorSearch:
    """
    向量搜索引擎

    使用 LanceDB 存储和检索向量
    """

    TABLE_NAME = "social_memory"

    def __init__(
        self,
        db: lancedb.LanceDB,
        embedder: Optional[TFIDFEmbedder] = None,
        vector_dim: int = 128,
    ):
        """
        初始化

        Args:
            db: LanceDB 实例
            embedder: 向量生成器
            vector_dim: 向量维度
        """
        self.db = db
        self.embedder = embedder or get_embedder(vector_dim)
        self.vector_dim = vector_dim
        self._table = None

    @property
    def table(self):
        """获取表，不存在则创建"""
        if self._table is None:
            self._init_table()
        return self._table

    def _init_table(self) -> None:
        """初始化表"""
        try:
            self._table = self.db.open_table(self.TABLE_NAME)
            logger.info(f"Opened existing table: {self.TABLE_NAME}")
        except Exception:
            # 表不存在，创建新表
            import pyarrow as pa

            schema = pa.schema([
                pa.field("id", pa.string()),
                pa.field("event", pa.string()),
                pa.field("vector", pa.list_(pa.float32(), self.vector_dim)),
                pa.field("impact", pa.string()),
                pa.field("severity", pa.string()),
                pa.field("participants", pa.string()),
                pa.field("lessons", pa.string()),
                pa.field("task_id", pa.string()),
                pa.field("domain", pa.string()),
                pa.field("outcome", pa.string()),
                pa.field("created_at", pa.int64()),
            ])

            self.db.create_table(self.TABLE_NAME, schema=schema)
            self._table = self.db.open_table(self.TABLE_NAME)

            # 创建向量索引
            self._table.create_index(
                vector_column_name="vector",
                index_type="IVF",
                num_partitions=256,
                num_sub_vectors=16,
            )

            logger.info(f"Created new table: {self.TABLE_NAME}")

    def add(
        self,
        id: str,
        event: str,
        vector: List[float],
        impact: str,
        severity: str,
        participants: str = "",
        lessons: str = "",
        task_id: str = "",
        domain: str = "",
        outcome: str = "",
        created_at: int = None,
    ) -> None:
        """
        添加向量记录

        Args:
            id: 记录 ID
            event: 事件描述
            vector: 向量
            impact: 影响类型
            severity: 严重度
            participants: 参与者（逗号分隔）
            lessons: 经验教训（逗号分隔）
            task_id: 任务 ID
            domain: 领域
            outcome: 结果
            created_at: 创建时间戳
        """
        import pyarrow as pa

        if created_at is None:
            import time
            created_at = int(time.time())

        data = [{
            "id": id,
            "event": event,
            "vector": vector,
            "impact": impact,
            "severity": severity,
            "participants": participants,
            "lessons": lessons,
            "task_id": task_id,
            "domain": domain,
            "outcome": outcome,
            "created_at": created_at,
        }]

        self.table.add(data)
        logger.debug(f"Added vector record: {id}")

    def search(
        self,
        query: str,
        top_k: int = 5,
        severity_filter: Optional[List[str]] = None,
        since: Optional[int] = None,
    ) -> List[dict]:
        """
        搜索相似记忆

        Args:
            query: 查询文本
            top_k: 返回数量
            severity_filter: 严重度过滤
            since: 时间过滤（时间戳）

        Returns:
            匹配的记录列表
        """
        # 生成查询向量
        query_vector = self.embedder.embed(query).tolist()

        # 构建过滤条件
        filters = []
        if severity_filter:
            severity_str = " OR ".join([f'severity = "{s}"' for s in severity_filter])
            filters.append(f"({severity_str})")
        if since:
            filters.append(f"created_at >= {since}")

        filter_expr = " AND ".join(filters) if filters else None

        # 执行搜索
        results = self.table.search(query_vector) \
            .limit(top_k)

        if filter_expr:
            results = results.where(filter_expr)

        return results.to_list()

    def delete(self, id: str) -> None:
        """删除记录"""
        self.table.delete(f"id = '{id}'")
        logger.debug(f"Deleted vector record: {id}")

    def count(self) -> int:
        """获取记录数量"""
        return len(self.table.to_lance().to_table())
