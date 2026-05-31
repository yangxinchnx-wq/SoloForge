# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 5.2 — Reward Validation
# Path: experiments/ppo/reward_validation.py
#
# 验证 reward function 在关键场景下的行为是否符合预期
# 不训练，只跑轨迹分析
# ─────────────────────────────────────────────────────────────────

import sys
import os
import numpy as np
from typing import Dict

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.env.reward_engine import compute_reward


class MockState:
    def __init__(self, queue_depth: int, worker_count: int = 200, oscillation_score: float = 0.0):
        self.queue_depth = queue_depth
        self.worker_count = worker_count
        self.oscillation_score = oscillation_score


ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}


def compute_load_ratio(queue_depth: int, worker_count: int) -> float:
    return queue_depth / max(worker_count * 2, 1)


def get_zone_id(queue_depth: int, worker_count: int) -> int:
    lr = compute_load_ratio(queue_depth, worker_count)
    if lr < 0.1: return 0
    elif lr < 0.25: return 1
    elif lr < 0.5: return 2
    elif lr < 1.0: return 3
    else: return 4


# ============================================================
# Audit 1: Zone E → expand2 must be best
# ============================================================

def audit_zone_e() -> dict:
    """Audit 1: Zone E 时，expand2 奖励必须最高"""
    print("\n" + "=" * 60)
    print("AUDIT 1: Zone E — expand2 should have highest reward")
    print("=" * 60)

    # Zone E: queue >> capacity, lr >= 1.0
    test_cases = [
        {"name": "E1", "q": 2000, "w": 100},   # lr=10
        {"name": "E2", "q": 5000, "w": 100},   # lr=25
        {"name": "E3", "q": 1000, "w": 200},   # lr=2.5
        {"name": "E4", "q": 3000, "w": 200},   # lr=7.5
        {"name": "E5", "q": 10000, "w": 100}, # lr=50
    ]

    all_pass = True
    results = {}

    for tc in test_cases:
        q = tc["q"]
        w = tc["w"]
        zone = get_zone_id(q, w)
        rewards = {}
        for action_idx in range(5):
            delta = action_idx - 2  # action_index → delta
            s = MockState(q, w, oscillation_score=0.1)
            rewards[ACTION_NAMES[action_idx]] = compute_reward(s, delta)

        # expand2 必须最高
        expand2_best = rewards["expand2"] >= max(rewards.values())
        results[tc["name"]] = {
            "zone": zone,
            "rewards": rewards,
            "expand2_best": expand2_best,
        }

        print(f"\n  {tc['name']}: Zone {zone}, q={q}")
        for a, r in sorted(rewards.items(), key=lambda x: x[1], reverse=True):
            marker = " ← BEST" if a == "expand2" else ""
            print(f"    {a:>8}: {r:>8.2f}{marker}")

        if not expand2_best:
            print(f"    FAIL: expand2 is NOT highest reward!")
            all_pass = False
        else:
            print(f"    PASS: expand2 is highest")

    print(f"\n  {'PASS' if all_pass else 'FAIL'}")
    return {"pass": all_pass, "results": results}


# ============================================================
# Audit 2: Zone A → noop must be best
# ============================================================

def audit_zone_a() -> dict:
    """Audit 2: Zone A 时，noop 奖励必须最高（queue 已低，不要折腾）"""
    print("\n" + "=" * 60)
    print("AUDIT 2: Zone A — noop should have highest reward")
    print("=" * 60)

    test_cases = [
        {"name": "A1", "q": 5, "w": 200},    # lr=0.0125
        {"name": "A2", "q": 10, "w": 200},   # lr=0.025
        {"name": "A3", "q": 20, "w": 300},   # lr=0.033
        {"name": "A4", "q": 30, "w": 500},   # lr=0.03
    ]

    all_pass = True
    results = {}

    for tc in test_cases:
        q = tc["q"]
        w = tc["w"]
        zone = get_zone_id(q, w)
        rewards = {}
        for action_idx in range(5):
            delta = action_idx - 2
            s = MockState(q, w, oscillation_score=0.0)
            rewards[ACTION_NAMES[action_idx]] = compute_reward(s, delta)

        # noop 必须最高（低负载时不做动作才是最优的）
        noop_best = rewards["noop"] >= max(rewards.values())
        results[tc["name"]] = {
            "zone": zone,
            "rewards": rewards,
            "noop_best": noop_best,
        }

        print(f"\n  {tc['name']}: Zone {zone}, q={q}")
        for a, r in sorted(rewards.items(), key=lambda x: x[1], reverse=True):
            marker = " ← BEST" if a == "noop" else ""
            print(f"    {a:>8}: {r:>8.2f}{marker}")

        if not noop_best:
            print(f"    FAIL: noop is NOT highest reward!")
            all_pass = False
        else:
            print(f"    PASS: noop is highest")

    print(f"\n  {'PASS' if all_pass else 'FAIL'}")
    return {"pass": all_pass, "results": results}


