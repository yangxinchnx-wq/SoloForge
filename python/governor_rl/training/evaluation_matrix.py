# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Evaluation Matrix
# Path: python/governor_rl/training/evaluation_matrix.py
#
# Runtime RL Benchmark - 标准化评估框架
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import numpy as np
import json
from datetime import datetime
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass, field
from abc import ABC, abstractmethod

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.env import RuntimeEnvFactory


@dataclass
class MetricResult:
    """指标结果"""
    name: str
    value: float
    unit: str
    category: str  # "queue", "stability", "economic", "robustness"
    higher_is_better: bool = True


@dataclass
class BenchmarkResult:
    """Benchmark 结果"""
    benchmark_name: str
    policy_name: str
    config: Dict
    timestamp: str
    episode_length: int

    metrics: List[MetricResult]
    overall_score: float

    # 原始数据（用于调试）
    raw_queue: List[float] = field(default_factory=list)
    raw_workers: List[float] = field(default_factory=list)
    raw_oscillation: List[float] = field(default_factory=list)


class RuntimeBenchmark(ABC):
    """Runtime Benchmark 基类"""
    
    @abstractmethod
    def evaluate(
        self,
        policy,
        env_config: Dict,
        max_steps: int = 500,
    ) -> BenchmarkResult:
        """评估策略"""
        pass
    
    @abstractmethod
    def get_name(self) -> str:
        """Benchmark 名称"""
        pass


class QueueHealthBenchmark(RuntimeBenchmark):
    """Queue Health Benchmark"""
    
    def get_name(self) -> str:
        return "Queue Health"
    
    def evaluate(
        self,
        policy,
        env_config: Dict,
        max_steps: int = 500,
    ) -> BenchmarkResult:
        env = RuntimeEnvFactory.create(
            arrival_rate=env_config["arrival_rate"],
            burst_prob=env_config["burst_prob"],
            duration=max_steps,
        )
        
        obs, _ = env.reset()
        queues, workers, oscillations = [], [], []
        
        for step in range(max_steps):
            action, _ = policy.get_action(obs, deterministic=True)
            next_obs, _, done, _, info = env.step(action)
            
            queues.append(info.get("queue_depth", 0))
            workers.append(info.get("worker_count", 0))
            oscillations.append(info.get("oscillation_score", 0.0))
            
            obs = next_obs
            if done:
                break
        
        queues = np.array(queues)
        
        metrics = [
            MetricResult("avg_queue", float(np.mean(queues)), "items", "queue", False),
            MetricResult("max_queue", float(np.max(queues)), "items", "queue", False),
            MetricResult("queue_p95", float(np.percentile(queues, 95)), "items", "queue", False),
            MetricResult("queue_p99", float(np.percentile(queues, 99)), "items", "queue", False),
            MetricResult("queue_std", float(np.std(queues)), "items", "queue", False),
            MetricResult("time_above_200", float(np.sum(queues > 200) / len(queues)), "%", "queue", False),
        ]
        
        overall = 1.0 / (1.0 + np.mean(queues) / 100)

        return BenchmarkResult(
            benchmark_name="Queue Health",
            policy_name="unknown",
            config=env_config,
            timestamp=datetime.now().isoformat(),
            episode_length=len(queues),
            metrics=metrics,
            overall_score=overall,
            raw_queue=queues.tolist(),
            raw_workers=workers,
            raw_oscillation=oscillations,
        )


class StabilityBenchmark(RuntimeBenchmark):
    """Stability Benchmark"""
    
    def get_name(self) -> str:
        return "Stability"
    
    def evaluate(
        self,
        policy,
        env_config: Dict,
        max_steps: int = 500,
    ) -> BenchmarkResult:
        env = RuntimeEnvFactory.create(
            arrival_rate=env_config["arrival_rate"],
            burst_prob=env_config["burst_prob"],
            duration=max_steps,
        )
        
        obs, _ = env.reset()
        oscillations, workers = [], []
        mode_switches = 0
        last_regime = None
        
        for step in range(max_steps):
            action, _ = policy.get_action(obs, deterministic=True)
            next_obs, _, done, _, info = env.step(action)
            
            oscillations.append(info.get("oscillation_score", 0.0))
            workers.append(info.get("worker_count", 0))
            
            regime = info.get("regime", "unknown")
            if last_regime and regime != last_regime:
                mode_switches += 1
            last_regime = regime
            
            obs = next_obs
            if done:
                break
        
        oscillations = np.array(oscillations)
        workers = np.array(workers)
        worker_churn = float(np.mean(np.abs(np.diff(workers)))) if len(workers) > 1 else 0
        
        metrics = [
            MetricResult("avg_oscillation", float(np.mean(oscillations)), "score", "stability", False),
            MetricResult("max_oscillation", float(np.max(oscillations)), "score", "stability", False),
            MetricResult("oscillation_std", float(np.std(oscillations)), "score", "stability", False),
            MetricResult("worker_churn", worker_churn, "workers/step", "stability", False),
            MetricResult("mode_switches", float(mode_switches), "count", "stability", False),
        ]
        
        overall = 1.0 / (1.0 + np.mean(oscillations) * 10)

        return BenchmarkResult(
            benchmark_name="Stability",
            policy_name="unknown",
            config=env_config,
            timestamp=datetime.now().isoformat(),
            episode_length=len(oscillations),
            metrics=metrics,
            overall_score=overall,
            raw_queue=[],
            raw_workers=workers.tolist(),
            raw_oscillation=oscillations.tolist(),
        )


