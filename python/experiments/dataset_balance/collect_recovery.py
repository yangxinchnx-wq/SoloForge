# -*- coding: utf-8 -*-
"""
Collect recovery scenarios
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


def run_recovery_episode(
    start_zone: str,
    arrival_rate: float,
    burst_prob: float,
    duration: int,
    seed: int = None,
) -> List[Dict]:
    """运行 recovery episode"""
    if seed is not None:
        np.random.seed(seed)
        random.seed(seed)

    env = RuntimeEnvFactory.create(
        arrival_rate=arrival_rate,
        burst_prob=burst_prob,
        duration=duration,
    )

    obs, _ = env.reset(seed=seed if seed else None)

    # 设置初始状态到目标 zone
    if start_zone == "E":
        env.simulator.state.worker_count = 50  # 低 worker，高 queue
        env.simulator.state.queue_depth = 500
    elif start_zone == "D":
        env.simulator.state.worker_count = 80
        env.simulator.state.queue_depth = 200
    elif start_zone == "C":
        env.simulator.state.worker_count = 100
        env.simulator.state.queue_depth = 100
    else:
        env.simulator.state.worker_count = 150
        env.simulator.state.queue_depth = 30

    timeline = []

    warmup_ticks = 10

    for tick in range(duration):
        state = env.simulator.state
        queue_depth = state.queue_depth
        worker_count = state.worker_count
        cpu_usage = state.cpu_usage

        # Recovery 策略：温和扩容
        capacity = worker_count * 2
        load_ratio = queue_depth / max(1, capacity)

        if load_ratio < 0.3:
            action = 2  # noop
        elif load_ratio < 0.6:
            action = 3  # expand1
        else:
            action = 4  # expand2

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
                "scenario": f"recovery_{start_zone}",
            }
            timeline.append(entry)

        obs = next_obs
        if done:
            break

    return timeline


def main():
    """收集 recovery 数据"""
    print("=" * 60)
    print("Collecting Recovery Scenarios")
    print("=" * 60)

    scenarios = [
        # Recovery from Zone E
        {"zone": "E", "arrival_rate": 10.0, "burst_prob": 0.3, "episodes": 10},
        {"zone": "E", "arrival_rate": 15.0, "burst_prob": 0.4, "episodes": 10},

        # Recovery from Zone D
        {"zone": "D", "arrival_rate": 8.0, "burst_prob": 0.2, "episodes": 8},
        {"zone": "D", "arrival_rate": 10.0, "burst_prob": 0.3, "episodes": 8},

        # Recovery from Zone C
        {"zone": "C", "arrival_rate": 5.0, "burst_prob": 0.1, "episodes": 6},
        {"zone": "C", "arrival_rate": 8.0, "burst_prob": 0.2, "episodes": 6},

        # Recovery from Zone B
        {"zone": "B", "arrival_rate": 3.0, "burst_prob": 0.1, "episodes": 5},
        {"zone": "B", "arrival_rate": 5.0, "burst_prob": 0.15, "episodes": 5},
    ]

    all_entries = []

    for scenario in scenarios:
        name = f"recovery_{scenario['zone']}_{scenario['arrival_rate']}"
        print(f"\n[{name}] zone={scenario['zone']}, arrival={scenario['arrival_rate']}")

        for ep in range(scenario["episodes"]):
            seed = abs(hash(name + str(ep))) % (2**31)

            timeline = run_recovery_episode(
                start_zone=scenario["zone"],
                arrival_rate=scenario["arrival_rate"],
                burst_prob=scenario["burst_prob"],
                duration=2000,
                seed=seed,
            )

            for entry in timeline:
                entry["episode"] = ep
                all_entries.append(entry)

        print(f"  Episodes {scenario['episodes']}: {scenario['episodes'] * 1990} entries")

    # 分析 transition 分布
    transitions = Counter()
    prev_zone = None
    for entry in all_entries:
        zone = entry["zone"]
        if prev_zone is not None:
            key = f"{prev_zone}->{zone}"
            transitions[key] += 1
        prev_zone = zone

    total = len(transitions)
    recovery_transitions = ["E->D", "D->C", "C->B", "B->A"]
    recovery_count = sum(transitions.get(t, 0) for t in recovery_transitions)
    recovery_ratio = recovery_count / sum(transitions.values()) if sum(transitions.values()) > 0 else 0

    print(f"\n{'='*60}")
    print("Recovery Transition Distribution")
    print("="*60)
    for trans in recovery_transitions:
        count = transitions.get(trans, 0)
        ratio = count / sum(transitions.values()) if sum(transitions.values()) > 0 else 0
        print(f"  {trans}: {count:,} ({ratio:.1%})")

    print(f"\nTotal Recovery: {recovery_count:,} ({recovery_ratio:.1%})")

    # 保存
    output_path = "datasets/timeline_v3_1_recovery.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in all_entries:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(all_entries)} entries to: {output_path}")


if __name__ == "__main__":
    main()
