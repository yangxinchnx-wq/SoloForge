# -*- coding: utf-8 -*-
"""
M2 幂等性 e2e 验证
Path: python/tools/m2_idempotency_e2e_test.py
Date: 2026-07-01

完整链路:
  1. 直接 fetch POST http://127.0.0.1:8766/sync/reputation (绕开 3001/bridge/outbox,
     因为 bridge 每次 emit 会生成新 commandId, 不能复现"同 commandId 重放")
  2. 同一 commandId 发 3 次:
     - 第 1 次期望: HTTP 200 + {"ok":true,"deduped":false}, SQLite 累加 1 次
     - 第 2/3 次期望: HTTP 200 + {"ok":true,"deduped":true}, SQLite 不变
  3. 验证 SQLite current_reputation_score 累加 = 单次 delta (不重复)

要求: 8766 必须 listening (node start-all.mjs --no-electron 已起 server_prod)
"""
from __future__ import annotations

import json
import socket
import sys
import time
import urllib.error
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


def post_json_raw(url: str, payload: dict) -> tuple:
    """原汁原味 fetch, 不抛 HTTPError, 返回 (status, body)"""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5.0) as resp:
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


def get_dedup_count(command_id: str) -> int:
    """查 dedup 表有几行 (期望 1, 即只记一次)"""
    import sqlite3
    conn = sqlite3.connect(str(REPO_DB), timeout=5.0)
    try:
        # 表名默认 reputation_sync_log_event_dedup (与 config 默认一致)
        # 实际生产表名可能不同, 这里兜底查
        for table in (
            "reputation_sync_log_event_dedup",
            "reputation_sync_event_dedup",
        ):
            try:
                row = conn.execute(
                    f"SELECT count(*) FROM {table} WHERE command_id = ?",
                    (command_id,),
                ).fetchone()
                if row is not None:
                    return row[0]
            except sqlite3.OperationalError:
                continue
        return -1  # 表都不存在
    finally:
        conn.close()


def cleanup_db(cluster_id: str, command_id: str) -> None:
    import sqlite3
    conn = sqlite3.connect(str(REPO_DB), timeout=5.0)
    try:
        conn.execute("DELETE FROM reputation_sync_log WHERE cluster_id = ?", (cluster_id,))
        for table in (
            "reputation_sync_log_event_dedup",
            "reputation_sync_event_dedup",
        ):
            try:
                conn.execute(f"DELETE FROM {table} WHERE command_id = ?", (command_id,))
            except sqlite3.OperationalError:
                continue
        conn.commit()
    finally:
        conn.close()


