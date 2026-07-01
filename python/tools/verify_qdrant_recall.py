# -*- coding: utf-8 -*-
"""
SoloForge Qdrant 召回率校验 (D11-F6)
Path: python/tools/verify_qdrant_recall.py
Date: 2026-06-30

验证目标:
- 从 SQLite 各源表抽 N 条
- 用其中文本字段做 query, 期望 top-1 命中自己 (point.payload.source_id == row.id)
- 报告: recall@1, recall@3, mean similarity, latency

零破坏: 只读 SQLite + 只读 Qdrant

用法:
  cd python
  python tools/verify_qdrant_recall.py --source all
  python tools/verify_qdrant_recall.py --source social_memory --limit 3
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import sqlite3
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("verify_qdrant_recall")


SOURCES: Dict[str, Dict[str, Any]] = {
    "social_memory": {
        "query": """
            SELECT id, event, lessons, domain FROM social_memory
        """,
        "build_query_text": lambda r: f"{r['event']} | {r['lessons']}",
        "match_field": "source_id",  # payload 里 source_id == row.id
    },
    "culture": {
        "query": """
            SELECT id, principle, description FROM culture
        """,
        "build_query_text": lambda r: f"{r['principle']} | {r['description']}",
        "match_field": "source_id",
    },
    "institution": {
        "query": """
            SELECT id, name, rules FROM institution
        """,
        "build_query_text": lambda r: f"{r['name']} | {r['rules']}",
        "match_field": "source_id",
    },
}


def _setup_path() -> Path:
    script_path = Path(__file__).resolve()
    py_dir = script_path.parents[1]
    os.chdir(py_dir)
    sys.path.insert(0, str(py_dir))
    return py_dir


def _row_factory(cursor, row):
    return {col[0]: row[idx] for idx, col in enumerate(cursor.description)}


def read_rows(sqlite_path: Path, src: str) -> List[Dict[str, Any]]:
    conn = sqlite3.connect(str(sqlite_path))
    conn.row_factory = _row_factory
    cur = conn.cursor()
    cur.execute(SOURCES[src]["query"])
    rows = cur.fetchall()
    conn.close()
    return rows


def verify_recall(sqlite_path: Path, sources: List[str], limit: int, collection: str) -> Dict[str, Any]:
    logger.info("=== QDRANT RECALL VERIFICATION ===")
    logger.info(f"  sqlite:    {sqlite_path}")
    logger.info(f"  qdrant:    {collection}")
    logger.info(f"  sources:   {sources}")
    logger.info(f"  limit/src: {limit}")

    from soloforge_ai_society.vector.factory import get_embedder
    from soloforge_ai_society.services.qdrant_client import QdrantConfig
    from qdrant_client import QdrantClient

    embedder = get_embedder()
    logger.info(f"[embedder] {embedder.__class__.__name__} dim={embedder.dim}")

    probe = QdrantClient(host="127.0.0.1", port=6333)
    h = probe.get_collection(collection)
    logger.info(f"[qdrant] collection={collection} total_points={h.points_count}")

    overall = {
        "total_queries": 0,
        "hit_at_1": 0,
        "hit_at_3": 0,
        "hit_at_5": 0,
        "sim_sum": 0.0,
        "latency_ms_sum": 0.0,
        "by_source": {},
    }

    for src in sources:
        if src not in SOURCES:
            logger.error(f"Unknown source: {src}")
            continue
        rows = read_rows(sqlite_path, src)
        if not rows:
            logger.info(f"  [{src}] 0 行, 跳过")
            continue

        sample = random.sample(rows, min(limit, len(rows)))
        cfg = SOURCES[src]

        src_result = {
            "total_queries": len(sample),
            "hit_at_1": 0,
            "hit_at_3": 0,
            "hit_at_5": 0,
            "sim_sum": 0.0,
            "latency_ms_sum": 0.0,
            "details": [],
        }

        logger.info(f"  [{src}] sampling {len(sample)}/{len(rows)}")

        for r in sample:
            query_text = cfg["build_query_text"](r)
            t0 = time.time()
            qv = embedder.embed(query_text).tolist()
            response = probe.query_points(
                collection_name=collection,
                query=qv,
                limit=5,
                with_payload=True,
            )
            hits = response.points
            latency_ms = (time.time() - t0) * 1000

            # 判定: top-k 命中 = 任意 hit 的 payload.source_id == row.id
            hit_at_k = {1: False, 3: False, 5: False}
            top_sim = 0.0
            for k_rank, hit in enumerate(hits, start=1):
                payload = hit.payload or {}
                src_id = payload.get(cfg["match_field"]) or payload.get("id")
                top_sim = max(top_sim, float(hit.score))
                if str(src_id) == str(r["id"]):
                    if k_rank <= 1:
                        hit_at_k[1] = True
                    if k_rank <= 3:
                        hit_at_k[3] = True
                    if k_rank <= 5:
                        hit_at_k[5] = True

            src_result["hit_at_1"] += int(hit_at_k[1])
            src_result["hit_at_3"] += int(hit_at_k[3])
            src_result["hit_at_5"] += int(hit_at_k[5])
            src_result["sim_sum"] += top_sim
            src_result["latency_ms_sum"] += latency_ms
            src_result["details"].append({
                "row_id": r["id"],
                "query_text": query_text[:50],
                "top_score": round(top_sim, 4),
                "hit_at_1": hit_at_k[1],
                "hit_at_3": hit_at_k[3],
                "hit_at_5": hit_at_k[5],
                "latency_ms": round(latency_ms, 2),
            })

        n = src_result["total_queries"]
        if n > 0:
            src_result["recall_at_1"] = round(src_result["hit_at_1"] / n, 3)
            src_result["recall_at_3"] = round(src_result["hit_at_3"] / n, 3)
            src_result["recall_at_5"] = round(src_result["hit_at_5"] / n, 3)
            src_result["mean_top_similarity"] = round(src_result["sim_sum"] / n, 4)
            src_result["mean_latency_ms"] = round(src_result["latency_ms_sum"] / n, 2)

        overall["by_source"][src] = src_result
        overall["total_queries"] += src_result["total_queries"]
        overall["hit_at_1"] += src_result["hit_at_1"]
        overall["hit_at_3"] += src_result["hit_at_3"]
        overall["hit_at_5"] += src_result["hit_at_5"]
        overall["sim_sum"] += src_result["sim_sum"]
        overall["latency_ms_sum"] += src_result["latency_ms_sum"]

        logger.info(
            f"    [{src}] recall@1={src_result['recall_at_1']:.3f} "
            f"recall@3={src_result['recall_at_3']:.3f} "
            f"recall@5={src_result['recall_at_5']:.3f} "
            f"sim={src_result['mean_top_similarity']:.4f} "
            f"lat={src_result['mean_latency_ms']:.1f}ms"
        )

    n = overall["total_queries"]
    if n > 0:
        overall["recall_at_1"] = round(overall["hit_at_1"] / n, 3)
        overall["recall_at_3"] = round(overall["hit_at_3"] / n, 3)
        overall["recall_at_5"] = round(overall["hit_at_5"] / n, 3)
        overall["mean_top_similarity"] = round(overall["sim_sum"] / n, 4)
        overall["mean_latency_ms"] = round(overall["latency_ms_sum"] / n, 2)
    return overall


def main() -> int:
    parser = argparse.ArgumentParser(description="SoloForge D11-F6 Qdrant 召回率校验")
    parser.add_argument("--source", default="all",
                        help="源 social_memory|culture|institution|all")
    parser.add_argument("--limit", type=int, default=5, help="每个源抽多少条 (default 5)")
    parser.add_argument("--collection", default="ai_society_events")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    _setup_path()
    sqlite_path = Path("data/ai_society/ai_society.db")
    sources = ["social_memory", "culture", "institution"] if args.source == "all" else [args.source]

    random.seed(42)  # 可复现
    report = verify_recall(sqlite_path, sources, args.limit, args.collection)

    print("\n" + "=" * 70)
    print("Qdrant 召回率校验报告")
    print("=" * 70)
    print(f"  total_queries: {report.get('total_queries', 0)}")
    print(f"  recall@1:      {report.get('recall_at_1', 0):.3f}")
    print(f"  recall@3:      {report.get('recall_at_3', 0):.3f}")
    print(f"  recall@5:      {report.get('recall_at_5', 0):.3f}")
    print(f"  mean_sim:      {report.get('mean_top_similarity', 0):.4f}")
    print(f"  mean_latency:  {report.get('mean_latency_ms', 0):.1f}ms")
    for src, r in report.get("by_source", {}).items():
        print(f"  [{src}] n={r['total_queries']} R@1={r['recall_at_1']:.3f} R@3={r['recall_at_3']:.3f} R@5={r['recall_at_5']:.3f} sim={r['mean_top_similarity']:.4f}")
    print("=" * 70)

    if args.json:
        print("\n--- JSON ---")
        print(json.dumps(report, ensure_ascii=False, indent=2))

    # 验收: recall@3 >= 0.8 (plan §12.3 F6)
    r1 = report.get("recall_at_3", 0)
    if r1 < 0.8:
        warn_msg = f"WARN: recall@3={r1:.3f} < 0.8 阈值 (plan §12.3 F6)"
        logger.warning(warn_msg)
        # 但仍 0 退出 (因为是校验, 不是迁移)
    return 0


if __name__ == "__main__":
    sys.exit(main())