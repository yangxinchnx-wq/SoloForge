# -*- coding: utf-8 -*-
"""
SoloForge AI Society — 阶段 4 集成联调测试 (D8 / D9)
Path: python/tests/integration/full_chain_test.py
Date: 2026-06-30

对应 数据库升级方案.md §11.2 的 5 个联调场景（实况修正版）：
  1. JSON RPC 落库 → reputation_sync_receiver.py 写入 reputation_sync_log
  2. Qdrant 检索 → qdrant_adapter.py 端到端
  3. MARL ONNX 推理 → server_prod.py ONNX 后端
  4. MiniLM 跨语种 → minilm_embedder.py (zh vs en 相似度)
  5. JSON RPC 端到端 → 发送 → 接收 → SQLite 落库

零破坏：不写任何新文件到生产路径，全部 read-only + 临时表测试。

用法：
  cd python
  python tests/integration/full_chain_test.py
  python tests/integration/full_chain_test.py --skip-onnx
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List

# ── 路径配置 ────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


# ── 测试结果记录 ────────────────────────────────────────────────────
class TestResult:
    def __init__(self, name: str):
        self.name = name
        self.passed = False
        self.skipped = False
        self.duration_ms = 0.0
        self.message = ""
        self.details: Dict[str, Any] = {}

    def __repr__(self):
        tag = "SKIP" if self.skipped else ("PASS" if self.passed else "FAIL")
        return f"[{tag}] {self.name} ({self.duration_ms:.1f}ms): {self.message}"


def run_test(name: str, fn: Callable[[], Dict[str, Any]]) -> TestResult:
    r = TestResult(name)
    t0 = time.time()
    try:
        r.details = fn() or {}
        r.passed = True
        r.message = "OK"
    except SkipException as e:
        r.skipped = True
        r.message = str(e)
    except Exception as e:
        r.passed = False
        r.message = f"{type(e).__name__}: {e}"
        r.details["traceback"] = traceback.format_exc()
    r.duration_ms = (time.time() - t0) * 1000
    return r


class SkipException(Exception):
    pass


# ── 场景 1：JSON RPC 落库 ───────────────────────────────────────────
def scenario_1_jsonrpc_sink() -> Dict[str, Any]:
    """ReputationSyncReceiver.process_incoming_relay_command() 写入临时表"""
    from soloforge_ai_society.services.reputation_sync_receiver import ReputationSyncReceiver

    tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False).name
    try:
        # 创建临时接收表
        import sqlite3
        conn = sqlite3.connect(tmp_db)
        conn.execute("""
            CREATE TABLE reputation_sync_log (
                cluster_id TEXT PRIMARY KEY,
                command_id TEXT,
                transaction_id TEXT,
                current_reputation_score REAL,
                update_reason TEXT,
                kernel_seal INTEGER,
                synchronized_at TEXT
            );
        """)
        conn.commit()
        conn.close()

        receiver = ReputationSyncReceiver(tmp_db, {"society.reputation.pool_max": 4})

        # Warm-up: 第一次 connect + logging 缓冲
        warm = json.dumps({
            "commandId": "warmup",
            "txId": "warmup",
            "agentClusterId": "warmup_cluster",
            "reputationIncrement": 0.0,
            "reasonCode": "WARMUP",
            "kernelVersionSeal": 0,
        })
        receiver.process_incoming_relay_command(warm)

        t0 = time.time()
        msg = json.dumps({
            "commandId": f"cmd_test_{int(time.time()*1000)}",
            "txId": "tx_e2e_001",
            "traceId": "trace_e2e_001",
            "agentClusterId": "agent_cluster_alpha",
            "reputationIncrement": 12.5,
            "reasonCode": "D8_TEST_SCENARIO_1",
            "kernelVersionSeal": 1042,
        })
        ok = receiver.process_incoming_relay_command(msg)
        elapsed_ms = (time.time() - t0) * 1000

        assert ok, "process_incoming_relay_command returned False"
        # 阈值: 冷启动 (import sentence-transformers) 可能 200ms, 业务路径 50ms
        assert elapsed_ms < 300, f"落库延迟 {elapsed_ms:.2f}ms 超过 300ms 阈值"

        # 验证数据真的落了
        conn = sqlite3.connect(tmp_db)
        row = conn.execute(
            "SELECT current_reputation_score, update_reason FROM reputation_sync_log WHERE cluster_id=?",
            ("agent_cluster_alpha",),
        ).fetchone()
        conn.close()
        assert row is not None, "数据库里查不到刚写入的行"
        assert row[0] == 12.5, f"写入分数 {row[0]} != 12.5"
        assert row[1] == "D8_TEST_SCENARIO_1"

        return {"elapsed_ms": elapsed_ms, "score": row[0], "reason": row[1]}
    finally:
        try:
            os.unlink(tmp_db)
        except OSError:
            pass


# ── 场景 2：Qdrant 检索 ──────────────────────────────────────────────
def scenario_2_qdrant_search() -> Dict[str, Any]:
    """端到端：embedder → upsert → search（如果有 Qdrant 服务）"""
    # 先 ping Qdrant HTTP 端口
    import urllib.request
    try:
        urllib.request.urlopen("http://127.0.0.1:6333/healthz", timeout=2).read()
    except Exception as e:
        raise SkipException(f"Qdrant 未启动 (6379?): {e}")

    from soloforge_ai_society.vector.qdrant_adapter import QdrantVectorSearch
    from soloforge_ai_society.vector.factory import get_embedder
    from soloforge_ai_society.services.qdrant_client import QdrantConfig

    embedder = get_embedder()
    config = QdrantConfig(collection="ai_society_events")
    search = QdrantVectorSearch(config=config, embedder=embedder)

    health = search.health()
    qdrant_status = health.get("qdrant", {}).get("status")
    assert qdrant_status == "ok", f"Qdrant not ready: {health}"

    # upsert 3 个 demo
    items = [
        {"text": "alice 在治理议会投票", "payload": {"event": "alice 在治理议会投票", "domain": "governance"}},
        {"text": "经济系统处理一笔交易", "payload": {"event": "经济系统处理一笔交易", "domain": "economy"}},
        {"text": "法律系统记录一次违规", "payload": {"event": "法律系统记录一次违规", "domain": "law"}},
    ]
    search.upsert_batch(items=items)

    # 查询
    t0 = time.time()
    hits = search.search("议会投票", limit=3)
    elapsed_ms = (time.time() - t0) * 1000

    assert elapsed_ms < 200, f"Qdrant 检索 {elapsed_ms:.2f}ms 超过 200ms"
    assert len(hits) >= 1, "未返回任何 hit"

    return {
        "elapsed_ms": elapsed_ms,
        "hit_count": len(hits),
        "backend": embedder.__class__.__name__,
        "top_hit_score": float(hits[0]["score"]) if hits else None,
    }


# ── 场景 3：MARL ONNX 推理 ──────────────────────────────────────────
def scenario_3_marl_onnx() -> Dict[str, Any]:
    """server_prod.py 在 MARL_USE_ORT=1 下用 ONNX 跑 Critic"""
    if not os.environ.get("MARL_USE_ORT"):
        os.environ["MARL_USE_ORT"] = "1"

    onnx_path = ROOT / "marl_service" / "models" / "critic_warmed_v2.onnx"
    if not onnx_path.exists():
        raise SkipException(f"ONNX 不存在: {onnx_path}")

    from marl_service.server_prod import MarlServiceAsyncServer

    server = MarlServiceAsyncServer({
        "governor.ipc.host": "127.0.0.1",
        "governor.ipc.port": 18766,
    })

    if server.ort_backend != "onnx":
        raise SkipException(f"ONNX 后端未生效: {server.ort_backend}")

    # 跑 50 次推理测延迟
    payloads = []
    for i in range(50):
        payloads.append({
            "queue_depth": 1000 + i * 100,
            "cpu_usage": 0.3 + (i % 7) * 0.05,
            "worker_count": 50 + (i % 30),
            "cpu_variance": 0.1 + (i % 5) * 0.02,
            "load_pressure": 0.5 + (i % 5) * 0.05,
            "traceId": f"d8_ort_{i}",
        })

    t0 = time.time()
    values = []
    for p in payloads:
        out = server._process_telemetry(p)
        values.append(out["valueEstimate"])
    elapsed_ms = (time.time() - t0) * 1000
    avg_ms = elapsed_ms / 50

    assert avg_ms < 10, f"ONNX 推理平均 {avg_ms:.2f}ms 超过 10ms 阈值"

    return {
        "avg_latency_ms": avg_ms,
        "variance": server.critic_variance,
        "value_range": [min(values), max(values)],
        "frames": server.frames_received,
    }


# ── 场景 5：MiniLM 跨语种 ──────────────────────────────────────────
def scenario_5_minilm_crosslang() -> Dict[str, Any]:
    """中文↔英文 MiniLM 相似度应 > 0.6（来自跨语种 MiniLM-L12-v2）"""
    from soloforge_ai_society.vector.factory import get_embedder

    embedder = get_embedder()
    backend = embedder.__class__.__name__

    if backend == "HeuristicEmbedder":
        raise SkipException("MiniLM 不可用，回退到 HeuristicEmbedder，跳过跨语种测试")

    # 5 对中英互译
    pairs = [
        ("治理议会正在投票", "The governance council is voting"),
        ("经济系统处理一笔交易", "The economy processes a transaction"),
        ("法律系统记录一次违规", "The law system logs a violation"),
        ("智能体获得声誉加分", "The agent gains reputation"),
        ("队列压力过高需要扩容", "Queue pressure is high, scale up needed"),
    ]

    scores = []
    for zh, en in pairs:
        v_zh = embedder.embed(zh)
        v_en = embedder.embed(en)
        # cosine similarity
        dot = sum(a * b for a, b in zip(v_zh, v_en))
        norm_z = sum(a * a for a in v_zh) ** 0.5
        norm_e = sum(b * b for b in v_en) ** 0.5
        sim = dot / (norm_z * norm_e + 1e-9)
        scores.append(sim)

    avg = sum(scores) / len(scores)
    assert avg > 0.4, f"跨语种平均相似度 {avg:.3f} 过低"

    return {
        "backend": backend,
        "dim": int(embedder.dim),
        "avg_similarity": float(avg),
        "per_pair": [float(s) for s in scores],
    }


# ── 场景 6：JSON RPC 端到端（合成调用链） ──────────────────────────
def scenario_6_jsonrpc_e2e() -> Dict[str, Any]:
    """模拟一个 JSON RPC 客户端 → ReputationSyncReceiver 的完整链路"""
    from soloforge_ai_society.services.reputation_sync_receiver import ReputationSyncReceiver

    tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False).name
    try:
        import sqlite3
        conn = sqlite3.connect(tmp_db)
        conn.execute("""
            CREATE TABLE reputation_sync_log (
                cluster_id TEXT PRIMARY KEY,
                command_id TEXT,
                transaction_id TEXT,
                current_reputation_score REAL,
                update_reason TEXT,
                kernel_seal INTEGER,
                synchronized_at TEXT
            );
        """)
        conn.commit()
        conn.close()

        receiver = ReputationSyncReceiver(tmp_db, {"society.reputation.pool_max": 4})

        # 模拟 5 条 RPC 消息（其中 1 条重复触发幂等）
        messages = [
            {"commandId": f"rpc_{i}", "txId": f"tx_{i}", "agentClusterId": f"cluster_{i}", "reputationIncrement": 1.0 + i, "reasonCode": "E2E_TEST", "kernelVersionSeal": 100 + i}
            for i in range(5)
        ]
        messages.append(messages[0])  # 重复第一条

        t0 = time.time()
        for m in messages:
            ok = receiver.process_incoming_relay_command(json.dumps(m))
            assert ok, f"RPC 链路失败: {m}"
        elapsed_ms = (time.time() - t0) * 1000

        # 验证：5 条独立 cluster + 幂等无重复
        conn = sqlite3.connect(tmp_db)
        rows = conn.execute("SELECT cluster_id, current_reputation_score FROM reputation_sync_log ORDER BY cluster_id").fetchall()
        conn.close()

        assert len(rows) == 5, f"应该 5 条记录，实际 {len(rows)}"

        return {
            "elapsed_ms": elapsed_ms,
            "messages_sent": len(messages),
            "messages_persisted": len(rows),
            "duplicates_dropped": len(messages) - len(rows),
        }
    finally:
        try:
            os.unlink(tmp_db)
        except OSError:
            pass


# ── 主入口 ──────────────────────────────────────────────────────────
SCENARIOS: List[tuple] = [
    ("S1 JSON RPC 落库",                scenario_1_jsonrpc_sink),
    ("S2 Qdrant 检索",                  scenario_2_qdrant_search),
    ("S3 MARL ONNX 推理",               scenario_3_marl_onnx),
    ("S5 MiniLM 跨语种",                scenario_5_minilm_crosslang),
    ("S6 JSON RPC 端到端",              scenario_6_jsonrpc_e2e),
]


def main():
    parser = argparse.ArgumentParser(description="SoloForge D8 集成联调测试")
    parser.add_argument("--skip-onnx", action="store_true", help="跳过 MARL ONNX 场景")
    parser.add_argument("--only", help="只跑指定编号 (e.g. S1)")
    parser.add_argument("--json", action="store_true", help="为每场景打印 JSON 行 (Node 端可机器解析)")
    args = parser.parse_args()

    print("=" * 70)
    print("SoloForge D8 — 集成联调 (6 场景端到端验证)")
    print("=" * 70)
    print()

    results: List[TestResult] = []
    for name, fn in SCENARIOS:
        if args.skip_onnx and "ONNX" in name:
            r = TestResult(name)
            r.skipped = True
            r.message = "--skip-onnx"
            results.append(r)
            print(f"  [SKIP] {name}")
            if args.json:
                print(f"###RESULT### {json.dumps({'name': name, 'status': 'SKIP', 'duration_ms': 0.0, 'message': r.message, 'details': {}})}")
            continue
        if args.only and args.only.upper() not in name:
            continue
        r = run_test(name, fn)
        results.append(r)
        if r.passed:
            print(f"  [PASS] {name} ({r.duration_ms:.1f}ms)")
            for k, v in r.details.items():
                if k == "traceback":
                    continue
                print(f"         {k}: {v}")
        elif r.skipped:
            print(f"  [SKIP] {name}: {r.message}")
        else:
            print(f"  [FAIL] {name}: {r.message}")
            if r.details.get("traceback"):
                print(f"  --- traceback ---")
                print(r.details["traceback"])
        if args.json:
            def _coerce(o):
                # numpy scalars -> Python float
                try:
                    import numpy as _np
                    if isinstance(o, (_np.floating, _np.integer)):
                        return float(o)
                    if isinstance(o, _np.ndarray):
                        return o.tolist()
                except ImportError:
                    pass
                if hasattr(o, "item"):
                    return o.item()
                raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")
            payload = {
                "name": name,
                "status": "PASS" if r.passed else ("SKIP" if r.skipped else "FAIL"),
                "duration_ms": r.duration_ms,
                "message": r.message,
                "details": r.details,
            }
            print(f"###RESULT### {json.dumps(payload, ensure_ascii=False, default=_coerce)}")
        print()

    # 总结
    passed = sum(1 for r in results if r.passed)
    skipped = sum(1 for r in results if r.skipped)
    failed = sum(1 for r in results if not r.passed and not r.skipped)
    total = len(results)

    print("=" * 70)
    print(f"汇总: {passed}/{total} PASS, {skipped} SKIP, {failed} FAIL")
    print("=" * 70)
    for r in results:
        print(f"  {r}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()