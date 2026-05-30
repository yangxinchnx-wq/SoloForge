# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Runtime Phase Definitions
# Path: python/governor_rl/phases/runtime_phase.py
#
# 核心定义：Runtime Phase 枚举
# ─────────────────────────────────────────────────────────────────

from enum import Enum


class RuntimePhase(Enum):
    """
    Runtime Phase 枚举
    
    定义系统可能处于的所有运行时相位
    """
    STABLE = 0         # 稳定状态
    EXPANDING = 1      # 扩张中
    SHRINKING = 2      # 收缩中
    PRECURSOR = 3      # 前兆阶段（崩溃预警）
    RECOVERY = 4       # 恢复中
    OSCILLATING = 5    # 振荡中
    SATURATED = 6      # 饱和状态


# Phase 名称映射
PHASE_NAMES = {
    RuntimePhase.STABLE: "stable",
    RuntimePhase.EXPANDING: "expanding",
    RuntimePhase.SHRINKING: "shrinking",
    RuntimePhase.PRECURSOR: "precursor",
    RuntimePhase.RECOVERY: "recovery",
    RuntimePhase.OSCILLATING: "oscillating",
    RuntimePhase.SATURATED: "saturated",
}

# Phase ID 映射（用于 observation）
PHASE_IDS = {phase: i / 6.0 for i, phase in enumerate(RuntimePhase)}


def get_phase_name(phase: RuntimePhase) -> str:
    """获取 phase 名称"""
    return PHASE_NAMES.get(phase, "unknown")


def get_phase_id(phase: RuntimePhase) -> float:
    """获取 phase ID（用于归一化）"""
    return PHASE_IDS.get(phase, 0.5)
