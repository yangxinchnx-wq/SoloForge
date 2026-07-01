# -*- coding: utf-8 -*-
"""
SoloForge DuckDB Analytics Service
Path: python/soloforge_ai_society/services/analytics.py
Date: 2026-06-30

治理/经济/法律/声誉聚合查询的 DuckDB 加速层。
零破坏：不动现有 SQLite 代码，analytics 是只读外挂查询。
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