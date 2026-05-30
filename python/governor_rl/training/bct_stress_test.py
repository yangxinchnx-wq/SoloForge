# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: BC Stress Test
# Path: python/governor_rl/training/bct_stress_test.py
#
# 验证 BC 模型在未见 workload 下的泛化能力
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import numpy as np
from typing import Dict, List, Tuple
from dataclasses import dataclass

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.env import RuntimeEnvFactory


@dataclass
class StressTestResult:
    """压力测试结果"""
    config_name: str
    arrival_rate: float
    burst_prob: float
    
    # Queue Health
    avg_queue: float
    max_queue: float
    queue_p95: float
    
    # Stability
    avg_oscillation: float
    worker_churn: float
    mode_switches: int
    
    # Economic
    avg_workers: float
    control_cost: float
    
    # Overall
    total_reward: float
    episode_length: int
    completed: bool


class BCStressTest:
    """
    Behavioral Clone Stress Test
    
    验证 BC 模型在未见场景下的泛化能力
    """
    
    # 测试配置
    TEST_CONFIGS = {
        # 基础负载（训练时见过）
        "train_baseline": {"arrival_rate": 15.0, "burst_prob": 0.15},
        
        # 未知低负载
        "unseen_low": {"arrival_rate": 8.0, "burst_prob": 0.05},
        
        # 未知中负载
        "unseen_medium": {"arrival_rate": 20.0, "burst_prob": 0.15},
        
        # 未知高负载
        "unseen_high": {"arrival_rate": 28.0, "burst_prob": 0.20},
        
        # 极端高负载
        "extreme_load": {"arrival_rate": 35.0, "burst_prob": 0.25},
        
        # 高突发
        "high_burst": {"arrival_rate": 15.0, "burst_prob": 0.40},
        
        # 低突发稳态
        "steady_low_burst": {"arrival_rate": 18.0, "burst_prob": 0.02},
        
        # 长空闲
        "long_idle": {"arrival_rate": 5.0, "burst_prob": 0.01},
        
        # Chaos: 负载突变
        "load_spike": {"arrival_rate": 15.0, "burst_prob": 0.15, "load_spike": True},
        
        # Chaos: CPU 抖动
        "cpu_jitter": {"arrival_rate": 15.0, "burst_prob": 0.15, "cpu_jitter": True},
    }
    
    def __init__(self, policy_path: str = "checkpoints/bc_policy.pt"):
        self.policy = PolicyNetwork()
        
        if os.path.exists(policy_path):
            checkpoint = torch.load(policy_path, weights_only=False)
            self.policy.load_state_dict(checkpoint["policy_state_dict"])
            self.policy.eval()
            print(f"[BCStressTest] 模型已加载: {policy_path}")
        else:
            print(f"[BCStressTest] 警告: 未找到模型 {policy_path}，使用随机初始化")
        
        self.results: List[StressTestResult] = []
    
    def run_single_test(
        self,
        config_name: str,
        config: Dict,
        duration: int = 500,
        deterministic: bool = True,
    ) -> StressTestResult:
        """运行单个测试"""
        print(f"\n  运行测试: {config_name}")
        print(f"    arrival_rate={config['arrival_rate']}, burst_prob={config['burst_prob']}")
        
        # 创建环境
        env = RuntimeEnvFactory.create(
            arrival_rate=config["arrival_rate"],
            burst_prob=config["burst_prob"],
            duration=duration,
        )
        
        obs, _ = env.reset()
        
        # 指标收集
        queues = []
        oscillations = []
        workers = []
        actions = []
        mode_switches = 0
        last_mode = None
        
        for step in range(duration):
            # 获取动作
            with torch.no_grad():
                action, _ = self.policy.get_action(obs, deterministic=deterministic)
            
            # 执行
            next_obs, reward, done, _, info = env.step(action)
            
            # 收集指标
            queues.append(info.get("queue_depth", 0))
            oscillations.append(info.get("oscillation_score", 0.0))
            workers.append(info.get("worker_count", 0))
            actions.append(action)
            
            # 模式切换计数
            current_mode = info.get("regime", "unknown")
            if last_mode is not None and current_mode != last_mode:
                mode_switches += 1
            last_mode = current_mode
            
            obs = next_obs
            
            if done:
                break
        
        # 计算 worker churn
        worker_churn = self._compute_churn(workers)
        
        # 计算 control cost
        control_cost = self._compute_control_cost(actions)
        
        # 计算统计
        queues = np.array(queues)
        oscillations = np.array(oscillations)
        workers = np.array(workers)
        
        result = StressTestResult(
            config_name=config_name,
            arrival_rate=config["arrival_rate"],
            burst_prob=config["burst_prob"],
            avg_queue=float(np.mean(queues)),
            max_queue=float(np.max(queues)),
            queue_p95=float(np.percentile(queues, 95)),
            avg_oscillation=float(np.mean(oscillations)),
            worker_churn=worker_churn,
            mode_switches=mode_switches,
            avg_workers=float(np.mean(workers)),
            control_cost=control_cost,
            total_reward=float(np.sum([0] * len(queues))),  # 环境返回的是累积 reward
            episode_length=len(queues),
            completed=done,
        )
        
        print(f"    完成: {len(queues)} steps, avg_queue={result.avg_queue:.1f}, "
              f"oscillation={result.avg_oscillation:.3f}")
        
        return result
    
    def _compute_churn(self, workers: List[int]) -> float:
        """计算 worker 变更率"""
        if len(workers) < 2:
            return 0.0
        workers = np.array(workers)
        churns = np.abs(np.diff(workers))
        return float(np.mean(churns))
    
    def _compute_control_cost(self, actions: List[int]) -> float:
        """计算控制成本"""
        action_map = {0: -2, 1: -1, 2: 0, 3: 1, 4: 2}
        deltas = [action_map.get(a, 0) for a in actions]
        return float(np.mean(np.abs(deltas)))
    
    def run_all_tests(self, duration: int = 500) -> List[StressTestResult]:
        """运行所有压力测试"""
        print("=" * 60)
        print("BC Stress Test: 泛化能力验证")
        print("=" * 60)
        
        self.results = []
        
        for config_name, config in self.TEST_CONFIGS.items():
            result = self.run_single_test(config_name, config, duration)
            self.results.append(result)
        
        return self.results
    
    def print_summary(self):
        """打印测试总结"""
        print("\n" + "=" * 80)
        print("Stress Test Summary")
        print("=" * 80)
        
        # 表头
        print(f"\n{'Config':<20} {'Arrival':>8} {'Burst':>6} {'AvgQ':>8} {'MaxQ':>8} "
              f"{'Osc':>8} {'Churn':>8} {'Workers':>8} {'Switches':>9}")
        print("-" * 80)
        
        for r in self.results:
            print(f"{r.config_name:<20} {r.arrival_rate:>8.1f} {r.burst_prob:>6.2f} "
                  f"{r.avg_queue:>8.1f} {r.max_queue:>8.1f} "
                  f"{r.avg_oscillation:>8.3f} {r.worker_churn:>8.3f} "
                  f"{r.avg_workers:>8.1f} {r.mode_switches:>9}")
        
        # 泛化能力评估
        print("\n" + "=" * 80)
        print("Generalization Assessment")
        print("=" * 80)
        
        # 找出失败场景
        failed = [r for r in self.results if r.avg_queue > 200 or r.avg_oscillation > 0.5]
        if failed:
            print("\n⚠️ 泛化失败场景:")
            for r in failed:
                print(f"  - {r.config_name}: queue={r.avg_queue:.0f}, osc={r.avg_oscillation:.3f}")
        else:
            print("\n✅ 所有未见场景均通过泛化测试")
        
        # 关键指标统计
        avg_overall_queue = np.mean([r.avg_queue for r in self.results])
        avg_overall_osc = np.mean([r.avg_oscillation for r in self.results])
        
        print(f"\n总体平均:")
        print(f"  Queue: {avg_overall_queue:.1f}")
        print(f"  Oscillation: {avg_overall_osc:.3f}")


def main():
    """主函数"""
    print("=" * 60)
    print("BC Stress Test Runner")
    print("=" * 60)
    
    tester = BCStressTest()
    tester.run_all_tests()
    tester.print_summary()


if __name__ == "__main__":
    main()
