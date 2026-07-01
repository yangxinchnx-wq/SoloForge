# -*- coding: utf-8 -*-
"""
SoloForge Embedding 回填迁移脚本 (D10 / D11)
Path: python/tools/migrate_social_memory.py
Date: 2026-06-30

对应 数据库升级方案.md §12 阶段 5 任务表
- F1 写迁移脚本 (本文件)
- F2 dry-run 只读模式
- F3 不删 SQLite 旧记录
- F4 不删旧 LanceDB
- F5 全量回填
- F6 召回率校验

零破坏：
- SQLite 表原样保留（只是读取）
- 旧 LanceDB 路径不删 (.lance.deprecated.2026-06-30 归档保留)
- Qdrant upsert 幂等（用 row.id 作为 point_id，重复运行安全）
- 新增内容：Qdrant collection 中嵌入向量

用法：
  cd python
  python tools/migrate_social_memory.py --dry-run                 # 只统计
  python tools/migrate_social_memory.py --dry-run --source all   # 统计所有源表
  python tools/migrate_social_memory.py --commit --source social_memory
  python tools/migrate_social_memory.py --commit --source culture
  python tools/migrate_social_memory.py --commit --source institution
  python tools/migrate_social_memory.py --commit --source all    # 全量
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("migrate_social_memory")


# ── 源表配置 ────────────────────────────────────────────────────────
# 每个 source 描述：如何从 SQLite 读 → 如何把字段拼成可嵌入文本 → Qdrant payload 是什么
SOURCES: Dict[str, Dict[str, Any]] = {
    "social_memory": {
        "description": "社会记忆事件 (event/lessons 拼成文本)",
        "query": """
            SELECT id, event, impact, severity, participants, lessons,
                   task_id, domain, outcome, created_at
            FROM social_memory
        """,
        "build_text": lambda r: f"{r['event']} | {r['lessons']}",
        "build_payload": lambda r: {
            "source": "social_memory",
            "event": r["event"],
            "impact": r["impact"],
            "severity": r["severity"],
            "participants": r["participants"],
            "lessons": r["lessons"],
            "task_id": r["task_id"],
            "domain": r["domain"],
            "outcome": r["outcome"],
            "created_at": r["created_at"],
        },
    },
    "culture": {
        "description": "文化原则 (principle + description)",
        "query": """
            SELECT id, principle, description, adoption_rate, target_rate,
                   evidence, created_at, updated_at
            FROM culture
        """,
        "build_text": lambda r: f"{r['principle']} | {r['description']}",
        "build_payload": lambda r: {
            "source": "culture",
            "principle": r["principle"],
            "description": r["description"],
            "adoption_rate": r["adoption_rate"],
            "target_rate": r["target_rate"],
            "evidence": r["evidence"],
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        },
    },
    "institution": {
        "description": "机构规则 (name + rules)",
        "query": """
            SELECT id, name, rules, scope, enforcement, priority,
                   agent_id, task_type, domain, created_at, updated_at
            FROM institution
        """,
        "build_text": lambda r: f"{r['name']} | {r['rules']}",
        "build_payload": lambda r: {
            "source": "institution",
            "name": r["name"],
            "rules": r["rules"],
            "scope": r["scope"],
            "enforcement": r["enforcement"],
            "priority": r["priority"],
            "agent_id": r["agent_id"],
            "task_type": r["task_type"],
            "domain": r["domain"],
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        },
    },
}


def _setup_path() -> Path:
    script_path = Path(__file__).resolve()
    py_dir = script_path.parents[1]
    os.chdir(py_dir)
    sys.path.insert(0, str(py_dir))
    return py_dir


def _resolve_sqlite_path() -> Path:
    """从 pool.Config 拿权威 SQLite 路径"""
    try:
        from soloforge_ai_society.config.runtime import get_config
        cfg = get_config()
        if cfg and getattr(cfg, "database", None) and cfg.database.path:
            return Path(cfg.database.path)
    except Exception:
        pass
    return Path("data/ai_society/ai_society.db")


def _row_factory(cursor, row):
    return {col[0]: row[idx] for idx, col in enumerate(cursor.description)}


def read_source_rows(sqlite_path: Path, source_name: str) -> List[Dict[str, Any]]:
    cfg = SOURCES[source_name]
    conn = sqlite3.connect(str(sqlite_path))
    conn.row_factory = _row_factory
    cur = conn.cursor()
    cur.execute(cfg["query"])
    rows = cur.fetchall()
    conn.close()
    return rows


def run_dry_run(sqlite_path: Path, sources: List[str]) -> Dict[str, Any]:
    """统计模式：只读 SQLite, 不连 Qdrant"""
    logger.info("=== DRY RUN ===")
    summary = {}
    grand_total = 0
    for src in sources:
        if src not in SOURCES:
            logger.error(f"Unknown source: {src}")
            continue
        cfg = SOURCES[src]
        rows = read_source_rows(sqlite_path, src)
        n = len(rows)
        grand_total += n
        summary[src] = {
            "description": cfg["description"],
            "row_count": n,
            "sample_text": cfg["build_text"](rows[0]) if rows else None,
        }
        logger.info(f"  [{src}] {cfg['description']}: {n} 条")
        if rows:
            logger.info(f"           sample: {cfg['build_text'](rows[0])[:60]}...")
    return {"mode": "dry-run", "sqlite_path": str(sqlite_path), "sources": summary, "grand_total": grand_total}


def run_commit(sqlite_path: Path, sources: List[str], collection: str = "ai_society_events") -> Dict[str, Any]:
    """回填模式: MiniLM 嵌入 → Qdrant upsert

    幂等: 用 deterministic UUIDv5 (namespace=collection_name, name=row_id) 作为 point_id,
    重复跑同一条 SQLite 记录 → 覆盖 Qdrant 同 id, count 不变。
    """
    logger.info("=== COMMIT MODE ===")

    import uuid
    from qdrant_client import QdrantClient
    from soloforge_ai_society.vector.factory import get_embedder
    from soloforge_ai_society.services.qdrant_client import QdrantConfig, QdrantClient as QInternal

    embedder = get_embedder()
    logger.info(f"[embedder] {embedder.__class__.__name__} dim={embedder.dim}")

    # 健康检查
    try:
        probe = QdrantClient(host="127.0.0.1", port=6333)
        h = probe.get_collection(collection)
        existing_count = h.points_count
        logger.info(f"[qdrant] collection={collection} existing_count={existing_count}")
    except Exception as e:
        logger.error(f"[qdrant] 健康检查失败: {e}")
        return {"mode": "commit", "qdrant_unreachable": True, "error": str(e)}

    namespace = uuid.UUID(hashlib.md5(collection.encode()).hexdigest())
    cfg_q = QdrantConfig(collection=collection)
    q_internal = QInternal(cfg_q)

    summary = {}
    grand_total = 0
    grand_upserted = 0
    grand_failed = 0
    grand_skipped = 0
    t_global = time.time()

    for src in sources:
        if src not in SOURCES:
            logger.error(f"Unknown source: {src}")
            continue
        cfg = SOURCES[src]
        rows = read_source_rows(sqlite_path, src)
        n = len(rows)
        grand_total += n

        if n == 0:
            summary[src] = {"row_count": 0, "upserted": 0, "failed": 0, "skipped": 0}
            logger.info(f"  [{src}] 0 条, 跳过")
            continue

        # 准备 points (text → vector)
        #   注意: source_id 在 items 里直接放, 不依赖 build_payload 是否含 id
        t0 = time.time()
        items = []
        for r in rows:
            text = cfg["build_text"](r)
            point_id = str(uuid.uuid5(namespace, f"{src}:{r['id']}"))
            items.append({
                "id": point_id,
                "text": text,
                "source_id": str(r["id"]),  # ← SQLite row.id 强保留
                "payload": cfg["build_payload"](r),
            })

        # 嵌入 + upsert
        try:
            texts = [it["text"] for it in items]
            vecs = embedder.embed_batch(texts)
            points = []
            for it, vec in zip(items, vecs):
                pl = dict(it["payload"])
                pl.setdefault("text", it["text"])
                pl.setdefault("source_table", src)
                pl["source_id"] = it["source_id"]  # ← 始终写入
                vec_list = vec.tolist() if hasattr(vec, "tolist") else list(vec)
                points.append({"id": it["id"], "vector": vec_list, "payload": pl})

            q_internal.upsert_points(points)
            upserted = len(points)
            failed = 0
            skipped = 0
        except Exception as e:
            logger.error(f"  [{src}] upsert 失败: {e}")
            upserted = 0
            failed = n
            skipped = 0
        elapsed = time.time() - t0

        grand_upserted += upserted
        grand_failed += failed
        grand_skipped += skipped

        summary[src] = {
            "row_count": n,
            "upserted": upserted,
            "failed": failed,
            "skipped": skipped,
            "elapsed_sec": round(elapsed, 3),
            "throughput_per_sec": round(n / elapsed, 1) if elapsed > 0 else 0,
        }
        logger.info(f"  [{src}] {upserted}/{n} upserted ({elapsed:.3f}s, {n/max(elapsed,1e-6):.1f} ops/s)")

    # 校验
    try:
        info = probe.get_collection(collection)
        final_count = info.points_count
    except Exception as e:
        logger.warning(f"[qdrant] count 校验失败: {e}")
        final_count = None

    return {
        "mode": "commit",
        "sqlite_path": str(sqlite_path),
        "qdrant_collection": collection,
        "embedder_backend": embedder.__class__.__name__,
        "embedder_dim": embedder.dim,
        "sources": summary,
        "grand_total": grand_total,
        "grand_upserted": grand_upserted,
        "grand_failed": grand_failed,
        "grand_skipped": grand_skipped,
        "qdrant_collection_count": final_count,
        "elapsed_sec": round(time.time() - t_global, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="SoloForge D10/D11 Embedding 回填")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写 (默认)")
    parser.add_argument("--commit", action="store_true", help="实际 upsert 到 Qdrant")
    parser.add_argument("--source", default="social_memory",
                        help="源表名 social_memory|culture|institution|all (default: social_memory)")
    parser.add_argument("--collection", default="ai_society_events",
                        help="Qdrant collection 名称")
    parser.add_argument("--json", action="store_true", help="机器可读 JSON 输出")
    args = parser.parse_args()

    py_dir = _setup_path()
    sqlite_path = _resolve_sqlite_path()

    sources = ["social_memory", "culture", "institution"] if args.source == "all" else [args.source]

    if args.commit:
        report = run_commit(sqlite_path, sources, collection=args.collection)
    else:
        report = run_dry_run(sqlite_path, sources)

    print("\n" + "=" * 70)
    print(f"Embedding 回填报告 ({report['mode']})")
    print("=" * 70)
    print(f"  sqlite:     {report['sqlite_path']}")
    if args.commit:
        print(f"  qdrant:     {report.get('qdrant_collection')}")
        print(f"  embedder:   {report.get('embedder_backend')} (dim={report.get('embedder_dim')})")
    print(f"  grand_total: {report.get('grand_total', 0)}")
    if args.commit:
        print(f"  upserted:    {report.get('grand_upserted', 0)}")
        print(f"  failed:      {report.get('grand_failed', 0)}")
        if "qdrant_collection_count" in report:
            print(f"  qdrant count (collection total): {report['qdrant_collection_count']}")
    for src, info in report.get("sources", {}).items():
        if args.commit:
            print(f"  [{src}] {info['upserted']}/{info['row_count']} upserted in {info['elapsed_sec']}s ({info['throughput_per_sec']} ops/s)")
        else:
            print(f"  [{src}] {info['description']}: {info['row_count']} 条")
    print("=" * 70)

    if args.json:
        print("\n--- JSON ---")
        print(json.dumps(report, ensure_ascii=False, indent=2))

    # 退出码: commit 模式下, 若 upserted < total -> 1
    if args.commit:
        if report.get("grand_failed", 0) > 0:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())