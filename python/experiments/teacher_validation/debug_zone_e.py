# -*- coding: utf-8 -*-
"""
Debug Zone E coverage
"""

import sys
import os
sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.training.simulator.teacher_v4 import TeacherV4
from governor_rl.env import RuntimeEnvFactory


def debug_zone_e_scenario():
    """Debug Zone E scenario"""

    print("=" * 60)
    print("Zone E Crisis Debug")
    print("=" * 60)

    env = RuntimeEnvFactory.create(
        arrival_rate=30.0,
        burst_prob=0.7,
        duration=500,
    )
    env.reset()

    teacher = TeacherV4()

    max_queue = 0
    max_load_ratio = 0
    zone_counts = {"A": 0, "B": 0, "C": 0, "D": 0, "E": 0}

    for tick in range(500):
        state = env.simulator.state
        queue_depth = state.queue_depth
        worker_count = state.worker_count

        # 计算 load_ratio
        capacity = worker_count * 2
        load_ratio = queue_depth / max(1, capacity)

        # Zone
        if load_ratio < 0.1:
            zone = "A"
        elif load_ratio < 0.25:
            zone = "B"
        elif load_ratio < 0.5:
            zone = "C"
        elif load_ratio < 1.0:
            zone = "D"
        else:
            zone = "E"

        zone_counts[zone] += 1
        max_queue = max(max_queue, queue_depth)
        max_load_ratio = max(max_load_ratio, load_ratio)

        # 每 50 tick 打印一次
        if tick % 50 == 0:
            print(f"Tick {tick}: queue={queue_depth}, workers={worker_count}, lr={load_ratio:.3f}, zone={zone}")

        # Teacher 决策
        action_value = teacher.decide(queue_depth=queue_depth, worker_count=worker_count)

        # 转换为 action_index
        ACTION_VALUE_TO_INDEX = {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4}
        action_index = ACTION_VALUE_TO_INDEX[action_value]

        # 执行动作
        env.step(action_index)

    print(f"\nMax queue: {max_queue}")
    print(f"Max load_ratio: {max_load_ratio:.3f}")
    print(f"Zone distribution: {zone_counts}")


if __name__ == "__main__":
    debug_zone_e_scenario()
