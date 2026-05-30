# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Collapse Classification
# Path: experiments/collapse_analysis/classify.py
#
# Sprint 1: Collapse Forensics
# 目标：解释清楚 80% collapse 是什么
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import numpy as np
from typing import Dict, List, Tuple, Optional
from enum import Enum
from dataclasses import dataclass, field
from collections import Counter
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))
sys.path.insert(0, python_dir)


class CollapseType(Enum):
    """Collapse 类型"""
    QUEUE_OVERFLOW = "QUEUE_OVERFLOW"
    WORKER_STARVATION = "WORKER_STARVATION"
    RESOURCE_EXHAUSTION = "RESOURCE_EXHAUSTION"
    ACTION_OSCILLATION = "ACTION_OSCILLATION"
    POLICY_FREEZE = "POLICY_FREEZE"
    UNKNOWN = "UNKNOWN"


@dataclass
class CollapseEvent:
    """Collapse 事件"""
    episode: int
    tick: int
    collapse_type: CollapseType
    max_queue: int
    min_workers: int
    final_queue: int
    final_workers: int
    last_actions: List[int] = field(default_factory=list)
    last_rewards: List[float] = field(default_factory=list)
    queue_trace: List[int] = field(default_factory=list)
    worker_trace: List[int] = field(default_factory=list)
    action_trace: List[int] = field(default_factory=list)
    reward_trace: List[float] = field(default_factory=list)


@dataclass
class CollapseStats:
    """Collapse 统计"""
    total_episodes: int
    collapsed_episodes: int
    collapse_rate: float
    type_distribution: Dict[str, int]
    type_rates: Dict[str, float]
    tick_to_collapse: Dict[str, float]  # P50, P90, P99
    bc_stats: Dict = field(default_factory=dict)
    ppo_stats: Dict = field(default_factory=list)


