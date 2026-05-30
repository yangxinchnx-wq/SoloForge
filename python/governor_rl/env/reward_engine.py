# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Reward Engine
# Path: python/governor_rl/env/reward_engine.py
#
# Reward Schema (冻结)
# ─────────────────────────────────────────────────────────────────

import numpy as np


def compute_reward(state, action_delta):
    """
    计算 Reward (冻结)

    Args:
        state: object with queue_depth and oscillation_score attributes
        action_delta: worker 变化量

    Returns:
        float: reward
    """
    queue_penalty = -state.queue_depth * 0.01

    oscillation_penalty = -state.oscillation_score * 0.1

    control_cost = -abs(action_delta) * 0.02

    reward = (
        queue_penalty
        + oscillation_penalty
        + control_cost
    )

    return float(reward)
