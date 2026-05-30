# -*- coding: utf-8 -*-
"""
Direct state manipulation recovery collection
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


def run_fixed_state_episode(
    initial_workers: int,
    initial_queue: int,
    arrival_rate: float,
    burst_prob: float,
    duration: int,
    seed: int = None,
) -> List[Dict]:
    """运行固定状态 episode"""
    if seed is not None:
        np.random.seed(seed)
        random.seed(seed)

    env = RuntimeEnvFactory.create(
        arrival_rate=arrival_rate,
        burst_prob=burst_prob,
        duration=duration,
    )

    # 直接设置状态，不调用 reset
    env.simulator.state.worker_count = initial_workers
    env.simulator.state.queue_depth = initial_queue
    env.simulator._tick_count = 0

    timeline = []

    warmup_ticks = 5

    for tick in range(duration):
        state = env.simulator.state
        queue_depth = state.queue_depth
        worker_count = state.worker_count
        cpu_usage = state.cpu_usage

        # 手动策略
        zone = get_zone(queue_depth, worker_count)

        if zone == "E":
            action = 4  # expand2
        elif zone == "D":
            action = 3  # expand1
        elif zone == "C":
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
            }
            timeline.append(entry)

        # 如果系统收敛到 Zone A，重置到目标状态
        if zone == "A" and tick > 100:
            env.simulator.state.worker_count = initial_workers
            env.simulator.state.queue_depth = initial_queue

        if done:
            break

    return timeline


def main():
    """收集固定状态 recovery 数据"""
    print("=" * 60)
    print("Fixed State Recovery Collection")
    print("=" * 60)

    scenarios = [
        # E zone recovery (workers=50, queue=300+)
        {"workers": 50, "queue": 300, "arrival": 8.0, "burst": 0.2, "episodes": 10},
        {"workers": 40, "queue": 400, "arrival": 8.0, "burst": 0.2, "episodes": 10},
        {"workers": 30, "queue": 500, "arrival": 8.0, "burst": 0.2, "episodes": 10},

        # D zone recovery (workers=80, queue=200)
        {"workers": 80, "queue": 200, "arrival": 5.0, "burst": 0.15, "episodes": 8},
        {"workers": 70, "queue": 250, "arrival": 5.0, "burst": 0.15, "episodes": 8},

        # C zone recovery (workers=100, queue=100)
        {"workers": 100, "queue": 100, "arrival": 3.0, "burst": 0.1, "episodes": 6},
        {"workers": 90, "queue": 120, "arrival": 3.0, "burst": 0.1, "episodes": 6},
    ]

    all_entries = []

    for scenario in scenarios:
        name = f"fixed_{scenario['workers']}_{scenario['queue']}"
        print(f"\n[{name}] workers={scenario['workers']}, queue={scenario['queue']}")

        for ep in range(scenario["episodes"]):
            seed = abs(hash(name + str(ep))) % (2**31)

            timeline = run_fixed_state_episode(
                initial_workers=scenario["workers"],
                initial_queue=scenario["queue"],
                arrival_rate=scenario["arrival"],
                burst_prob=scenario["burst"],
                duration=2000,
                seed=seed,
            )

            for entry in timeline:
                entry["episode"] = ep
                entry["scenario"] = name
                all_entries.append(entry)

        print(f"  Episodes {scenario['episodes']}: {scenario['episodes'] * 1995} entries")

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
    crisis_keys = ["D->E", "C->E", "B->E", "A->E"]

    print(f"\n{'='*60}")
    print("Transition Distribution")
    print("="*60)

    print("\nRecovery transitions:")
    recovery_total = 0
    for key in recovery_keys:
        count = transitions.get(key, 0)
        ratio = count / total if total > 0 else 0
        recovery_total += count
        print(f"  {key}: {count:,} ({ratio:.1%})")
    print(f"  Total: {recovery_total:,} ({recovery_total/total:.1%})")

    print("\nCrisis transitions:")
    crisis_total = 0
    for key in crisis_keys:
        count = transitions.get(key, 0)
        ratio = count / total if total > 0 else 0
        crisis_total += count
        print(f"  {key}: {count:,} ({ratio:.1%})")
    print(f"  Total: {crisis_total:,} ({crisis_total/total:.1%})")

    # Zone 分布
    zone_counter = Counter(e["zone"] for e in all_entries)
    print("\nZone distribution:")
    for zone in ["A", "B", "C", "D", "E"]:
        count = zone_counter.get(zone, 0)
        ratio = count / len(all_entries) if len(all_entries) > 0 else 0
        print(f"  Zone {zone}: {count:,} ({ratio:.1%})")

    # 保存
    output_path = "datasets/timeline_v3_1_fixed_recovery.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in all_entries:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(all_entries):,} entries to: {output_path}")


if __name__ == "__main__":
    main()
