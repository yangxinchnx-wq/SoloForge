# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime Simulator: 运行时世界模拟器
# Path: python/training/simulator/runtime_simulator.py
#
# 目标：让 Runtime 世界第一次动起来
# 验证：Rule Governor 是否会自激振荡
# ─────────────────────────────────────────────────────────────────

import sys
import os
import time
import random
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


@dataclass
class RuntimeState:
    """运行时状态快照"""
    tick: int = 0
    queue_depth: int = 0
    cpu_usage: float = 0.0
    token_pressure: float = 0.0
    reflection_load: float = 0.0
    worker_count: int = 4
    active_agents: int = 0

    # 历史记录（用于检测振荡）
    action_history: List[str] = field(default_factory=list)
    queue_history: List[int] = field(default_factory=list)
    worker_history: List[int] = field(default_factory=list)


@dataclass
class WorkloadProfile:
    """工作负载配置"""
    base_arrival_rate: float = 10.0      # 基础任务到达率
    burst_probability: float = 0.05      # 突发概率
    burst_multiplier: float = 5.0        # 突发倍数
    task_complexity_mean: float = 1.0     # 平均任务复杂度


class RuntimeSimulator:
    """
    运行时世界模拟器

    核心思想：事件驱动世界模拟
    - 不模拟 LLM
    - 只模拟 Runtime Physics
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self.tick_interval = self.config.get('tick_interval', 0.1) if isinstance(self.config, dict) else 0.1  # 秒

        # 初始化状态
        self.state = RuntimeState()

        # 工作负载生成器
        if isinstance(self.config, dict):
            self.workload = WorkloadProfile(
                base_arrival_rate=self.config.get('arrival_rate', 10.0),
                burst_probability=self.config.get('burst_prob', 0.05),
                burst_multiplier=self.config.get('burst_mult', 5.0),
            )
        else:
            self.workload = WorkloadProfile()

        # 当前突发状态
        self._in_burst = False
        self._burst_ticks_remaining = 0

        # 运行控制
        self._running = False
        self._tick_count = 0

        print("[Simulator] Runtime Simulator 初始化完成")

    def reset(self) -> RuntimeState:
        """重置到初始状态"""
        self.state = RuntimeState()
        self._in_burst = False
        self._burst_ticks_remaining = 0
        return self.state

    def tick(self) -> RuntimeState:
        """
        模拟一个时间步

        执行顺序：
        1. 生成新任务
        2. Governor 处理
        3. 执行动作
        4. 更新状态
        5. 收集遥测
        """
        self._tick_count += 1
        self.state.tick = self._tick_count

        # 1. 生成新任务
        new_tasks = self._generate_workload()
        self.state.queue_depth += new_tasks

        # 2. Governor 决策（子类实现）
        action = self.governor_decide()

        # 3. 执行动作
        self._apply_action(action)

        # 4. 处理已有任务
        self._process_tasks()

        # 5. 收集遥测
        self._collect_telemetry()

        return self.state

    def _generate_workload(self) -> int:
        """生成工作负载"""
        # 突发处理
        if self._in_burst:
            self._burst_ticks_remaining -= 1
            if self._burst_ticks_remaining <= 0:
                self._in_burst = False
            arrival = self.workload.base_arrival_rate * self.workload.burst_multiplier
        else:
            # 随机突发
            if random.random() < self.workload.burst_probability:
                self._in_burst = True
                self._burst_ticks_remaining = random.randint(5, 20)
                arrival = self.workload.base_arrival_rate * self.workload.burst_multiplier
            else:
                arrival = self.workload.base_arrival_rate

        # Poisson 分布
        return max(0, int(random.gauss(arrival, arrival * 0.3)))

    def governor_decide(self) -> str:
        """
        Governor 决策
        子类重写此方法实现不同的 Governor 策略
        """
        return "no_op"

    def _apply_action(self, action: str) -> None:
        """应用 Governor 决策"""
        self.state.action_history.append(action)

        if action == "spawn_worker":
            self.state.worker_count += 1
        elif action == "reduce_workers":
            self.state.worker_count = max(1, self.state.worker_count - 1)
        elif action == "enable_reflection":
            self.state.reflection_load = min(1.0, self.state.reflection_load + 0.2)
        elif action == "disable_reflection":
            self.state.reflection_load = max(0.0, self.state.reflection_load - 0.2)
        elif action == "compress_context":
            # 模拟上下文压缩效果
            self.state.token_pressure *= 0.7

    def _process_tasks(self) -> None:
        """处理队列中的任务"""
        # 处理能力 = worker_count * base_rate
        capacity = self.state.worker_count * 2
        processed = min(capacity, self.state.queue_depth)
        self.state.queue_depth -= processed

        # 模拟 CPU 负载
        base_cpu = self.state.queue_depth / 100.0  # 队列越深，CPU 越高
        worker_cpu = self.state.worker_count * 0.05
        self.state.cpu_usage = min(1.0, base_cpu + worker_cpu)

        # 模拟 Token 压力
        base_token = self.state.queue_depth / 200.0
        reflection_token = self.state.reflection_load * 0.2
        self.state.token_pressure = min(1.0, base_token + reflection_token)

        # 活跃 Agent 数
        self.state.active_agents = min(self.state.worker_count, self.state.queue_depth)

    def _collect_telemetry(self) -> None:
        """收集遥测数据"""
        # 记录历史（用于振荡检测）
        self.state.queue_history.append(self.state.queue_depth)
        self.state.worker_history.append(self.state.worker_count)

        # 限制历史长度
        if len(self.state.queue_history) > 1000:
            self.state.queue_history = self.state.queue_history[-500:]
        if len(self.state.worker_history) > 1000:
            self.state.worker_history = self.state.worker_history[-500:]
        if len(self.state.action_history) > 100:
            self.state.action_history = self.state.action_history[-50:]

    def get_observation(self) -> Dict[str, Any]:
        """
        获取当前观测

        这是神经网络会看到的状态
        """
        return {
            # 原始状态
            "queue_depth": self.state.queue_depth,
            "cpu_usage": self.state.cpu_usage,
            "token_pressure": self.state.token_pressure,
            "reflection_load": self.state.reflection_load,
            "worker_count": self.state.worker_count,
            "active_agents": self.state.active_agents,

            # 时间序列特征（用于检测趋势和振荡）
            "queue_trend": self._compute_trend(self.state.queue_history[-10:]) if len(self.state.queue_history) >= 10 else 0.0,
            "worker_trend": self._compute_trend(self.state.worker_history[-10:]) if len(self.state.worker_history) >= 10 else 0.0,
            "queue_variance": self._compute_variance(self.state.queue_history[-20:]) if len(self.state.queue_history) >= 20 else 0.0,
            "worker_variance": self._compute_variance(self.state.worker_history[-20:]) if len(self.state.worker_history) >= 20 else 0.0,
        }

    def _compute_trend(self, values: List[float]) -> float:
        """计算趋势（简单线性回归斜率）"""
        if len(values) < 2:
            return 0.0
        n = len(values)
        mean_x = (n - 1) / 2.0
        mean_y = sum(values) / n
        cov = sum((i - mean_x) * (v - mean_y) for i, v in enumerate(values))
        var_x = sum((i - mean_x) ** 2 for i in range(n))
        if var_x == 0:
            return 0.0
        return cov / var_x

    def _compute_variance(self, values: List[float]) -> float:
        """计算方差"""
        if len(values) < 2:
            return 0.0
        mean = sum(values) / len(values)
        return sum((v - mean) ** 2 for v in values) / len(values)

    def get_oscillation_score(self) -> float:
        """
        计算振荡分数

        高的振荡分数意味着 Governor 决策不稳定
        """
        if len(self.state.action_history) < 10:
            return 0.0

        # 检测 worker_count 变化频率
        recent_workers = self.state.worker_history[-20:]
        changes = sum(1 for i in range(1, len(recent_workers)) if recent_workers[i] != recent_workers[i-1])

        # 检测 action 切换频率
        recent_actions = self.state.action_history[-20:]
        action_changes = sum(1 for i in range(1, len(recent_actions)) if recent_actions[i] != recent_actions[i-1])

        return (changes + action_changes) / 20.0

    def get_queue_recovery_rate(self) -> float:
        """
        计算队列恢复率

        正数 = 队列在减少
        负数 = 队列在增加
        """
        if len(self.state.queue_history) < 10:
            return 0.0

        recent = self.state.queue_history[-10:]
        return self._compute_trend(recent)

    def run(self, duration_ticks: int = 1000, callback=None) -> None:
        """
        运行模拟

        Args:
            duration_ticks: 运行多少个时间步
            callback: 每 tick 调用的回调函数
        """
        self._running = True
        self._tick_count = 0

        print(f"[Simulator] 开始运行，{duration_ticks} ticks")

        for i in range(duration_ticks):
            if not self._running:
                break

            state = self.tick()

            if callback:
                callback(state)

            if i % 100 == 0:
                print(f"[Simulator] Tick {i}: queue={state.queue_depth}, workers={state.worker_count}, "
                      f"cpu={state.cpu_usage:.2f}, oscillation={self.get_oscillation_score():.3f}")

        print(f"[Simulator] 运行结束，共 {self._tick_count} ticks")

    def stop(self) -> None:
        """停止模拟"""
        self._running = False


class RuleGovernorSimulator(RuntimeSimulator):
    """
    基于规则的 Governor 模拟器

    策略：
    - 队列 > 100 → 扩容
    - 队列 < 30 → 缩容
    - CPU > 0.8 → 禁用 Reflection
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        super().__init__(config)

        # Governor 参数
        self.queue_high = self.config.get('queue_high', 100)
        self.queue_low = self.config.get('queue_low', 30)
        self.cpu_threshold = self.config.get('cpu_threshold', 0.8)

        print(f"[Rule Governor] 初始化完成: high={self.queue_high}, low={self.queue_low}, cpu={self.cpu_threshold}")

    def governor_decide(self) -> str:
        """基于规则的 Governor 决策"""

        # 优先级1：CPU 过高 → 禁用 Reflection
        if self.state.cpu_usage > self.cpu_threshold:
            if self.state.reflection_load > 0.1:
                return "disable_reflection"

        # 优先级2：队列过高 → 扩容
        if self.state.queue_depth > self.queue_high:
            return "spawn_worker"

        # 优先级3：队列过低 → 缩容
        if self.state.queue_depth < self.queue_low and self.state.worker_count > 2:
            return "reduce_workers"

        # 优先级4：Reflection 长期被禁用 → 重新启用
        recent_actions = self.state.action_history[-20:]
        suppress_count = sum(1 for a in recent_actions if a == "disable_reflection")
        if suppress_count > 15 and self.state.cpu_usage < 0.5:
            return "enable_reflection"

        return "no_op"


