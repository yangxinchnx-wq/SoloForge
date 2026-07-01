# -*- coding: utf-8 -*-
"""
SoloForge Qdrant Adapter
Path: python/soloforge_ai_society/vector/qdrant_adapter.py
Date: 2026-06-30

把现有 AI Society 事件 embedding 工作流无缝切换到 Qdrant。
零破坏：
  - 不修改 vector/search.py (LanceDB 路径)
  - 不修改 vector/embedder.py (TFIDF 路径)
  - 调用方可选择 VectorSearch (LanceDB) 或 QdrantVectorSearch (本类)
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Dict, List, Optional

import numpy as np

from soloforge_ai_society.services.qdrant_client import QdrantClient, QdrantConfig
from soloforge_ai_society.vector.factory import get_embedder
from soloforge_ai_society.vector.embedder_protocol import is_embedder

logger = logging.getLogger(__name__)


class QdrantVectorSearch:
    """
    基于 Qdrant 的向量检索引擎

    用法:
        s = QdrantVectorSearch(collection="ai_society_events")
        s.upsert(text="AI Society 有 12 个机构", payload={"category": "demo"})
        hits = s.search("how many institutions?", limit=3)
    """

    def __init__(
        self,
        config: Optional[QdrantConfig] = None,
        embedder: Optional[Any] = None,
    ):
        self.config = config or QdrantConfig()
        self.qdrant = QdrantClient(self.config)
        if embedder is not None:
            if not is_embedder(embedder):
                raise TypeError("embedder must implement IEmbedder (dim/embed/embed_batch)")
            self.embedder = embedder
        else:
            self.embedder = get_embedder()

        if self.embedder.dim != self.config.vector_dim:
            logger.warning(
                "[QdrantAdapter] embedder dim=%d != qdrant vector_dim=%d, " "mismatch may cause errors",
                self.embedder.dim, self.config.vector_dim,
            )

        self.qdrant.create_collection(recreate=False)

    def upsert(self, text: str, payload: Optional[Dict[str, Any]] = None) -> str:
        """嵌入 + 写入，返回 point id"""
        vec = self.embedder.embed(text).tolist()
        pid = str(uuid.uuid4())
        pl = dict(payload or {})
        pl.setdefault("text", text)
        pl.setdefault("created_at", int(time.time()))
        self.qdrant.upsert_points([{"id": pid, "vector": vec, "payload": pl}])
        return pid

    def upsert_batch(self, items: List[Dict[str, Any]]) -> List[str]:
        """批量 upsert，每项含 text 和 payload。"""
        texts = [it["text"] for it in items]
        vecs = self.embedder.embed_batch(texts)
        ids = [str(uuid.uuid4()) for _ in items]
        points = []
        for i, (pid, vec, item) in enumerate(zip(ids, vecs, items)):
            pl = dict(item.get("payload", {}))
            pl.setdefault("text", item["text"])
            pl.setdefault("created_at", int(time.time()))
            points.append({"id": pid, "vector": vec.tolist(), "payload": pl})
        self.qdrant.upsert_points(points)
        return ids

    def search(self, query: str, limit: int = 10, score_threshold: Optional[float] = None,
               filter_: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """按文本搜索，返回 [{id, score, payload}]"""
        qv = self.embedder.embed(query).tolist()
        return self.qdrant.search(qv, limit=limit, score_threshold=score_threshold, filter_=filter_)

    def health(self) -> Dict[str, Any]:
        return {
            "qdrant": self.qdrant.health(),
            "embedder_backend": type(self.embedder).__name__,
            "embedder_model": self.embedder.model_name if hasattr(self.embedder, "model_name") else "<unknown>",
            "vector_dim": self.embedder.dim,
        }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    print("=== SoloForge QdrantVectorSearch Demo ===")
    s = QdrantVectorSearch()
    print(f"health: {s.health()}")
    print()
    texts = [
        "AI Society has 12 institutions",
        "AI Society 有 12 个机构",
        "人工智能社会正在快速发展",
        "The weather is nice today",
        "今天天气真好",
    ]
    print(f"upserting {len(texts)} points...")
    ids = s.upsert_batch([{"text": t, "payload": {"category": "demo"}} for t in texts])
    print(f"  ids: {ids[:2]}...")
    print()
    for q in ["Tell me about AI Society institutions", "太阳系行星", "今天天气如何"]:
        hits = s.search(q, limit=3)
        print(f"query: {q!r}")
        for h in hits:
            print(f"  [{h['score']:.3f}] {h['payload']['text']}")
        print()