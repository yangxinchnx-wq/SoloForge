# -*- coding: utf-8 -*-
"""
Manual recovery data collection
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


def run_manual_recovery(
    start_zone: str,
    start_workers: int,
    start_queue: int,
    arrival_rate: float,
    burst_prob: float,
    duration: int,
    seed: int = None,
) -> List[Dict]:
    """运行手动控制的 recovery episode"""
    if seed is not None:
        np.random.seed(seed)
        random.seed(seed)

    env = RuntimeEnvFactory.create(
        arrival_rate=arrival_rate,
        burst_prob=burst_prob,
        duration=duration,
    )

    obs, _ = env.reset(seed=seed if seed else None)

    # 设置初始状态
    env.simulator.state.worker_count = start_workers
    env.simulator.state.queue_depth = start_queue

    timeline = []

    warmup_ticks = 5

    for tick in range(duration):
        state = env.simulator.state
        queue_depth = state.queue_depth
        worker_count = state.worker_count
        cpu_usage = state.cpu_usage

        # 手动策略：基于当前 zone 决定动作
        zone = get_zone(queue_depth, worker_count)

        if zone == "E":
            action = 4  # expand2
        elif zone == "D":
            action = 3  # expand1
        elif zone == "C":
            action = 2  # noop
        elif zone == "B":
            action = 2  # noop
        else:
            action = 2  # noop

        next_obs, _, done, _, info = env.step(action)

        if tick >= warmup_ticks:
            zone = get_zone(queue_depth, worker_count)
            bucket = get_worker_bucket(worker_count)

            entry = {
                "tick": tick,
                "queue_depth": queue_depth,
                "worker_count": worker_count,
                "cpu_usage": cpu_usage,
                "action_index": action,
                "action_value": action - 2,
                "zone": zone,
                "worker_bucket": bucket,
                "scenario": f"manual_recovery_{start_zone}",
            }
            timeline.append(entry)

        obs = next_obs
        if done:
            break

    return timeline


def main():
    """收集手动 recovery 数据"""
    print("=" * 60)
    print("Manual Recovery Data Collection")
    print("=" * 60)

    scenarios = [
        # E -> D -> C recovery
        {"zone": "E", "workers": 50, "queue": 300, "arrival": 5.0, "burst": 0.1, "episodes": 5},
        {"zone": "E", "workers": 40, "queue": 400, "arrival": 5.0, "burst": 0.1, "episodes": 5},
        {"zone": "E", "workers": 30, "queue": 500, "arrival": 5.0, "burst": 0.1, "episodes": 5},

        # D -> C recovery
        {"zone": "D", "workers": 80, "queue": 200, "arrival": 3.0, "burst": 0.1, "episodes": 4},
        {"zone": "D", "workers": 70, "queue": 250, "arrival": 3.0, "burst": 0.1, "episodes": 4},

        # C -> B recovery
        {"zone": "C", "workers": 100, "queue": 100, "arrival": 2.0, "burst": 0.05, "episodes": 3},
        {"zone": "C", "workers": 90, "queue": 120, "arrival": 2.0, "burst": 0.05, "episodes": 3},
    ]

    all_entries = []

    for scenario in scenarios:
        name = f"manual_{scenario['zone']}_{scenario['workers']}"
        print(f"\n[{name}] zone={scenario['zone']}, workers={scenario['workers']}, queue={scenario['queue']}")

        for ep in range(scenario["episodes"]):
            seed = abs(hash(name + str(ep))) % (2**31)

            timeline = run_manual_recovery(
                start_zone=scenario["zone"],
                start_workers=scenario["workers"],
                start_queue=scenario["queue"],
                arrival_rate=scenario["arrival"],
                burst_prob=scenario["burst"],
                duration=3000,
                seed=seed,
            )

            for entry in timeline:
                entry["episode"] = ep
                all_entries.append(entry)

        print(f"  Episodes {scenario['episodes']}: {scenario['episodes'] * 2995} entries")

    # 分析转移
    transitions = Counter()
    prev_zone = None
    for entry in all_entries:
        zone = entry["zone"]
        if prev_zone is not None:
            key = f"{prev_zone}->{zone}"
            transitions[key] += 1
        prev_zone = zone

    total = sum(transitions.values())
    recovery_keys = ["E->D", "D->C", "C->B", "B->A"]

    print(f"\n{'='*60}")
    print("Transition Distribution")
    print("="*60)
    print(f"Total transitions: {total:,}")

    recovery_total = 0
    for key in ["E->E", "D->D", "C->C", "B->B", "A->A"]:
        count = transitions.get(key, 0)
        ratio = count / total if total > 0 else 0
        print(f"  {key}: {count:,} ({ratio:.1%})")

    print("\nRecovery transitions:")
    for key in recovery_keys:
        count = transitions.get(key, 0)
        ratio = count / total if total > 0 else 0
        recovery_total += count
        print(f"  {key}: {count:,} ({ratio:.1%})")

    print(f"\nTotal Recovery: {recovery_total:,} ({recovery_total/total:.1%})")

    # 保存
    output_path = "datasets/timeline_v3_1_manual_recovery.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in all_entries:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(all_entries):,} entries to: {output_path}")


if __name__ == "__main__":
    main()
