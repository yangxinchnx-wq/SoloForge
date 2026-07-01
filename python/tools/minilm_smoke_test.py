# -*- coding: utf-8 -*-
"""
MiniLM 真 RAG embedding 验证
Path: python/tools/minilm_smoke_test.py
Date: 2026-06-30

验证 factory.py 默认走 MiniLM (不再是 TFIDF fallback)。
"""
from __future__ import annotations

import math
import sys
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_DIR / "python"))


def main() -> int:
    print("=== MiniLM smoke test (audit 2026-06-30 U4 修复) ===\n")

    t0 = time.time()
    from soloforge_ai_society.vector.factory import get_embedder
    emb = get_embedder()
    elapsed_import = time.time() - t0

    cls_name = type(emb).__name__
    print(f"[1] factory 选择: {cls_name} (import+init {elapsed_import:.1f}s)")

    # 2. 维度
    test_vec = emb.embed("test")
    v = test_vec.tolist() if hasattr(test_vec, "tolist") else list(test_vec)
    dim = len(v)
    print(f"[2] 向量维度: {dim}")
    if cls_name == "MiniLMEmbedder":
        dim_ok = dim == 384
    elif cls_name == "HeuristicEmbedder":
        dim_ok = dim > 0
    else:
        dim_ok = False
    print(f"    维度校验: {'✓' if dim_ok else '✗'}")

    # 3. 语义相似度
    pairs = [
        ("谁偷了我的东西?", "物品被其他玩家非法占有", "近义"),
        ("今天天气怎么样", "午饭吃什么", "远义"),
        ("hello world", "你好世界", "近义跨语种"),
        ("agent 推理很慢", "模型推理延迟高", "近义"),
    ]
    print(f"\n[3] 语义相似度测试:")
    sim_results = []
    for q, d, label in pairs:
        v1 = emb.embed(q)
        v2 = emb.embed(d)
        v1l = v1.tolist() if hasattr(v1, "tolist") else list(v1)
        v2l = v2.tolist() if hasattr(v2, "tolist") else list(v2)
        dot = sum(a * b for a, b in zip(v1l, v2l))
        n1 = math.sqrt(sum(a * a for a in v1l))
        n2 = math.sqrt(sum(a * a for a in v2l))
        cos = dot / (n1 * n2) if n1 * n2 > 0 else 0.0
        sim_results.append({"q": q, "d": d, "label": label, "cos": round(cos, 4)})
        print(f"    {label:>12}  cos({q!r}, {d!r}) = {cos:.4f}")

    near_cos = max(r["cos"] for r in sim_results if r["label"].startswith("近"))
    far_cos = max(r["cos"] for r in sim_results if r["label"] == "远义")
    semantic_ok = near_cos > far_cos
    print(f"\n[3.5] 近义 max cos = {near_cos:.4f}, 远义 max cos = {far_cos:.4f}")
    print(f"     语义合理性: {'✓' if semantic_ok else '✗'}")

    is_minilm = cls_name == "MiniLMEmbedder"
    print(f"\n=== 总结 ===")
    print(f"  embedder:      {cls_name}")
    print(f"  维度:          {dim} ({'✓' if dim_ok else '✗'})")
    print(f"  语义合理性:    {'✓' if semantic_ok else '✗'}")
    print(f"  MiniLM 启用:   {'✓ 真的' if is_minilm else '✗ fallback (U4 未修)'}")

    overall = is_minilm and dim_ok and semantic_ok
    print(f"\n{'✅ PASS' if overall else '❌ FAIL'} (audit U4: {'已修' if overall else '需查'})")
    return 0 if overall else 1


if __name__ == "__main__":
    sys.exit(main())
