# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 4.6 - BC Domain Certification
# Path: governor_rl/training/sprint46_bc_domain_cert.py
#
# Sprint 4.6: BC Domain Certification
# 验证 BC 在训练分布内（In-Domain）的性能
#
# 三个级别:
#   In-Domain: P0-P99 训练分布内，Agreement > 90%
#   Near-OOD: P99-P99.9 边界附近，Agreement > 80%
#   Far-OOD: > 5x P99，只要求不崩溃
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import numpy as np
from typing import Dict, List, Tuple
import json

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.training.simulator.teacher_v4 import TeacherV4

# V2 Policy Network
import torch.nn as nn
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


def load_bc_model(model_path: str, use_v2: bool = False):
    """加载 BC 模型"""
    checkpoint = torch.load(model_path, map_location='cpu')

    if use_v2:
        # V2: PolicyNetworkV2
        input_dim = checkpoint.get('input_dim', 10)
        policy = PolicyNetworkV2(input_dim=input_dim, hidden_dim=128)
    else:
        # V1: PolicyNetwork
        policy = PolicyNetwork(hidden_dim=128)

    policy.load_state_dict(checkpoint['policy_state_dict'])
    policy.eval()
    return policy


def compute_load_ratio(queue_depth: int, worker_count: int) -> float:
    """计算 load_ratio"""
    return queue_depth / max(worker_count * 2, 1)


def get_zone_id(queue_depth: int, worker_count: int) -> int:
    """获取 Zone ID (基于 load_ratio，与 Teacher V4 一致)"""
    load_ratio = compute_load_ratio(queue_depth, worker_count)
    if load_ratio < 0.1:
        return 0
    elif load_ratio < 0.25:
        return 1
    elif load_ratio < 0.5:
        return 2
    elif load_ratio < 1.0:
        return 3
    else:
        return 4


def make_obs(queue_depth: int, worker_count: int, cpu_usage: float = 0.5, use_v2: bool = False) -> torch.FloatTensor:
    """构建 observation tensor"""
    zone_id = get_zone_id(queue_depth, worker_count)
    load_ratio = compute_load_ratio(queue_depth, worker_count)

    if use_v2:
        # V2: 使用 log 归一化的 load_ratio
        max_lr = 21.5
        lr_norm = np.log(1 + load_ratio) / np.log(1 + max_lr)
        obs = np.array([
            queue_depth / 1000.0,
            0.0,
            0.0,
            worker_count / 200.0,
            cpu_usage,
            0.0,
            0.0,
            0.0,
            zone_id / 4.0,
            lr_norm,  # 新增
        ], dtype=np.float32)
    else:
        # V1: 无 load_ratio
        obs = np.array([
            queue_depth / 1000.0,
            0.0,
            0.0,
            worker_count / 200.0,
            cpu_usage,
            0.0,
            0.0,
            0.0,
            zone_id / 4.0,
        ], dtype=np.float32)
    return torch.FloatTensor(obs).unsqueeze(0)


def bc_decide(model, queue_depth: int, worker_count: int, use_v2: bool = False) -> int:
    """BC 决策"""
    obs = make_obs(queue_depth, worker_count, use_v2=use_v2)
    with torch.no_grad():
        logits = model(obs)
        action = torch.argmax(logits, dim=-1).item()
    return action


def teacher_decide(queue_depth: int, worker_count: int) -> int:
    """Teacher 决策"""
    teacher = TeacherV4()
    action = teacher.decide(queue_depth, worker_count)
    return {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4}[action]


def analyze_training_distribution(timeline_path: str) -> Dict:
    """分析训练数据分布"""
    entries = []
    with open(timeline_path, 'r', encoding='utf-8') as f:
        for line in f:
            entries.append(json.loads(line))

    queue_values = [e['queue_depth'] for e in entries]
    worker_values = [e['worker_count'] for e in entries]
    load_ratios = [compute_load_ratio(e['queue_depth'], e['worker_count']) for e in entries]

    queue_values = sorted(queue_values)
    worker_values = sorted(worker_values)
    load_ratios = sorted(load_ratios)

    n = len(queue_values)

    percentiles = {}
    for p in [50, 90, 95, 99, 99.5, 99.9]:
        idx = int(n * p / 100)
        percentiles[f'p{p}'] = {
            'queue': queue_values[min(idx, n-1)],
            'worker': worker_values[min(idx, n-1)],
            'load_ratio': load_ratios[min(idx, n-1)],
        }

    return {
        'n': n,
        'queue_range': (min(queue_values), max(queue_values)),
        'worker_range': (min(worker_values), max(worker_values)),
        'load_ratio_range': (min(load_ratios), max(load_ratios)),
        'percentiles': percentiles,
    }


