# -*- coding: utf-8 -*-
"""
Final Timeline V3.1 Collection with Teacher V4
"""

import sys
import os
import json
import random
import numpy as np
from collections import Counter
from typing import List, Dict

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.training.simulator.teacher_v4 import TeacherV4
from governor_rl.env import RuntimeEnvFactory


def get_zone(queue_depth: int, worker_count: int = 200) -> str:
    """获取 Zone (基于 load_ratio)"""
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


def get_worker_bucket(worker_count: int) -> str:
    """获取 worker bucket"""
    if worker_count <= 20:
        return "1-20"
    elif worker_count <= 50:
        return "20-50"
    elif worker_count <= 100:
        return "50-100"
    elif worker_count <= 200:
        return "100-200"
    else:
        return "200+"


# Action mapping
ACTION_VALUE_TO_INDEX = {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4}


def run_episode(
    arrival_rate: float,
    burst_prob: float,
    duration: int,
    seed: int = None,
    initial_workers: int = 200,
) -> List[Dict]:
    """运行 episode"""
    if seed is not None:
        np.random.seed(seed)
        random.seed(seed)

    env = RuntimeEnvFactory.create(
        arrival_rate=arrival_rate,
        burst_prob=burst_prob,
        duration=duration,
    )

    # 设置初始 worker count
    env.simulator.state.worker_count = initial_workers

    # 创建 Teacher V4
    teacher = TeacherV4()

    obs, _ = env.reset(seed=seed if seed else None)
    timeline = []

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
        action_index = ACTION_VALUE_TO_INDEX[action_value]

        # 执行动作
        next_obs, _, done, _, info = env.step(action_index)

        # 跳过 warmup
        if tick >= warmup_ticks:
            zone = get_zone(queue_depth, worker_count)
            bucket = get_worker_bucket(worker_count)

            entry = {
                "tick": tick,
                "queue_depth": queue_depth,
                "worker_count": worker_count,
                "cpu_usage": cpu_usage,
                "action_index": action_index,
                "action_value": action_value,
                "zone": zone,
                "worker_bucket": bucket,
            }
            timeline.append(entry)

        obs = next_obs
        if done:
            break

    return timeline


def collect():
    """收集数据"""
    print("=" * 60)
    print("Final Timeline V3.1 Collection")
    print("=" * 60)

    # 场景配置 - 专注于平衡覆盖
    scenarios = [
        # Zone A (低负载)
        {"name": "zone_a_idle", "arrival": 0.5, "burst": 0.0, "workers": 100, "episodes": 3},

        # Zone B (轻负载)
        {"name": "zone_b_light", "arrival": 2.0, "burst": 0.05, "workers": 80, "episodes": 5},
        {"name": "zone_b_moderate", "arrival": 3.0, "burst": 0.1, "workers": 100, "episodes": 5},

        # Zone C (中负载)
        {"name": "zone_c_balanced", "arrival": 5.0, "burst": 0.1, "workers": 100, "episodes": 5},
        {"name": "zone_c_stressed", "arrival": 8.0, "burst": 0.15, "workers": 120, "episodes": 5},

        # Zone D (高负载)
        {"name": "zone_d_heavy", "arrival": 15.0, "burst": 0.2, "workers": 150, "episodes": 5},
        {"name": "zone_d_stress", "arrival": 20.0, "burst": 0.3, "workers": 180, "episodes": 5},

        # Zone E (危机负载)
        {"name": "zone_e_crisis", "arrival": 30.0, "burst": 0.5, "workers": 200, "episodes": 8},
        {"name": "zone_e_overload", "arrival": 40.0, "burst": 0.6, "workers": 250, "episodes": 8},

        # High worker count scenarios
        {"name": "high_worker_1", "arrival": 5.0, "burst": 0.0, "workers": 200, "episodes": 3},
        {"name": "high_worker_2", "arrival": 8.0, "burst": 0.1, "workers": 250, "episodes": 3},
        {"name": "high_worker_3", "arrival": 10.0, "burst": 0.15, "workers": 300, "episodes": 3},
    ]

    all_entries = []

    for scenario in scenarios:
        print(f"\n[{scenario['name']}] arrival={scenario['arrival']}, burst={scenario['burst']}, workers={scenario['workers']}")

        for ep in range(scenario["episodes"]):
            seed = abs(hash(scenario["name"] + str(ep))) % (2**31)

            timeline = run_episode(
                arrival_rate=scenario["arrival"],
                burst_prob=scenario["burst"],
                duration=2000,
                seed=seed,
                initial_workers=scenario["workers"],
            )

            for entry in timeline:
                entry["scenario"] = scenario["name"]
                entry["episode"] = ep
                all_entries.append(entry)

        print(f"  Episodes {scenario['episodes']}: {scenario['episodes'] * 1980} entries")

    # 分析
    action_counter = Counter(e["action_index"] for e in all_entries)
    zone_counter = Counter(e["zone"] for e in all_entries)
    bucket_counter = Counter(e["worker_bucket"] for e in all_entries)

    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}

    print(f"\n{'='*60}")
    print("Distribution Summary")
    print("="*60)

    print("\nAction Distribution:")
    max_action = 0
    for action_id in range(5):
        count = action_counter.get(action_id, 0)
        ratio = count / len(all_entries)
        max_action = max(max_action, ratio)
        status = "✅" if ratio <= 0.40 else "❌"
        print(f"  {ACTION_NAMES[action_id]:<8}: {count:,} ({ratio:.1%}) {status}")
    print(f"  Max: {max_action:.1%}")

    print("\nZone Distribution:")
    for zone in ["A", "B", "C", "D", "E"]:
        count = zone_counter.get(zone, 0)
        ratio = count / len(all_entries)
        status = "✅" if ratio >= 0.05 else "❌"
        print(f"  Zone {zone}: {count:,} ({ratio:.1%}) {status}")

    print("\nWorker Bucket Distribution:")
    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        count = bucket_counter.get(bucket, 0)
        ratio = count / len(all_entries)
        status = "✅" if ratio >= 0.05 else "❌"
        print(f"  {bucket:<8}: {count:,} ({ratio:.1%}) {status}")

    # 保存
    output_path = "datasets/timeline_v3_1.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in all_entries:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(all_entries):,} entries to: {output_path}")

    return {
        "total": len(all_entries),
        "max_action_ratio": max_action,
    }


if __name__ == "__main__":
    result = collect()
