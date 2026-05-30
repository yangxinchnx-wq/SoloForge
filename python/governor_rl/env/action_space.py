# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Action Space
# Path: python/governor_rl/env/action_space.py
#
# 离散动作空间：5 个动作
# ─────────────────────────────────────────────────────────────────

# Action Space: 离散 5 个动作
# 0: -2 (快速缩容)
# 1: -1 (缓慢缩容)
# 2:  0 (保持不变)
# 3: +1 (缓慢扩容)
# 4: +2 (快速扩容)

ACTION_MAP = {
    0: -2,
    1: -1,
    2:  0,
    3: +1,
    4: +2,
}

ACTION_NAMES = {
    0: "fast_shrink",
    1: "slow_shrink",
    2: "no_op",
    3: "slow_expand",
    4: "fast_expand",
}

NUM_ACTIONS = len(ACTION_MAP)
