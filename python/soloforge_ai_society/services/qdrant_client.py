# -*- coding: utf-8 -*-
"""
SoloForge AI Society Qdrant Client
Path: python/soloforge_ai_society/services/qdrant_client.py
Date: 2026-06-30

封装 Qdrant HTTP/gRPC API，专门为 AI Society event embedding 设计。
零破坏：这是新文件，不影响现有任何调用。
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ---- 默认配置 ----
DEFAULT_HOST = "127.0.0.1"
DEFAULT_HTTP_PORT = 6333
DEFAULT_GRPC_PORT = 6334
DEFAULT_COLLECTION = "ai_society_events"
VECTOR_DIM = 384  # paraphrase-multilingual-MiniLM-L12-v2
DISTANCE = "Cosine"


@dataclass
class QdrantConfig:
    host: str = DEFAULT_HOST
    http_port: int = DEFAULT_HTTP_PORT
    grpc_port: int = DEFAULT_GRPC_PORT
    collection: str = DEFAULT_COLLECTION
    vector_dim: int = VECTOR_DIM
    distance: str = DISTANCE
    enable_int8_quantization: bool = True
    prefer_grpc: bool = True


class QdrantUnavailable(RuntimeError):
    pass


class QdrantClient:
    def __init__(self, config: Optional[QdrantConfig] = None):
        self.config = config or QdrantConfig()
        self._client = None

    def _ensure_client(self):
        if self._client is not None:
            return
        try:
            from qdrant_client import QdrantClient
        except ImportError as e:
            raise QdrantUnavailable("qdrant-client not installed. Run: pip install qdrant-client") from e
        url = f"http://{self.config.host}:{self.config.http_port}"
        try:
            self._client = QdrantClient(
                url=url,
                prefer_grpc=self.config.prefer_grpc,
                timeout=30,
            )
            # 健康检查
            self._client.get_collections()
        except Exception as e:
            raise QdrantUnavailable(f"Cannot connect to Qdrant at {url}: {e}") from e

    @property
    def client(self):
        self._ensure_client()
        return self._client

    # ---- Collection 管理 ----

    def collection_exists(self, name: Optional[str] = None) -> bool:
        name = name or self.config.collection
        try:
            return self.client.collection_exists(name)
        except Exception as e:
            logger.warning("[qdrant] collection_exists check failed: %s", e)
            return False

    def create_collection(self, name: Optional[str] = None, recreate: bool = False) -> Dict[str, Any]:
        from qdrant_client.http import models

        name = name or self.config.collection
        if self.collection_exists(name):
            if not recreate:
                logger.info("[qdrant] collection '%s' already exists, skip", name)
                info = self.client.get_collection(name)
                return {"status": "exists", "name": name, "info": str(info)}

        from qdrant_client.http import models
        quant_config = None
        if self.config.enable_int8_quantization:
            quant_config = models.ScalarQuantization(
                scalar=models.ScalarQuantizationConfig(
                    type="int8",
                    quantile=0.99,
                    always_ram=True,
                )
            )
            logger.info("[qdrant] INT8 quantization ENABLED (P7)")

        if recreate and self.collection_exists(name):
            logger.info("[qdrant] dropping existing collection for recreate")
            self.client.delete_collection(name)

        t = time.time()
        self.client.create_collection(
            collection_name=name,
            vectors_config=models.VectorParams(
                size=self.config.vector_dim,
                distance=models.Distance.COSINE,
            ),
            quantization_config=quant_config,
        )
        elapsed = time.time() - t
        logger.info("[qdrant] created collection '%s' (dim=%d, distance=%s, time=%.3fs)",
                    name, self.config.vector_dim, self.config.distance, elapsed)
        return {
            "status": "created",
            "name": name,
            "dim": self.config.vector_dim,
            "distance": self.config.distance,
            "int8": self.config.enable_int8_quantization,
            "elapsed_seconds": elapsed,
        }

    def get_collection_info(self, name: Optional[str] = None) -> Dict[str, Any]:
        name = name or self.config.collection
        info = self.client.get_collection(name)
        return {
            "name": name,
            "status": str(info.status),
            "points_count": getattr(info, "points_count", 0),
            "vectors_count": getattr(info.vectors_count, "default", 0) if hasattr(info, "vectors_count") and info.vectors_count else 0,
            "config": {
                "dim": self.config.vector_dim,
                "distance": self.config.distance,
            },
        }

    # ---- Point 操作 ----

    def upsert_points(self, points: List[Dict[str, Any]], name: Optional[str] = None) -> int:
        from qdrant_client.http import models

        name = name or self.config.collection
        structs = []
        for p in points:
            structs.append(models.PointStruct(
                id=p["id"],
                vector=p["vector"],
                payload=p.get("payload", {}),
            ))
        self.client.upsert(collection_name=name, points=structs, wait=True)
        return len(structs)

    def search(self, query_vector: List[float], limit: int = 10,
               score_threshold: Optional[float] = None,
               filter_: Optional[Dict[str, Any]] = None,
               name: Optional[str] = None) -> List[Dict[str, Any]]:
        from qdrant_client.http import models

        name = name or self.config.collection
        kwargs = {
            "collection_name": name,
            "query": query_vector,
            "limit": limit,
        }
        if score_threshold is not None:
            kwargs["score_threshold"] = score_threshold
        if filter_ is not None:
            kwargs["query_filter"] = models.Filter(**filter_)

        hits = self.client.query_points(**kwargs).points
        return [{
            "id": h.id,
            "score": h.score,
            "payload": h.payload,
        } for h in hits]

    # ---- 健康检查 ----

    def health(self) -> Dict[str, Any]:
        try:
            self._ensure_client()
            collections = self.client.get_collections()
            return {
                "status": "ok",
                "host": self.config.host,
                "port": self.config.http_port,
                "collections": [c.name for c in collections.collections],
            }
        except QdrantUnavailable as e:
            return {"status": "unavailable", "error": str(e)}


# 便捷单例（避免重复创建）
_default_client: Optional[QdrantClient] = None


def get_qdrant_client(config: Optional[QdrantConfig] = None) -> QdrantClient:
    global _default_client
    if _default_client is None:
        _default_client = QdrantClient(config)
    return _default_client


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    cfg = QdrantConfig()
    cli = QdrantClient(cfg)
    print("=== SoloForge Qdrant Client ===")
    h = cli.health()
    print(f"Health: {h}")
    if h["status"] == "ok":
        print(f"\nEnsuring collection '{cfg.collection}' exists...")
        result = cli.create_collection(recreate=False)
        print(f"Result: {result}")
        info = cli.get_collection_info()
        print(f"\nCollection info:")
        for k, v in info.items():
            print(f"  {k}: {v}")