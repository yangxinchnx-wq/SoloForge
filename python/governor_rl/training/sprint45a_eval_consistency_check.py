# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 4.5A - Evaluation Consistency Check
# Path: governor_rl/training/sprint45a_eval_consistency_check.py
#
# Sprint 4.5A: Evaluation Consistency Check
# 验证评测方法的可信度
#
# 检查项:
#   A1: Action Mapping Audit
#   A2: Feature Builder Audit
#   A3: Teacher Consistency Audit
#   A4: Replay Audit
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import torch.nn as nn
import numpy as np
from typing import Dict, List, Tuple
import json
import random

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.training.simulator.teacher_v4 import TeacherV4


# ============================================================
# 单一入口：Feature Builder
# ============================================================

# 全局配置
FEATURE_CONFIG = {
    "include_load_ratio": True,
    "input_dim": 10,
    "max_lr": 21.5,
}


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


def build_features(queue_depth: int, worker_count: int, cpu_usage: float = 0.5) -> np.ndarray:
    """
    单一入口：构建所有特征

    特征顺序 (10维):
    0: queue_depth / 1000
    1: queue_velocity (0)
    2: queue_acceleration (0)
    3: worker_count / 200
    4: cpu_usage
    5: precursor_score (0)
    6: risk_score (0)
    7: oscillation_score (0)
    8: zone_id / 4
    9: load_ratio (log-normalized) [可选]
    """
    zone_id = get_zone_id(queue_depth, worker_count)
    load_ratio = compute_load_ratio(queue_depth, worker_count)

    if FEATURE_CONFIG["include_load_ratio"]:
        max_lr = FEATURE_CONFIG["max_lr"]
        lr_norm = np.log(1 + load_ratio) / np.log(1 + max_lr)
        obs = np.array([
            queue_depth / 1000.0,
            0.0,  # queue_velocity
            0.0,  # queue_acceleration
            worker_count / 200.0,
            cpu_usage,
            0.0,  # precursor_score
            0.0,  # risk_score
            0.0,  # oscillation_score
            zone_id / 4.0,
            lr_norm,
        ], dtype=np.float32)
    else:
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

    return obs


def teacher_decide(queue_depth: int, worker_count: int) -> int:
    """
    Teacher 决策，统一返回 action_index (0-4)
    """
    teacher = TeacherV4()
    action_value = teacher.decide(queue_depth, worker_count)
    # Teacher V4 返回 action_value: -2, -1, 0, 1, 2
    # 转换为 action_index: 0, 1, 2, 3, 4
    action_index = action_value + 2  # -2 -> 0, -1 -> 1, 0 -> 2, 1 -> 3, 2 -> 4
    return action_index


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
# BC Decision
# ============================================================

def bc_decide(model, queue_depth: int, worker_count: int) -> int:
    """BC 决策"""
    obs = build_features(queue_depth, worker_count)
    obs_tensor = torch.FloatTensor(obs).unsqueeze(0)
    with torch.no_grad():
        logits = model(obs_tensor)
        action = torch.argmax(logits, dim=-1).item()
    return action


# ============================================================
# 审计函数
# ============================================================

ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}


def check_a1_action_mapping():
    """A1: Action Mapping Audit"""
    print("\n" + "=" * 60)
    print("CHECK A1: Action Mapping Audit")
    print("=" * 60)

    teacher = TeacherV4()

    # 测试所有 Zone 的 Teacher 输出
    # Zone 边界: A(<0.1), B(0.1-0.25), C(0.25-0.5), D(0.5-1.0), E(>=1.0)
    test_cases = [
        {"zone": "A", "q": 10, "w": 200},   # lr = 0.025 < 0.1
        {"zone": "B", "q": 40, "w": 200},   # lr = 0.100 = 0.1 (边界情况)
        {"zone": "C", "q": 300, "w": 400},   # lr = 0.375 ∈ [0.25, 0.5)
        {"zone": "D", "q": 600, "w": 500},   # lr = 0.600 ∈ [0.5, 1.0)
        {"zone": "E", "q": 1000, "w": 200},   # lr = 2.500 >= 1.0
    ]

    print("\nTeacher action_value → action_index mapping:")
    print("-" * 50)

    all_valid = True
    for case in test_cases:
        q, w = case["q"], case["w"]
        zone = get_zone_id(q, w)
        lr = compute_load_ratio(q, w)

        action_value = teacher.decide(q, w)
        action_index = action_value + 2

        expected_zone = case["zone"]
        expected_action = {"A": 0, "B": 1, "C": 2, "D": 3, "E": 4}[expected_zone]

        valid = 0 <= action_index <= 4
        match = action_index == expected_action and zone == ord(expected_zone) - ord('A')

        status = "VALID" if valid else "INVALID"
        match_status = "MATCH" if match else "MISMATCH"

        print(f"Zone {zone} (expected {expected_zone}), lr={lr:.3f}: action_value={action_value} → action_index={action_index} [{status}] [{match_status}]")

        if not valid or not match:
            all_valid = False

    print(f"\nResult: {'PASS' if all_valid else 'FAIL'}")
    return {"pass": all_valid}