class EconomicBenchmark(RuntimeBenchmark):
    """Economic Benchmark"""
    
    def get_name(self) -> str:
        return "Economic"
    
    def evaluate(
        self,
        policy,
        env_config: Dict,
        max_steps: int = 500,
    ) -> BenchmarkResult:
        env = RuntimeEnvFactory.create(
            arrival_rate=env_config["arrival_rate"],
            burst_prob=env_config["burst_prob"],
            duration=max_steps,
        )
        
        obs, _ = env.reset()
        workers, actions = [], []
        
        action_map = {0: -2, 1: -1, 2: 0, 3: 1, 4: 2}
        
        for step in range(max_steps):
            action, _ = policy.get_action(obs, deterministic=True)
            next_obs, _, done, _, info = env.step(action)
            
            workers.append(info.get("worker_count", 0))
            actions.append(action)
            
            obs = next_obs
            if done:
                break
        
        workers = np.array(workers)
        control_cost = float(np.mean([abs(action_map.get(a, 0)) for a in actions]))
        
        metrics = [
            MetricResult("avg_workers", float(np.mean(workers)), "workers", "economic", True),
            MetricResult("min_workers", float(np.min(workers)), "workers", "economic", True),
            MetricResult("max_workers", float(np.max(workers)), "workers", "economic", False),
            MetricResult("control_cost", control_cost, "delta/step", "economic", False),
            MetricResult("worker_variance", float(np.std(workers)), "workers", "economic", False),
        ]
        
        # 合理范围内 worker 越多越好（表示有资源处理负载）
        overall = float(np.mean(workers)) / 50.0  # 假设 50 是理想值

        return BenchmarkResult(
            benchmark_name="Economic",
            policy_name="unknown",
            config=env_config,
            timestamp=datetime.now().isoformat(),
            episode_length=len(workers),
            metrics=metrics,
            overall_score=overall,
            raw_queue=[],
            raw_workers=workers.tolist(),
            raw_oscillation=[],
        )


class RobustnessBenchmark(RuntimeBenchmark):
    """Robustness Benchmark - 测试在未见场景下的表现"""
    
    # 分布外配置
    OOD_CONFIGS = [
        {"arrival_rate": 35.0, "burst_prob": 0.30},  # 极端高负载
        {"arrival_rate": 5.0, "burst_prob": 0.01},   # 极端低负载
        {"arrival_rate": 28.0, "burst_prob": 0.45},  # 高突发
        {"arrival_rate": 8.0, "burst_prob": 0.40},   # 低负载高突发
    ]
    
    def get_name(self) -> str:
        return "Robustness"
    
    def evaluate(
        self,
        policy,
        env_config: Dict = None,
        max_steps: int = 500,
    ) -> BenchmarkResult:
        """
        评估鲁棒性：在分布外配置上的平均表现
        """
        all_queues, all_osc = [], []
        survived = 0
        
        for config in self.OOD_CONFIGS:
            env = RuntimeEnvFactory.create(
                arrival_rate=config["arrival_rate"],
                burst_prob=config["burst_prob"],
                duration=max_steps,
            )
            
            obs, _ = env.reset()
            queues, oscillations = [], []
            done = False
            
            for step in range(max_steps):
                action, _ = policy.get_action(obs, deterministic=True)
                next_obs, _, done, _, info = env.step(action)
                
                queues.append(info.get("queue_depth", 0))
                oscillations.append(info.get("oscillation_score", 0.0))
                
                obs = next_obs
                if done:
                    break
            
            # 如果没有崩溃，记录数据
            if np.max(queues) < 1000:  # 没有溢出
                survived += 1
                all_queues.extend(queues)
                all_osc.extend(oscillations)
        
        all_queues = np.array(all_queues) if all_queues else np.array([0])
        all_osc = np.array(all_osc) if all_osc else np.array([0])
        
        metrics = [
            MetricResult("ood_survival_rate", survived / len(self.OOD_CONFIGS), "ratio", "robustness", True),
            MetricResult("ood_avg_queue", float(np.mean(all_queues)), "items", "robustness", False),
            MetricResult("ood_avg_oscillation", float(np.mean(all_osc)), "score", "robustness", False),
            MetricResult("ood_max_queue", float(np.max(all_queues)), "items", "robustness", False),
        ]
        
        # 综合鲁棒性得分
        survival_bonus = survived / len(self.OOD_CONFIGS)
        queue_penalty = 1.0 / (1.0 + np.mean(all_queues) / 200)
        overall = survival_bonus * 0.5 + queue_penalty * 0.5

        return BenchmarkResult(
            benchmark_name="Robustness",
            policy_name="unknown",
            config={"mode": "ood_evaluation"},
            timestamp=datetime.now().isoformat(),
            episode_length=len(all_queues),
            metrics=metrics,
            overall_score=overall,
            raw_queue=all_queues.tolist(),
            raw_workers=[],
            raw_oscillation=all_osc.tolist(),
        )


