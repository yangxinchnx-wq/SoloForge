# -*- coding: utf-8 -*-
"""
SoloForge Embedder 工厂
Path: python/soloforge_ai_society/vector/factory.py
Date: 2026-06-30 → 2026-07-01（移除 TFIDF fallback）

工厂方法 get_embedder()，支持环境变量切换实现。
零破坏：现有 embedder.py.get_embedder() 已不再使用；新代码用本文件的 get_embedder()。

环境变量：
  SOLOFORGE_EMBEDDER = "minilm"     （唯一选项，默认 minilm）

选择：
  MiniLM (sentence_transformers) - 唯一选项，384 维多语言嵌入
  无降级：如果 MiniLM 不可用则直接报错
"""

from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)


def get_embedder(prefer: Optional[str] = None, dim: Optional[int] = None):
    """
    获取嵌入器实例（工厂方法）。

    Args:
        prefer: "minilm" | None（用环境变量 SOLOFORGE_EMBEDDER）
        dim: 保留参数（不再生效，MiniLM 固定 384 维）

    Returns:
        实现 IEmbedder 协议的对象

    Raises:
        ImportError: 如果 sentence_transformers 未安装
        FileNotFoundError: 如果 MiniLM 模型未下载
    """
    backend = (prefer or os.environ.get("SOLOFORGE_EMBEDDER", "minilm")).lower()

    if backend == "minilm":
        from soloforge_ai_society.vector.minilm_embedder import get_minilm_embedder
        from soloforge_ai_society.vector.embedder_protocol import is_embedder
        emb = get_minilm_embedder()
        if is_embedder(emb):
            logger.info("[factory] selected MiniLMEmbedder (384-dim, multilingual)")
            return emb
        raise RuntimeError("MiniLMEmbedder does not implement IEmbedder protocol")

    raise ValueError(f"Unknown embedder backend: {backend!r}. Only 'minilm' is supported.")