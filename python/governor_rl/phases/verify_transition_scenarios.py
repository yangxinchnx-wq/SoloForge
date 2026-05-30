# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Transition Scenarios Verification
# Path: python/governor_rl/phases/verify_transition_scenarios.py
#
# 验证 5 个 Transition-Forcing Scenarios 是否真的产生目标 Phase
# 只运行 1000 ticks/scenario，打印 Counter(phases)
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.scenarios.scenario_spec import get_scenario, PRESET_SCENARIOS
from governor_rl.scenarios.scenario_runner import ScenarioRunner
from governor_rl.phases import RuntimePhase, TransitionDetector, get_phase_name


def verify_scenario(scenario_name: str, duration: int = 1000) -> dict:
    """
    验证单个 scenario 的 Phase Coverage
    """
    print(f"\n{'='*60}")
    print(f"验证场景: {scenario_name}")
    print(f"{'='*60}")

    try:
        scenario = get_scenario(scenario_name)
        print(f"描述: {scenario.description}")
        print(f"目标: {scenario.target_regime}")
        print(f"参数: arrival_rate={scenario.base_arrival_rate}, "
              f"burst_prob={scenario.burst_probability}, "
              f"worker_failure_prob={scenario.worker_failure_probability}")
    except Exception as e:
        print(f"错误: 无法加载场景 - {e}")
        return {"name": scenario_name, "error": str(e)}

    # 运行（只 1000 ticks）
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
        print(f"错误: 运行失败 - {e}")
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
        status = "✅" if count > 0 else "❌"
        print(f"  {status} {get_phase_name(phase):<12}: {count:>5} ({ratio:>6.1%})")

    # 关键验证
    results = {
        "name": scenario_name,
        "total_ticks": total,
        "phase_distribution": {get_phase_name(p): c for p, c in phase_counter.items()},
        "has_precursor": phase_counter.get(RuntimePhase.PRECURSOR, 0) > 0,
        "has_recovery": phase_counter.get(RuntimePhase.RECOVERY, 0) > 0,
        "has_oscillating": phase_counter.get(RuntimePhase.OSCILLATING, 0) > 0,
        "has_saturated": phase_counter.get(RuntimePhase.SATURATED, 0) > 0,
        "has_expanding": phase_counter.get(RuntimePhase.EXPANDING, 0) > 0,
        "has_shrinking": phase_counter.get(RuntimePhase.SHRINKING, 0) > 0,
        "transition_count": sum(
            phase_counter.get(p, 0)
            for p in [RuntimePhase.PRECURSOR, RuntimePhase.RECOVERY,
                     RuntimePhase.OSCILLATING, RuntimePhase.EXPANDING,
                     RuntimePhase.SHRINKING]
        ),
    }

    return results


def main():
    """主函数"""
    print("=" * 60)
    print("Transition Scenarios Verification")
    print("=" * 60)
    print("验证 5 个 Transition-Forcing Scenarios")
    print("每个场景只运行 1000 ticks")
    print("=" * 60)

    # 要验证的 5 个新场景
    scenarios_to_verify = [
        "precursor_trigger",
        "oscillation_trigger",
        "saturation_trigger",
        "recovery_trigger",
        "worker_crash_recovery",
    ]

    results = []

    for scenario_name in scenarios_to_verify:
        result = verify_scenario(scenario_name, duration=1000)
        results.append(result)

    # 总结
    print("\n" + "=" * 60)
    print("Verification Summary")
    print("=" * 60)

    print(f"\n{'Scenario':<25} {'Precursor':>10} {'Oscill':>10} {'Recovery':>10} {'Saturated':>10} {'Transition':>12}")
    print("-" * 80)

    for r in results:
        name = r.get("name", "?")
        has_p = "✅" if r.get("has_precursor", False) else "❌"
        has_o = "✅" if r.get("has_oscillating", False) else "❌"
        has_r = "✅" if r.get("has_recovery", False) else "❌"
        has_s = "✅" if r.get("has_saturated", False) else "❌"
        tc = r.get("transition_count", 0)
        print(f"{name:<25} {has_p:>10} {has_o:>10} {has_r:>10} {has_s:>10} {tc:>12}")

    # 验证是否通过
    print("\n" + "=" * 60)
    print("Validation Check")
    print("=" * 60)

    all_passed = True
    for r in results:
        name = r.get("name", "?")
        checks = []

        if "precursor" in name:
            checks.append(("precursor", r.get("has_precursor", False)))
        if "oscillation" in name:
            checks.append(("oscillating", r.get("has_oscillating", False)))
        if "recovery" in name or "worker_crash" in name:
            checks.append(("recovery", r.get("has_recovery", False)))
        if "saturation" in name:
            checks.append(("saturated", r.get("has_saturated", False)))

        # 至少有一个 transition phase
        has_transition = any(
            r.get(f"has_{p}", False)
            for p in ["precursor", "oscillating", "recovery", "saturated", "expanding", "shrinking"]
        )

        if checks:
            all_checks_pass = all(c[1] for c in checks)
            status = "✅ PASS" if all_checks_pass else "❌ FAIL"
            print(f"  {name}: {status}")
            for check_name, passed in checks:
                print(f"    - {check_name}: {'✅' if passed else '❌'}")
            if not all_checks_pass:
                all_passed = False
        else:
            print(f"  {name}: ⚠️ 无特定检查")

    print("\n" + "=" * 60)
    if all_passed:
        print("✅ 所有 Transition-Forcing Scenarios 通过验证")
        print("可以开始大规模 Rollout")
    else:
        print("❌ 部分场景未产生目标 Phase")
        print("需要调整场景参数或混沌注入策略")
    print("=" * 60)


if __name__ == "__main__":
    main()
