# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Dataset Rebalance
# Path: experiments/dataset_rebalance/rebalance.py
#
# Sprint 2A: 降低 noop_ratio，从 57.76% 到 30-35%
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
from collections import Counter
import random

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.env import RuntimeEnvFactory


# Action 名称映射
ACTION_NAMES = {
    0: "shrink2",
    1: "shrink1",
    2: "noop",
    3: "expand1",
    4: "expand2",
}

# 重采样目标
TARGET_NOOP_RATIO = 0.35  # 35%
NOOP_KEEP_PROB = 0.40     # 保留 40% 的 no-op


def load_dataset(path: str) -> list:
    """加载数据集"""
    data = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            data.append(json.loads(line.strip()))
    return data


def analyze_distribution(data: list) -> dict:
    """分析动作分布"""
    actions = [d["action"] for d in data]
    counter = Counter(actions)
    total = len(data)

    distribution = {}
    for action_idx in range(5):
        count = counter.get(action_idx, 0)
        distribution[ACTION_NAMES[action_idx]] = {
            "count": count,
            "ratio": count / total if total > 0 else 0,
        }

    # 计算 entropy
    probs = [counter.get(i, 0) / total for i in range(5) if counter.get(i, 0) > 0]
    entropy = -sum(p * np.log2(p) for p in probs if p > 0)

    return {
        "total": total,
        "distribution": distribution,
        "noop_ratio": counter.get(2, 0) / total if total > 0 else 0,
        "action_entropy": entropy,
    }


def resample_balanced(data: list, noop_keep_prob: float = 0.4, seed: int = 42) -> list:
    """
    重采样以平衡动作分布

    Args:
        data: 原始数据
        noop_keep_prob: no-op 保留概率
        seed: 随机种子

    Returns:
        重采样后的数据
    """
    random.seed(seed)
    np.random.seed(seed)

    balanced = []

    for item in data:
        action = item["action"]

        if action == 2:  # no-op
            if random.random() < noop_keep_prob:
                balanced.append(item)
        else:
            # 其他动作全部保留
            balanced.append(item)

    return balanced


def train_bc(
    data: list,
    epochs: int = 20,
    batch_size: int = 256,
    lr: float = 3e-4,
) -> tuple:
    """
    训练 BC 模型

    Returns:
        (policy, losses)
    """
    class BCDataset(Dataset):
        def __init__(self, data):
            self.data = data

        def __len__(self):
            return len(self.data)

        def __getitem__(self, idx):
            item = self.data[idx]
            obs = torch.FloatTensor(item["obs"])
            action = torch.LongTensor([item["action"]])[0]
            return obs, action

    dataset = BCDataset(data)
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    policy = PolicyNetwork(hidden_dim=128)
    optimizer = optim.Adam(policy.parameters(), lr=lr)
    criterion = nn.CrossEntropyLoss()

    losses = []
    for epoch in range(epochs):
        epoch_loss = 0.0
        num_batches = 0

        for obs, action in dataloader:
            logits = policy(obs)
            loss = criterion(logits, action)

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            epoch_loss += loss.item()
            num_batches += 1

        avg_loss = epoch_loss / num_batches
        losses.append(avg_loss)

        if (epoch + 1) % 5 == 0:
            print(f"    Epoch {epoch+1}/{epochs}, Loss: {avg_loss:.4f}")

    return policy, losses


def evaluate_policy_entropy(policy, n_samples: int = 1000) -> float:
    """
    计算策略 entropy

    测量策略的多样性
    """
    policy.eval()

    # 生成随机 observations
    observations = []
    for _ in range(n_samples):
        obs = np.random.randn(9).astype(np.float32)
        obs = np.clip(obs, -3, 3)
        observations.append(obs)

    # 收集动作分布
    actions = []
    with torch.no_grad():
        for obs in observations:
            action, _ = policy.get_action(obs, deterministic=False)
            actions.append(action)

    # 计算 entropy
    counter = Counter(actions)
    total = len(actions)
    probs = [counter.get(i, 0) / total for i in range(5)]
    entropy = -sum(p * np.log2(p) for p in probs if p > 0)

    return entropy, dict(counter)


def evaluate_policy_action_dist(policy, n_samples: int = 1000) -> dict:
    """
    评估策略在真实环境中的动作分布
    """
    policy.eval()

    actions = []
    for _ in range(n_samples):
        # 创建环境
        env = RuntimeEnvFactory.create(
            arrival_rate=15.0,
            burst_prob=0.15,
            duration=1000,
        )
        obs, _ = env.reset()

        episode_actions = []
        with torch.no_grad():
            for _ in range(100):
                action, _ = policy.get_action(obs, deterministic=False)
                next_obs, _, done, _, _ = env.step(action)

                episode_actions.append(action)
                obs = next_obs

                if done:
                    break

        actions.extend(episode_actions)

    counter = Counter(actions)
    total = len(actions)

    distribution = {}
    for action_idx in range(5):
        count = counter.get(action_idx, 0)
        distribution[ACTION_NAMES[action_idx]] = {
            "count": count,
            "ratio": count / total if total > 0 else 0,
        }

    return distribution


def run_shadow_eval(policy, test_configs: list) -> dict:
    """
    运行 Shadow Evaluation
    """
    results = []

    for config in test_configs:
        env = RuntimeEnvFactory.create(
            arrival_rate=config["arrival_rate"],
            burst_prob=config["burst_prob"],
            duration=500,
        )
        obs, _ = env.reset()
        policy.eval()

        queues = []
        workers = []
        actions = []
        max_queue = 0

        with torch.no_grad():
            for _ in range(500):
                action, _ = policy.get_action(obs, deterministic=True)
                next_obs, _, done, _, info = env.step(action)

                queues.append(info.get("queue_depth", 0))
                workers.append(info.get("worker_count", 0))
                actions.append(action)
                max_queue = max(max_queue, info.get("queue_depth", 0))

                obs = next_obs
                if done:
                    break

        results.append({
            "config": config["name"],
            "avg_queue": np.mean(queues),
            "max_queue": max_queue,
            "avg_workers": np.mean(workers),
            "worker_std": np.std(workers),
            "survived": max_queue < 4000,
        })

    return results


