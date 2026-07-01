# -*- coding: utf-8 -*-
"""
SoloForge DuckDB Analytics Service
Path: python/soloforge_ai_society/services/analytics.py
Date: 2026-06-30
Updated: 2026-07-02 — 补齐训练数据导出能力（snapshot + parquet）

DuckDB 在 AI Society 数据栈中的定位（第 5 层：OLAP 分析）：
  ┌──────────────────────────────────────────┐
  │  L1 OLTP   → SQLite (200KB, WAL+mmap)    │  写入主库
  │  L2 向量   → Qdrant 6333 (MiniLM 384d)   │  语义检索
  │  L3 缓存   → Garnet 6379                 │  读加速 106x
  │  L4 冷数据 → JSONL                       │  不可变审计
  │  L5 OLAP   → DuckDB (本文件)             │  训练数据准备 + 聚合
  └──────────────────────────────────────────┘

零破坏：不动现有 SQLite 代码，analytics 是只读外挂查询 + 离线快照导出。
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ---- 内置分析查询模板 ----
ANALYTICS_QUERIES: Dict[str, Dict[str, Any]] = {
    "governance_summary": {
        "description": "治理合规记录按 action_taken 聚合（最近）",
        "sql": """
            SELECT
                action_taken,
                compliant,
                COUNT(*) AS cnt
            FROM db.main.governance_record
            GROUP BY action_taken, compliant
            ORDER BY cnt DESC
            LIMIT 20
        """,
    },
    "top_institutions": {
        "description": "Top 机构 by 信誉分 (reputation)",
        "sql": """
            SELECT entity_id, entity_type, score, name
            FROM db.main.reputation
            ORDER BY CAST(score AS DOUBLE) DESC NULLS LAST
            LIMIT 10
        """,
    },
    "law_violation_by_type": {
        "description": "法律违规按 status 聚合 + 平均 ID 分布",
        "sql": """
            SELECT
                status,
                COUNT(*) AS cnt,
                COUNT(DISTINCT law_id) AS distinct_laws
            FROM db.main.law_violation
            GROUP BY status
            HAVING cnt > 0
            ORDER BY cnt DESC
            LIMIT 20
        """,
    },
    "memory_table_counts": {
        "description": "每个业务表的 DuckDB 视角行数",
        "sql": """
            SELECT 'coalition' AS table_name, COUNT(*) AS row_count FROM db.main.coalition
            UNION ALL SELECT 'economy', COUNT(*) FROM db.main.economy
            UNION ALL SELECT 'governance', COUNT(*) FROM db.main.governance
            UNION ALL SELECT 'governance_record', COUNT(*) FROM db.main.governance_record
            UNION ALL SELECT 'law', COUNT(*) FROM db.main.law
            UNION ALL SELECT 'law_violation', COUNT(*) FROM db.main.law_violation
            UNION ALL SELECT 'reputation', COUNT(*) FROM db.main.reputation
            UNION ALL SELECT 'reputation_record', COUNT(*) FROM db.main.reputation_record
            UNION ALL SELECT 'social_memory', COUNT(*) FROM db.main.social_memory
            UNION ALL SELECT 'credit_transaction', COUNT(*) FROM db.main.credit_transaction
            UNION ALL SELECT 'economy_record', COUNT(*) FROM db.main.economy_record
            UNION ALL SELECT 'culture', COUNT(*) FROM db.main.culture
            UNION ALL SELECT 'institution', COUNT(*) FROM db.main.institution
            ORDER BY row_count DESC
        """,
    },
}


def _resolve_duckdb_binary() -> Optional[str]:
    """查找 duckdb CLI 二进制"""
    candidates = [
        Path(__file__).resolve().parents[3] / "bin" / "duckdb" / "duckdb.exe",
        Path("C:/Users/yangx/Desktop/SoloForge/bin/duckdb/duckdb.exe"),
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return shutil.which("duckdb")


def _resolve_sqlite_path() -> Optional[Path]:
    """查找 AI Society 主 SQLite 数据库"""
    candidates = [
        Path("python/data/ai_society/ai_society.db"),
        Path(__file__).resolve().parents[3] / "data" / "ai_society" / "ai_society.db",
        Path(__file__).resolve().parents[2] / "data" / "ai_society" / "ai_society.db",
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


class AnalyticsService:
    """DuckDB 加速分析服务（封装 duckdb CLI 调用）"""

    def __init__(self, duckdb_path: Optional[str] = None, sqlite_path: Optional[str] = None):
        self.duckdb_path = duckdb_path or _resolve_duckdb_binary()
        if not self.duckdb_path:
            raise FileNotFoundError("duckdb.exe not found in bin/duckdb/ or PATH")
        self.sqlite_path = Path(sqlite_path) if sqlite_path else _resolve_sqlite_path()
        if not self.sqlite_path:
            raise FileNotFoundError("AI Society SQLite database not found")

    def health(self) -> Dict[str, Any]:
        return {
            "duckdb_binary": str(self.duckdb_path),
            "duckdb_available": Path(self.duckdb_path).exists(),
            "sqlite_path": str(self.sqlite_path) if self.sqlite_path else None,
            "sqlite_exists": self.sqlite_path.exists() if self.sqlite_path else False,
            "queries_defined": list(ANALYTICS_QUERIES.keys()),
        }

    def _run_query(self, sql: str, fmt: str = "csv") -> str:
        """通过 duckdb CLI 执行查询，返回字符串输出。

        自动注入前缀：INSTALL sqlite; LOAD sqlite; ATTACH '<SQLITE_PATH>'
        把当前 SQLite 数据库作为 'db' 别名挂载，业务表用 db.main.<table> 引用。
        """
        attach_path = str(self.sqlite_path).replace("\\", "/")
        prefix = (
            "INSTALL sqlite; LOAD sqlite; "
            f"ATTACH '{attach_path}' AS db (TYPE sqlite); "
        )
        if not sql.lstrip().lower().startswith(("install", "select", "with", "pragma", "describe", "show", "from")):
            sql = prefix + sql
        else:
            sql = prefix + sql
        cmd = [self.duckdb_path, "-csv", "-c", sql]
        t = time.time()
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        elapsed = time.time() - t
        if proc.returncode != 0:
            raise RuntimeError(f"duckdb query failed: {proc.stderr}")
        logger.info("[analytics] query OK in %.3fs", elapsed)
        return proc.stdout

    def run_analytics(self, query_name: str) -> Dict[str, Any]:
        if query_name not in ANALYTICS_QUERIES:
            raise ValueError(f"Unknown query: {query_name}. Available: {list(ANALYTICS_QUERIES.keys())}")
        spec = ANALYTICS_QUERIES[query_name]
        out = self._run_query(spec["sql"])
        rows = []
        for line in out.strip().split("\n"):
            if line and not line.startswith(","):
                rows.append(line.split(","))
        return {
            "query_name": query_name,
            "description": spec["description"],
            "row_count": max(0, len(rows) - 1),
            "rows": rows,
            "raw_csv": out,
        }

    def list_queries(self) -> List[str]:
        return list(ANALYTICS_QUERIES.keys())

    def direct_sql(self, sql: str) -> str:
        """运行任意 SQL（read-only 推荐）"""
        return self._run_query(sql)

    # ---- 训练数据导出（2026-07-02 新增）----

    # 默认要导出快照的业务表（与初始化脚本创建顺序一致）
    SNAPSHOT_TABLES: List[str] = [
        "agent", "cluster", "memory", "reputation", "reputation_record",
        "event", "transaction", "credit_transaction", "coalition",
        "governance_record", "law", "law_violation", "economy_record",
    ]

    def export_snapshot(
        self,
        out_path: str | Path,
        tables: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """把 SQLite 业务表抽到独立 .duckdb 文件（训练数据准备第一步）。

        用 ATTACH + COPY ... TO 把每张表落到一个 .duckdb 文件，训练脚本可独立打开，
        不与 SQLite 在线写入路径冲突。

        Args:
            out_path: 输出 .duckdb 文件路径（不存在会自动创建父目录）
            tables: 要导出的表名列表；默认 SNAPSHOT_TABLES

        Returns:
            {
                "out_path": str,
                "tables_exported": [{"table": str, "row_count": int}, ...],
                "total_rows": int,
                "elapsed_s": float,
            }
        """
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        if out_path.exists():
            out_path.unlink()  # 重建，避免 schema 漂移

        tables = tables or self.SNAPSHOT_TABLES
        attach_path = str(self.sqlite_path).replace("\\", "/")
        out_path_str = str(out_path).replace("\\", "/")

        prefix = (
            "INSTALL sqlite; LOAD sqlite; "
            f"ATTACH '{attach_path}' AS src (TYPE sqlite, READ_ONLY); "
            f"ATTACH '{out_path_str}' AS dst; "
            "CREATE SCHEMA IF NOT EXISTS dst.main; "
        )

        results: List[Dict[str, Any]] = []
        t0 = time.time()
        for table in tables:
            # 1. 创建目标表（schema 从源复制）
            create_sql = f"CREATE OR REPLACE TABLE dst.main.{table} AS SELECT * FROM src.main.{table} WHERE 0"
            self._run_query(prefix + create_sql)
            # 2. 拷贝数据
            copy_sql = f"INSERT INTO dst.main.{table} SELECT * FROM src.main.{table}"
            self._run_query(prefix + copy_sql)
            # 3. 统计行数
            cnt_sql = f"SELECT COUNT(*) FROM dst.main.{table}"
            cnt_out = self._run_query(prefix + cnt_sql).strip()
            row_count = int(cnt_out.split("\n")[-1]) if cnt_out else 0
            results.append({"table": table, "row_count": row_count})

        elapsed = time.time() - t0
        total = sum(r["row_count"] for r in results)
        logger.info(
            "[analytics] snapshot OK: %d tables, %d total rows, %.2fs → %s",
            len(results), total, elapsed, out_path,
        )
        return {
            "out_path": str(out_path.resolve()),
            "tables_exported": results,
            "total_rows": total,
            "elapsed_s": round(elapsed, 3),
        }

    def export_to_parquet(
        self,
        out_dir: str | Path,
        tables: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """从 .duckdb 导出 Parquet（训练脚本 pandas/polars 友好）。

        工作流：先调 export_snapshot() 得到 .duckdb，再把每张表 COPY ... TO '<dir>/<table>.parquet'。
        训练脚本直接 pd.read_parquet() 即可，不依赖 DuckDB Python 库。

        Args:
            out_dir: 输出目录（每张表一个 .parquet 文件）
            tables: 要导出的表名列表；默认 SNAPSHOT_TABLES

        Returns:
            {
                "out_dir": str,
                "files": [{"table": str, "path": str, "row_count": int}, ...],
                "total_rows": int,
            }
        """
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        tables = tables or self.SNAPSHOT_TABLES

        # 先建临时 snapshot
        tmp_duckdb = out_dir / "_snapshot.duckdb"
        self.export_snapshot(tmp_duckdb, tables)

        # 导出 parquet
        attach_path = str(tmp_duckdb).replace("\\", "/")
        prefix = f"ATTACH '{attach_path}' AS src; "
        files: List[Dict[str, Any]] = []
        for table in tables:
            parquet_path = out_dir / f"{table}.parquet"
            copy_sql = f"COPY src.main.{table} TO '{parquet_path.as_posix()}' (FORMAT PARQUET)"
            self._run_query(prefix + copy_sql)
            # 行数：parquet 文件 size 作粗略指示
            files.append({
                "table": table,
                "path": str(parquet_path.resolve()),
                "size_bytes": parquet_path.stat().st_size if parquet_path.exists() else 0,
            })

        # 清理临时 .duckdb
        try:
            tmp_duckdb.unlink()
        except OSError:
            pass

        return {"out_dir": str(out_dir.resolve()), "files": files}