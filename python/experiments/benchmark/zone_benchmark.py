# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Zone Benchmark
# Path: experiments/benchmark/zone_benchmark.py
#
# Task 1.2: 按 Zone 统计 BC 与 Teacher 的 match rate
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import torch
import torch.nn as nn
import numpy as np
from typing import Dict

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.training.simulator.teacher_v4 import TeacherV4


# ============================================================
# Policy Network V2
# ============================================================

class PolicyNetworkV2(nn.Module):
    def __init__(self, input_dim: int = 10, hidden_dim: int = 128, num_actions: int = 5):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, num_actions),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


# ============================================================
# Feature Builder
# ============================================================

def compute_load_ratio(queue_depth: int, worker_count: int) -> float:
    return queue_depth / max(worker_count * 2, 1)


def get_zone_id(queue_depth: int, worker_count: int) -> int:
    lr = compute_load_ratio(queue_depth, worker_count)
    if lr < 0.1: return 0
    elif lr < 0.25: return 1
    elif lr < 0.5: return 2
    elif lr < 1.0: return 3
    else: return 4


def build_features(queue_depth: int, worker_count: int, cpu_usage: float = 0.5) -> np.ndarray:
    zone_id = get_zone_id(queue_depth, worker_count)
    load_ratio = compute_load_ratio(queue_depth, worker_count)
    max_lr = 21.5
    lr_norm = np.log(1 + load_ratio) / np.log(1 + max_lr)
    obs = np.array([
        queue_depth / 1000.0, 0.0, 0.0,
        worker_count / 200.0, cpu_usage,
        0.0, 0.0, 0.0,
        zone_id / 4.0, lr_norm,
    ], dtype=np.float32)
    return obs


def bc_decide(model, queue_depth: int, worker_count: int) -> int:
    obs = build_features(queue_depth, worker_count)
    obs_tensor = torch.FloatTensor(obs).unsqueeze(0)
    with torch.no_grad():
        return torch.argmax(model(obs_tensor), dim=-1).item()


def teacher_decide(queue_depth: int, worker_count: int) -> int:
    teacher = TeacherV4()
    action_value = teacher.decide(queue_depth, worker_count)
    return action_value + 2


# ============================================================
# Zone Benchmark
# ============================================================

def get_zone_samples(zone: int, n: int = 500) -> list:
    """生成指定 Zone 的 (queue, worker) 样本"""
    np.random.seed(42 + zone)
    samples = []

    if zone == 0:  # Zone A: lr < 0.1
        for _ in range(n):
            w = np.random.randint(10, 500)
            q = int(w * 2 * np.random.uniform(0.0, 0.09))
            samples.append((q, w))
    elif zone == 1:  # Zone B: 0.1 <= lr < 0.25
        for _ in range(n):
            w = np.random.randint(10, 500)
            q = int(w * 2 * np.random.uniform(0.1, 0.24))
            samples.append((q, w))
    elif zone == 2:  # Zone C: 0.25 <= lr < 0.5
        for _ in range(n):
            w = np.random.randint(10, 500)
            q = int(w * 2 * np.random.uniform(0.25, 0.49))
            samples.append((q, w))
    elif zone == 3:  # Zone D: 0.5 <= lr < 1.0
        for _ in range(n):
            w = np.random.randint(10, 500)
            q = int(w * 2 * np.random.uniform(0.5, 0.99))
            samples.append((q, w))
    else:  # Zone E: lr >= 1.0
        for _ in range(n):
            w = np.random.randint(10, 500)
            q = int(w * 2 * np.random.uniform(1.0, 20.0))
            samples.append((q, w))

    return samples


def run_zone_benchmark(bc_model_path: str = "checkpoints/bc_policy_v3_1_clean.pt") -> Dict:
    """运行 Zone Benchmark"""
    print("=" * 60)
    print("ZONE BENCHMARK")
    print("=" * 60)
    print(f"Model: {bc_model_path}")

    # 加载模型
    checkpoint = torch.load(bc_model_path, map_location='cpu')
    input_dim = checkpoint.get('input_dim', 10)
    model = PolicyNetworkV2(input_dim=input_dim)
    model.load_state_dict(checkpoint['policy_state_dict'])
    model.eval()
    print(f"Model loaded: input_dim={input_dim}")

    zone_names = {0: "A", 1: "B", 2: "C", 3: "D", 4: "E"}
    results = {}

    print("\nZone Breakdown:")
    print("-" * 60)

    for zone_id in range(5):
        samples = get_zone_samples(zone_id, n=500)
        matches = 0
        zone_name = zone_names[zone_id]

        for q, w in samples:
            bc_action = bc_decide(model, q, w)
            teacher_action = teacher_decide(q, w)
            if bc_action == teacher_action:
                matches += 1

        rate = matches / len(samples)
        results[zone_name] = round(rate, 4)
        print(f"  Zone {zone_name} ({zone_id}): {matches}/{len(samples)} ({rate:.2%})")

    # 汇总
    print("\n" + "=" * 60)
    print("ZONE BENCHMARK SUMMARY")
    print("=" * 60)
    print(f"\n{'':6} {'Match Rate':>12}")
    print("-" * 20)
    for z in "ABCDE":
        print(f"  Zone {z}: {results[z]:>12.2%}")

    avg_rate = sum(results.values()) / len(results)
    print(f"\n  Average: {avg_rate:>12.2%}")

    return results


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Zone Benchmark")
    parser.add_argument("--model", type=str, default="checkpoints/bc_policy_v3_1_clean.pt")
    parser.add_argument("--output", type=str, default="artifacts/zone_benchmark.json")
    args = parser.parse_args()

    results = run_zone_benchmark(args.model)

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to: {args.output}")

    return results


if __name__ == "__main__":
    main()
