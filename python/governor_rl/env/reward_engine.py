# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Reward Engine
# Path: python/governor_rl/env/reward_engine.py
#
# Reward Schema (Sprint 5 Fix)
#
# 设计原则：
# - Zone E (高负载): expand2 奖励最高
# - Zone A (低负载): shrink2 奖励最高
# - Collapse: reward << 0
# - Thrashing: oscillation penalty
#
# 关键修复：
# - 引入 load_ratio 作为控制成本的比例因子
# - 高负载时，扩容成本低（鼓励扩张）
# - 低负载时，缩容成本低（鼓励收缩）
# ─────────────────────────────────────────────────────────────────

import numpy as np


def compute_reward(state, action_delta):
    """
    计算 Reward

    Args:
        state: object with queue_depth, worker_count, and oscillation_score attributes
        action_delta: worker 变化量 (正值=扩张, 负值=收缩)

    Returns:
        float: reward
    """
    queue_penalty = -state.queue_depth * 0.01

    oscillation_penalty = -state.oscillation_score * 0.1

    # 原始控制成本
    base_control_cost = -abs(action_delta) * 0.02

    # 负载比例 (queue / capacity)
    capacity = max(state.worker_count * 2, 1)
    load_ratio = state.queue_depth / capacity

    # 非对称控制成本:
    # - 高负载 (lr > 1): 扩容成本低，缩容成本高
    # - 低负载 (lr < 0.25): 缩容成本低，扩容成本高
    # control_cost_scale 在 [0, 1] 范围内
    control_cost_scale = max(0.0, 1.0 - load_ratio)

    if action_delta >= 0:
        # 扩容: 成本随负载降低
        # 高负载时接近 0 (鼓励扩容)，低负载时为 1 (正常惩罚)
        control_cost = -action_delta * 0.02 * control_cost_scale
    else:
        # 缩容: 成本随负载增加
        # 高负载时接近 1 (惩罚缩容)，低负载时接近 0 (鼓励收缩)
        control_cost = -abs(action_delta) * 0.02 * (2 - control_cost_scale)

    reward = (
        queue_penalty
        + oscillation_penalty
        + control_cost
    )

    return float(reward)
