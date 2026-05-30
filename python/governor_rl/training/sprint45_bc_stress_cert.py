# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 4.5 - BC Stress Certification
# Path: governor_rl/training/sprint45_bc_stress_cert.py
#
# Sprint 4.5: BC Stress Certification
# 在进入 PPO V2 之前，验证 BC 的泛化能力
#
# 四个审计:
#   Audit 1: High Queue Stress (queue > 5000)
#   Audit 2: High Worker Stress (workers > 200)
#   Audit 3: Noise Robustness (observation noise)
#   Audit 4: Recovery Scenario (full lifecycle)
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import torch.nn as nn
import numpy as np
from typing import Dict, List, Tuple
import json

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.training.simulator.teacher_v4 import TeacherV4


def load_bc_model(model_path: str, use_v2: bool = False):
    """加载 BC 模型"""
    checkpoint = torch.load(model_path, map_location='cpu')

    if use_v2:
        input_dim = checkpoint.get('input_dim', 10)
        policy = PolicyNetworkV2(input_dim=input_dim, hidden_dim=128)
    else:
        policy = PolicyNetwork(hidden_dim=128)

    policy.load_state_dict(checkpoint['policy_state_dict'])
    policy.eval()
    return policy


# V2 Policy Network
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


def get_zone_id(queue_depth: int, worker_count: int) -> int:
    """获取 Zone ID (基于 load_ratio，与 Teacher V4 一致)"""
    capacity = worker_count * 2
    load_ratio = queue_depth / max(1, capacity)
    if load_ratio < 0.1:
        return 0  # Zone A
    elif load_ratio < 0.25:
        return 1  # Zone B
    elif load_ratio < 0.5:
        return 2  # Zone C
    elif load_ratio < 1.0:
        return 3  # Zone D
    else:
        return 4  # Zone E


def compute_load_ratio(queue_depth: int, worker_count: int) -> float:
    """计算 load_ratio"""
    return queue_depth / max(worker_count * 2, 1)


def make_obs(queue_depth: int, worker_count: int, cpu_usage: float = 0.5, use_v2: bool = False) -> torch.FloatTensor:
    """构建 observation tensor"""
    zone_id = get_zone_id(queue_depth, worker_count)

    if use_v2:
        # V2: 带 load_ratio
        max_lr = 21.5
        lr = compute_load_ratio(queue_depth, worker_count)
        lr_norm = np.log(1 + lr) / np.log(1 + max_lr)
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


def compute_agreement(model, test_cases: List[Dict], use_v2: bool = False) -> Dict:
    """计算 BC 与 Teacher 的一致率"""
    agreements = 0
    total = len(test_cases)

    for case in test_cases:
        bc_action = bc_decide(model, case["queue_depth"], case["worker_count"], use_v2=use_v2)
        teacher_action = teacher_decide(case["queue_depth"], case["worker_count"])

        if bc_action == teacher_action:
            agreements += 1

    rate = agreements / total if total > 0 else 0.0
    return {"agreements": agreements, "total": total, "rate": rate}


def run_audit1_high_queue_stress(model, use_v2: bool = False) -> Dict:
    """Audit 1: High Queue Stress"""
    print("\n" + "=" * 60)
    print("AUDIT 1: High Queue Stress")
    print("=" * 60)

    # 构造高队列测试用例
    queues = [5000, 10000, 15000, 20000, 25000, 30000]
    workers = [10, 20, 50, 100, 150]

    test_cases = []
    for q in queues:
        for w in workers:
            test_cases.append({"queue_depth": q, "worker_count": w})

    result = compute_agreement(model, test_cases, use_v2=use_v2)

    print(f"\nTest Cases: {result['total']}")
    print(f"Agreements: {result['agreements']}")
    print(f"Agreement Rate: {result['rate']:.2%}")

    threshold = 0.80
    passed = result['rate'] > threshold
    print(f"Threshold: {threshold:.0%}")
    print(f"Result: {'PASS' if passed else 'FAIL'}")

    return {"rate": result['rate'], "passed": passed, "test_cases": len(test_cases)}


