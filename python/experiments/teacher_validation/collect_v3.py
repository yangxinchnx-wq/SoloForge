# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Timeline V3 Collection
# Path: experiments/teacher_validation/collect_v3.py
#
# Sprint 3.5: Timeline V3 Rebuild with Fixed Teacher V4
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import numpy as np
from typing import List, Dict
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.training.simulator.teacher_v4 import TeacherV4
from governor_rl.env import RuntimeEnvFactory


# Action 映射
ACTION_TO_INDEX = {
    -2: 0,  # shrink2
    -1: 1,  # shrink1
    0: 2,   # noop
    +1: 3,  # expand1
    +2: 4,  # expand2
}

ACTION_INDEX_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}


# Zone 定义 (基于 load_ratio)
def get_zone(queue_depth: int, worker_count: int = 200) -> str:
    capacity = worker_count * 2
    load_ratio = queue_depth / max(1, capacity)

    if load_ratio < 0.1:
        return "A"
    elif load_ratio < 0.25:
        return "B"
    elif load_ratio < 0.5:
        return "C"
    elif load_ratio < 1.0:
        return "D"
    else:
        return "E"


# 期望的 Zone→Action 映射 (与 Teacher V4 策略一致)
EXPECTED_ZONE_ACTION = {
    "A": -2,  # Zone A → shrink2
    "B": -1,  # Zone B → shrink1
    "C": 0,   # Zone C → noop
    "D": 1,   # Zone D → expand1
    "E": 2,   # Zone E → expand2
}


def run_episode(
    arrival_rate: float,
    burst_prob: float,
    duration: int,
    seed: int = None,
    target_zone: str = None,
) -> List[Dict]:
    """
    运行单个 episode

    Args:
        arrival_rate: 到达率
        burst_prob: burst 概率
        duration: 持续时间
        seed: 随机种子
        target_zone: 目标 Zone (用于统计)
    """
    if seed is not None:
        np.random.seed(seed)

    # 创建环境
    env = RuntimeEnvFactory.create(
        arrival_rate=arrival_rate,
        burst_prob=burst_prob,
        duration=duration,
    )

    # 创建 Teacher V4
    teacher = TeacherV4()

    obs, _ = env.reset(seed=seed if seed else None)
    timeline = []

    # 跳过初始的 warmup tick
    warmup_ticks = 20

    for tick in range(duration):
        # 获取当前状态
        state = env.simulator.state
        queue_depth = state.queue_depth
        worker_count = state.worker_count
        cpu_usage = state.cpu_usage

        # Teacher V4 决策
        action_value = teacher.decide(
            queue_depth=queue_depth,
            worker_count=worker_count,
        )
        action_index = ACTION_TO_INDEX[action_value]

        # 执行动作 (env.step 期望 action_index)
        next_obs, _, done, _, info = env.step(action_index)

        # 跳过 warmup
        if tick >= warmup_ticks:
            # Zone (基于 Teacher 决策时的状态)
            zone = get_zone(queue_depth, worker_count)

            entry = {
                "tick": tick,
                "queue_depth": queue_depth,  # 决策时的状态
                "worker_count": worker_count,  # 决策时的状态
                "cpu_usage": cpu_usage,
                "action_index": action_index,
                "action_value": action_value,
                "zone": zone,
                "expected_action": EXPECTED_ZONE_ACTION[zone],
                "correct": action_value == EXPECTED_ZONE_ACTION[zone],
            }
            timeline.append(entry)

        obs = next_obs
        if done:
            break

    return timeline, teacher