def check_a2_feature_builder():
    """A2: Feature Builder Audit"""
    print("\n" + "=" * 60)
    print("CHECK A2: Feature Builder Audit")
    print("=" * 60)

    # 测试 build_features 输出维度
    obs = build_features(100, 50)
    dim = len(obs)

    print(f"\nFeature vector dimension: {dim}")
    print(f"Expected dimension: {FEATURE_CONFIG['input_dim']}")

    # 测试边界情况
    test_cases = [
        {"q": 0, "w": 1},
        {"q": 1000, "w": 500},
        {"q": 50000, "w": 100},
    ]

    print("\nFeature vector samples:")
    print("-" * 50)

    all_valid = True
    for case in test_cases:
        q, w = case["q"], case["w"]
        obs = build_features(q, w)

        if len(obs) != FEATURE_CONFIG["input_dim"]:
            print(f"q={q}, w={w}: DIMENSION MISMATCH ({len(obs)} vs {FEATURE_CONFIG['input_dim']})")
            all_valid = False
        else:
            print(f"q={q}, w={w}: dim={len(obs)} OK")

    print(f"\nResult: {'PASS' if all_valid else 'FAIL'}")
    return {"pass": all_valid, "dimension": dim}


def check_a3_teacher_consistency():
    """A3: Teacher Consistency Audit"""
    print("\n" + "=" * 60)
    print("CHECK A3: Teacher Consistency Audit")
    print("=" * 60)

    # 使用不同的 Teacher 实例验证一致性
    teacher1 = TeacherV4()
    teacher2 = TeacherV4()

    # 随机采样测试
    random.seed(42)
    test_cases = []
    for _ in range(1000):
        q = random.randint(0, 10000)
        w = random.randint(1, 500)
        test_cases.append((q, w))

    print(f"\nTesting {len(test_cases)} random states...")

    matches = 0
    mismatches = []

    for q, w in test_cases:
        action1 = teacher1.decide(q, w)
        action2 = teacher2.decide(q, w)

        if action1 == action2:
            matches += 1
        else:
            mismatches.append((q, w, action1, action2))

    match_rate = matches / len(test_cases)

    print(f"Consistent decisions: {matches}/{len(test_cases)} ({match_rate:.2%})")

    if mismatches:
        print(f"\nMismatches found: {len(mismatches)}")
        for i, (q, w, a1, a2) in enumerate(mismatches[:5]):
            zone = get_zone_id(q, w)
            print(f"  q={q}, w={w}, zone={zone}: teacher1={a1}, teacher2={a2}")
        if len(mismatches) > 5:
            print(f"  ... and {len(mismatches) - 5} more")
    else:
        print("No mismatches found.")

    passed = match_rate == 1.0
    print(f"\nResult: {'PASS' if passed else 'FAIL'}")
    return {"pass": passed, "match_rate": match_rate, "mismatches": len(mismatches)}


def check_a4_replay_audit(model, timeline_path: str, num_samples: int = 1000):
    """A4: Replay Audit"""
    print("\n" + "=" * 60)
    print("CHECK A4: Replay Audit")
    print("=" * 60)

    # 从数据集随机采样
    entries = []
    with open(timeline_path, 'r', encoding='utf-8') as f:
        for line in f:
            entries.append(json.loads(line))

    random.seed(42)
    samples = random.sample(entries, min(num_samples, len(entries)))

    print(f"\nReplaying {len(samples)} samples from dataset...")

    agreements = 0
    mismatches = []

    for i, entry in enumerate(samples):
        q = entry["queue_depth"]
        w = entry["worker_count"]
        expected_action = entry["action_index"]  # 数据集中记录的是 action_index

        bc_action = bc_decide(model, q, w)
        teacher_action = teacher_decide(q, w)

        if bc_action == expected_action:
            agreements += 1
        else:
            if len(mismatches) < 10:
                mismatches.append({
                    "q": q, "w": w,
                    "expected": expected_action,
                    "bc": bc_action,
                    "teacher": teacher_action,
                })

    agreement_rate = agreements / len(samples)

    print(f"\nReplay Agreement: {agreements}/{len(samples)} ({agreement_rate:.2%})")

    if mismatches:
        print("\nSample mismatches:")
        for m in mismatches:
            print(f"  q={m['q']}, w={m['w']}: expected={ACTION_NAMES[m['expected']]}, bc={ACTION_NAMES[m['bc']]}, teacher={ACTION_NAMES[m['teacher']]}")
    else:
        print("No mismatches found!")

    # 阈值：>95%
    threshold = 0.95
    passed = agreement_rate > threshold
    print(f"\nThreshold: >{threshold:.0%}")
    print(f"Result: {'PASS' if passed else 'FAIL'}")

    return {"pass": passed, "agreement_rate": agreement_rate, "agreements": agreements, "total": len(samples)}


