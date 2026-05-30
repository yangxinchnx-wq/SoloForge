# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Dataset Sampler
# Path: python/governor_rl/training/dataset_sampler.py
#
# Stage 2: Transition-aware Sampling
# 解决 78% no-op 问题
# ─────────────────────────────────────────────────────────────────

import random
import json
import numpy as np
from typing import List, Dict
from collections import Counter


def should_keep(entry: Dict, random_seed: int = None) -> bool:
    """
    决定是否保留 transition

    Args:
        entry: transition dict
        random_seed: 随机种子

    Returns:
        bool: 是否保留
    """
    if random_seed is not None:
        random.seed(random_seed)

    phase = entry.get("phase", "unknown")
    action = entry.get("action", 2)

    # Stable + no-op: 大幅下采样
    if phase == "stable" and action == 2:
        return random.random() < 0.10

    # Stable + other: 少量下采样
    if phase == "stable":
        return random.random() < 0.20

    # Unknown + no-op: 少量保留
    if phase == "unknown" and action == 2:
        return random.random() < 0.15

    # 其他全部保留
    return True


def sample_transitions(
    input_path: str,
    output_path: str = None,
    random_seed: int = 42,
) -> Dict:
    """
    对 timeline 进行 transition-aware 采样

    Args:
        input_path: 输入文件路径
        output_path: 输出文件路径
        random_seed: 随机种子

    Returns:
        Dict: 采样统计
    """
    print("=" * 60)
    print("Transition-Aware Sampling")
    print("=" * 60)
    print(f"Input: {input_path}")

    # 加载
    entries = []
    with open(input_path, 'r', encoding='utf-8') as f:
        for line in f:
            entries.append(json.loads(line.strip()))

    print(f"Loaded {len(entries)} entries")

    # 原始统计
    original_actions = Counter(e.get("action", 2) for e in entries)
    original_phases = Counter(e.get("phase", "unknown") for e in entries)

    print("\n原始分布:")
    print(f"  Actions: {dict(original_actions)}")
    print(f"  Phases: {dict(original_phases)}")

    # 采样
    sampled = [e for e in entries if should_keep(e, random_seed)]

    print(f"\n采样后: {len(sampled)} entries ({len(sampled)/len(entries)*100:.1f}%)")

    # 采样后统计
    sampled_actions = Counter(e.get("action", 2) for e in sampled)
    sampled_phases = Counter(e.get("phase", "unknown") for e in sampled)

    print("\n采样后分布:")
    print(f"  Actions: {dict(sampled_actions)}")
    print(f"  Phases: {dict(sampled_phases)}")

    # 计算 noop_ratio
    noop_count = sampled_actions.get(2, 0)
    noop_ratio = noop_count / len(sampled) if sampled else 0

    # 计算 action entropy
    action_entropy = _compute_entropy(sampled_actions, len(sampled))

    print(f"\noop_ratio: {noop_ratio:.2%}")
    print(f"action_entropy: {action_entropy:.3f}")

    # 保存
    if output_path:
        with open(output_path, 'w', encoding='utf-8') as f:
            for e in sampled:
                f.write(json.dumps(e, ensure_ascii=False) + '\n')
        print(f"\nSaved to: {output_path}")

    return {
        "original_count": len(entries),
        "sampled_count": len(sampled),
        "noop_ratio": noop_ratio,
        "action_entropy": action_entropy,
        "action_distribution": dict(sampled_actions),
        "phase_distribution": dict(sampled_phases),
    }


def _compute_entropy(counter: Counter, total: int) -> float:
    """计算 entropy"""
    if total == 0:
        return 0.0
    entropy = 0.0
    for count in counter.values():
        if count > 0:
            p = count / total
            entropy -= p * np.log2(p)
    return entropy


def validate_dataset(path: str) -> Dict:
    """
    验证数据集

    Returns:
        Dict: 验证结果
    """
    entries = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            entries.append(json.loads(line.strip()))

    actions = Counter(e.get("action", 2) for e in entries)
    phases = Counter(e.get("phase", "unknown") for e in entries)

    noop_ratio = actions.get(2, 0) / len(entries)
    action_entropy = _compute_entropy(actions, len(entries))

    checks = {
        "noop_ratio": noop_ratio < 0.65,
        "action_entropy": action_entropy > 0.9,
        "min_samples": len(entries) > 1000,
    }

    return {
        "passed": all(checks.values()),
        "checks": checks,
        "noop_ratio": noop_ratio,
        "action_entropy": action_entropy,
        "total_samples": len(entries),
    }


def main():
    """演示"""
    import glob

    # 查找最新的 train.jsonl
    datasets = glob.glob("datasets/dataset_v1/train_*.jsonl")
    if not datasets:
        print("No dataset found. Run curriculum_rollout first.")
        return

    input_path = max(datasets, key=os.path.getmtime)
    output_path = input_path.replace("_raw", "").replace("train_", "train_sampled_")

    sample_transitions(input_path, output_path)


if __name__ == "__main__":
    import os
    main()
