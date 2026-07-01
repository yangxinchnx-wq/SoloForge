# -*- coding: utf-8 -*-
"""UI 3000 → 8766 代理测试 (验证 3000/api/marl/reputation 端到端)"""
import json
import time
import urllib.error
import urllib.request

cluster_id = f"ui_proxy_e2e_{int(time.time())}"
dup_cid = f"ui_proxy_dup_{int(time.time())}"
payload = {
    "commandId": dup_cid,
    "txId": "t1",
    "traceId": "tr1",
    "agentClusterId": cluster_id,
    "reputationIncrement": 2.0,
    "reasonCode": "UI_PROXY_E2E",
    "kernelVersionSeal": 1,
}
data = json.dumps(payload).encode("utf-8")
print("=== UI 3000 → 8766 代理测试 ===")
print(f"cluster_id={cluster_id}")
print(f"dup_command_id={dup_cid}")
for i in range(3):
    req = urllib.request.Request(
        "http://127.0.0.1:3000/api/marl/reputation",
        data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            print(f"  POST #{i+1} → HTTP {r.status} body={r.read().decode()}")
    except urllib.error.HTTPError as e:
        print(f"  POST #{i+1} → HTTP {e.code} body={e.read().decode()[:200]}")

# 验证 SQLite 累加
import sqlite3
db = r"C:\Users\yangx\Desktop\SoloForge\python\data\ai_society\ai_society.db"
conn = sqlite3.connect(db, timeout=5)
row = conn.execute(
    "SELECT current_reputation_score FROM reputation_sync_log WHERE cluster_id = ?",
    (cluster_id,),
).fetchone()
dedup_row = conn.execute(
    "SELECT count(*) FROM reputation_sync_log_event_dedup WHERE command_id = ?",
    (dup_cid,),
).fetchone()
conn.close()
print(f"\nSQLite: score={row[0] if row else 'N/A'} (期望 2.0)")
print(f"event_dedup 表行数={dedup_row[0] if dedup_row else 'N/A'} (期望 1)")
print(f"\n=> UI 3000 → 8766 代理 {(('✅ PASS' if row and abs(row[0] - 2.0) < 0.01 and dedup_row[0] == 1 else '❌ FAIL'))}")
