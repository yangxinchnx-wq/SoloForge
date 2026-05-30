# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Scenario Objectives
# Path: python/governor_rl/scenarios/scenario_objectives.py
#
# 核心定义：场景目标枚举
# 每个场景必须有明确的 target_phase
# ─────────────────────────────────────────────────────────────────

from enum import Enum


class ScenarioObjective(Enum):
    """
    场景目标枚举
    
    每个场景必须声明它要制造什么 Runtime Phase
    """
    PRECURSOR = 0      # 触发 precursor phase
    OSCILLATION = 1    # 触发 oscillation phase
    SATURATION = 2     # 触发 saturation phase
    RECOVERY = 3       # 触发 recovery phase
    EXPANDING = 4      # 触发 expanding phase
    SHRINKING = 5      # 触发 shrinking phase


# Objective 名称映射
OBJECTIVE_NAMES = {
    ScenarioObjective.PRECURSOR: "precursor_trigger",
    ScenarioObjective.OSCILLATION: "oscillation_trigger",
    ScenarioObjective.SATURATION: "saturation_trigger",
    ScenarioObjective.RECOVERY: "recovery_trigger",
    ScenarioObjective.EXPANDING: "expanding_trigger",
    ScenarioObjective.SHRINKING: "shrinking_trigger",
}


def get_objective_name(obj: ScenarioObjective) -> str:
    """获取 objective 名称"""
    return OBJECTIVE_NAMES.get(obj, "unknown")


# Phase Coverage 目标（冻结）
PHASE_COVERAGE_TARGETS = {
    "stable": 0.40,       # < 40%
    "precursor": 0.10,     # > 10%
    "recovery": 0.10,      # > 10%
    "oscillating": 0.05,   # > 5%
    "saturated": 0.05,     # > 5%
    "expanding": 0.05,     # > 5%
    "shrinking": 0.05,     # > 5%
}


def validate_phase_coverage(phase_distribution: dict) -> dict:
    """
    验证 Phase Coverage 是否达标
    
    Returns:
        验证报告 {"valid": bool, "issues": list}
    """
    total = sum(phase_distribution.values())
    if total == 0:
        return {"valid": False, "issues": ["No phase data"]}
    
    issues = []
    
    for phase, target_ratio in PHASE_COVERAGE_TARGETS.items():
        actual_ratio = phase_distribution.get(phase, 0) / total
        
        if phase == "stable":
            # stable 应该 < 目标
            if actual_ratio > target_ratio:
                issues.append(f"stable 过多: {actual_ratio:.1%} > {target_ratio:.1%}")
        else:
            # 其他 phase 应该 > 目标
            if actual_ratio < target_ratio:
                issues.append(f"{phase} 不足: {actual_ratio:.1%} < {target_ratio:.1%}")
    
    return {
        "valid": len(issues) == 0,
        "issues": issues,
    }