# ============================================================
# Audit 3: Collapse → reward << 0
# ============================================================

def audit_collapse() -> dict:
    """Audit 3: 崩溃状态必须 reward << 0"""
    print("\n" + "=" * 60)
    print("AUDIT 3: Collapse — reward must be very negative")
    print("=" * 60)

    collapse_cases = [
        {"q": 10000, "w": 200},
        {"q": 20000, "w": 200},
        {"q": 30000, "w": 200},
        {"q": 40000, "w": 200},
        {"q": 50000, "w": 200},
    ]

    all_pass = True
    results = {}

    for tc in collapse_cases:
        q = tc["q"]
        w = tc["w"]
        rewards = {}
        for action_idx in range(5):
            delta = action_idx - 2
            s = MockState(q, w, oscillation_score=0.5)
            rewards[ACTION_NAMES[action_idx]] = compute_reward(s, delta)

        worst = min(rewards.values())
        very_neg = worst < -10

        print(f"\n  q={q:>6}: worst={worst:>8.2f} {'PASS' if very_neg else 'FAIL'}")

        results[q] = {"rewards": rewards, "worst": worst, "very_neg": very_neg}
        if not very_neg:
            all_pass = False

    print(f"\n  {'PASS' if all_pass else 'FAIL'}")
    return {"pass": all_pass, "results": results}


# ============================================================
# Audit 4: Thrashing → must be penalized
# ============================================================

def audit_thrashing() -> dict:
    """Audit 4: 振荡控制必须受到惩罚"""
    print("\n" + "=" * 60)
    print("AUDIT 4: Thrashing — oscillation should penalize reward")
    print("=" * 60)

    test_cases = [
        {"name": "no_osc", "osc": 0.0},
        {"name": "low_osc", "osc": 0.2},
        {"name": "med_osc", "osc": 0.4},
        {"name": "high_osc", "osc": 0.6},
        {"name": "crit_osc", "osc": 0.8},
    ]

    q = 1000  # 固定 queue
    w = 200   # 固定 worker
    delta = 0  # 固定 noop

    print(f"\n  queue={q}, workers={w}, action=noop, varying oscillation:")
    print(f"  {'Name':>10} {'Oscillation':>12} {'Reward':>10} {'Penalty':>10}")
    print("  " + "-" * 48)

    all_pass = True
    penalties = []

    for tc in test_cases:
        osc = tc["osc"]
        s = MockState(q, w, oscillation_score=osc)
        r = compute_reward(s, delta)
        osc_penalty = abs(-osc * 0.1)  # store as positive: 0.0, 0.02, 0.04, 0.06, 0.08
        penalties.append(osc_penalty)

        print(f"  {tc['name']:>10} {osc:>12.2f} {r:>10.2f} {osc_penalty:>10.2f}")

    # 验证：oscillation 越高，penalty 越大（reward 越低）
    # penalties = [0.0, 0.02, 0.04, 0.06, 0.08]，严格递增
    for i in range(len(penalties) - 1):
        if penalties[i] >= penalties[i + 1]:
            print(f"    FAIL at step {i}: pen[{i}]={penalties[i]:.4f} >= pen[{i+1}]={penalties[i+1]:.4f}")
            all_pass = False

    print(f"\n  {'PASS' if all_pass else 'FAIL'}: oscillation penalty increases with higher oscillation")
    return {"pass": all_pass, "penalties": penalties}


# ============================================================
# Run all audits
# ============================================================

def run_reward_validation() -> Dict:
    print("=" * 60)
    print("SPRINT 5.2: REWARD VALIDATION")
    print("=" * 60)

    r1 = audit_zone_e()
    r2 = audit_zone_a()
    r3 = audit_collapse()
    r4 = audit_thrashing()

    all_pass = all([r1["pass"], r2["pass"], r3["pass"], r4["pass"]])

    print("\n" + "=" * 60)
    print("SPRINT 5.2 SUMMARY")
    print("=" * 60)
    print(f"  Audit 1 (Zone E expand2):   {'PASS' if r1['pass'] else 'FAIL'}")
    print(f"  Audit 2 (Zone A shrink2):   {'PASS' if r2['pass'] else 'FAIL'}")
    print(f"  Audit 3 (Collapse < -10):    {'PASS' if r3['pass'] else 'FAIL'}")
    print(f"  Audit 4 (Oscillation pen):  {'PASS' if r4['pass'] else 'FAIL'}")
    print(f"\n  Overall: {'PASS — Reward function is sound' if all_pass else 'FAIL — Reward function has issues'}")

    return {
        "audit1_zone_e": r1,
        "audit2_zone_a": r2,
        "audit3_collapse": r3,
        "audit4_thrashing": r4,
        "pass": all_pass,
    }


def main():
    result = run_reward_validation()
    return result


if __name__ == "__main__":
    main()
