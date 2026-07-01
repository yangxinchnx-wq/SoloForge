# -*- coding: utf-8 -*-
"""
SoloForge Embedder 工厂
Path: python/soloforge_ai_society/vector/factory.py
Date: 2026-06-30

工厂方法 get_embedder()，支持环境变量切换实现。
零破坏：现有 embedder.py.get_embedder() 完全不动；新代码用本文件的 get_embedder()。

环境变量：
  SOLOFORGE_EMBEDDER = "tfidf" | "minilm" | "heuristic"    （默认 minilm）
  SOLOFORGE_EMBEDDER_DIM = int                              （仅 tfidf，默认 128）

选择优先级（自动）：
  1. MiniLM (sentence_transformers) - 优选，若模型已下载且 sentence_transformers 已装
  2. TFIDF (原 embedder.py) - 兼容旧调用
  3. Heuristic (纯 numpy 随机) - 终极 fallback
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def get_embedder(
    prefer: Optional[str] = None,
    dim: Optional[int] = None,
):
    """
    获取嵌入器实例（工厂方法）。

    Args:
        prefer: "minilm" | "tfidf" | "heuristic" | None（用环境变量）
        dim: 仅 TFIDF 生效，默认 128

    Returns:
        实现 IEmbedder 协议的对象
    """
    backend = (prefer or os.environ.get("SOLOFORGE_EMBEDDER", "minilm")).lower()

    if backend == "minilm":
        try:
            from soloforge_ai_society.vector.minilm_embedder import MiniLMEmbedder, get_minilm_embedder
            from soloforge_ai_society.vector.embedder_protocol import is_embedder
            emb = get_minilm_embedder()
            if is_embedder(emb):
                logger.info("[factory] selected MiniLMEmbedder (384-dim, multilingual)")
                return emb
        except ImportError as e:
            logger.warning("[factory] MiniLMEmbedder unavailable: %s", e)
        except FileNotFoundError as e:
            logger.warning("[factory] MiniLM model missing: %s", e)
        # 失败后回退到 TFIDF
        logger.info("[factory] falling back to TFIDFEmbedder")

    if backend == "tfidf":
        from soloforge_ai_society.vector.embedder import TFIDFEmbedder
        d = dim if dim is not None else int(os.environ.get("SOLOFORGE_EMBEDDER_DIM", "128"))
        logger.info("[factory] selected TFIDFEmbedder (dim=%d)", d)
        return TFIDFEmbedder(dim=d)

    if backend == "heuristic":
        from soloforge_ai_society.vector.heuristic_embedder import HeuristicEmbedder
        logger.info("[factory] selected HeuristicEmbedder")
        return HeuristicEmbedder()

    raise ValueError(f"Unknown embedder backend: {backend!r}")