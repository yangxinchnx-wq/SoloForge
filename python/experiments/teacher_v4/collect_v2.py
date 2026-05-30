# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Timeline V2 Collection
# Path: experiments/teacher_v4/collect_v2.py
#
# Sprint 2C: 使用 Teacher V4 收集 Timeline V2
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import numpy as np
from typing import List, Dict
from collections import Counter
from dataclasses import dataclass

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))
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

ACTION_NAMES = {
    0: "shrink2",
    1: "shrink1",
    2: "noop",
    3: "expand1",
    4: "expand2",
}


@dataclass
class TimelineEntry:
    """Timeline 条目"""
    tick: int
    queue_depth: int
    worker_count: int
    cpu_usage: float
    action_index: int
    action_value: int
    regime: str


def run_teacher_v4_episode(
    arrival_rate: float = 15.0,
    burst_prob: float = 0.15,
    duration: int = 5000,
    seed: int = None,
) -> List[TimelineEntry]:
    """
    运行 Teacher V4 单个 episode

    Returns:
        List[TimelineEntry]
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

    obs, _ = env.reset()
    timeline = []

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

        # 执行动作
        # 将 action index 转换为 action value
        index_to_value = {0: -2, 1: -1, 2: 0, 3: 1, 4: 2}
        env_action = index_to_value.get(action_index, 0)

        next_obs, _, done, _, info = env.step(env_action)

        # 记录
        entry = TimelineEntry(
            tick=tick,
            queue_depth=queue_depth,
            worker_count=worker_count,
            cpu_usage=cpu_usage,
            action_index=action_index,
            action_value=action_value,
            regime="balanced",  # Teacher V4 不输出 regime
        )
        timeline.append(entry)

        obs = next_obs
        if done:
            break

    return timeline, teacher


def collect_timeline_v2(
    output_path: str = "datasets/timeline_v2.jsonl",
    scenarios: List[Dict] = None,
    episodes_per_scenario: int = 3,
) -> Dict:
    """
    收集 Timeline V2

    Returns:
        统计结果
    """
    if scenarios is None:
        # Sprint 2E: Zone-Coverage Scenarios (Reduced burst for stability)
        scenarios = [
            # Zone A (queue <= 20) - 极低负载
            {"name": "zone_a_under_utilized", "arrival_rate": 3.0, "burst_prob": 0.05},
            {"name": "zone_a_light", "arrival_rate": 5.0, "burst_prob": 0.05},
            # Zone B (20 < queue <= 100) - 低负载
            {"name": "zone_b_light", "arrival_rate": 15.0, "burst_prob": 0.05},
            {"name": "zone_b_oscillating", "arrival_rate": 20.0, "burst_prob": 0.10},
            # Zone C (100 < queue <= 500) - 中等负载
            {"name": "zone_c_balanced", "arrival_rate": 35.0, "burst_prob": 0.05},
            {"name": "zone_c_stressed", "arrival_rate": 45.0, "burst_prob": 0.05},
            # Zone D (500 < queue <= 2000) - 高负载
            {"name": "zone_d_heavy", "arrival_rate": 60.0, "burst_prob": 0.05},
            {"name": "zone_d_burst", "arrival_rate": 55.0, "burst_prob": 0.10},
            # Zone E (queue > 2000) - 危机负载
            {"name": "zone_e_crisis", "arrival_rate": 80.0, "burst_prob": 0.10},
            {"name": "zone_e_saturation", "arrival_rate": 70.0, "burst_prob": 0.15},
        ]

    print("=" * 60)
    print("Timeline V2 Collection (Teacher V4)")
    print("=" * 60)

    all_entries = []
    scenario_stats = {}

    for scenario in scenarios:
        print(f"\n[{scenario['name']}] arrival_rate={scenario['arrival_rate']}, burst_prob={scenario['burst_prob']}")

        scenario_entries = []
        scenario_action_counter = Counter()
        scenario_zone_counter = Counter()

        for ep in range(episodes_per_scenario):
            seed = abs(hash(scenario["name"])) % (2**31) + ep * 100

            timeline, teacher = run_teacher_v4_episode(
                arrival_rate=scenario["arrival_rate"],
                burst_prob=scenario["burst_prob"],
                duration=5000,
                seed=seed,
            )

            # 转换为 dict
            for entry in timeline:
                entry_dict = {
                    "tick": entry.tick,
                    "queue_depth": entry.queue_depth,
                    "worker_count": entry.worker_count,
                    "cpu_usage": entry.cpu_usage,
                    "action_index": entry.action_index,
                    "action_value": entry.action_value,
                    "scenario": scenario["name"],
                    "episode": ep,
                }
                all_entries.append(entry_dict)
                scenario_entries.append(entry_dict)

                scenario_action_counter[entry.action_index] += 1

            print(f"  Episode {ep}: {len(timeline)} entries")

        # Scenario 统计
        total = len(scenario_entries)
        scenario_stats[scenario["name"]] = {
            "total": total,
            "action_distribution": {
                ACTION_NAMES[idx]: {
                    "count": count,
                    "ratio": count / total if total > 0 else 0,
                }
                for idx, count in scenario_action_counter.items()
            },
        }

    # 总统计
    total_entries = len(all_entries)
    overall_action_counter = Counter(e["action_index"] for e in all_entries)

    print("\n" + "=" * 60)
    print("Overall Action Distribution")
    print("=" * 60)

    overall_distribution = {}
    for idx in range(5):
        count = overall_action_counter.get(idx, 0)
        ratio = count / total_entries if total_entries > 0 else 0
        overall_distribution[ACTION_NAMES[idx]] = {
            "count": count,
            "ratio": ratio,
        }
        status = "✅" if count > 0 else "❌ MISSING"
        print(f"  {ACTION_NAMES[idx]:<8}: {count:>6} ({ratio:>6.1%}) {status}")

    # 保存
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in all_entries:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {total_entries} entries to: {output_path}")

    # 生成热力图数据
    heatmap_data = generate_heatmap_data(all_entries)

    return {
        "total_entries": total_entries,
        "overall_distribution": overall_distribution,
        "scenario_stats": scenario_stats,
        "heatmap_data": heatmap_data,
    }


def generate_heatmap_data(entries: List[Dict]) -> Dict:
    """生成 queue vs action 热力图数据"""
    # Queue 分桶
    queue_buckets = {
        "0-20": [],
        "20-100": [],
        "100-500": [],
        "500-2000": [],
        "2000+": [],
    }

    for entry in entries:
        q = entry["queue_depth"]
        a = entry["action_index"]

        if q <= 20:
            queue_buckets["0-20"].append(a)
        elif q <= 100:
            queue_buckets["20-100"].append(a)
        elif q <= 500:
            queue_buckets["100-500"].append(a)
        elif q <= 2000:
            queue_buckets["500-2000"].append(a)
        else:
            queue_buckets["2000+"].append(a)

    # 转换为分布
    heatmap = {}
    for bucket_name, actions in queue_buckets.items():
        counter = Counter(actions)
        total = len(actions)
        heatmap[bucket_name] = {
            ACTION_NAMES[idx]: counter.get(idx, 0) / total if total > 0 else 0
            for idx in range(5)
        }

    return heatmap


def print_heatmap(heatmap_data: Dict):
    """打印热力图"""
    print("\n" + "=" * 60)
    print("Queue vs Action Heatmap")
    print("=" * 60)
    print("-" * 70)
    print(f"{'Queue':<12} {'shrink2':>10} {'shrink1':>10} {'noop':>10} {'expand1':>10} {'expand2':>10}")
    print("-" * 70)

    for queue_range in ["0-20", "20-100", "100-500", "500-2000", "2000+"]:
        if queue_range in heatmap_data:
            dist = heatmap_data[queue_range]
            s2 = dist.get("shrink2", 0)
            s1 = dist.get("shrink1", 0)
            n = dist.get("noop", 0)
            e1 = dist.get("expand1", 0)
            e2 = dist.get("expand2", 0)
            print(f"{queue_range:<12} {s2:>9.1%} {s1:>9.1%} {n:>9.1%} {e1:>9.1%} {e2:>9.1%}")


def validate_timeline_v2(stats: Dict) -> Dict:
    """验证 Timeline V2"""
    print("\n" + "=" * 60)
    print("Timeline V2 Validation")
    print("=" * 60)

    dist = stats["overall_distribution"]

    # 检查所有动作都出现
    missing_actions = []
    for action_name in ["shrink2", "shrink1", "noop", "expand1", "expand2"]:
        if dist.get(action_name, {}).get("count", 0) == 0:
            missing_actions.append(action_name)

    # 目标分布
    target_ranges = {
        "shrink2": (0.05, 0.15),
        "shrink1": (0.10, 0.20),
        "noop": (0.30, 0.50),
        "expand1": (0.10, 0.20),
        "expand2": (0.05, 0.15),
    }

    in_range = []
    out_range = []
    for action_name, (min_ratio, max_ratio) in target_ranges.items():
        ratio = dist.get(action_name, {}).get("ratio", 0)
        if min_ratio <= ratio <= max_ratio:
            in_range.append(action_name)
        else:
            out_range.append((action_name, ratio, min_ratio, max_ratio))

    checks = {
        "all_actions_present": len(missing_actions) == 0,
        "distribution_in_range": len(out_range) == 0,
    }

    print(f"\nAll 5 actions present: {'✅ YES' if checks['all_actions_present'] else '❌ NO'}")
    if missing_actions:
        print(f"  Missing: {missing_actions}")

    print(f"\nDistribution in target range: {'✅ YES' if checks['distribution_in_range'] else '⚠️ PARTIAL'}")
    for action_name, ratio, min_r, max_r in out_range:
        print(f"  {action_name}: {ratio:.1%} (target: {min_r:.0%}-{max_r:.0%})")

    all_pass = checks["all_actions_present"]

    print("\n" + "=" * 60)
    if all_pass:
        print("✅ Timeline V2 VALIDATION PASSED")
        print("Teacher V4 is ready for BC/PPO training")
    else:
        print("❌ Timeline V2 VALIDATION FAILED")
        print("Teacher V4 needs adjustment")
    print("=" * 60)

    return checks


def main():
    """主函数"""
    # 收集 Timeline V2
    stats = collect_timeline_v2(
        output_path="datasets/timeline_v2.jsonl",
        episodes_per_scenario=3,
    )

    # 打印热力图
    print_heatmap(stats["heatmap_data"])

    # 验证
    checks = validate_timeline_v2(stats)

    # 保存完整报告
    report = {
        "timestamp": "2026-05-30",
        "stats": {
            "total_entries": stats["total_entries"],
            "overall_distribution": stats["overall_distribution"],
        },
        "heatmap_data": stats["heatmap_data"],
        "validation": {
            "all_actions_present": checks["all_actions_present"],
            "distribution_in_range": checks["distribution_in_range"],
        },
    }

    report_path = "experiments/teacher_v4/timeline_v2_report.json"
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\nReport saved: {report_path}")


if __name__ == "__main__":
    main()
