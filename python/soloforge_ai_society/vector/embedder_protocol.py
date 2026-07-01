# -*- coding: utf-8 -*-
"""
SoloForge Embedder Protocol
Path: python/soloforge_ai_society/vector/embedder_protocol.py
Date: 2026-06-30

IEmbedder 抽象接口（Protocol），零破坏。
所有实现（MiniLMEmbedder / HeuristicEmbedder）都满足该 duck-type。
"""

from __future__ import annotations

from typing import List, Protocol, runtime_checkable

import numpy as np


@runtime_checkable
class IEmbedder(Protocol):
    """嵌入器统一接口（Protocol）。"""
    dim: int
    model_name: str

    def embed(self, text: str) -> np.ndarray: ...
    def embed_batch(self, texts: List[str]) -> np.ndarray: ...


def is_embedder(obj) -> bool:
    """运行时检查是否符合 IEmbedder 协议（duck-type，不依赖继承）。"""
    if obj is None:
        return False
    return (
        hasattr(obj, "dim")
        and callable(getattr(obj, "embed", None))
        and callable(getattr(obj, "embed_batch", None))
    )