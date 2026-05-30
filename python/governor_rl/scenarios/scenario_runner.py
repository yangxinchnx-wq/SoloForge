# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Scenario Runner
# Path: python/governor_rl/scenarios/scenario_runner.py
#
# 场景运行器 - Teacher Rollout 核心
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import numpy as np
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, asdict
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.scenarios.scenario_spec import ScenarioSpec, PRESET_SCENARIOS, get_scenario
from governor_rl.scenarios.workload_patterns import WorkloadGenerator
from governor_rl.scenarios.chaos_injection import ChaosEngine, FailureDetector


@dataclass
class TimelineEntry:
    """时间线条目"""
    tick: int
    
    # 环境状态
    queue_depth: int
    worker_count: int
    cpu_usage: float
    processing_rate: float
    arrival_rate: float
    
    # Governor 决策
    action_type: str
    action_delta: int
    
    # 衍生指标
    oscillation_score: float
    regime: str
    precursor_score: float
    
    # 故障标注
    failure_type: Optional[str] = None
    chaos_intensity: float = 0.0
    
    # 元信息
    scenario_name: str = ""
    episode_id: str = ""


class ScenarioRunner:
    """
    场景运行器
    
    在指定场景下运行 Teacher (Adaptive Governor V3) 并记录时间线
    """
    
    def __init__(
        self,
        output_dir: str = "datasets/trajectories",
        record_failure: bool = True,
    ):
        self.output_dir = output_dir
        self.record_failure = record_failure
        
        os.makedirs(output_dir, exist_ok=True)
        
        # 创建组件
        self.workload_gen = None
        self.chaos_engine = ChaosEngine()
        self.failure_detector = FailureDetector()
    
    def run_scenario(
        self,
        scenario: ScenarioSpec,
        teacher=None,
        seed: int = None,
        episode_id: str = None,
        verbose: bool = True,
    ) -> List[TimelineEntry]:
        """
        运行单个场景
        
        Args:
            scenario: 场景规格
            teacher: Teacher Governor (AdaptiveGovernorV3)
            seed: 随机种子
            episode_id: Episode ID
            verbose: 是否打印进度
            
        Returns:
            时间线列表
        """
        if seed is not None:
            np.random.seed(seed)
        
        episode_id = episode_id or f"{scenario.name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        
        if verbose:
            print(f"  运行场景: {scenario.name} (duration={scenario.duration})")
        
        # 初始化
        self.workload_gen = WorkloadGenerator(
            base_arrival_rate=scenario.base_arrival_rate,
            arrival_std=scenario.arrival_std,
            arrival_pattern=scenario.arrival_pattern,
            seed=seed,
        )
        self.chaos_engine.reset()
        self.failure_detector = FailureDetector()
        
        # 创建 Governor
        if teacher is None:
            from training.simulator.adaptive_governor import AdaptiveGovernorV3
            teacher = AdaptiveGovernorV3()
        
        teacher.workload.burst_probability = scenario.burst_probability
        teacher.workload.base_arrival_rate = scenario.base_arrival_rate
        
        # 运行
        timeline = []

        # 处理 chaos_params
        chaos_params = scenario.chaos_params or {}
        instant_crash_tick = chaos_params.get("crash_tick", None)
        instant_crash_done = False

        for tick in range(scenario.duration):
            # Instant crash（worker_crash_recovery scenario）
            if (instant_crash_tick is not None and
                tick == instant_crash_tick and
                not instant_crash_done):
                # 直接修改 state
                original_workers = teacher.state.worker_count
                teacher.state.worker_count = max(1, int(original_workers * 0.2))
                print(f"    [INSTANT CRASH] tick={tick}, workers: {original_workers} → {teacher.state.worker_count}")
                instant_crash_done = True

            # Traffic drop after burst（recovery_trigger scenario）
            if chaos_params.get("traffic_drop_after_burst"):
                if 500 <= tick < 1000:
                    # High burst period
                    teacher.workload.base_arrival_rate = 40.0
                else:
                    # Normal period
                    teacher.workload.base_arrival_rate = 15.0

            # Sudden drop（gradual_relief scenario - 极端版）
            if chaos_params.get("sudden_drop"):
                drop_tick = chaos_params.get("drop_tick", 1000)
                initial_rate = chaos_params.get("initial_rate", 50.0)
                drop_to_rate = chaos_params.get("drop_to_rate", 5.0)

                if tick < drop_tick:
                    teacher.workload.base_arrival_rate = initial_rate
                else:
                    teacher.workload.base_arrival_rate = drop_to_rate

            # Burst then relief（oscillation_decay scenario - 极端版）
            if chaos_params.get("burst_then_relief"):
                burst_start = chaos_params.get("burst_start", 200)
                burst_end = chaos_params.get("burst_end", 1200)
                burst_rate = chaos_params.get("burst_rate", 60.0)
                relief_rate = chaos_params.get("relief_rate", 8.0)

                if burst_start <= tick < burst_end:
                    teacher.workload.base_arrival_rate = burst_rate
                else:
                    teacher.workload.base_arrival_rate = relief_rate

            # 生成工作负载
            workload_event = self.workload_gen.generate(
                tick=tick,
                burst_prob=scenario.burst_probability,
                burst_multiplier=scenario.burst_multiplier,
                burst_dur_min=scenario.burst_duration_min,
                burst_dur_max=scenario.burst_duration_max,
                idle_prob=scenario.idle_probability,
                idle_rate=scenario.idle_rate,
                cpu_spike_prob=scenario.cpu_spike_probability,
                cpu_spike_dur=scenario.cpu_spike_duration,
                cpu_spike_mult=scenario.cpu_spike_multiplier,
                queue_flood_prob=scenario.queue_flood_probability,
                queue_flood_amount=scenario.queue_flood_amount,
                worker_failure_prob=scenario.worker_failure_probability,
                worker_failure_batch=scenario.worker_failure_batch,
            )

            # 混沌注入
            cpu_mult, workers_kill, queue_inj = self.chaos_engine.step(
                tick=tick,
                cpu_spike_prob=scenario.cpu_spike_probability,
                cpu_spike_dur=scenario.cpu_spike_duration,
                cpu_spike_mult=scenario.cpu_spike_multiplier,
                worker_failure_prob=scenario.worker_failure_probability,
                worker_failure_batch=scenario.worker_failure_batch,
                queue_flood_prob=scenario.queue_flood_probability,
                queue_flood_amount=scenario.queue_flood_amount,
            )

            # 应用工作负载（只对非特殊场景生效）
            if not chaos_params.get("traffic_drop_after_burst") and \
               not chaos_params.get("gradual_decay") and \
               chaos_params.get("high_stress_start") is None:
                teacher.workload.base_arrival_rate = workload_event.arrival_rate
            if hasattr(teacher.workload, 'process'):
                teacher.workload.process()

            # Tick Governor
            teacher.tick()

            # 注入队列洪泛（直接修改 state）
            if queue_inj > 0:
                teacher.state.queue_depth += queue_inj

            # Kill workers（直接修改 state）
            if workers_kill > 0:
                if teacher.state.worker_count > workers_kill:
                    teacher.state.worker_count -= workers_kill

            # 获取状态
            state = teacher.state

            # 更新故障检测
            action_delta = self._action_to_delta(state.action_history[-1] if state.action_history else "no_op")
            self.failure_detector.update(
                tick=tick,
                queue_depth=state.queue_depth,
                oscillation_score=teacher.analyzer.compute_metrics(tick).oscillation_score,
                worker_count=state.worker_count,
                action=action_delta,
            )

            # 构建时间线条目
            entry = TimelineEntry(
                tick=tick,
                queue_depth=state.queue_depth,
                worker_count=state.worker_count,
                cpu_usage=state.cpu_usage,
                processing_rate=state.token_pressure,  # 使用 token_pressure 作为 processing_rate
                arrival_rate=workload_event.arrival_rate,
                action_type=state.action_history[-1] if state.action_history else "no_op",
                action_delta=action_delta,
                oscillation_score=teacher.analyzer.compute_metrics(tick).oscillation_score,
                regime=teacher._classify_runtime_regime(),  # 使用内部的 regime 分类方法
                precursor_score=0.0,  # 简化：precursor score 暂时设为 0
                failure_type=self.failure_detector.get_failure_type() if self.record_failure else None,
                chaos_intensity=cpu_mult,
                scenario_name=scenario.name,
                episode_id=episode_id,
            )
            
            timeline.append(entry)
        
        if verbose:
            # 统计
            actions = [e.action_delta for e in timeline]
            unique_actions = len(set(actions))
            print(f"    完成: {len(timeline)} ticks, {unique_actions} 种动作")
        
        return timeline
    
    def _action_to_delta(self, action_type: str) -> int:
        """动作类型转 delta"""
        mapping = {
            "spawn_worker": 1,
            "spawn_workers": 2,
            "reduce_workers": -1,
            "reduce_workers_batch": -2,
            "enable_reflection": 0,
            "disable_reflection": 0,
            "no_op": 0,
        }
        return mapping.get(action_type, 0)
    
    def save_timeline(
        self,
        timeline: List[TimelineEntry],
        filename: str = None,
    ) -> str:
        """保存时间线"""
        filename = filename or f"timeline_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jsonl"
        filepath = os.path.join(self.output_dir, filename)
        
        with open(filepath, 'w', encoding='utf-8') as f:
            for entry in timeline:
                f.write(json.dumps(asdict(entry), ensure_ascii=False) + '\n')
        
        return filepath
    
    def load_timeline(self, filepath: str) -> List[TimelineEntry]:
        """加载时间线"""
        timeline = []
        with open(filepath, 'r', encoding='utf-8') as f:
            for line in f:
                data = json.loads(line.strip())
                timeline.append(TimelineEntry(**data))
        return timeline