def run_audit2_high_worker_stress(model, use_v2: bool = False) -> Dict:
    """Audit 2: High Worker Stress"""
    print("\n" + "=" * 60)
    print("AUDIT 2: High Worker Stress")
    print("=" * 60)

    # 构造高 worker 测试用例
    workers = [200, 250, 300, 350, 400, 450, 500]
    queues = [0, 50, 100, 200, 500, 1000]

    test_cases = []
    for w in workers:
        for q in queues:
            test_cases.append({"queue_depth": q, "worker_count": w})

    result = compute_agreement(model, test_cases, use_v2=use_v2)

    print(f"\nTest Cases: {result['total']}")
    print(f"Agreements: {result['agreements']}")
    print(f"Agreement Rate: {result['rate']:.2%}")

    threshold = 0.80
    passed = result['rate'] > threshold
    print(f"Threshold: {threshold:.0%}")
    print(f"Result: {'PASS' if passed else 'FAIL'}")

    return {"rate": result['rate'], "passed": passed, "test_cases": len(test_cases)}


def run_audit3_noise_robustness(model, num_samples: int = 500, use_v2: bool = False) -> Dict:
    """Audit 3: Noise Robustness"""
    print("\n" + "=" * 60)
    print("AUDIT 3: Noise Robustness")
    print("=" * 60)

    # 构造基准测试用例
    base_queues = [100, 500, 1000, 2000, 5000, 10000]
    base_workers = [20, 50, 100, 150, 200, 300]

    test_cases = []
    for q in base_queues:
        for w in base_workers:
            test_cases.append({"queue_depth": q, "worker_count": w})

    # 对每个测试用例加噪声，检查动作是否翻转
    flips = 0
    total = 0

    action_log = []

    for case in test_cases:
        # 基准动作
        base_action = bc_decide(model, case["queue_depth"], case["worker_count"])

        # 加噪声测试多次
        for _ in range(5):
            # 添加噪声
            q_noisy = case["queue_depth"] * np.random.uniform(0.9, 1.1)
            w_noisy = case["worker_count"]  # worker_count 不加噪声
            cpu_noisy = np.clip(0.5 + np.random.normal(0, 0.05), 0, 1)

            obs = make_obs(int(q_noisy), w_noisy, cpu_noisy, use_v2=use_v2)
            with torch.no_grad():
                logits = model(obs)
                noisy_action = torch.argmax(logits, dim=-1).item()

            if noisy_action != base_action:
                flips += 1
            total += 1

    flip_rate = flips / total if total > 0 else 0.0

    print(f"\nTest Cases: {len(test_cases)}")
    print(f"Noise Samples: {total}")
    print(f"Action Flips: {flips}")
    print(f"Flip Rate: {flip_rate:.2%}")

    # 要求翻转率 < 20%
    threshold = 0.20
    passed = flip_rate < threshold
    print(f"Threshold: <{threshold:.0%}")
    print(f"Result: {'PASS' if passed else 'FAIL'}")

    return {"flip_rate": flip_rate, "passed": passed, "samples": total, "flips": flips}


def simulate_step(queue_depth: int, worker_count: int, action: int) -> Tuple[int, int]:
    """模拟一步执行后的状态"""
    # action: 0=shrink2, 1=shrink1, 2=noop, 3=expand1, 4=expand2
    action_delta = {-2: -2, -1: -1, 0: 0, 1: 1, 2: 2}

    delta = action_delta.get(action, 0)
    new_workers = max(1, worker_count + delta)

    # 简化模拟：队列根据 worker 数量自动调整
    capacity = new_workers * 2
    if queue_depth > capacity:
        # 处理能力不足，队列增长
        queue_change = min(queue_depth - capacity, 100)
    else:
        # 处理能力充足，队列减少
        queue_change = -min(capacity - queue_depth, 50)

    new_queue = max(0, queue_depth + queue_change)

    return new_queue, new_workers