def collect_timeline_v3(
    output_path: str = "datasets/timeline_v3.jsonl",
    episodes_per_scenario: int = 10,  # 增加 episodes
) -> Dict:
    """
    收集 Timeline V3

    场景设计：确保覆盖所有 5 个 Zone
    """
    # Sprint 3.5: Zone-Coverage Scenarios
    # 每个场景专注覆盖一个 Zone
    # Zone 边界: A(q<=10), B(10<q<=30), C(30<q<=100), D(100<q<=300), E(q>300)
    scenarios = [
        # Zone A (queue <= 10) - 极低负载
        {"name": "zone_a_idle", "arrival_rate": 0.5, "burst_prob": 0.0, "target_zone": "A"},

        # Zone B (10 < q <= 30) - 低负载
        {"name": "zone_b_light", "arrival_rate": 2.0, "burst_prob": 0.0, "target_zone": "B"},

        # Zone C (30 < q <= 100) - 中等负载
        {"name": "zone_c_balanced", "arrival_rate": 5.0, "burst_prob": 0.1, "target_zone": "C"},

        # Zone D (100 < q <= 300) - 高负载
        {"name": "zone_d_heavy", "arrival_rate": 10.0, "burst_prob": 0.2, "target_zone": "D"},

        # Zone E (q > 300) - 危机负载 (需要更高的 arrival_rate)
        {"name": "zone_e_crisis", "arrival_rate": 25.0, "burst_prob": 0.5, "target_zone": "E"},
        {"name": "zone_e_overload", "arrival_rate": 30.0, "burst_prob": 0.6, "target_zone": "E"},

        # 混合场景
        {"name": "steady_low", "arrival_rate": 1.0, "burst_prob": 0.05, "target_zone": "AB"},
        {"name": "steady_medium", "arrival_rate": 3.0, "burst_prob": 0.1, "target_zone": "BC"},
        {"name": "long_idle", "arrival_rate": 0.5, "burst_prob": 0.0, "target_zone": "A"},
        {"name": "gradual_growth", "arrival_rate": 2.0, "burst_prob": 0.1, "target_zone": "BC"},
        {"name": "burst_spike", "arrival_rate": 15.0, "burst_prob": 0.5, "target_zone": "DE"},
        {"name": "overload_spike", "arrival_rate": 30.0, "burst_prob": 0.7, "target_zone": "E"},
    ]

    print("=" * 60)
    print("Timeline V3 Collection (Teacher V4 - Fixed)")
    print("=" * 60)

    all_entries = []
    scenario_stats = {}

    for scenario in scenarios:
        print(f"\n[{scenario['name']}] arrival={scenario['arrival_rate']}, burst={scenario['burst_prob']}, target={scenario['target_zone']}")

        scenario_entries = []

        for ep in range(episodes_per_scenario):
            seed = abs(hash(scenario["name"] + str(ep))) % (2**31)

            timeline, teacher = run_episode(
                arrival_rate=scenario["arrival_rate"],
                burst_prob=scenario["burst_prob"],
                duration=2000,
                seed=seed,
            )

            for entry in timeline:
                entry["scenario"] = scenario["name"]
                entry["episode"] = ep
                all_entries.append(entry)
                scenario_entries.append(entry)

        print(f"  Episode {ep}: {len(timeline)} entries (total: {len(scenario_entries)})")

        # Scenario 统计
        zone_counter = Counter(e["zone"] for e in scenario_entries)
        action_counter = Counter(e["action_index"] for e in scenario_entries)
        correct = sum(1 for e in scenario_entries if e["correct"])

        scenario_stats[scenario["name"]] = {
            "entries": len(scenario_entries),
            "zones": dict(zone_counter),
            "actions": dict(action_counter),
            "accuracy": correct / len(scenario_entries) if scenario_entries else 0,
        }

    # 总统计
    total_entries = len(all_entries)
    overall_action_counter = Counter(e["action_index"] for e in all_entries)
    overall_zone_counter = Counter(e["zone"] for e in all_entries)
    overall_correct = sum(1 for e in all_entries if e["correct"])

    print("\n" + "=" * 60)
    print("Overall Action Distribution")
    print("=" * 60)

    overall_distribution = {}
    for idx in range(5):
        count = overall_action_counter.get(idx, 0)
        ratio = count / total_entries if total_entries > 0 else 0
        overall_distribution[ACTION_INDEX_NAMES[idx]] = {
            "count": count,
            "ratio": ratio,
        }
        status = "✅" if count > 0 else "❌ MISSING"
        print(f"  {ACTION_INDEX_NAMES[idx]:<8}: {count:>6} ({ratio:>6.1%}) {status}")

    print("\n" + "=" * 60)
    print("Overall Zone Distribution")
    print("=" * 60)

    for zone in ["A", "B", "C", "D", "E"]:
        count = overall_zone_counter.get(zone, 0)
        ratio = count / total_entries if total_entries > 0 else 0
        print(f"  Zone {zone}: {count:>6} ({ratio:>6.1%})")

    print(f"\nOverall Teacher Accuracy: {overall_correct}/{total_entries} ({overall_correct/total_entries*100:.1f}%)")

    # 保存
    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in all_entries:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {total_entries} entries to: {output_path}")

    return {
        "total_entries": total_entries,
        "overall_distribution": overall_distribution,
        "overall_zone_distribution": dict(overall_zone_counter),
        "scenario_stats": scenario_stats,
        "overall_accuracy": overall_correct / total_entries if total_entries > 0 else 0,
    }


def main():
    """主函数"""
    stats = collect_timeline_v3(
        output_path="datasets/timeline_v3.jsonl",
        episodes_per_scenario=5,
    )

    # 保存报告
    report_path = "experiments/teacher_validation/timeline_v3_report.json"
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)
    print(f"\nReport saved: {report_path}")


if __name__ == "__main__":
    main()