class DatasetCollector:
    """
    数据集收集器
    
    批量收集多个场景的轨迹数据
    """
    
    def __init__(
        self,
        output_dir: str = "datasets/trajectories",
        scenarios: List[str] = None,
        episodes_per_scenario: int = 5,
    ):
        self.runner = ScenarioRunner(output_dir=output_dir)
        self.scenarios = scenarios or list(PRESET_SCENARIOS.keys())
        self.episodes_per_scenario = episodes_per_scenario
        
        self.all_timelines: List[List[TimelineEntry]] = []
    
    def collect_all(self, seed_offset: int = 0) -> List[List[TimelineEntry]]:
        """
        收集所有场景数据
        
        Args:
            seed_offset: 种子偏移量
            
        Returns:
            所有时间线列表
        """
        print("=" * 60)
        print("Dataset Collection")
        print("=" * 60)
        
        self.all_timelines = []
        
        for scenario_name in self.scenarios:
            scenario = get_scenario(scenario_name)
            
            print(f"\n场景: {scenario_name}")
            print(f"  描述: {scenario.description}")
            print(f"  参数: arrival_rate={scenario.base_arrival_rate}, "
                  f"burst_prob={scenario.burst_probability}, "
                  f"idle_prob={scenario.idle_probability}")
            
            for ep in range(self.episodes_per_scenario):
                seed = seed_offset + self.scenarios.index(scenario_name) * 100 + ep
                
                timeline = self.runner.run_scenario(
                    scenario=scenario,
                    seed=seed,
                    episode_id=f"{scenario_name}_ep{ep:02d}",
                )
                
                self.all_timelines.append(timeline)
        
        print(f"\n总计收集: {len(self.all_timelines)} 个 episodes")
        total_ticks = sum(len(t) for t in self.all_timelines)
        print(f"总 tick 数: {total_ticks:,}")
        
        return self.all_timelines
    
    def save_all(self, prefix: str = "dataset") -> str:
        """保存所有时间线"""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        combined_path = os.path.join(
            self.runner.output_dir,
            f"{prefix}_{timestamp}.jsonl"
        )
        
        with open(combined_path, 'w', encoding='utf-8') as f:
            for timeline in self.all_timelines:
                for entry in timeline:
                    f.write(json.dumps(asdict(entry), ensure_ascii=False) + '\n')
        
        print(f"[DatasetCollector] 保存到: {combined_path}")
        return combined_path


def main():
    """主函数：演示场景运行"""
    print("=" * 60)
    print("Scenario Runner Demo")
    print("=" * 60)
    
    # 收集几个场景的数据
    collector = DatasetCollector(
        output_dir="datasets/trajectories",
        scenarios=["steady_low", "steady_medium", "steady_high", "burst_traffic", "long_idle"],
        episodes_per_scenario=2,
    )
    
    collector.collect_all()
    
    # 保存
    collector.save_all("demo")


if __name__ == "__main__":
    main()
