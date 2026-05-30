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
        db: lancedb.LanceDBConnection,
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
        self._index_created = False

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

            logger.info(f"Created new table: {self.TABLE_NAME}")

    def _create_index_if_needed(self) -> None:
        """延迟创建索引（需要在有数据后才能创建）"""
        if self._table is None or self._index_created:
            return

        try:
            # 检查是否已有索引
            try:
                indices = self._table.list_indices()
                has_vector_index = any(idx.get("columns") == ["vector"] for idx in indices)
            except Exception:
                has_vector_index = False

            if not has_vector_index:
                # 尝试不同的索引 API
                try:
                    # LanceDB 0.8+ API with IvfFlat
                    from lancedb.index import IvfFlat
                    self._table.create_index(
                        "vector",
                        IvfFlat(distance_type="cosine")
                    )
                except (ImportError, TypeError) as e:
                    logger.debug(f"Index creation skipped: {e}")
                self._index_created = True
                logger.info("Vector index creation attempted")
        except Exception as e:
            logger.warning(f"Failed to create index: {e}")
            # 不阻塞，搜索仍可使用暴力匹配

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
        if created_at is None:
            import time
            created_at = int(time.time() * 1000)  # 毫秒

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

        # 添加数据后尝试创建索引（延迟创建）
        self._create_index_if_needed()

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
            since: 时间过滤（毫秒时间戳）

        Returns:
            匹配的记录列表，包含 _distance 字段
        """
        # 生成查询向量
        query_vector = self.embedder.embed(query).tolist()

        # 构建过滤条件
        filters = []
        if severity_filter:
            severity_str = " OR ".join([f'severity = "{self._escape_str(s)}"' for s in severity_filter])
            filters.append(f"({severity_str})")
        if since:
            filters.append(f"created_at >= {since}")

        filter_expr = " AND ".join(filters) if filters else None

        try:
            # 执行搜索
            try:
                # 新版本 API
                search_query = self.table.search(query_vector, vector_column_name="vector")
            except TypeError:
                # 旧版本 API
                search_query = self.table.search(query_vector)

            if filter_expr:
                search_query = search_query.where(filter_expr)

            results = search_query.limit(top_k).to_list()

            # 确保返回包含 _distance 字段（兼容不同版本）
            for r in results:
                if "_distance" not in r:
                    r["_distance"] = r.get("distance", 0.0)

            return results

        except Exception as e:
            logger.error(f"Search failed: {e}")
            # 回退到暴力匹配
            return self._brute_force_search(query, top_k, severity_filter, since)

    def _brute_force_search(
        self,
        query: str,
        top_k: int = 5,
        severity_filter: Optional[List[str]] = None,
        since: Optional[int] = None,
    ) -> List[dict]:
        """暴力匹配搜索（索引不可用时的回退）"""
        import numpy as np

        query_vector = self.embedder.embed(query)

        # 获取所有数据
        try:
            all_data = self.table.to_lance().to_table().to_pydict()
        except Exception:
            logger.warning("Cannot retrieve data for brute force search")
            return []

        if not all_data.get("id"):
            return []

        # 过滤
        indices = list(range(len(all_data["id"])))

        if severity_filter:
            indices = [i for i in indices if all_data["severity"][i] in severity_filter]

        if since:
            indices = [i for i in indices if all_data["created_at"][i] >= since]

        # 计算距离
        results = []
        for i in indices:
            vector = np.array(all_data["vector"][i])
            distance = float(np.linalg.norm(query_vector - vector))

            results.append({
                "id": all_data["id"][i],
                "event": all_data["event"][i],
                "impact": all_data["impact"][i],
                "severity": all_data["severity"][i],
                "participants": all_data["participants"][i],
                "lessons": all_data["lessons"][i],
                "task_id": all_data["task_id"][i],
                "domain": all_data["domain"][i],
                "outcome": all_data["outcome"][i],
                "created_at": all_data["created_at"][i],
                "_distance": distance,
            })

        # 按距离排序
        results.sort(key=lambda x: x["_distance"])

        return results[:top_k]

    def _escape_str(self, s: str) -> str:
        """转义字符串防止 SQL 注入"""
        return s.replace('"', '\\"').replace("'", "\\'")

    def delete(self, id: str) -> None:
        """删除记录"""
        self.table.delete(f"id = '{self._escape_str(id)}'")
        logger.debug(f"Deleted vector record: {id}")

    def count(self) -> int:
        """获取记录数量"""
        try:
            return len(self.table.to_lance().to_table())
        except Exception:
            return 0

    def get_stats(self) -> dict:
        """获取统计信息"""
        stats = {
            "table_name": self.TABLE_NAME,
            "record_count": self.count(),
            "vector_dim": self.vector_dim,
            "index_created": self._index_created,
        }

        try:
            indices = self.table.list_indices()
            stats["indices"] = indices
        except Exception:
            stats["indices"] = []

        return stats
