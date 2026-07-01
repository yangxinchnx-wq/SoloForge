# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Vector Package (Qdrant + MiniLM)

升级 (2026-07-01): TFIDFEmbedder / VectorSearch (LanceDB) 已删除。
替代：vector.factory.get_embedder() + vector.qdrant_adapter.QdrantVectorSearch
"""

from .factory import get_embedder
from .qdrant_adapter import QdrantVectorSearch
from .embedder_protocol import IEmbedder, is_embedder

__all__ = ["get_embedder", "QdrantVectorSearch", "IEmbedder", "is_embedder"]