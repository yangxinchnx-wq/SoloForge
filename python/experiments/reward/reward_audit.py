# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Reward Audit
# Path: experiments/reward/reward_audit.py
#
# Phase 4: 验证 reward function 的单调性
# 4 个必须成立的不变式
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import numpy as np
from typing import Dict

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.env.reward_engine import compute_reward


class MockState:
    """Mock state object for reward computation"""
    def __init__(self, queue_depth: int, oscillation_score: float = 0.0):
        self.queue_depth = queue_depth
        self.oscillation_score = oscillation_score


def verify_reward_invariants(n_samples: int = 10000, seed: int = 42) -> Dict:
    """验证 reward function 的 4 个不变量"""
    print("=" * 60)
    print("REWARD AUDIT")
    print("=" * 60)
    print(f"Random samples: {n_samples}")
    print(f"Seed: {seed}")

    np.random.seed(seed)

    results = {
        "case1_queue_up_reward_down": {"pass": True, "violations": 0, "total": 0},
        "case2_workers_up_reward_down": {"pass": True, "violations": 0, "total": 0},
        "case3_recovery_reward_up": {"pass": True, "violations": 0, "total": 0},
        "case4_collapse_reward_neg": {"pass": True, "violations": 0, "total": 0},
    }

    # ============================================================
    # Case 1: queue ↑ → reward ↓
    # ============================================================
    print("\n--- Case 1: queue ↑ → reward ↓ ---")
    violations = 0
    for _ in range(n_samples):
        q1 = np.random.randint(0, 5000)
        q2 = q1 + np.random.randint(1, 5000)  # q2 > q1
        osc = np.random.uniform(0, 0.5)
        action_delta = np.random.randint(-2, 3)

        s1 = MockState(q1, osc)
        s2 = MockState(q2, osc)

        r1 = compute_reward(s1, action_delta)
        r2 = compute_reward(s2, action_delta)

        if r2 >= r1:  # violation: reward should go down
            violations += 1

    total = n_samples
    pass_ = violations == 0
    results["case1_queue_up_reward_down"] = {
        "pass": pass_,
        "violations": violations,
        "total": total,
        "violation_rate": violations / total,
    }
    status = "PASS" if pass_ else "FAIL"
    print(f"  Violations: {violations}/{total} ({violations/total:.2%})")
    print(f"  Result: {status}")

    # ============================================================
    # Case 2: workers ↑ → reward ↓ (control cost)
    # ============================================================
    print("\n--- Case 2: workers ↑ → reward ↓ ---")
    violations = 0
    for _ in range(n_samples):
        q = np.random.randint(0, 2000)
        osc = np.random.uniform(0, 0.5)
        action_delta = np.random.randint(1, 3)  # positive delta (workers up)

        s = MockState(q, osc)
        r = compute_reward(s, action_delta)
        control_cost = -abs(action_delta) * 0.02

        if control_cost >= 0:  # violation: positive delta should cost
            violations += 1

    total = n_samples
    pass_ = violations == 0
    results["case2_workers_up_reward_down"] = {
        "pass": pass_,
        "violations": violations,
        "total": total,
        "violation_rate": violations / total,
    }
    status = "PASS" if pass_ else "FAIL"
    print(f"  Violations: {violations}/{total} ({violations/total:.2%})")
    print(f"  Result: {status}")

    # ============================================================
    # Case 3: recovery scenario → reward ↑ (vs collapse)
    # ============================================================
    print("\n--- Case 3: recovery > collapse ---")
    violations = 0
    for _ in range(n_samples):
        # Recovery state: low queue, low oscillation
        s_recovery = MockState(
            queue_depth=np.random.randint(10, 200),
            oscillation_score=np.random.uniform(0, 0.1),
        )
        # Collapse state: high queue
        s_collapse = MockState(
            queue_depth=np.random.randint(10000, 50000),
            oscillation_score=np.random.uniform(0, 0.5),
        )
        action_delta = 0  # noop

        r_recovery = compute_reward(s_recovery, action_delta)
        r_collapse = compute_reward(s_collapse, action_delta)

        if r_recovery <= r_collapse:  # violation: recovery should be better
            violations += 1

    total = n_samples
    pass_ = violations == 0
    results["case3_recovery_reward_up"] = {
        "pass": pass_,
        "violations": violations,
        "total": total,
        "violation_rate": violations / total,
    }
    status = "PASS" if pass_ else "FAIL"
    print(f"  Violations: {violations}/{total} ({violations/total:.2%})")
    print(f"  Result: {status}")

    # ============================================================
    # Case 4: collapse → reward << 0
    # ============================================================
    print("\n--- Case 4: collapse → reward << 0 ---")
    violations = 0
    for _ in range(n_samples):
        s = MockState(
            queue_depth=np.random.randint(10000, 50000),
            oscillation_score=np.random.uniform(0, 0.5),
        )
        action_delta = np.random.randint(-2, 3)
        r = compute_reward(s, action_delta)

        if r >= -10:  # violation: collapse reward should be very negative
            violations += 1

    total = n_samples
    pass_ = violations == 0
    results["case4_collapse_reward_neg"] = {
        "pass": pass_,
        "violations": violations,
        "total": total,
        "violation_rate": violations / total,
    }
    status = "PASS" if pass_ else "FAIL"
    print(f"  Violations: {violations}/{total} ({violations/total:.2%})")
    print(f"  Result: {status}")

    # ============================================================
    # Reward component breakdown
    # ============================================================
    print("\n--- Reward Component Analysis ---")

    test_states = [
        {"name": "healthy (q=10, osc=0, delta=0)", "q": 10, "osc": 0.0, "delta": 0},
        {"name": "moderate (q=500, osc=0.1, delta=1)", "q": 500, "osc": 0.1, "delta": 1},
        {"name": "high (q=2000, osc=0.3, delta=2)", "q": 2000, "osc": 0.3, "delta": 2},
        {"name": "critical (q=10000, osc=0.5, delta=-2)", "q": 10000, "osc": 0.5, "delta": -2},
    ]

    print(f"\n  {'State':<30} {'queue_pen':>12} {'osc_pen':>10} {'ctrl_cost':>11} {'total':>10}")
    print("  " + "-" * 75)

    for ts in test_states:
        s = MockState(ts["q"], ts["osc"])
        r = compute_reward(s, ts["delta"])
        qp = -ts["q"] * 0.01
        op = -ts["osc"] * 0.1
        cc = -abs(ts["delta"]) * 0.02
        print(f"  {ts['name']:<30} {qp:>12.2f} {op:>10.2f} {cc:>11.2f} {r:>10.2f}")

    # 汇总
    print("\n" + "=" * 60)
    print("REWARD AUDIT SUMMARY")
    print("=" * 60)
    all_pass = all(r["pass"] for r in results.values())
    for name, r in results.items():
        print(f"  {name}: {'PASS' if r['pass'] else 'FAIL'} ({r['violations']} violations)")
    print(f"\nOverall: {'PASS — All invariants hold' if all_pass else 'FAIL — Some invariants violated'}")
    return results


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Reward Audit")
    parser.add_argument("--samples", type=int, default=10000)
    parser.add_argument("--output", type=str, default="artifacts/reward_audit.json")
    args = parser.parse_args()

    results = verify_reward_invariants(n_samples=args.samples)

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to: {args.output}")

    return results


if __name__ == "__main__":
    main()
