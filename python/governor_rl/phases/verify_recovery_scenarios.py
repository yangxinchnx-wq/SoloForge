# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Recovery Coverage Verification
# Path: python/governor_rl/phases/verify_recovery_scenarios.py
#
# 验证 Recovery 覆盖率（precursor + recovery 占比）
# Recovery 覆盖率 > 15% 即通过
# ─────────────────────────────────────────────────────────────────

import sys
import os
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.scenarios.scenario_spec import get_scenario
from governor_rl.scenarios.scenario_runner import ScenarioRunner
from governor_rl.phases import RuntimePhase, TransitionDetector, get_phase_name


def verify_scenario(scenario_name: str, duration: int = 5000) -> dict:
    """验证单个场景的 Recovery 覆盖率"""
    print(f"\n{'='*60}")
    print(f"验证: {scenario_name}")
    print(f"{'='*60}")

    try:
        scenario = get_scenario(scenario_name)
        print(f"描述: {scenario.description}")
    except Exception as e:
        print(f"错误: {e}")
        return {"name": scenario_name, "error": str(e)}

    # 运行
    runner = ScenarioRunner()
    original_duration = scenario.duration
    scenario.duration = duration

    try:
        timeline = runner.run_scenario(
            scenario=scenario,
            seed=42,
            episode_id=f"verify_{scenario_name}",
            verbose=False,
        )
    except Exception as e:
        print(f"错误: {e}")
        scenario.duration = original_duration
        return {"name": scenario_name, "error": str(e)}
    finally:
        scenario.duration = original_duration

    # Phase 检测
    detector = TransitionDetector()
    phases = []

    for entry in timeline:
        phase = detector.update(
            queue_depth=entry.queue_depth,
            precursor_score=entry.precursor_score,
            oscillation_score=entry.oscillation_score,
            worker_count=entry.worker_count,
            action_delta=entry.action_delta,
            cpu_usage=entry.cpu_usage,
        )
        phases.append(phase)

    # 统计
    phase_counter = Counter(phases)
    total = len(phases)

    print(f"\nPhase 分布 ({total} ticks):")
    for phase in RuntimePhase:
        count = phase_counter.get(phase, 0)
        ratio = count / total if total > 0 else 0
        print(f"  {get_phase_name(phase):<12}: {count:>5} ({ratio:>6.1%})")

    # Recovery 覆盖率 = precursor + recovery + saturated
    # 因为这些都是 "系统需要调整/恢复" 的状态
    recovery_phases = [RuntimePhase.PRECURSOR, RuntimePhase.RECOVERY, RuntimePhase.SATURATED]
    recovery_count = sum(phase_counter.get(p, 0) for p in recovery_phases)
    recovery_coverage = recovery_count / total if total > 0 else 0.0

    print(f"\nRecovery 覆盖率:")
    print(f"  (precursor + recovery + saturated) / total")
    print(f"  = {recovery_count} / {total}")
    print(f"  = {recovery_coverage:.1%}")

    return {
        "name": scenario_name,
        "total_ticks": total,
        "phase_distribution": {get_phase_name(p): c for p, c in phase_counter.items()},
        "recovery_count": recovery_count,
        "recovery_coverage": recovery_coverage,
    }


def main():
    """主函数"""
    print("=" * 60)
    print("Recovery Coverage Verification")
    print("=" * 60)
    print("Gate: Recovery Coverage > 15%")
    print("(precursor + recovery + saturated) / total")
    print("=" * 60)

    scenarios = [
        "gradual_relief",
        "oscillation_decay",
    ]

    results = []

    for scenario_name in scenarios:
        result = verify_scenario(scenario_name, duration=5000)
        results.append(result)

    # 总结
    print("\n" + "=" * 60)
    print("Recovery Coverage Summary")
    print("=" * 60)

    all_pass = True
    for r in results:
        name = r.get("name", "?")
        coverage = r.get("recovery_coverage", 0.0)

        status = "✅ PASS" if coverage > 0.15 else "❌ FAIL"
        if coverage <= 0.15:
            all_pass = False

        print(f"  {name}: {coverage:.1%} {status}")

    print("\n" + "=" * 60)

    if all_pass:
        print("✅ Recovery Coverage Gate 通过")
        print("可以进入 Curriculum Rollout 阶段")
    else:
        print("❌ Recovery Coverage Gate 未通过")

    print("=" * 60)

    return all_pass


if __name__ == "__main__":
    main()
