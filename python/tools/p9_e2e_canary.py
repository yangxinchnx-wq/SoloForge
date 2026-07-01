# -*- coding: utf-8 -*-
"""
P9 端到端 canary 验证 (B1+B2+B3 修复后)
Path: python/tools/p9_e2e_canary.py
Date: 2026-06-30

验证 audit_2026-06-30.md 的 B1 (类型) + B2 (HTTP server) + B3 (bridge 集成) 三修复
之后, P9 端到端真正打通。
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from soloforge_ai_society.services.reputation_sync_receiver import (  # noqa: E402
    ReputationSyncReceiver,
    start_sync_http_server,
    stop_sync_http_server,
)


class OutboxWorkerSim:
    """内存版 outbox worker (P9 通路模拟)"""

    def __init__(self, target_url: str, max_retries: int = 5):
        self.target_url = target_url
        self.max_retries = max_retries
        self.queue = []
        self.sent = []
        self.dead = []
        self.lock = threading.Lock()

    def enqueue(self, payload: dict) -> str:
        oid = f"outbox_e2e_{int(time.time()*1000)}_{len(self.queue)}"
        with self.lock:
            self.queue.append({"id": oid, "payload": payload, "retry_count": 0})
        return oid

    def push(self) -> int:
        sent_now = 0
        with self.lock:
            pending = [q for q in self.queue if q["retry_count"] < self.max_retries and q["id"] not in {s["id"] for s in self.sent}]
        for item in pending:
            body = json.dumps(item["payload"]).encode("utf-8")
            req = urllib.request.Request(
                self.target_url,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Outbox-Id": item["id"],
                    "X-Command-Id": item["payload"].get("commandId", ""),
                },
                method="POST",
            )
            try:
                resp = urllib.request.urlopen(req, timeout=3)
                if 200 <= resp.status < 300:
                    with self.lock:
                        self.sent.append({"id": item["id"], "payload": item["payload"]})
                    sent_now += 1
                else:
                    item["retry_count"] += 1
            except Exception as e:
                item["retry_count"] += 1
                item["last_error"] = str(e)
                if item["retry_count"] >= self.max_retries:
                    with self.lock:
                        self.dead.append(item)
        return sent_now


def make_payload(command_id: str, cluster_id: str, increment: float, reason: str = "E2E_TEST") -> dict:
    return {
        "commandId": command_id,
        "txId": f"tx_{command_id}",
        "traceId": f"trace_{command_id}",
        "agentClusterId": cluster_id,
        "reputationIncrement": increment,
        "reasonCode": reason,
        "kernelVersionSeal": 1,
        "timestamp": int(time.time() * 1000),
    }


def main():
    print("=== P9 端到端 canary 验证 (B1+B2+B3 修复后) ===\n")

    tmpdir = tempfile.mkdtemp(prefix="p9_e2e_")
    db_path = os.path.join(tmpdir, "test_reputation.db")
    print(f"[SETUP] tmpdir={tmpdir}")

    config = {
        "society.reputation.table_name": "reputation_sync_log",
        "society.reputation.pool_max": 4,
    }

    receiver = ReputationSyncReceiver(db_path, config)
    start_sync_http_server(receiver, host="127.0.0.1", port=8766)
    print("[STEP] HTTP server up on http://127.0.0.1:8766/sync/reputation")

    worker = OutboxWorkerSim("http://127.0.0.1:8766/sync/reputation", max_retries=5)

    try:
        # Health
        try:
            h = urllib.request.urlopen("http://127.0.0.1:8766/health", timeout=2)
            print(f"[HEALTH] GET /health → {h.status} {h.read().decode()}")
        except Exception as e:
            print(f"[FAIL] /health failed: {e}")
            return 1

        # 9 messages, 3 clusters × 3 each
        N = 9
        for i in range(N):
            cluster = f"agent_cluster_e2e_{i // 3}"
            worker.enqueue(make_payload(
                command_id=f"cmd_e2e_{i:03d}",
                cluster_id=cluster,
                increment=2.5 + i * 0.5,
                reason=f"E2E_TEST_{i}",
            ))
        print(f"[STEP] enqueued {N} messages, 3 unique clusters")

        # Poll
        for round_n in range(3):
            sent_now = worker.push()
            print(f"[POLL {round_n}] sent={sent_now}, total sent={len(worker.sent)}, dead={len(worker.dead)}")
            if len(worker.sent) + len(worker.dead) >= N:
                break
            time.sleep(0.2)

        # Verify DB
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT cluster_id, current_reputation_score, update_reason, command_id FROM reputation_sync_log ORDER BY cluster_id"
        ).fetchall()
        print(f"\n[DB] reputation_sync_log rows={len(rows)}")
        for r in rows:
            print(f"  - cluster={r['cluster_id']} score={r['current_reputation_score']:.4f} "
                  f"reason={r['update_reason']} cmd={r['command_id']}")
        conn.close()

        # Expected: cluster_0: i=0,1,2 → 2.5+3.0+3.5=9.0; cluster_1: i=3,4,5 → 4.0+4.5+5.0=13.5; cluster_2: i=6,7,8 → 5.5+6.0+6.5=18.0
        expected = {
            "agent_cluster_e2e_0": 9.0,
            "agent_cluster_e2e_1": 13.5,
            "agent_cluster_e2e_2": 18.0,
        }
        actual = {r["cluster_id"]: round(r["current_reputation_score"], 4) for r in rows}
        print(f"\n[CHECK] expected: {expected}")
        print(f"[CHECK] actual:   {actual}")
        sum_correct = expected == actual

        sent_count = len(worker.sent)
        dead_count = len(worker.dead)
        db_rows = len(rows)
        cluster_count = len({r["cluster_id"] for r in rows})

        pass_ = (
            sent_count == N
            and dead_count == 0
            and db_rows == 3
            and cluster_count == 3
            and sum_correct
        )

        print(f"\n=== P9 E2E 验收 ===")
        print(f"  worker.sent:       {sent_count}/{N}")
        print(f"  worker.dead:       {dead_count}")
        print(f"  db rows:           {db_rows}")
        print(f"  cluster_count:     {cluster_count}/3")
        print(f"  sum correct:       {sum_correct}")
        print(f"  RESULT:            {'✅ PASS' if pass_ else '❌ FAIL'}")
        return 0 if pass_ else 1
    finally:
        stop_sync_http_server()
        try:
            os.remove(db_path)
            os.rmdir(tmpdir)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())