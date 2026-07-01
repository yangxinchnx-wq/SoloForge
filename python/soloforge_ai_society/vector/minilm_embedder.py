# -*- coding: utf-8 -*-
"""
SoloForge MiniLM Embedder
Path: python/soloforge_ai_society/vector/minilm_embedder.py
Date: 2026-06-30

paraphrase-multilingual-MiniLM-L12-v2 嵌入器（sentence_transformers 实现）。
零破坏：新文件, 走 factory 即可热切换。
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import List, Optional

import numpy as np

logger = logging.getLogger(__name__)

# 默认模型路径（D3 已下载）
DEFAULT_MODEL_PATH = Path(__file__).resolve().parents[3] / "bin" / "models" / "paraphrase-multilingual-MiniLM-L12-v2"
EXPECTED_DIM = 384
EXPECTED_NAME = "paraphrase-multilingual-MiniLM-L12-v2"


class MiniLMEmbedder:
    """
    MiniLM 多语言嵌入器

    实现 IEmbedder 接口（duck-type）：
      - dim = 384
      - model_name = "paraphrase-multilingual-MiniLM-L12-v2"
      - embed / embed_batch 委托给底层 SentenceTransformer
    """

    def __init__(self, model_path: Optional[str] = None, device: str = "cpu"):
        self._model_path = Path(model_path) if model_path else DEFAULT_MODEL_PATH
        self._device = device
        self._model = None
        self.dim = EXPECTED_DIM
        self.model_name = EXPECTED_NAME

    def _ensure_loaded(self):
        if self._model is not None:
            return
        if not self._model_path.exists():
            raise FileNotFoundError(
                f"MiniLM model not found at {self._model_path}. "
                f"D3-B3 download task incomplete. Expected model.safetensors."
            )
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as e:
            raise ImportError(
                "sentence-transformers not installed. Run: pip install sentence-transformers"
            ) from e
        t = time.time()
        self._model = SentenceTransformer(str(self._model_path), device=self._device)
        actual_dim = self._model.get_sentence_embedding_dimension()
        if actual_dim != self.dim:
            logger.warning("[MiniLM] expected dim=%d, model has dim=%d", self.dim, actual_dim)
            self.dim = actual_dim
        logger.info("[MiniLM] loaded from %s in %.2fs", self._model_path, time.time() - t)

    def embed(self, text: str) -> np.ndarray:
        self._ensure_loaded()
        v = self._model.encode(text, convert_to_numpy=True)
        return np.asarray(v, dtype=np.float32)

    def embed_batch(self, texts: List[str]) -> np.ndarray:
        self._ensure_loaded()
        v = self._model.encode(texts, convert_to_numpy=True, batch_size=32, show_progress_bar=False)
        return np.asarray(v, dtype=np.float32)

    def __repr__(self) -> str:
        loaded = "loaded" if self._model is not None else "lazy"
        return f"MiniLMEmbedder(model_name={self.model_name!r}, dim={self.dim}, state={loaded}, path={self._model_path})"


# 模块级工厂方法（与 embedder.py 中的 get_embedder 风格一致）
_instance: Optional[MiniLMEmbedder] = None


def get_minilm_embedder(model_path: Optional[str] = None) -> MiniLMEmbedder:
    """获取全局 MiniLM 嵌入器实例（懒加载）"""
    global _instance
    if _instance is None:
        _instance = MiniLMEmbedder(model_path=model_path)
    return _instance