def main():
    """主函数：演示 Rule Governor 的自激振荡"""
    print("=" * 60)
    print("SoloForge Runtime Simulator - Rule Governor 振荡测试")
    print("=" * 60)

    # 创建带突发负载的模拟器
    config = {
        'arrival_rate': 15.0,
        'burst_prob': 0.15,      # 较高突发概率
        'burst_mult': 8.0,       # 较大突发倍数
        'queue_high': 100,
        'queue_low': 30,
        'cpu_threshold': 0.8,
    }

    simulator = RuleGovernorSimulator(config)

    # 运行 500 ticks，收集统计
    stats = {
        'max_queue': 0,
        'max_workers': 0,
        'min_workers': 999,
        'oscillation_scores': [],
    }

    def collect_stats(state: RuntimeState):
        stats['max_queue'] = max(stats['max_queue'], state.queue_depth)
        stats['max_workers'] = max(stats['max_workers'], state.worker_count)
        stats['min_workers'] = min(stats['min_workers'], state.worker_count)
        stats['oscillation_scores'].append(simulator.get_oscillation_score())

    simulator.run(duration_ticks=500, callback=collect_stats)

    # 输出统计
    print("\n" + "=" * 60)
    print("模拟统计")
    print("=" * 60)
    print(f"最大队列深度: {stats['max_queue']}")
    print(f"最大 Worker 数: {stats['max_workers']}")
    print(f"最小 Worker 数: {stats['min_workers']}")
    print(f"平均振荡分数: {sum(stats['oscillation_scores']) / len(stats['oscillation_scores']):.3f}")
    print(f"最终振荡分数: {stats['oscillation_scores'][-1]:.3f}")

    # 振荡检测
    avg_osc = sum(stats['oscillation_scores']) / len(stats['oscillation_scores'])
    if avg_osc > 0.3:
        print("\n⚠️  检测到高振荡！Rule Governor 正在自激振荡")
        print("   这证明了：需要 PPO 学习更稳定的控制策略")
    else:
        print("\n✅ 系统运行稳定")


if __name__ == '__main__':
    main()
