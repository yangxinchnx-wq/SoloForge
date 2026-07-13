# -*- coding: utf-8 -*-
"""
BadgerDB 集成验证脚本 — 验证 MemoryService + BadgerDB 事件日志端到端可用
"""
import sys
import uuid
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "python"))

from soloforge_ai_society.database.manager import get_db_manager
from soloforge_ai_society.services.memory_service import MemoryService

print("=" * 60)
print("BadgerDB Integration Test")
print("=" * 60)

mgr = get_db_manager()
ms = MemoryService(mgr)

print("\n--- 1. Check BadgerDB status ---")
stats = ms.get_event_log_stats()
print(f"  BadgerDB enabled: {stats.get('enabled', False)}")
if stats.get("enabled"):
    print(f"  BatchedWriter config: {stats.get('config', {})}")
else:
    print("  [SKIP] BadgerDB not available, exiting")
    sys.exit(1)

print("\n--- 2. Create test memories (will be logged to BadgerDB) ---")
test_ids = []
for i in range(3):
    m = ms.create(
        event=f"badger integration test #{i} - {uuid.uuid4().hex[:8]}",
        impact="positive",
        severity="low",
        participants=[f"agent_{i}", "agent_test"],
        lessons=[f"test lesson {i}"],
        domain="test",
    )
    test_ids.append(m.id)
    print(f"  Created: {m.id} (event: {m.event[:50]}...)")

print("\n--- 3. Flush & read recent events from BadgerDB ---")
import time
time.sleep(0.5)  # wait for async flush
events = ms.get_recent_events(limit=10)
print(f"  Recent events from BadgerDB: {len(events)}")
for ev in events[:5]:
    print(f"    [{ev.get('severity', '?')}] {ev.get('event', '?')[:50]}...")
    print(f"      id={ev.get('id', '?')}, domain={ev.get('domain', '?')}")

print("\n--- 4. Verify data consistency (SQLite vs BadgerDB) ---")
sqlite_count = ms.count()
print(f"  SQLite total memories: {sqlite_count}")
print(f"  BadgerDB recent events: {len(events)}")
print(f"  Test memories created this run: {len(test_ids)}")

# Verify the test events are in BadgerDB
test_events_in_badger = [e for e in events if e.get("id") in test_ids]
print(f"  Test events found in BadgerDB: {len(test_events_in_badger)}/{len(test_ids)}")

if len(test_events_in_badger) == len(test_ids):
    print("\n  [PASS] All test events found in BadgerDB!")
else:
    print(f"\n  [WARN] Expected {len(test_ids)} test events, found {len(test_events_in_badger)}")

print("\n--- 5. Cleanup ---")
ms.close()
print("  MemoryService closed (BatchedWriter drained)")

print("\n" + "=" * 60)
print("Integration test complete!")
print("=" * 60)
