# -*- coding: utf-8 -*-
"""
SoloForge Heuristic Embedder
Path: python/soloforge_ai_society/vector/heuristic_embedder.py
Date: 2026-06-30

无依赖的占位 embedder：384 维向量，每个文本 → 由 hash 决定的伪随机向量（保证同样输入 → 同样输出）。
用于：
  - 工厂方法终极 fallback（无模型 / 无 numpy 时）
  - 单测和离线调试
"""

from __future__ import annotations

import hashlib
from typing import List

import numpy as np


class HeuristicEmbedder:
    dim = 384
    model_name = "heuristic-hash-v1"

    def __init__(self, dim: int = 384, seed_bits: int = 8):
        self._dim = dim
        self._seed_bits = seed_bits

    def _hash_vector(self, text: str) -> np.ndarray:
        h = hashlib.sha512(text.encode("utf-8")).digest()
        seed = int.from_bytes(h[:self._seed_bits], "big")
        rng = np.random.default_rng(seed)
        v = rng.standard_normal(self._dim).astype(np.float32)
        n = np.linalg.norm(v)
        return v / n if n > 0 else v

    def embed(self, text: str) -> np.ndarray:
        return self._hash_vector(text or "")

    def embed_batch(self, texts: List[str]) -> np.ndarray:
        return np.stack([self._hash_vector(t or "") for t in texts], axis=0)

    def __repr__(self) -> str:
        return f"HeuristicEmbedder(dim={self._dim}, model_name={self.model_name!r})"