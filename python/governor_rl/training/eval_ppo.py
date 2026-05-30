# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: PPO Evaluation
# Path: python/governor_rl/training/eval_ppo.py
#
# 评估 PPO 模型
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import numpy as np
from collections import Counter
from torch.serialization import add_safe_globals

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork, ValueNetwork
from governor_rl.env import RuntimeEnvFactory
from governor_rl.training.ppo_trainer import PPOConfig

# Allow PPOConfig to be loaded
add_safe_globals([PPOConfig])

BC_EVALUATION_GATE = {
    "avg_queue": 2000,
    "worker_variance": 5,
    "unseen_survival": 0.80,
    "action_entropy": 0.8,
}

def load_ppo(policy_path="checkpoints/ppo_policy.pt"):
    """加载 PPO 模型"""
    policy = PolicyNetwork()
    value_net = ValueNetwork()

    checkpoint = torch.load(policy_path, weights_only=False, map_location='cpu')

    # 尝试加载策略
    if "policy_state_dict" in checkpoint:
        policy.load_state_dict(checkpoint["policy_state_dict"])
    elif "state_dict" in checkpoint:
        policy.load_state_dict(checkpoint["state_dict"])

    if "value_state_dict" in checkpoint:
        value_net.load_state_dict(checkpoint["value_state_dict"])
    elif "value_net_state_dict" in checkpoint:
        value_net.load_state_dict(checkpoint["value_net_state_dict"])

    policy.eval()
    value_net.eval()

    return policy, value_net

def eval_config(policy, config, max_steps=500):
    """评估单个配置"""
    env = RuntimeEnvFactory.create(
        arrival_rate=config["arrival_rate"],
        burst_prob=config["burst_prob"],
        duration=max_steps,
    )

    obs, _ = env.reset()

    queues = []
    workers = []
    actions = []
    done = False

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

    queues = np.array(queues)
    workers = np.array(workers)

    avg_queue = np.mean(queues)
    worker_variance = np.var(workers) if len(workers) > 1 else 0
    survived = np.max(queues) < 5000

    return {
        "config": config["name"],
        "avg_queue": avg_queue,
        "max_queue": np.max(queues),
        "worker_variance": worker_variance,
        "avg_workers": np.mean(workers),
        "survived": survived,
        "actions": actions,
    }

def compute_entropy(counter, total):
    if total == 0:
        return 0.0
    entropy = 0.0
    for count in counter.values():
        if count > 0:
            p = count / total
            entropy -= p * np.log2(p)
    return entropy

def main():
    print("=" * 60)
    print("PPO Model Evaluation")
    print("=" * 60)

    # 加载 PPO
    print("\n[1] 加载 PPO 模型...")
    policy, value_net = load_ppo("checkpoints/ppo_policy.pt")
    print("  PPO 模型已加载")

    # 测试配置
    test_configs = [
        {"arrival_rate": 8.0, "burst_prob": 0.05, "name": "unseen_low"},
        {"arrival_rate": 25.0, "burst_prob": 0.25, "name": "unseen_high"},
        {"arrival_rate": 35.0, "burst_prob": 0.30, "name": "extreme"},
        {"arrival_rate": 15.0, "burst_prob": 0.40, "name": "high_burst"},
    ]

    print("\n[2] Stress Test...")
    results = []
    for config in test_configs:
        print(f"\n  Test: {config['name']}")
        result = eval_config(policy, config)
        results.append(result)
        print(f"    avg_queue: {result['avg_queue']:.0f}")
        print(f"    worker_variance: {result['worker_variance']:.2f}")
        print(f"    survival: {result['survived']}")

    # 汇总
    avg_queue = np.mean([r["avg_queue"] for r in results])
    avg_variance = np.mean([r["worker_variance"] for r in results])
    survival_rate = sum(1 for r in results if r["survived"]) / len(results)

    all_actions = []
    for result in results:
        all_actions.extend(result["actions"])
    action_entropy = compute_entropy(Counter(all_actions), len(all_actions))

    action_dist = Counter(all_actions)
    print("\n  Action distribution:")
    for action in sorted(action_dist.keys()):
        count = action_dist[action]
        ratio = count / len(all_actions) if all_actions else 0
        print(f"    action={action}: {count:>4} ({ratio:.1%})")

    print("\n" + "=" * 60)
    print("PPO STRESS TEST SUMMARY")
    print("=" * 60)
    print(f"Avg Queue: {avg_queue:.0f} (target < {BC_EVALUATION_GATE['avg_queue']})")
    print(f"Worker Variance: {avg_variance:.2f} (target > {BC_EVALUATION_GATE['worker_variance']})")
    print(f"Survival Rate: {survival_rate:.1%} (target > {BC_EVALUATION_GATE['unseen_survival']:.0%})")
    print(f"Action Entropy: {action_entropy:.3f} (target > {BC_EVALUATION_GATE['action_entropy']})")

    # Gate validation
    print("\n" + "=" * 60)
    print("PPO EVALUATION GATE")
    print("=" * 60)

    checks = {
        "avg_queue": avg_queue < BC_EVALUATION_GATE["avg_queue"],
        "worker_variance": avg_variance > BC_EVALUATION_GATE["worker_variance"],
        "survival_rate": survival_rate >= BC_EVALUATION_GATE["unseen_survival"],
        "action_entropy": action_entropy >= BC_EVALUATION_GATE["action_entropy"],
    }

    all_pass = all(checks.values())

    print(f"\n{'Metric':<20} {'Actual':>12} {'Target':>12} {'Status':>10}")
    print("-" * 60)

    actuals = {
        "avg_queue": avg_queue,
        "worker_variance": avg_variance,
        "survival_rate": survival_rate,
        "action_entropy": action_entropy,
    }

    for metric, passed in checks.items():
        actual = actuals[metric]
        if metric == "survival_rate":
            actual_str = f"{actual:.1%}"
            target_str = f">{BC_EVALUATION_GATE['unseen_survival']:.0%}"
        else:
            actual_str = f"{actual:.3f}"
            target_str = f"{'<' if metric in ['avg_queue'] else '>'}{BC_EVALUATION_GATE[metric]}"

        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"{metric:<20} {actual_str:>12} {target_str:>12} {status:>10}")

    print("\n" + "=" * 60)
    if all_pass:
        print("✅ PPO EVALUATION GATE PASSED")
    else:
        print("❌ PPO EVALUATION GATE FAILED")
    print("=" * 60)

if __name__ == "__main__":
    main()
