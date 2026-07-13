# -*- coding: utf-8 -*-
"""
SoloForge Qdrant 向量重建脚本
Path: python/tools/rebuild_qdrant_vectors.py

用途:
  当 Qdrant 数据丢失时（如 bin/data/qdrant 被误删），
  从 SQLite (ai_society.db) 的 social_memory 表重新嵌入向量到 Qdrant。

用法:
  cd c:\Users\yangx\Desktop\SoloForge
  bin\python-3.13\python.exe python\tools\rebuild_qdrant_vectors.py

前提:
  1. Qdrant 服务已启动 (port 6333)
  2. BadgerDB Gateway 已启动 (port 7001) — 非必须，但推荐
  3. MiniLM 模型存在于 bin/models/paraphrase-multilingual-MiniLM-L12-v2/
"""
from __future__ import annotations

import logging
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

# 确保项目根目录在 sys.path 中
PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "python"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("rebuild_qdrant")

# --- 路径常量 ---
SQLITE_PATH = PROJECT_ROOT / "python" / "data" / "ai_society" / "ai_society.db"


def load_social_memories(db_path: Path) -> List[Dict[str, Any]]:
    """从 SQLite 读取所有 social_memory 记录"""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM social_memory ORDER BY created_at")
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def rebuild_qdrant() -> Dict[str, Any]:
    """重建 Qdrant 向量索引"""
    stats = {
        "start_time": datetime.now().isoformat(),
        "sqlite_path": str(SQLITE_PATH),
        "total_memories": 0,
        "upserted": 0,
        "failed": 0,
        "errors": [],
    }

    # 1. 检查 SQLite 文件
    if not SQLITE_PATH.exists():
        raise FileNotFoundError(f"SQLite database not found: {SQLITE_PATH}")

    # 2. 加载 social_memory 数据
    memories = load_social_memories(SQLITE_PATH)
    stats["total_memories"] = len(memories)
    logger.info("Loaded %d social_memory records from SQLite", len(memories))

    if not memories:
        logger.warning("No social_memory records found — nothing to rebuild")
        stats["end_time"] = datetime.now().isoformat()
        return stats

    # 3. 初始化 Qdrant 向量搜索（会自动创建 collection）
    from soloforge_ai_society.vector.qdrant_adapter import QdrantVectorSearch
    from soloforge_ai_society.vector.factory import get_embedder

    logger.info("Initializing embedder (MiniLM 384-dim)...")
    embedder = get_embedder()
    logger.info("Embedder ready: %s (dim=%d)", type(embedder).__name__, embedder.dim)

    logger.info("Initializing QdrantVectorSearch (will create collection if missing)...")
    search = QdrantVectorSearch(embedder=embedder)
    logger.info("QdrantVectorSearch initialized")

    # 4. 逐条重建向量
    t0 = time.time()
    for i, mem in enumerate(memories):
        try:
            # 解析 created_at 为时间戳
            created_at_str = mem.get("created_at", "")
            try:
                created_at_ts = int(datetime.fromisoformat(created_at_str).timestamp())
            except (ValueError, TypeError):
                created_at_ts = int(time.time())

            # 构造 payload（与 MemoryService.create 保持一致）
            payload = {
                "memory_id": mem["id"],
                "impact": mem.get("impact", ""),
                "severity": mem.get("severity", ""),
                "participants": mem.get("participants", ""),
                "lessons": mem.get("lessons", ""),
                "task_id": mem.get("task_id") or "",
                "domain": mem.get("domain") or "",
                "outcome": mem.get("outcome") or "",
                "created_at": created_at_ts,
            }

            # 嵌入 event 文本并写入 Qdrant
            search.upsert(text=mem["event"], payload=payload)
            stats["upserted"] += 1

            if (i + 1) % 10 == 0:
                logger.info("Progress: %d/%d (%.1f%%)", i + 1, len(memories), (i + 1) / len(memories) * 100)

        except Exception as e:
            stats["failed"] += 1
            stats["errors"].append({"memory_id": mem.get("id", "?"), "error": str(e)})
            logger.error("Failed to upsert memory %s: %s", mem.get("id", "?"), e)

    elapsed = time.time() - t0
    stats["elapsed_seconds"] = round(elapsed, 2)
    stats["end_time"] = datetime.now().isoformat()

    # 5. 验证结果
    try:
        from soloforge_ai_society.services.qdrant_client import QdrantClient, QdrantConfig
        client = QdrantClient(QdrantConfig())
        info = client.get_collection_info()
        stats["qdrant_collection_info"] = info
        logger.info("Qdrant collection after rebuild: %s", info)
    except Exception as e:
        logger.warning("Could not get Qdrant collection info: %s", e)

    logger.info(
        "Rebuild complete: %d/%d upserted, %d failed, %.2fs",
        stats["upserted"], stats["total_memories"], stats["failed"], elapsed,
    )
    return stats


if __name__ == "__main__":
    print("=" * 60)
    print("SoloForge Qdrant Vector Rebuild")
    print("=" * 60)

    result = rebuild_qdrant()

    print()
    print("=" * 60)
    print("Rebuild Summary")
    print("=" * 60)
    print(f"  SQLite source:   {result['sqlite_path']}")
    print(f"  Total memories:  {result['total_memories']}")
    print(f"  Upserted:        {result['upserted']}")
    print(f"  Failed:          {result['failed']}")
    print(f"  Elapsed:         {result.get('elapsed_seconds', 0):.2f}s")
    if result.get("qdrant_collection_info"):
        info = result["qdrant_collection_info"]
        print(f"  Qdrant points:   {info.get('points_count', '?')}")
        print(f"  Qdrant status:   {info.get('status', '?')}")
    if result["errors"]:
        print(f"  Errors ({len(result['errors'])}):")
        for e in result["errors"][:5]:
            print(f"    - {e['memory_id']}: {e['error']}")
    print("=" * 60)
