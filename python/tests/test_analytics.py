# -*- coding: utf-8 -*-
"""
SoloForge AI Society - DuckDB Analytics Tests (2026-07-02)

端到端验证：
1. health()  能识别 duckdb.exe + SQLite
2. export_snapshot() 抽表到独立 .duckdb
3. export_to_parquet() 导出训练数据
4. run_analytics('memory_table_counts') 聚合查询
5. 临时 snapshot 文件可被独立 duckdb CLI 打开
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from soloforge_ai_society.services.analytics import (
    AnalyticsService,
    ANALYTICS_QUERIES,
    _resolve_duckdb_binary,
)


DUCKDB_BIN = _resolve_duckdb_binary()
SKIP_REASON = "duckdb.exe not available"
pytestmark = pytest.mark.skipif(not DUCKDB_BIN, reason=SKIP_REASON)


@pytest.fixture
def temp_workspace():
    """临时工作目录"""
    tmp = Path(tempfile.mkdtemp(prefix="analytics_test_"))
    yield tmp
    if tmp.exists():
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture
def service():
    """AnalyticsService 实例（依赖真实 ai_society.db）"""
    return AnalyticsService()


class TestHealth:
    """health() 基础检查"""

    def test_health_returns_duckdb_binary(self, service):
        h = service.health()
        assert h["duckdb_binary"]
        assert Path(h["duckdb_binary"]).exists()

    def test_health_returns_sqlite_path(self, service):
        h = service.health()
        assert h["sqlite_path"]
        assert Path(h["sqlite_path"]).exists()

    def test_health_lists_queries(self, service):
        h = service.health()
        assert "memory_table_counts" in h["queries_defined"]
        assert len(h["queries_defined"]) >= 4


class TestBuiltInQueries:
    """内置聚合查询模板"""

    def test_all_queries_have_sql(self):
        for name, spec in ANALYTICS_QUERIES.items():
            assert "sql" in spec, f"{name} missing sql"
            assert spec["sql"].strip().upper().startswith("SELECT"), \
                f"{name} should be a SELECT"

    @pytest.mark.parametrize("query_name", list(ANALYTICS_QUERIES.keys()))
    def test_query_runs(self, service, query_name):
        """每个内置查询都应能跑通（即使返回 0 行）"""
        result = service.run_analytics(query_name)
        assert "rows" in result
        assert "row_count" in result
        assert result["row_count"] >= 0


class TestExportSnapshot:
    """export_snapshot() 端到端"""

    def test_snapshot_creates_file(self, service, temp_workspace):
        out = temp_workspace / "snap.duckdb"
        r = service.export_snapshot(out, tables=["culture", "law"])
        assert Path(r["out_path"]).exists()
        assert Path(r["out_path"]).stat().st_size > 0

    def test_snapshot_table_row_counts(self, service, temp_workspace):
        out = temp_workspace / "snap.duckdb"
        r = service.export_snapshot(out, tables=["culture", "law", "coalition"])
        counts = {t["table"]: t["row_count"] for t in r["tables_exported"]}
        # 3 张表必须都返回有效行数（>=0）
        assert all(c >= 0 for c in counts.values())
        assert set(counts.keys()) == {"culture", "law", "coalition"}
        assert r["total_rows"] == sum(counts.values())

    def test_snapshot_independently_openable(self, service, temp_workspace):
        """生成的 .duckdb 必须能被独立 duckdb CLI 打开"""
        out = temp_workspace / "snap.duckdb"
        service.export_snapshot(out, tables=["culture"])

        # 用独立 duckdb 进程验证（ATTACH 进去再查）
        result = subprocess.run(
            [
                DUCKDB_BIN, "-csv", "-c",
                f"ATTACH '{out.as_posix()}' AS snap; SELECT COUNT(*) FROM snap.main.culture",
            ],
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, f"duckdb open failed: {result.stderr}"
        # CSV 输出应该有数字
        lines = [l for l in result.stdout.strip().split("\n") if l]
        assert len(lines) >= 1

    def test_snapshot_rebuilds_existing_file(self, service, temp_workspace):
        """重复调用应覆盖（避免 schema 漂移）"""
        out = temp_workspace / "snap.duckdb"
        r1 = service.export_snapshot(out, tables=["culture"])
        r2 = service.export_snapshot(out, tables=["culture", "law"])
        assert Path(r1["out_path"]) == Path(r2["out_path"])
        assert len(r2["tables_exported"]) == 2


class TestExportParquet:
    """export_to_parquet() 端到端"""

    def test_parquet_files_created(self, service, temp_workspace):
        out_dir = temp_workspace / "parquet_out"
        r = service.export_to_parquet(out_dir, tables=["culture", "law"])
        assert Path(r["out_dir"]).exists()
        for f in r["files"]:
            assert Path(f["path"]).exists()
            assert f["size_bytes"] > 0
            assert f["path"].endswith(".parquet")

    def test_parquet_cleans_temp_duckdb(self, service, temp_workspace):
        out_dir = temp_workspace / "parquet_out"
        service.export_to_parquet(out_dir, tables=["culture"])
        # _snapshot.duckdb 临时文件应被清理
        assert not (out_dir / "_snapshot.duckdb").exists()

    def test_parquet_readable_by_duckdb_cli(self, service, temp_workspace):
        """生成的 parquet 必须能被独立 duckdb 读"""
        out_dir = temp_workspace / "parquet_out"
        service.export_to_parquet(out_dir, tables=["culture"])
        pq = out_dir / "culture.parquet"

        result = subprocess.run(
            [
                DUCKDB_BIN, "-csv", "-c",
                f"SELECT COUNT(*) FROM read_parquet('{pq.as_posix()}')",
            ],
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, f"parquet read failed: {result.stderr}"