def run_evaluation_consistency_check(
    bc_model_path: str = "checkpoints/bc_policy_v3_1.pt",
    timeline_path: str = "datasets/timeline_v3_1.jsonl",
) -> Dict:
    """运行所有一致性检查"""
    print("=" * 60)
    print("SPRINT 4.5A: EVALUATION CONSISTENCY CHECK")
    print("=" * 60)

    # A1: Action Mapping
    result_a1 = check_a1_action_mapping()

    # A2: Feature Builder
    result_a2 = check_a2_feature_builder()

    # A3: Teacher Consistency
    result_a3 = check_a3_teacher_consistency()

    # A4: Replay Audit (需要加载模型)
    print("\n" + "=" * 60)
    print("Loading BC Model...")
    checkpoint = torch.load(bc_model_path, map_location='cpu')

    input_dim = checkpoint.get('input_dim', FEATURE_CONFIG["input_dim"])
    FEATURE_CONFIG["input_dim"] = input_dim
    FEATURE_CONFIG["include_load_ratio"] = (input_dim == 10)

    model = PolicyNetworkV2(input_dim=input_dim)
    model.load_state_dict(checkpoint['policy_state_dict'])
    model.eval()
    print(f"Model loaded: input_dim={input_dim}")

    result_a4 = check_a4_replay_audit(model, timeline_path)

    # 汇总
    print("\n" + "=" * 60)
    print("SPRINT 4.5A SUMMARY")
    print("=" * 60)

    results = {
        "A1_action_mapping": result_a1,
        "A2_feature_builder": result_a2,
        "A3_teacher_consistency": result_a3,
        "A4_replay_audit": result_a4,
    }

    print("\n| Check    | Status | Details |")
    print("|----------|--------|---------|")
    print(f"| A1 Action Mapping | {'PASS' if result_a1['pass'] else 'FAIL'} | {'Consistent' if result_a1['pass'] else 'Issues found'} |")
    print(f"| A2 Feature Builder | {'PASS' if result_a2['pass'] else 'FAIL'} | dim={result_a2.get('dimension', 'N/A')} |")
    print(f"| A3 Teacher Consistency | {'PASS' if result_a3['pass'] else 'FAIL'} | {result_a3['match_rate']:.2%} match |")
    print(f"| A4 Replay Audit | {'PASS' if result_a4['pass'] else 'FAIL'} | {result_a4['agreement_rate']:.2%} |")

    all_pass = all(r['pass'] for r in results.values())

    print("\n" + "=" * 60)
    if all_pass:
        print("EVALUATION CONSISTENCY: PASS")
        print("Sprint 4.5B Stress Certification can proceed")
    else:
        print("EVALUATION CONSISTENCY: FAIL")
        print("Fix evaluation issues before trusting Sprint 4.5/4.6 results")
        if not result_a1['pass']:
            print("  - A1: Action mapping inconsistency")
        if not result_a2['pass']:
            print("  - A2: Feature dimension mismatch")
        if not result_a3['pass']:
            print("  - A3: Teacher produces inconsistent outputs")
        if not result_a4['pass']:
            print("  - A4: BC fails on training data replay")
    print("=" * 60)

    results["all_pass"] = all_pass
    return results


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Sprint 4.5A: Evaluation Consistency Check")
    parser.add_argument("--model", type=str, default="checkpoints/bc_policy_v3_1.pt")
    parser.add_argument("--timeline", type=str, default="datasets/timeline_v3_1.jsonl")

    args = parser.parse_args()

    result = run_evaluation_consistency_check(
        bc_model_path=args.model,
        timeline_path=args.timeline,
    )

    sys.exit(0 if result["all_pass"] else 1)


if __name__ == "__main__":
    main()