def run_domain_certification(
    bc_model_path: str = "checkpoints/bc_policy_v3_sprint4.pt",
    timeline_path: str = "datasets/timeline_v3_1.jsonl",
    use_v2: bool = False,
) -> Dict:
    """运行 BC Domain Certification"""
    print("=" * 60)
    print("SPRINT 4.6: BC DOMAIN CERTIFICATION")
    print("=" * 60)
    print(f"Model: {bc_model_path}")
    print(f"Use V2 (load_ratio): {use_v2}")

    # 1. 分析训练分布
    print("\n[1/4] Analyzing Training Distribution...")
    dist = analyze_training_distribution(timeline_path)

    print(f"\nDataset Size: {dist['n']:,}")
    print(f"Queue Range: {dist['queue_range'][0]} - {dist['queue_range'][1]}")
    print(f"Worker Range: {dist['worker_range'][0]} - {dist['worker_range'][1]}")
    print(f"Load Ratio Range: {dist['load_ratio_range'][0]:.3f} - {dist['load_ratio_range'][1]:.3f}")

    print("\nPercentiles:")
    for p, values in dist['percentiles'].items():
        print(f"  {p}: queue={values['queue']}, worker={values['worker']}, lr={values['load_ratio']:.3f}")

    # 2. 加载模型
    print("\n[2/4] Loading BC Model...")
    model = load_bc_model(bc_model_path, use_v2=use_v2)
    print("Model loaded successfully")

    # 3. In-Domain 测试
    print("\n[3/4] Running Domain Tests...")

    ACTION_NAMES = {0: 'shrink2', 1: 'shrink1', 2: 'noop', 3: 'expand1', 4: 'expand2'}

    p99 = dist['percentiles']['p99']
    p999 = dist['percentiles']['p99.9']

    # In-Domain: 在 P99 以内
    print("\n" + "=" * 60)
    print("IN-DOMAIN TEST (within P99)")
    print("=" * 60)

    in_domain_cases = [
        {"queue": 100, "worker": 50},
        {"queue": 200, "worker": 100},
        {"queue": 300, "worker": 100},
        {"queue": 400, "worker": 150},
        {"queue": 500, "worker": 150},
        {"queue": 600, "worker": 200},
        {"queue": 700, "worker": 200},
        {"queue": 800, "worker": 200},
        {"queue": 1000, "worker": 250},
    ]

    in_domain_agreements = 0
    in_domain_total = len(in_domain_cases)

    print(f"\n{'Queue':>8} {'Worker':>8} {'Zone':>5} {'BC':>8} {'Teacher':>8} {'Match':>6}")
    print("-" * 50)

    for case in in_domain_cases:
        q, w = case["queue"], case["worker"]
        bc_action = bc_decide(model, q, w, use_v2=use_v2)
        teacher_action = teacher_decide(q, w)
        zone = get_zone_id(q, w)
        match = bc_action == teacher_action
        if match:
            in_domain_agreements += 1
        print(f"{q:>8} {w:>8} {zone:>5} {ACTION_NAMES[bc_action]:>8} {ACTION_NAMES[teacher_action]:>8} {'YES' if match else 'NO':>6}")

    in_domain_rate = in_domain_agreements / in_domain_total

    print(f"\nIn-Domain Agreement: {in_domain_rate:.2%} ({in_domain_agreements}/{in_domain_total})")
    in_domain_pass = in_domain_rate > 0.90
    print(f"Threshold: >90%")
    print(f"Result: {'PASS' if in_domain_pass else 'FAIL'}")

    # Near-OOD: P99-P99.9
    print("\n" + "=" * 60)
    print("NEAR-OOD TEST (P99 - P99.9)")
    print("=" * 60)

    # 在 P99 基础上扩展
    near_ood_cases = [
        {"queue": int(p99['queue'] * 1.5), "worker": int(p99['worker'] * 1.5)},
        {"queue": int(p99['queue'] * 2.0), "worker": int(p99['worker'] * 1.2)},
        {"queue": int(p99['queue'] * 2.5), "worker": int(p99['worker'])},
        {"queue": int(p99['queue'] * 3.0), "worker": int(p99['worker'] * 0.8)},
        {"queue": int(p99['queue'] * 4.0), "worker": int(p99['worker'] * 0.6)},
        {"queue": int(p99['queue'] * 5.0), "worker": int(p99['worker'] * 0.5)},
    ]

    near_ood_agreements = 0
    near_ood_total = len(near_ood_cases)

    print(f"\n{'Queue':>8} {'Worker':>8} {'Zone':>5} {'BC':>8} {'Teacher':>8} {'Match':>6}")
    print("-" * 50)

    for case in near_ood_cases:
        q, w = case["queue"], case["worker"]
        bc_action = bc_decide(model, q, w, use_v2=use_v2)
        teacher_action = teacher_decide(q, w)
        zone = get_zone_id(q, w)
        match = bc_action == teacher_action
        if match:
            near_ood_agreements += 1
        print(f"{q:>8} {w:>8} {zone:>5} {ACTION_NAMES[bc_action]:>8} {ACTION_NAMES[teacher_action]:>8} {'YES' if match else 'NO':>6}")

    near_ood_rate = near_ood_agreements / near_ood_total

    print(f"\nNear-OOD Agreement: {near_ood_rate:.2%} ({near_ood_agreements}/{near_ood_total})")
    near_ood_pass = near_ood_rate > 0.80
    print(f"Threshold: >80%")
    print(f"Result: {'PASS' if near_ood_pass else 'FAIL'}")

    # Far-OOD: 只要求不崩溃
    print("\n" + "=" * 60)
    print("FAR-OOD TEST (>5x P99)")
    print("=" * 60)

    far_ood_cases = [
        {"queue": 5000, "worker": 50},
        {"queue": 10000, "worker": 50},
        {"queue": 20000, "worker": 100},
        {"queue": 30000, "worker": 50},
        {"queue": 50000, "worker": 100},
    ]

    far_ood_valid = 0
    far_ood_total = len(far_ood_cases)

    print(f"\n{'Queue':>8} {'Worker':>8} {'Zone':>5} {'BC Action':>10} {'Status':>10}")
    print("-" * 55)

    for case in far_ood_cases:
        q, w = case["queue"], case["worker"]
        try:
            bc_action = bc_decide(model, q, w, use_v2=use_v2)
            teacher_action = teacher_decide(q, w)
            zone = get_zone_id(q, w)

            # Far-OOD 只要求 BC 输出有效动作（0-4）
            valid = 0 <= bc_action <= 4
            if valid:
                far_ood_valid += 1
            print(f"{q:>8} {w:>8} {zone:>5} {ACTION_NAMES[bc_action]:>10} {'VALID' if valid else 'INVALID':>10}")
        except Exception as e:
            print(f"{q:>8} {w:>8} ERROR: {e}")

    far_ood_rate = far_ood_valid / far_ood_total

    print(f"\nFar-OOD Validity: {far_ood_rate:.2%} ({far_ood_valid}/{far_ood_total})")
    far_ood_pass = far_ood_rate == 1.0  # 要求 100% 有效
    print(f"Threshold: 100% valid (no crash)")
    print(f"Result: {'PASS' if far_ood_pass else 'FAIL'}")

    # 4. 汇总
    print("\n" + "=" * 60)
    print("SPRINT 4.6 SUMMARY")
    print("=" * 60)

    all_pass = in_domain_pass and near_ood_pass and far_ood_pass

    print("\n| Test Level   | Rate     | Threshold | Status |")
    print("|--------------|----------|-----------|--------|")
    print(f"| In-Domain    | {in_domain_rate:.2%}   | >90%      | {'PASS' if in_domain_pass else 'FAIL'}     |")
    print(f"| Near-OOD     | {near_ood_rate:.2%}   | >80%      | {'PASS' if near_ood_pass else 'FAIL'}     |")
    print(f"| Far-OOD      | {far_ood_rate:.2%}   | 100%      | {'PASS' if far_ood_pass else 'FAIL'}     |")

    print("\n" + "=" * 60)
    if all_pass:
        print("BC DOMAIN CERTIFICATION: PASSED")
        print("Proceed to Sprint 4.7: Feature Engineering")
    else:
        print("BC DOMAIN CERTIFICATION: FAILED")
        if not in_domain_pass:
            print("  - BC fails in training distribution")
            print("  - Check model training or data quality")
        if not near_ood_pass:
            print("  - BC struggles near distribution boundary")
            print("  - Consider feature engineering (load_ratio)")
        if not far_ood_pass:
            print("  - BC produces invalid outputs for extreme cases")
            print("  - This is expected for BC, PPO should handle this")
    print("=" * 60)

    return {
        "in_domain": {"rate": in_domain_rate, "pass": in_domain_pass, "agreements": in_domain_agreements, "total": in_domain_total},
        "near_ood": {"rate": near_ood_rate, "pass": near_ood_pass, "agreements": near_ood_agreements, "total": near_ood_total},
        "far_ood": {"rate": far_ood_rate, "pass": far_ood_pass, "valid": far_ood_valid, "total": far_ood_total},
        "all_pass": all_pass,
        "distribution": dist,
    }


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Sprint 4.6: BC Domain Certification")
    parser.add_argument("--model", type=str, default="checkpoints/bc_policy_v3_sprint4.pt")
    parser.add_argument("--timeline", type=str, default="datasets/timeline_v3_1.jsonl")
    parser.add_argument("--v2", action="store_true", help="Use V2 model with load_ratio")

    args = parser.parse_args()

    result = run_domain_certification(
        bc_model_path=args.model,
        timeline_path=args.timeline,
        use_v2=args.v2,
    )

    sys.exit(0 if result["all_pass"] else 1)


if __name__ == "__main__":
    main()