def run_audit4_recovery_scenario(model, use_v2: bool = False) -> Dict:
    """Audit 4: Recovery Scenario"""
    print("\n" + "=" * 60)
    print("AUDIT 4: Recovery Scenario")
    print("=" * 60)

    # 模拟完整的 recovery 场景
    # Normal -> Stress -> Crisis -> Recovery -> Stable

    scenarios = [
        # Scenario 1: High queue, low workers -> crisis
        {"name": "Crisis Recovery 1", "init_q": 10000, "init_w": 20},
        # Scenario 2: Medium queue, medium workers
        {"name": "Crisis Recovery 2", "init_q": 5000, "init_w": 50},
        # Scenario 3: Very high queue, medium workers
        {"name": "Crisis Recovery 3", "init_q": 20000, "init_w": 100},
        # Scenario 4: Extreme crisis
        {"name": "Crisis Recovery 4", "init_q": 30000, "init_w": 50},
    ]

    successes = 0
    total_scenarios = len(scenarios)

    for scenario in scenarios:
        print(f"\n{scenario['name']}: q={scenario['init_q']}, w={scenario['init_w']}")

        queue = scenario["init_q"]
        workers = scenario["init_w"]
        max_steps = 50
        crisis_detected = False
        recovered = False

        for step in range(max_steps):
            # 检测是否处于 crisis
            zone = get_zone_id(queue, workers)
            if zone >= 4:  # Zone E
                crisis_detected = True

            # BC 决策
            action = bc_decide(model, queue, workers, use_v2=use_v2)
            teacher_action = teacher_decide(queue, workers)

            # 执行一步
            queue, workers = simulate_step(queue, workers, action)

            # 检测是否恢复
            new_zone = get_zone_id(queue, workers)
            if crisis_detected and new_zone <= 2:  # Zone A/B/C
                recovered = True
                print(f"  Step {step}: Zone {zone} -> {new_zone}, Recovered!")
                break

            if step < 5 or step >= max_steps - 3:
                print(f"  Step {step}: Zone {zone}, action={action}, q={queue}, w={workers}")

        if recovered:
            successes += 1
            print(f"  Result: RECOVERED")
        else:
            print(f"  Result: NOT RECOVERED (still in Zone {get_zone_id(queue, workers)})")

    success_rate = successes / total_scenarios if total_scenarios > 0 else 0.0

    print(f"\nTotal Scenarios: {total_scenarios}")
    print(f"Successful Recoveries: {successes}")
    print(f"Success Rate: {success_rate:.2%}")

    threshold = 0.80
    passed = success_rate >= threshold
    print(f"Threshold: {threshold:.0%}")
    print(f"Result: {'PASS' if passed else 'FAIL'}")

    return {"success_rate": success_rate, "passed": passed, "successes": successes, "total": total_scenarios}


def run_sprint45(
    bc_model_path: str = "checkpoints/bc_policy_v3_sprint4.pt",
    use_v2: bool = False,
) -> Dict:
    """运行 Sprint 4.5 BC Stress Certification"""
    print("=" * 60)
    print("SPRINT 4.5: BC STRESS CERTIFICATION")
    print("=" * 60)
    print(f"BC Model: {bc_model_path}")
    print(f"Use V2 (load_ratio): {use_v2}")

    # 加载模型
    print("\nLoading BC model...")
    model = load_bc_model(bc_model_path, use_v2=use_v2)
    print("Model loaded successfully")

    # 运行四个审计
    results = {}

    results["audit1_high_queue"] = run_audit1_high_queue_stress(model, use_v2=use_v2)
    results["audit2_high_worker"] = run_audit2_high_worker_stress(model, use_v2=use_v2)
    results["audit3_noise"] = run_audit3_noise_robustness(model, use_v2=use_v2)
    results["audit4_recovery"] = run_audit4_recovery_scenario(model, use_v2=use_v2)

    # 汇总
    print("\n" + "=" * 60)
    print("SPRINT 4.5 SUMMARY")
    print("=" * 60)

    all_pass = all(r["passed"] for r in results.values())

    print("\n| Audit              | Rate     | Threshold | Status |")
    print("|--------------------|----------|-----------|--------|")
    print(f"| High Queue Stress  | {results['audit1_high_queue']['rate']:.2%}    | >80%      | {'PASS' if results['audit1_high_queue']['passed'] else 'FAIL'}     |")
    print(f"| High Worker Stress | {results['audit2_high_worker']['rate']:.2%}    | >80%      | {'PASS' if results['audit2_high_worker']['passed'] else 'FAIL'}     |")
    print(f"| Noise Robustness   | {1-results['audit3_noise']['flip_rate']:.2%}    | <20% flip | {'PASS' if results['audit3_noise']['passed'] else 'FAIL'}     |")
    print(f"| Recovery Scenario  | {results['audit4_recovery']['success_rate']:.2%}    | >80%      | {'PASS' if results['audit4_recovery']['passed'] else 'FAIL'}     |")

    print("\n" + "=" * 60)
    if all_pass:
        print("MILESTONE M3.5: BC STRESS CERTIFIED")
        print("Ready for Sprint 5: PPO V2")
    else:
        print("BC STRESS CERTIFICATION: FAILED")
        print("Fix issues before PPO V2")
    print("=" * 60)

    results["all_pass"] = all_pass

    return results


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Sprint 4.5: BC Stress Certification")
    parser.add_argument("--model", type=str, default="checkpoints/bc_policy_v3_sprint4.pt")
    parser.add_argument("--v2", action="store_true", help="Use V2 model with load_ratio")

    args = parser.parse_args()

    result = run_sprint45(bc_model_path=args.model, use_v2=args.v2)

    sys.exit(0 if result["all_pass"] else 1)


if __name__ == "__main__":
    main()
