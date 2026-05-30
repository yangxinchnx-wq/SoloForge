# -*- coding: utf-8 -*-
"""
Debug Zone E Teacher behavior with cooldown
"""

import sys
import os
sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.training.simulator.teacher_v4 import TeacherV4
from governor_rl.env import RuntimeEnvFactory


def debug_zone_e():
    """Debug Teacher V4 in Zone E scenario"""

    print("=" * 60)
    print("Zone E Crisis - Debug Cooldown")
    print("=" * 60)

    env = RuntimeEnvFactory.create(
        arrival_rate=20.0,
        burst_prob=0.3,
        duration=100,
    )
    env.reset()

    teacher = TeacherV4()

    print(f"\n{'Tick':<6} {'Queue':<8} {'Workers':<8} {'Zone':<6} {'Action':<8} {'Reason'}")
    print("-" * 60)

    for tick in range(50):
        state = env.simulator.state
        queue_depth = state.queue_depth
        worker_count = state.worker_count

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

        # Teacher 决策 (返回 action_value)
        action_value = teacher.decide(queue_depth=queue_depth, worker_count=worker_count)

        # 转换为 action_index (0-4) for env.step()
        ACTION_VALUE_TO_INDEX = {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4}
        action_index = ACTION_VALUE_TO_INDEX[action_value]

        # 动作名称
        action_names = {-2: "shrink2", -1: "shrink1", 0: "noop", 1: "expand1", 2: "expand2"}
        action = action_value  # 使用 action_value 用于打印

        # 期望动作
        expected_actions = {"A": "shrink2", "B": "shrink1", "C": "noop", "D": "expand1", "E": "expand2"}
        expected = expected_actions[zone]
        match = "✅" if action_names[action_value] == expected else "❌"

        # Cooldown 状态
        ticks_since_expand = tick - teacher.last_expand_tick
        ticks_since_shrink = tick - teacher.last_shrink_tick

        reason = ""
        if action == 0:
            if ticks_since_expand < teacher.EXPAND_COOLDOWN:
                reason = f"expand_cooldown({ticks_since_expand}/{teacher.EXPAND_COOLDOWN})"
            elif ticks_since_shrink < teacher.SHRINK_COOLDOWN:
                reason = f"shrink_cooldown({ticks_since_shrink}/{teacher.SHRINK_COOLDOWN})"
            else:
                reason = "zone_stable"
        else:
            reason = "executed"

        print(f"{tick:<6} {queue_depth:<8} {worker_count:<8} {zone:<6} {action_names[action_value]:<8} {match} {reason}")

        # 执行动作 (使用 action_index)
        env.step(action_index)

    # Teacher 统计
    print(f"\nTeacher Stats:")
    print(f"  Action counts: {teacher.action_counts}")
    print(f"  Zone counts: {teacher.zone_counts}")


if __name__ == "__main__":
    debug_zone_e()
