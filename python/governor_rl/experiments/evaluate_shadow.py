# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Evaluate Shadow
# Path: python/governor_rl/experiments/evaluate_shadow.py
#
# Stage 3: Shadow Evaluation
# 同时运行 BC 和 PPO，比较性能
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import numpy as np
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.env import RuntimeEnvFactory
from governor_rl.env.reward_engine import compute_reward


# BC Stress Test 配置
TEST_CONFIGS = [
    {"arrival_rate": 10.0, "burst_prob": 0.05, "name": "baseline"},
    {"arrival_rate": 25.0, "burst_prob": 0.20, "name": "high_load"},
    {"arrival_rate": 30.0, "burst_prob": 0.30, "name": "chaotic_spike"},
    {"arrival_rate": 15.0, "burst_prob": 0.15, "name": "worker_failure"},
    {"arrival_rate": 5.0, "burst_prob": 0.10, "name": "long_idle"},
]


def load_policy(path: str) -> PolicyNetwork:
    """加载策略"""
    policy = PolicyNetwork()
    if os.path.exists(path):
        checkpoint = torch.load(path, weights_only=False)
        if "policy_state_dict" in checkpoint:
            policy.load_state_dict(checkpoint["policy_state_dict"])
        elif "state_dict" in checkpoint:
            policy.load_state_dict(checkpoint["state_dict"])
        print(f"  Loaded: {path}")
    else:
        print(f"  Not found: {path}")
    return policy


def eval_policy(policy: PolicyNetwork, config: dict, max_steps: int = 500) -> dict:
    """评估策略"""
    env = RuntimeEnvFactory.create(
        arrival_rate=config["arrival_rate"],
        burst_prob=config["burst_prob"],
        duration=max_steps,
    )

    obs, _ = env.reset()
    policy.eval()

    queues = []
    workers = []
    actions = []

    with torch.no_grad():
        for _ in range(max_steps):
            action, _ = policy.get_action(obs, deterministic=True)
            next_obs, _, done, _, info = env.step(action)

            queues.append(info.get("queue_depth", 0))
            workers.append(info.get("worker_count", 0))
            actions.append(action)

            obs = next_obs
            if done:
                break

    return {
        "queues": np.array(queues),
        "workers": np.array(workers),
        "actions": np.array(actions),
        "survived": np.max(queues) < 5000,
    }


def compute_stats(result: dict) -> dict:
    """计算统计"""
    queues = result["queues"]
    workers = result["workers"]
    actions = result["actions"]

    avg_queue = np.mean(queues)
    worker_std = np.std(workers)
    action_dist = Counter(actions)

    return {
        "avg_queue": avg_queue,
        "max_queue": np.max(queues),
        "worker_std": worker_std,
        "action_dist": dict(action_dist),
        "survived": result["survived"],
    }


def main():
    print("=" * 60)
    print("Shadow Evaluation")
    print("=" * 60)

    # 加载策略
    print("\n[1] Loading policies")
    bc_policy = load_policy("checkpoints/bc_policy.pt")
    ppo_policy = load_policy("checkpoints/ppo_policy.pt")

    # 评估
    print("\n[2] Evaluating policies")
    bc_results = []
    ppo_results = []

    for config in TEST_CONFIGS:
        print(f"\n  Test: {config['name']}")

        bc_result = eval_policy(bc_policy, config)
        ppo_result = eval_policy(ppo_policy, config)

        bc_stats = compute_stats(bc_result)
        ppo_stats = compute_stats(ppo_result)

        bc_results.append(bc_stats)
        ppo_results.append(ppo_stats)

        print(f"    BC:  queue={bc_stats['avg_queue']:.0f}, std={bc_stats['worker_std']:.1f}, survived={bc_stats['survived']}")
        print(f"    PPO: queue={ppo_stats['avg_queue']:.0f}, std={ppo_stats['worker_std']:.1f}, survived={ppo_stats['survived']}")

    # 汇总
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)

    bc_avg_queue = np.mean([r["avg_queue"] for r in bc_results])
    ppo_avg_queue = np.mean([r["avg_queue"] for r in ppo_results])

    bc_avg_std = np.mean([r["worker_std"] for r in bc_results])
    ppo_avg_std = np.mean([r["worker_std"] for r in ppo_results])

    bc_survival = sum(1 for r in bc_results if r["survived"]) / len(bc_results)
    ppo_survival = sum(1 for r in ppo_results if r["survived"]) / len(ppo_results)

    bc_collapse = 1 - bc_survival
    ppo_collapse = 1 - ppo_survival

    print(f"\n{'Metric':<20} {'BC':>12} {'PPO':>12} {'Winner':>10}")
    print("-" * 55)
    print(f"{'avg_queue':<20} {bc_avg_queue:>12.0f} {ppo_avg_queue:>12.0f} {'PPO' if ppo_avg_queue < bc_avg_queue else 'BC':>10}")
    print(f"{'worker_std':<20} {bc_avg_std:>12.1f} {ppo_avg_std:>12.1f} {'PPO' if ppo_avg_std > bc_avg_std else 'BC':>10}")
    print(f"{'collapse_rate':<20} {bc_collapse:>12.1%} {ppo_collapse:>12.1%} {'PPO' if ppo_collapse < bc_collapse else 'BC':>10}")

    # Gate 检查
    print("\n" + "=" * 60)
    print("Gate Validation")
    print("=" * 60)

    gates = {
        "avg_queue < 3000": ppo_avg_queue < 3000,
        "worker_std > 2": ppo_avg_std > 2,
        "collapse_rate < 20%": ppo_collapse < 0.20,
    }

    for gate, passed in gates.items():
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"  {gate}: {status}")

    all_pass = all(gates.values())
    print("\n" + "=" * 60)
    if all_pass:
        print("✅ Shadow Evaluation PASSED")
        print("Runtime Governor RL Closed Loop v1 is ready!")
    else:
        print("❌ Shadow Evaluation FAILED")
        print("Iteration required.")
    print("=" * 60)


if __name__ == "__main__":
    main()
