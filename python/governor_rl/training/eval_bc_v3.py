# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Evaluate BC V3
# Path: python/governor_rl/training/eval_bc_v3.py
#
# Sprint 4: Shadow Evaluation of BC V3
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import numpy as np
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.env import RuntimeEnvFactory, ACTION_MAP


# 测试配置
TEST_CONFIGS = [
    {"arrival_rate": 10.0, "burst_prob": 0.05, "name": "baseline"},
    {"arrival_rate": 25.0, "burst_prob": 0.20, "name": "high_load"},
    {"arrival_rate": 30.0, "burst_prob": 0.30, "name": "chaotic_spike"},
    {"arrival_rate": 15.0, "burst_prob": 0.15, "name": "worker_failure"},
    {"arrival_rate": 5.0, "burst_prob": 0.10, "name": "long_idle"},
]


def load_bc_v3(path: str) -> PolicyNetwork:
    """加载 BC V3 模型"""
    policy = PolicyNetwork(hidden_dim=128)
    if os.path.exists(path):
        checkpoint = torch.load(path, weights_only=False)
        policy.load_state_dict(checkpoint["policy_state_dict"])
        print(f"Loaded: {path}")
        print(f"  Loss: {checkpoint.get('loss_history', ['N/A'])[-1]:.4f}")
        print(f"  Accuracy: {checkpoint.get('accuracy', 0):.4f}")
    else:
        print(f"Not found: {path}")
    return policy


def get_bc_action(policy: PolicyNetwork, obs: np.ndarray, deterministic: bool = True) -> int:
    """从 BC Policy 获取动作"""
    obs_tensor = torch.FloatTensor(obs).unsqueeze(0)

    with torch.no_grad():
        logits = policy(obs_tensor)
        probs = torch.softmax(logits, dim=-1)

    probs = probs.squeeze(0).numpy()

    if deterministic:
        action_idx = int(np.argmax(probs))
    else:
        action_idx = int(np.random.choice(5, p=probs))

    return action_idx


def build_obs(state, info) -> np.ndarray:
    """构建 observation"""
    queue_depth = info.get("queue_depth", 0)
    worker_count = info.get("worker_count", 0)
    cpu_usage = info.get("cpu_usage", 0.0)

    # Zone 计算
    if queue_depth <= 20:
        zone_id = 0
    elif queue_depth <= 100:
        zone_id = 1
    elif queue_depth <= 500:
        zone_id = 2
    elif queue_depth <= 2000:
        zone_id = 3
    else:
        zone_id = 4

    return np.array([
        queue_depth / 1000.0,
        0.0,  # velocity
        0.0,  # acceleration
        worker_count / 200.0,
        cpu_usage,
        0.0,  # precursor
        0.0,  # risk
        0.0,  # oscillation
        zone_id / 4.0,
    ], dtype=np.float32)


def eval_config(policy: PolicyNetwork, config: dict, max_steps: int = 500) -> dict:
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

    for step in range(max_steps):
        # 构建 observation
        info = {
            "queue_depth": env.simulator.state.queue_depth,
            "worker_count": env.simulator.state.worker_count,
            "cpu_usage": env.simulator.state.cpu_usage,
        }
        obs = build_obs(env.simulator.state, info)

        # 获取动作
        action_idx = get_bc_action(policy, obs)

        # 执行
        next_obs, _, done, _, info = env.step(action_idx)

        queues.append(info["queue_depth"])
        workers.append(info["worker_count"])
        actions.append(action_idx)

        if done:
            break

    return {
        "config": config,
        "steps": len(queues),
        "queues": np.array(queues),
        "workers": np.array(workers),
        "actions": np.array(actions),
        "avg_queue": np.mean(queues),
        "max_queue": np.max(queues),
        "avg_workers": np.mean(workers),
        "final_workers": workers[-1] if workers else 0,
        "survived": np.max(queues) < 5000,
        "action_dist": Counter(actions),
    }


def print_result(result: dict):
    """打印结果"""
    config = result["config"]
    print(f"\n{config['name']} (arrival={config['arrival_rate']}, burst={config['burst_prob']})")
    print(f"  Steps: {result['steps']}")
    print(f"  Avg Queue: {result['avg_queue']:.1f}")
    print(f"  Max Queue: {result['max_queue']:.0f}")
    print(f"  Avg Workers: {result['avg_workers']:.1f}")
    print(f"  Final Workers: {result['final_workers']}")
    print(f"  Survived: {'YES' if result['survived'] else 'NO'}")

    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}
    action_dist = result["action_dist"]
    total = sum(action_dist.values())
    print(f"  Actions: ", end="")
    for a in range(5):
        count = action_dist.get(a, 0)
        pct = count / total * 100 if total > 0 else 0
        print(f"{ACTION_NAMES[a][:3]}={pct:.0f}% ", end="")
    print()


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Evaluate BC V3")
    parser.add_argument("--model", type=str, default="checkpoints/bc_policy_v3.pt")
    parser.add_argument("--steps", type=int, default=500)
    args = parser.parse_args()

    print("=" * 60)
    print("BC V3 Shadow Evaluation")
    print("=" * 60)

    # 加载模型
    print("\nLoading BC V3 model...")
    policy = load_bc_v3(args.model)

    # 评估
    print("\nEvaluating...")
    results = []
    for config in TEST_CONFIGS:
        result = eval_config(policy, config, max_steps=args.steps)
        results.append(result)
        print_result(result)

    # 汇总
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)

    survived = sum(1 for r in results if r["survived"])
    avg_queue = np.mean([r["avg_queue"] for r in results])
    avg_workers = np.mean([r["avg_workers"] for r in results])

    print(f"Survival Rate: {survived}/{len(results)} ({survived/len(results)*100:.0f}%)")
    print(f"Avg Queue: {avg_queue:.1f}")
    print(f"Avg Workers: {avg_workers:.1f}")

    if survived == len(results) and avg_queue < 500:
        print("\n✅ BC V3 SHADOW EVALUATION PASSED")
    else:
        print("\n⚠️ BC V3 needs improvement")


if __name__ == "__main__":
    main()