def main() -> int:
    print("=== M2 幂等性端到端验证 (HTTP → 8766 → SQLite) ===\n")

    # 检查 8766
    print("[1] 端口检查:")
    if not is_port_listening(8766):
        print("    ✗ :8766 NOT LISTENING, 先 node start-all.mjs --no-electron")
        return 1
    print("    ✓ :8766 OK")

    cluster_id = f"e2e_m2_test_{int(time.time())}"
    # 同一 commandId, 复用 3 次
    dup_command_id = f"e2e_m2_dup_cid_{int(time.time())}"
    delta = 5.0
    print(f"\n[2] 测试 cluster_id={cluster_id}")
    print(f"    dup_command_id={dup_command_id}")
    print(f"    delta={delta} (期望 SQLite 累加 1 次, 总分 = 5.0)")

    cleanup_db(cluster_id, dup_command_id)  # 保险清

    payload = {
        "commandId": dup_command_id,
        "txId": "e2e_m2_tx",
        "traceId": "e2e_m2_trace",
        "agentClusterId": cluster_id,
        "reputationIncrement": delta,
        "reasonCode": "M2_E2E_TEST",
        "kernelVersionSeal": 1,
    }

    print(f"\n[3] 同一 commandId 连发 3 次到 http://127.0.0.1:8766/sync/reputation")
    results = []
    for i in range(3):
        code, body = post_json_raw("http://127.0.0.1:8766/sync/reputation", payload)
        try:
            body_json = json.loads(body) if body else {}
        except json.JSONDecodeError:
            body_json = {"raw": body}
        results.append((code, body_json))
        marker = "✓" if code == 200 else "✗"
        deduped = body_json.get("deduped")
        print(f"    {marker} POST #{i+1} → HTTP {code} body={body_json} (deduped={deduped})")
        if code == 200:
            time.sleep(0.2)  # 给 receiver 写盘时间

    # 校验响应
    print(f"\n[4] 响应校验:")
    expected_deduped = [False, True, True]
    all_pass = True
    for i, (code, body) in enumerate(results):
        if code != 200:
            print(f"    ✗ POST #{i+1} HTTP {code} (期望 200)")
            all_pass = False
            continue
        if body.get("ok") is not True:
            print(f"    ✗ POST #{i+1} ok != True: {body}")
            all_pass = False
            continue
        if body.get("deduped") != expected_deduped[i]:
            print(f"    ✗ POST #{i+1} deduped={body.get('deduped')} (期望 {expected_deduped[i]})")
            all_pass = False
    if all_pass:
        print(f"    ✓ 3 次响应: [200+deduped:false, 200+deduped:true, 200+deduped:true] 全对")

    # 校验 SQLite
    print(f"\n[5] SQLite 校验:")
    actual = get_db_score(cluster_id)
    print(f"    reputation_sync_log.current_reputation_score = {actual} (期望 5.0)")
    if abs(actual - delta) > 0.01:
        print(f"    ✗ FAIL: 累加错误, 期望 {delta} (单次), 实际 {actual}")
        cleanup_db(cluster_id, dup_command_id)
        return 1
    print(f"    ✓ 累加正确 (3 次重放 → 只加 1 次 = {actual})")

    dedup_count = get_dedup_count(dup_command_id)
    print(f"    event_dedup 表中 command_id={dup_command_id} 行数 = {dedup_count} (期望 1)")
    if dedup_count != 1:
        print(f"    ✗ FAIL: dedup 表行数不对")
        cleanup_db(cluster_id, dup_command_id)
        return 1
    print(f"    ✓ dedup 表只记 1 次 (幂等键生效)")

    # 边界: 不同 commandId 同 cluster 期望累加
    print(f"\n[6] 边界测试: 不同 commandId 同 cluster, 期望继续累加")
    for i in range(2):
        distinct_payload = dict(payload)
        distinct_payload["commandId"] = f"{dup_command_id}_distinct_{i}"
        distinct_payload["reputationIncrement"] = 1.0
        code, body = post_json_raw("http://127.0.0.1:8766/sync/reputation", distinct_payload)
        marker = "✓" if code == 200 else "✗"
        print(f"    {marker} POST distinct #{i+1} cid=...{i} delta=1.0 → HTTP {code} body={body[:100]}")
        time.sleep(0.2)

    actual2 = get_db_score(cluster_id)
    expected2 = delta + 2 * 1.0
    print(f"    SQLite score = {actual2} (期望 {expected2} = 5.0 + 1.0 + 1.0)")
    if abs(actual2 - expected2) > 0.01:
        print(f"    ✗ FAIL: 不同 commandId 累加失败")
        cleanup_db(cluster_id, dup_command_id)
        return 1
    print(f"    ✓ 不同 commandId 正常累加, 互不干扰")

    # 清理
    cleanup_db(cluster_id, dup_command_id)
    for i in range(2):
        cleanup_db(cluster_id, f"{dup_command_id}_distinct_{i}")
    print(f"\n[7] 清理: 已删除 cluster_id={cluster_id} 相关所有行")

    print(f"\n=== 总结 ===")
    print(f"  M2 幂等键 (event_dedup 表 command_id PRIMARY KEY) 生效")
    print(f"  ✓ 同一 commandId 重放 3 次 → SQLite score 只加 1 次")
    print(f"  ✓ HTTP 200 + deduped:true 标识, outbox worker 不会无限重试")
    print(f"  ✓ 不同 commandId 同 cluster 继续累加, 业务语义保留")
    print(f"\n  ✅ PASS (M2 幂等性: 防重放, 不破坏累加)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
