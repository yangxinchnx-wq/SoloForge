# -*- coding: utf-8 -*-
"""
Debug Teacher V4 behavior
"""

import sys
import os
sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))
sys.path.insert(0, python_dir)

from governor_rl.training.simulator.teacher_v4 import TeacherV4
from governor_rl.env import RuntimeEnvFactory

def debug_teacher_v4():
    """Debug Teacher V4 with specific scenarios"""

    scenarios = [
        {"name": "zone_a", "arrival_rate": 5.0, "burst_prob": 0.05},
        {"name": "zone_b", "arrival_rate": 15.0, "burst_prob": 0.05},
        {"name": "zone_c", "arrival_rate": 35.0, "burst_prob": 0.05},
    ]

    for scenario in scenarios:
        print(f"\n{'='*60}")
        print(f"Scenario: {scenario['name']} (arrival={scenario['arrival_rate']})")
        print("="*60)

        env = RuntimeEnvFactory.create(
            arrival_rate=scenario["arrival_rate"],
            burst_prob=scenario["burst_prob"],
            duration=100,
        )
        env.reset()

        teacher = TeacherV4()

        # 记录前 30 ticks
        print(f"\n{'Tick':<6} {'Queue':<8} {'Workers':<8} {'LoadRatio':<10} {'Action':<8} {'Zone'}")
        print("-"*60)

        for tick in range(30):
            state = env.simulator.state
            queue_depth = state.queue_depth
            worker_count = state.worker_count

            # 计算 load_ratio
            capacity = worker_count * 2
            load_ratio = queue_depth / max(1, capacity)

            # Teacher 决策
            action = teacher.decide(queue_depth=queue_depth, worker_count=worker_count)

            # Zone
            if queue_depth <= 20:
                zone = "A"
            elif queue_depth <= 100:
                zone = "B"
            elif queue_depth <= 500:
                zone = "C"
            elif queue_depth <= 2000:
                zone = "D"
            else:
                zone = "E"

            # 期望动作
            if zone == "A":
                expected = "shrink2"
            elif zone == "B":
                expected = "shrink1"
            elif zone == "C":
                expected = "noop"
            elif zone == "D":
                expected = "expand1"
            else:
                expected = "expand2"

            # 动作名称
            action_names = {-2: "shrink2", -1: "shrink1", 0: "noop", 1: "expand1", 2: "expand2"}

            match = "✅" if action_names.get(action, "?") == expected else "❌"

            print(f"{tick:<6} {queue_depth:<8} {worker_count:<8} {load_ratio:<10.4f} {action_names[action]:<8} {zone} {match}")

            # 执行动作
            env.step(action)

if __name__ == "__main__":
    debug_teacher_v4()