class CollapseClassifier:
    """
    Collapse 分类器

    分析每个 episode 的 collapse 原因
    """

    # 阈值
    QUEUE_OVERFLOW_THRESHOLD = 5000
    WORKER_STARVATION_THRESHOLD = 1
    ACTION_OSCILLATION_SWITCH_RATE = 0.5  # 50% 动作切换
    POLICY_FREEZE_THRESHOLD = 0.1  # 10% 以下 action 变化

    def __init__(self):
        self.collapse_events: List[CollapseEvent] = []
        self.oscillation_window = 20  # 用于检测 oscillation 的窗口

    def classify_episode(
        self,
        episode_id: int,
        queue_history: List[int],
        worker_history: List[int],
        action_history: List[int],
        reward_history: List[float],
        max_queue: int = 5000,
        duration: int = 500,
    ) -> Optional[CollapseEvent]:
        """
        分类单个 episode

        Returns:
            CollapseEvent if collapsed, None otherwise
        """
        if len(queue_history) < 10:
            return None

        final_queue = queue_history[-1] if queue_history else 0
        min_workers = min(worker_history) if worker_history else 0

        # 检查是否 collapsed
        # 条件1: queue > threshold
        # 条件2: queue 持续增长到结尾
        if max_queue < self.QUEUE_OVERFLOW_THRESHOLD:
            # 检查 queue 是否持续增长
            if len(queue_history) >= 50:
                last_50 = queue_history[-50:]
                if last_50[-1] > last_50[0] * 1.5:  # 增长 50%
                    if final_queue > 2000:  # 最终队列仍然很高
                        pass  # 可能是 collapse

        # 判断是否真正 collapse
        is_collapsed = final_queue > 3000 or max_queue > 4000

        if not is_collapsed:
            return None

        # 分类 collapse 类型
        collapse_type = self._determine_collapse_type(
            queue_history=queue_history,
            worker_history=worker_history,
            action_history=action_history,
            reward_history=reward_history,
        )

        tick = len(queue_history) - 1

        event = CollapseEvent(
            episode=episode_id,
            tick=tick,
            collapse_type=collapse_type,
            max_queue=max_queue,
            min_workers=min_workers,
            final_queue=final_queue,
            final_workers=worker_history[-1] if worker_history else 0,
            last_actions=action_history[-20:] if len(action_history) >= 20 else action_history,
            last_rewards=reward_history[-20:] if len(reward_history) >= 20 else reward_history,
            queue_trace=queue_history,
            worker_trace=worker_history,
            action_trace=action_history,
            reward_trace=reward_history,
        )

        self.collapse_events.append(event)
        return event

    def _determine_collapse_type(
        self,
        queue_history: List[int],
        worker_history: List[int],
        action_history: List[int],
        reward_history: List[float],
    ) -> CollapseType:
        """判断 collapse 类型"""

        scores = {}

        # 1. QUEUE_OVERFLOW
        if queue_history[-1] > 4000:
            scores[CollapseType.QUEUE_OVERFLOW] = 0.8
        elif max(queue_history[-100:]) > 3000:
            scores[CollapseType.QUEUE_OVERFLOW] = 0.6
        else:
            scores[CollapseType.QUEUE_OVERFLOW] = 0.3

        # 2. WORKER_STARVATION
        if min(worker_history) == 0:
            scores[CollapseType.WORKER_STARVATION] = 0.9
        elif min(worker_history) <= 2:
            scores[CollapseType.WORKER_STARVATION] = 0.6
        else:
            scores[CollapseType.WORKER_STARVATION] = 0.1

        # 3. ACTION_OSCILLATION - 检测 +2/-2 快速切换
        if len(action_history) >= 20:
            recent_actions = action_history[-20:]
            switch_count = sum(
                1 for i in range(1, len(recent_actions))
                if recent_actions[i] != recent_actions[i-1]
            )
            switch_rate = switch_count / (len(recent_actions) - 1)

            # 检测 +2/-2 交替
            has_alternation = False
            for i in range(len(recent_actions) - 1):
                if (recent_actions[i] == 4 and recent_actions[i+1] == 0) or \
                   (recent_actions[i] == 0 and recent_actions[i+1] == 4):
                    has_alternation = True
                    break

            if has_alternation and switch_rate > 0.3:
                scores[CollapseType.ACTION_OSCILLATION] = 0.9
            elif switch_rate > 0.5:
                scores[CollapseType.ACTION_OSCILLATION] = 0.7
            elif switch_rate > 0.3:
                scores[CollapseType.ACTION_OSCILLATION] = 0.4
            else:
                scores[CollapseType.ACTION_OSCILLATION] = 0.2
        else:
            scores[CollapseType.ACTION_OSCILLATION] = 0.1

        # 4. POLICY_FREEZE - 检测是否一直输出同一个 action
        if len(action_history) >= 50:
            action_counter = Counter(action_history)
            most_common_count = action_counter.most_common(1)[0][1]
            freeze_ratio = most_common_count / len(action_history)

            if freeze_ratio > 0.95:
                scores[CollapseType.POLICY_FREEZE] = 0.9
            elif freeze_ratio > 0.85:
                scores[CollapseType.POLICY_FREEZE] = 0.6
            else:
                scores[CollapseType.POLICY_FREEZE] = 0.2
        else:
            scores[CollapseType.POLICY_FREEZE] = 0.1

        # 5. RESOURCE_EXHAUSTION - 检测 CPU/memory 相关（如果有数据）
        scores[CollapseType.RESOURCE_EXHAUSTION] = 0.1

        # 选择得分最高的类型
        max_score = max(scores.values())
        for collapse_type, score in scores.items():
            if score == max_score:
                return collapse_type

        return CollapseType.UNKNOWN

    def compute_stats(self) -> CollapseStats:
        """计算统计"""
        total = len(self.collapse_events)

        if total == 0:
            return CollapseStats(
                total_episodes=0,
                collapsed_episodes=0,
                collapse_rate=0.0,
                type_distribution={},
                type_rates={},
                tick_to_collapse={},
                bc_stats={},
                ppo_stats={},
            )

        # 类型分布
        type_counter = Counter(e.collapse_type for e in self.collapse_events)
        type_distribution = {t.value: c for t, c in type_counter.items()}
        type_rates = {t.value: c/total for t, c in type_counter.items()}

        # Tick-to-collapse 分布
        ticks = sorted([e.tick for e in self.collapse_events])
        if ticks:
            p50 = np.percentile(ticks, 50)
            p90 = np.percentile(ticks, 90)
            p99 = np.percentile(ticks, 99)
            tick_stats = {
                "P50": float(p50),
                "P90": float(p90),
                "P99": float(p99),
                "min": float(min(ticks)),
                "max": float(max(ticks)),
            }
        else:
            tick_stats = {}

        return CollapseStats(
            total_episodes=total,  # 注意：这个是 collapse 的数量
            collapsed_episodes=total,
            collapse_rate=1.0,  # 这些都是 collapse episodes
            type_distribution=type_distribution,
            type_rates=type_rates,
            tick_to_collapse=tick_stats,
            bc_stats={},
            ppo_stats={},
        )

    def get_top_traces(self, n: int = 10) -> List[Dict]:
        """获取 Top N collapse trace"""
        # 按 max_queue 排序
        sorted_events = sorted(
            self.collapse_events,
            key=lambda e: e.max_queue,
            reverse=True
        )

        traces = []
        for i, event in enumerate(sorted_events[:n]):
            traces.append({
                "rank": i + 1,
                "episode": event.episode,
                "collapse_type": event.collapse_type.value,
                "tick": event.tick,
                "max_queue": event.max_queue,
                "min_workers": event.min_workers,
                "final_queue": event.final_queue,
                "final_workers": event.final_workers,
                "last_actions": event.last_actions,
                "action_switch_rate": self._compute_switch_rate(event.action_trace),
                "queue_trend": self._compute_queue_trend(event.queue_trace),
            })

        return traces

    def _compute_switch_rate(self, actions: List[int]) -> float:
        """计算 action 切换率"""
        if len(actions) < 2:
            return 0.0
        switches = sum(
            1 for i in range(1, len(actions))
            if actions[i] != actions[i-1]
        )
        return switches / (len(actions) - 1)

    def _compute_queue_trend(self, queue: List[int]) -> str:
        """计算队列趋势"""
        if len(queue) < 10:
            return "unknown"

        recent = queue[-10:]
        if all(recent[i] >= recent[i-1] for i in range(1, len(recent))):
            return "increasing"
        elif all(recent[i] <= recent[i-1] for i in range(1, len(recent))):
            return "decreasing"
        else:
            return "oscillating"

    def save_report(self, output_dir: str = "experiments/collapse_analysis"):
        """保存报告"""
        os.makedirs(output_dir, exist_ok=True)

        stats = self.compute_stats()
        top_traces = self.get_top_traces()

        report = {
            "timestamp": datetime.now().isoformat(),
            "total_collapse_events": len(self.collapse_events),
            "type_distribution": stats.type_distribution,
            "type_rates": stats.type_rates,
            "tick_to_collapse": stats.tick_to_collapse,
            "top_traces": top_traces,
        }

        # 保存 JSON
        report_path = os.path.join(output_dir, "collapse_report.json")
        with open(report_path, 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        print(f"Report saved: {report_path}")

        # 保存 top traces 的详细数据
        for i, trace in enumerate(top_traces[:5]):
            event = self.collapse_events[trace["episode"]]
            example = {
                "rank": i + 1,
                "collapse_type": trace["collapse_type"],
                "episode": trace["episode"],
                "tick": trace["tick"],
                "queue_trace": event.queue_trace[-100:],
                "worker_trace": event.worker_trace[-100:],
                "action_trace": event.action_trace[-100:],
                "reward_trace": event.reward_trace[-100:] if event.reward_trace else [],
            }
            example_path = os.path.join(output_dir, "collapse_examples", f"collapse_{i+1}.json")
            with open(example_path, 'w', encoding='utf-8') as f:
                json.dump(example, f, indent=2, ensure_ascii=False)

        print(f"Examples saved: {output_dir}/collapse_examples/")

        return report

    def generate_dashboard(self, output_dir: str = "experiments/collapse_analysis"):
        """生成 Markdown Dashboard"""
        stats = self.compute_stats()
        top_traces = self.get_top_traces()

        dashboard = f"""# Collapse Analysis Dashboard

Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## Summary

- **Total Collapse Events**: {len(self.collapse_events)}
- **Collapse Rate**: {stats.collapse_rate:.1%}

## Q1: Collapse Type Distribution

| Type | Count | Rate |
|------|-------|------|
"""

        for collapse_type in CollapseType:
            count = stats.type_distribution.get(collapse_type.value, 0)
            rate = stats.type_rates.get(collapse_type.value, 0)
            dashboard += f"| {collapse_type.value} | {count} | {rate:.1%} |\n"

        dashboard += f"""
## Q2: Tick-to-Collapse Distribution

| Percentile | Tick |
|------------|------|
| P50 | {stats.tick_to_collapse.get('P50', 0):.0f} |
| P90 | {stats.tick_to_collapse.get('P90', 0):.0f} |
| P99 | {stats.tick_to_collapse.get('P99', 0):.0f} |
| Min | {stats.tick_to_collapse.get('min', 0):.0f} |
| Max | {stats.tick_to_collapse.get('max', 0):.0f} |

## Q3: Top 10 Collapse Traces

| Rank | Type | Episode | Tick | Max Queue | Final Queue | Switch Rate |
|------|------|---------|------|-----------|-------------|-------------|
"""

        for trace in top_traces:
            dashboard += f"| {trace['rank']} | {trace['collapse_type']} | {trace['episode']} | {trace['tick']} | {trace['max_queue']} | {trace['final_queue']} | {trace['action_switch_rate']:.2f} |\n"

        dashboard += """
## Root Cause Hypotheses

Based on the analysis above:

### Hypothesis 1: [To be filled after review]

### Hypothesis 2: [To be filled after review]

### Hypothesis 3: [To be filled after review]
"""

        dashboard_path = os.path.join(output_dir, "collapse_dashboard.md")
        with open(dashboard_path, 'w', encoding='utf-8') as f:
            f.write(dashboard)
        print(f"Dashboard saved: {dashboard_path}")

        return dashboard


def run_collapse_analysis(
    test_configs: List[Dict],
    bc_policy=None,
    ppo_policy=None,
    max_steps: int = 500,
    output_dir: str = "experiments/collapse_analysis",
) -> Dict:
    """
    运行完整的 Collapse 分析

    Args:
        test_configs: 测试配置
        bc_policy: BC 策略
        ppo_policy: PPO 策略
        max_steps: 最大步数
        output_dir: 输出目录

    Returns:
        分析报告
    """
    from governor_rl.env import RuntimeEnvFactory

    print("=" * 60)
    print("Collapse Forensics")
    print("=" * 60)

    # 创建分类器
    bc_classifier = CollapseClassifier()
    ppo_classifier = CollapseClassifier()

    # 运行 BC 测试
    print("\n[1] Running BC episodes...")
    bc_episodes = 0
    for i, config in enumerate(test_configs):
        env = RuntimeEnvFactory.create(
            arrival_rate=config["arrival_rate"],
            burst_prob=config["burst_prob"],
            duration=max_steps,
        )

        obs, _ = env.reset()
        bc_policy.eval()

        queue_history = []
        worker_history = []
        action_history = []
        reward_history = []
        max_queue = 0

        with torch.no_grad():
            for step in range(max_steps):
                action, _ = bc_policy.get_action(obs, deterministic=True)
                next_obs, _, done, _, info = env.step(action)

                queue_history.append(info.get("queue_depth", 0))
                worker_history.append(info.get("worker_count", 0))
                action_history.append(action)
                max_queue = max(max_queue, info.get("queue_depth", 0))

                obs = next_obs
                if done:
                    break

        # 分类
        event = bc_classifier.classify_episode(
            episode_id=i * 2,
            queue_history=queue_history,
            worker_history=worker_history,
            action_history=action_history,
            reward_history=reward_history,
            max_queue=max_queue,
            duration=max_steps,
        )
        bc_episodes += 1

    print(f"    BC episodes: {bc_episodes}")

    # 运行 PPO 测试
    print("\n[2] Running PPO episodes...")
    ppo_episodes = 0
    for i, config in enumerate(test_configs):
        env = RuntimeEnvFactory.create(
            arrival_rate=config["arrival_rate"],
            burst_prob=config["burst_prob"],
            duration=max_steps,
        )

        obs, _ = env.reset()
        ppo_policy.eval()

        queue_history = []
        worker_history = []
        action_history = []
        reward_history = []
        max_queue = 0

        with torch.no_grad():
            for step in range(max_steps):
                action, _ = ppo_policy.get_action(obs, deterministic=True)
                next_obs, _, done, _, info = env.step(action)

                queue_history.append(info.get("queue_depth", 0))
                worker_history.append(info.get("worker_count", 0))
                action_history.append(action)
                max_queue = max(max_queue, info.get("queue_depth", 0))

                obs = next_obs
                if done:
                    break

        # 分类
        event = ppo_classifier.classify_episode(
            episode_id=i * 2 + 1,
            queue_history=queue_history,
            worker_history=worker_history,
            action_history=action_history,
            reward_history=reward_history,
            max_queue=max_queue,
            duration=max_steps,
        )
        ppo_episodes += 1

    print(f"    PPO episodes: {ppo_episodes}")

    # 计算统计
    bc_stats = bc_classifier.compute_stats()
    ppo_stats = ppo_classifier.compute_stats()

    # Q4: BC vs PPO 崩溃对比
    print("\n[3] Generating comparison...")

    comparison = {
        "bc_collapse_count": len(bc_classifier.collapse_events),
        "ppo_collapse_count": len(ppo_classifier.collapse_events),
        "bc_type_distribution": bc_stats.type_distribution,
        "ppo_type_distribution": ppo_stats.type_distribution,
    }

    print("\n" + "=" * 60)
    print("Q4: BC vs PPO Collapse Comparison")
    print("=" * 60)

    print("\n| Type        | BC   | PPO  |")
    print("|-------------|------|------|")

    all_types = set(bc_stats.type_distribution.keys()) | set(ppo_stats.type_distribution.keys())
    for collapse_type in sorted(all_types):
        bc_count = bc_stats.type_distribution.get(collapse_type, 0)
        ppo_count = ppo_stats.type_distribution.get(collapse_type, 0)
        print(f"| {collapse_type:<11} | {bc_count:>4} | {ppo_count:>4} |")

    # 保存报告
    print("\n[4] Saving reports...")

    # 合并所有 collapse events
    all_classifier = CollapseClassifier()
    all_classifier.collapse_events = bc_classifier.collapse_events + ppo_classifier.collapse_events
    report = all_classifier.save_report(output_dir)

    # 添加对比数据
    report["bc_vs_ppo_comparison"] = comparison
    with open(os.path.join(output_dir, "collapse_report.json"), 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    # 生成 Dashboard
    dashboard = all_classifier.generate_dashboard(output_dir)

    print("\n✅ Collapse Analysis Complete")
    print(f"   Report: {output_dir}/collapse_report.json")
    print(f"   Dashboard: {output_dir}/collapse_dashboard.md")

    return report


if __name__ == "__main__":
    import torch
    from governor_rl.models import PolicyNetwork

    # 测试配置
    TEST_CONFIGS = [
        {"arrival_rate": 10.0, "burst_prob": 0.05, "name": "baseline"},
        {"arrival_rate": 25.0, "burst_prob": 0.20, "name": "high_load"},
        {"arrival_rate": 30.0, "burst_prob": 0.30, "name": "chaotic_spike"},
        {"arrival_rate": 15.0, "burst_prob": 0.15, "name": "worker_failure"},
        {"arrival_rate": 5.0, "burst_prob": 0.10, "name": "long_idle"},
    ]

    # 加载策略
    print("Loading policies...")

    bc_policy = PolicyNetwork()
    if os.path.exists("checkpoints/bc_policy.pt"):
        checkpoint = torch.load("checkpoints/bc_policy.pt", weights_only=False)
        bc_policy.load_state_dict(checkpoint["policy_state_dict"])

    ppo_policy = PolicyNetwork()
    if os.path.exists("checkpoints/ppo_policy.pt"):
        checkpoint = torch.load("checkpoints/ppo_policy.pt", weights_only=False)
        ppo_policy.load_state_dict(checkpoint["policy_state_dict"])

    # 运行分析
    run_collapse_analysis(
        test_configs=TEST_CONFIGS,
        bc_policy=bc_policy,
        ppo_policy=ppo_policy,
        max_steps=500,
    )
