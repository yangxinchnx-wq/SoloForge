"""AI 社会 service 端连通性测试(读路径 + 写路径各跑一遍)"""
import sys
import uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from soloforge_ai_society.database.manager import get_db_manager
from soloforge_ai_society.services.memory_service import MemoryService
from soloforge_ai_society.services.governance_service import GovernanceService
from soloforge_ai_society.services.economy_service import EconomyService
from soloforge_ai_society.services.reputation_service import ReputationService
from soloforge_ai_society.services.law_service import LawService
from soloforge_ai_society.services.coalition_service import CoalitionService

mgr = get_db_manager()

print("=== services ping ===")
for name, cls in [
    ("memory",      MemoryService),
    ("governance",  GovernanceService),
    ("economy",     EconomyService),
    ("reputation",  ReputationService),
    ("law",         LawService),
    ("coalition",   CoalitionService),
]:
    try:
        s = cls(mgr)
        print(f"  [{name:11s}] OK")
    except Exception as e:
        print(f"  [{name:11s}] FAIL: {e}")

print("\n=== Memory: create + get_by_id ===")
ms = MemoryService(mgr)
mid = f"mem_smoke_{uuid.uuid4().hex[:8]}"
m = ms.create(
    event=f"smoke test event {mid}",
    impact="positive",
    severity="low",
    participants=["agent_a", "agent_b"],
    lessons=["smoke test passed"],
    domain="test",
)
print(f"  create -> id={m.id}")
g = ms.get_by_id(m.id)
print(f"  get_by_id -> event={g.event if g else None}")

print("\n=== Coalition: create + get_active ===")
cs = CoalitionService(mgr)
c = cs.create(
    goal="smoke test goal",
    leader="agent_a",
    initial_members=["agent_a", "agent_b"],
    name="smoke-coalition",
    description="AI society smoke test",
)
print(f"  create -> id={c.id}")
acts = cs.get_active_coalitions()
print(f"  get_active_coalitions -> {len(acts)} row(s)")

print("\n=== Economy: create_account + get_account ===")
es = EconomyService(mgr)
agent_id = f"agent_smoke_{uuid.uuid4().hex[:6]}"
e = es.create_account(agent_id, name=agent_id)
print(f"  create_account -> id={e.id}, agent_id={e.agent_id}, credits={e.credits}")
g = es.get_account(agent_id)
print(f"  get_account -> credits={g.credits if g else None}")

print("\n=== Governance: get_all ===")
gs = GovernanceService(mgr)
rows = gs.get_all()
print(f"  get_all -> {len(rows)} row(s)")

print("\n=== Reputation: get_all_by_type ===")
rs = ReputationService(mgr)
rows = rs.get_all_by_type("agent")
print(f"  get_all_by_type(agent) -> {len(rows)} row(s)")

print("\n=== Law: get_all_laws ===")
ls = LawService(mgr)
laws = ls.get_all_laws()
print(f"  get_all_laws -> {len(laws)} row(s)")

print("\n=== Final state ===")
import sqlite3
conn = sqlite3.connect(str(mgr.config.sqlite_path))
for t in ("institution", "culture", "law", "coalition", "social_memory",
         "reputation", "economy", "governance", "reputation_sync_log"):
    n = conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
    print(f"  {t:22s} -> {n}")
conn.close()

print("\n=== ALL OK ===")
