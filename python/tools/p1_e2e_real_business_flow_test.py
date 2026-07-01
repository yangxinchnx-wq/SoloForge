# -*- coding: utf-8 -*-
"""
P1.1 + P1.3 端到端真业务流验证
Path: python/tools/p1_e2e_real_business_flow_test.py
Date: 2026-07-01

完整链路:
  1. POST http://127.0.0.1:3001/api/test/reputation-enqueue (dev hook)
     → 3001 emit ReputationIncrementRequested
     → bridge 订阅, 写 SurrealDB outbox_sync
     → OutboxWorker 100ms poll
     → fetch POST http://127.0.0.1:8766/sync/reputation
     → AI Society ReputationSyncHTTPHandler
     → SQLite reputation_sync_log
  2. 验证 SQLite current_reputation_score 累加 = 期望值

要求: 3001 必须用 SOLOFORGE_ENABLE_TEST_HOOK=1 启动
"""
from __future__ import annotations

import json
import socket
import sys
import time
import urllib.request
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
REPO_DB = PROJECT_DIR / "python" / "data" / "ai_society" / "ai_society.db"


def is_port_listening(port: int, host: str = "127.0.0.1", timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (ConnectionRefusedError, socket.timeout, OSError):
        return False


def post_json(url: str, payload: dict) -> tuple:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")
    except Exception as e:
        return 0, str(e)


def get_db_score(cluster_id: str) -> float:
    import sqlite3
    conn = sqlite3.connect(str(REPO_DB), timeout=5.0)
    try:
        row = conn.execute(
            "SELECT current_reputation_score FROM reputation_sync_log WHERE cluster_id = ?",
            (cluster_id,),
        ).fetchone()
        return row[0] if row else 0.0
    finally:
        conn.close()


def cleanup_db(cluster_id: str) -> int:
    import sqlite3
    conn = sqlite3.connect(str(REPO_DB), timeout=5.0)
    try:
        deleted = conn.execute(
            "DELETE FROM reputation_sync_log WHERE cluster_id = ?",
            (cluster_id,),
        ).rowcount
        conn.commit()
        return deleted
    finally:
        conn.close()


def main() -> int:
    print("=== P1.1 + P1.3 端到端真业务流验证 (emit → fetch → SQLite) ===\n")

    # 检查 3001, 8765, 8766
    print("[1] 端口检查:")
    for p in [3001, 8765, 8766]:
        ok = is_port_listening(p)
        marker = "✓" if ok else "✗"
        print(f"    {marker} :{p} {'OK' if ok else 'NOT LISTENING'}")
    if not all(is_port_listening(p) for p in [3001, 8765, 8766]):
        print(f"    ✗ FAIL: 端口不全, 先 node start-all.mjs --no-electron")
        return 1

    # 用唯一 cluster_id 测
    cluster_id = f"e2e_p1_test_{int(time.time())}"
    print(f"\n[2] 测试 cluster_id: {cluster_id}")
    cleanup_db(cluster_id)  # 保险清

    # 通过 3001 走完整链路
    print(f"\n[3] POST http://127.0.0.1:3001/api/test/reputation-enqueue")
    print(f"    → 3001 emit → bridge → outbox → worker → fetch 8766 → SQLite")

    expected = 0.0
    for i in range(1, 4):
        delta = float(i)
        expected += delta
        payload = {
            "commandId": f"e2e_p1_{int(time.time()*1000)}_{i}",
            "txId": f"e2e_p1_tx_{int(time.time()*1000)}_{i}",
            "traceId": f"e2e_p1_trace_{i}",
            "agentClusterId": cluster_id,
            "reputationIncrement": delta,
            "reasonCode": "P1_E2E_TEST",
            "kernelVersionSeal": 1,
        }
        code, body = post_json("http://127.0.0.1:3001/api/test/reputation-enqueue", payload)
        marker = "✓" if code == 200 else "✗"
        print(f"    {marker} POST #{i} delta={delta} → HTTP {code} {body[:150]}")
        if code != 200:
            print(f"    ✗ FAIL: 3001 返回非 200, 链路可能在 bridge 之前断")
            cleanup_db(cluster_id)
            return 1
        # 等 worker 推完
        time.sleep(0.5)

    # 给 2s 让所有 outbox 推送完成
    print(f"\n[4] 等 2s 让所有 outbox record 推送完成...")
    time.sleep(2.0)

    # 验证 SQLite
    print(f"\n[5] SQLite 验证: cluster_id={cluster_id}")
    actual = get_db_score(cluster_id)
    print(f"    expected: {expected}")
    print(f"    actual:   {actual}")
    if abs(actual - expected) > 0.01:
        print(f"    ✗ FAIL: 累加错误, 整条链路没真通")
        cleanup_db(cluster_id)
        return 1
    print(f"    ✓ 累加正确 (1+2+3 = {actual})")

    # 清理
    deleted = cleanup_db(cluster_id)
    print(f"\n[6] 清理: 删除 cluster_id={cluster_id} ({deleted} 行)")

    print(f"\n=== 总结 ===")
    print(f"  3001 → emit → bridge → outbox_sync → worker → fetch 8766 → AI Society → SQLite")
    print(f"  3/3 POST /api/test/reputation-enqueue 200 ✓")
    print(f"  SQLite 累加 1+2+3 = {actual} ✓")
    print(f"  完整链路真通 ✓")
    print(f"\n  ✅ PASS (P1.1 + P1.2 + P1.3 全部: 字段名对齐, 修复真生效, 业务流通)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