def main():
    print("=" * 60)
    print("Dataset Rebalance")
    print("=" * 60)

    # Step 1: 加载原始数据
    print("\n[1] Loading original dataset...")
    original_data = load_dataset("datasets/dataset_v1/train.jsonl")
    original_stats = analyze_distribution(original_data)

    print(f"    Total samples: {original_stats['total']}")
    print(f"    Noop ratio: {original_stats['noop_ratio']:.2%}")
    print(f"    Action entropy: {original_stats['action_entropy']:.3f}")
    print("\n    Original distribution:")
    for name, stats in original_stats['distribution'].items():
        print(f"      {name:<8}: {stats['count']:>6} ({stats['ratio']:>6.1%})")

    # Step 2: 重采样
    print(f"\n[2] Resampling with noop_keep_prob={NOOP_KEEP_PROB}...")
    balanced_data = resample_balanced(original_data, noop_keep_prob=NOOP_KEEP_PROB)
    balanced_stats = analyze_distribution(balanced_data)

    print(f"    Total samples: {balanced_stats['total']}")
    print(f"    Noop ratio: {balanced_stats['noop_ratio']:.2%}")
    print(f"    Action entropy: {balanced_stats['action_entropy']:.3f}")
    print("\n    Balanced distribution:")
    for name, stats in balanced_stats['distribution'].items():
        print(f"      {name:<8}: {stats['count']:>6} ({stats['ratio']:>6.1%})")

    # Step 3: 保存重采样数据
    print("\n[3] Saving balanced dataset...")
    balanced_path = "datasets/dataset_v1/train_balanced.jsonl"
    with open(balanced_path, 'w', encoding='utf-8') as f:
        for item in balanced_data:
            f.write(json.dumps(item, ensure_ascii=False) + '\n')
    print(f"    Saved: {balanced_path}")

    # Step 4: 训练 BC
    print("\n[4] Training BC with balanced data...")
    bc_policy, losses = train_bc(balanced_data, epochs=20)

    # 保存 BC v2
    bc_v2_path = "checkpoints/bc_policy_v2.pt"
    torch.save({
        "policy_state_dict": bc_policy.state_dict(),
    }, bc_v2_path)
    print(f"    Saved: {bc_v2_path}")

    # Step 5: 评估 policy entropy
    print("\n[5] Evaluating policy entropy...")
    entropy, action_counter = evaluate_policy_entropy(bc_policy, n_samples=5000)
    print(f"    Policy entropy (random obs): {entropy:.3f}")
    print(f"    Action distribution (random obs): {action_counter}")

    # Step 6: 评估策略在真实环境中的动作分布
    print("\n[6] Evaluating policy in real environment...")
    action_dist = evaluate_policy_action_dist(bc_policy, n_samples=10)
    print("    Action distribution (real env):")
    for name, stats in action_dist.items():
        print(f"      {name:<8}: {stats['count']:>6} ({stats['ratio']:>6.1%})")

    # 计算真实环境的 entropy
    probs = [stats["ratio"] for stats in action_dist.values()]
    real_entropy = -sum(p * np.log2(p) for p in probs if p > 0)
    print(f"\n    Real env entropy: {real_entropy:.3f}")

    # Step 7: Shadow Evaluation
    print("\n[7] Running Shadow Evaluation...")
    test_configs = [
        {"arrival_rate": 10.0, "burst_prob": 0.05, "name": "baseline"},
        {"arrival_rate": 25.0, "burst_prob": 0.20, "name": "high_load"},
        {"arrival_rate": 30.0, "burst_prob": 0.30, "name": "chaotic_spike"},
        {"arrival_rate": 15.0, "burst_prob": 0.15, "name": "worker_failure"},
        {"arrival_rate": 5.0, "burst_prob": 0.10, "name": "long_idle"},
    ]

    results = run_shadow_eval(bc_policy, test_configs)

    print("\n    Results:")
    collapse_count = 0
    for result in results:
        status = "SURVIVED" if result["survived"] else "COLLAPSED"
        collapse_count += 0 if result["survived"] else 1
        print(f"      {result['config']:<15}: queue={result['avg_queue']:>8.0f}, "
              f"survived={result['survived']}, std={result['worker_std']:.1f}")

    collapse_rate = collapse_count / len(results)

    # Step 8: 保存报告
    print("\n[8] Saving report...")
    report = {
        "timestamp": "2026-05-30",
        "original_stats": original_stats,
        "balanced_stats": balanced_stats,
        "noop_reduction": f"{original_stats['noop_ratio']:.2%} → {balanced_stats['noop_ratio']:.2%}",
        "policy_entropy": {
            "random_obs": entropy,
            "real_env": real_entropy,
        },
        "shadow_eval": {
            "collapse_rate": collapse_rate,
            "results": results,
        },
    }

    report_path = "experiments/dataset_rebalance/rebalance_report.json"
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"    Saved: {report_path}")

    # 汇总
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"\nNoop Ratio: {original_stats['noop_ratio']:.2%} → {balanced_stats['noop_ratio']:.2%}")
    print(f"Policy Entropy: {real_entropy:.3f}")
    print(f"Collapse Rate: {collapse_rate:.1%}")
    print(f"\n✅ Dataset Rebalance Complete")


if __name__ == "__main__":
    main()