class EvaluationMatrix:
    """
    Evaluation Matrix - 完整的评估框架
    
    组合多个 Benchmark 进行全面评估
    """
    
    def __init__(self):
        self.benchmarks = [
            QueueHealthBenchmark(),
            StabilityBenchmark(),
            EconomicBenchmark(),
            RobustnessBenchmark(),
        ]
    
    def evaluate_policy(
        self,
        policy,
        policy_name: str,
        test_configs: List[Dict] = None,
        max_steps: int = 500,
    ) -> Dict:
        """
        完整评估一个策略
        
        Args:
            policy: 策略网络
            policy_name: 策略名称
            test_configs: 测试配置列表
            max_steps: 每 episode 最大步数
            
        Returns:
            评估结果
        """
        test_configs = test_configs or [
            {"arrival_rate": 15.0, "burst_prob": 0.15},
        ]
        
        all_results = {}
        
        for config_name, config in [(f"config_{i}", c) for i, c in enumerate(test_configs)]:
            results_for_config = []
            
            for benchmark in self.benchmarks:
                result = benchmark.evaluate(policy, config, max_steps)
                result.policy_name = policy_name
                results_for_config.append(result)
            
            all_results[config_name] = results_for_config
        
        return {
            "policy_name": policy_name,
            "timestamp": datetime.now().isoformat(),
            "benchmarks": all_results,
        }
    
    def compare_policies(
        self,
        policies: Dict[str, PolicyNetwork],
        test_configs: List[Dict] = None,
    ) -> Dict:
        """
        对比多个策略
        
        Args:
            policies: {name: policy} 字典
            
        Returns:
            对比结果
        """
        print("=" * 60)
        print("Policy Comparison")
        print("=" * 60)
        
        results = {}
        
        for name, policy in policies.items():
            print(f"\n评估策略: {name}")
            results[name] = self.evaluate_policy(
                policy, name, test_configs
            )
        
        # 打印对比表格
        self._print_comparison_table(results)
        
        return results
    
    def _print_comparison_table(self, results: Dict):
        """打印对比表格"""
        print("\n" + "=" * 80)
        print("Comparison Summary")
        print("=" * 80)
        
        for benchmark_name in ["Queue Health", "Stability", "Economic", "Robustness"]:
            print(f"\n{benchmark_name}:")
            print("-" * 60)
            
            for policy_name, result in results.items():
                for bench_result in result["benchmarks"].values():
                    for metric in bench_result.metrics:
                        if metric.category == benchmark_name.lower().replace(" ", "_"):
                            direction = "↑" if metric.higher_is_better else "↓"
                            print(f"  {policy_name:<20} {metric.name:<20} {metric.value:>10.3f} {direction}")


def main():
    """主函数"""
    print("=" * 60)
    print("Runtime Evaluation Matrix Demo")
    print("=" * 60)
    
    # 加载 BC 策略
    bc_policy = PolicyNetwork()
    if os.path.exists("checkpoints/bc_policy.pt"):
        ckpt = torch.load("checkpoints/bc_policy.pt", weights_only=False)
        bc_policy.load_state_dict(ckpt["policy_state_dict"])
        bc_policy.eval()
        print("[OK] BC 策略已加载")
    
    # 创建评估矩阵
    matrix = EvaluationMatrix()
    
    # 测试配置
    test_configs = [
        {"arrival_rate": 15.0, "burst_prob": 0.15},
        {"arrival_rate": 20.0, "burst_prob": 0.20},
        {"arrival_rate": 10.0, "burst_prob": 0.10},
    ]
    
    # 评估 BC 策略
    result = matrix.evaluate_policy(
        bc_policy,
        "BehavioralClone",
        test_configs,
    )
    
    # 打印结果
    print("\n" + "=" * 60)
    print("BC Policy Evaluation Results")
    print("=" * 60)
    
    for config_name, benchmarks in result["benchmarks"].items():
        print(f"\n{config_name}:")
        for b in benchmarks:
            print(f"  {b.benchmark_name}: overall={b.overall_score:.3f}")
            for m in b.metrics:
                print(f"    {m.name}: {m.value:.3f} {m.unit}")


if __name__ == "__main__":
    main()
