# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Shadow Evaluator
# Path: python/governor_rl/training/shadow_evaluator.py
#
# Shadow PPO: 不执行，只预测和比较
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import numpy as np
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass

# 设置 UTF-8
sys.stdout.reconfigure(encoding='utf-8')

# 添加路径
script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.env import ACTION_MAP, RuntimeEnvFactory


@dataclass
class ShadowComparison:
    """Shadow 比较结果"""
    tick: int
    obs: np.ndarray
    teacher_action: int
    ppo_action: int
    action_diverged: bool
    teacher_reward: float
    ppo_reward: float
    reward_gap: float


@dataclass
class ShadowEvaluationResult:
    """Shadow 评估结果"""
    total_steps: int
    divergence_count: int
    divergence_rate: float
    avg_reward_gap: float
    ppo_better_count: int
    teacher_better_count: int
    comparisons: List[ShadowComparison]


class ShadowEvaluator:
    """
    Shadow Evaluator

    Shadow PPO 不接管 Runtime，只和 Teacher 比较
    """

    def __init__(self, ppo_policy: PolicyNetwork):
        self.ppo_policy = ppo_policy
        self.ppo_policy.eval()

        # 比较结果
        self.comparisons = []

    def evaluate_episode(
        self,
        env_config: Dict = None,
        teacher=None,
        max_steps: int = 500,
    ) -> ShadowEvaluationResult:
        """
        评估一个 episode

        Args:
            env_config: 环境配置
            teacher: Teacher Governor (可选)
            max_steps: 最大步数

        Returns:
            ShadowEvaluationResult
        """
        # 创建环境
        env = RuntimeEnvFactory.create(
            arrival_rate=env_config.get("arrival_rate", 15.0) if env_config else 15.0,
            burst_prob=env_config.get("burst_prob", 0.15) if env_config else 0.15,
            duration=max_steps,
        )

        obs, _ = env.reset()
        self.comparisons = []

        divergence_count = 0
        total_reward_gap = 0.0
        ppo_better_count = 0
        teacher_better_count = 0

        for step in range(max_steps):
            # PPO 预测动作
            ppo_action, _ = self.ppo_policy.get_action(obs, deterministic=True)

            # Teacher 动作 (如果有)
            if teacher is not None:
                teacher_action = self._get_teacher_action(teacher, obs)
            else:
                teacher_action = ppo_action  # 没有 Teacher 就用 PPO 的

            # 检查 divergence
            action_diverged = ppo_action != teacher_action

            if action_diverged:
                divergence_count += 1

            # 执行 PPO 动作
            next_obs, ppo_reward, done, _, info = env.step(ppo_action)

            # 计算 Teacher reward (使用相同的 observation)
            teacher_reward = self._compute_teacher_reward(teacher_action, info)

            # 计算 reward gap
            reward_gap = ppo_reward - teacher_reward
            total_reward_gap += abs(reward_gap)

            if reward_gap > 0:
                ppo_better_count += 1
            else:
                teacher_better_count += 1

            # 记录比较
            self.comparisons.append(ShadowComparison(
                tick=step,
                obs=obs.copy(),
                teacher_action=teacher_action,
                ppo_action=ppo_action,
                action_diverged=action_diverged,
                teacher_reward=teacher_reward,
                ppo_reward=ppo_reward,
                reward_gap=reward_gap,
            ))

            obs = next_obs

            if done:
                break

        # 汇总结果
        total_steps = len(self.comparisons)
        return ShadowEvaluationResult(
            total_steps=total_steps,
            divergence_count=divergence_count,
            divergence_rate=divergence_count / max(1, total_steps),
            avg_reward_gap=total_reward_gap / max(1, total_steps),
            ppo_better_count=ppo_better_count,
            teacher_better_count=teacher_better_count,
            comparisons=self.comparisons,
        )

    def _get_teacher_action(self, teacher, obs: np.ndarray) -> int:
        """从 Teacher 获取动作"""
        # Teacher 使用自己的逻辑
        # 这里简化：用规则映射
        if hasattr(teacher, "governor_decide"):
            action = teacher.governor_decide()
            action_to_id = {
                "spawn_worker": 3,
                "reduce_workers": 1,
                "no_op": 2,
            }
            return action_to_id.get(action, 2)
        return 2  # 默认 no_op

    def _compute_teacher_reward(self, action: int, info: Dict) -> float:
        """计算 Teacher reward"""
        # 简化的 reward 计算
        queue = info.get("queue_depth", 0)
        osc = info.get("oscillation_score", 0.0)

        action_delta = ACTION_MAP.get(action, 0)

        reward = (
            -queue * 0.01
            -osc * 0.1
            -abs(action_delta) * 0.02
        )

        return reward

    def print_summary(self, result: ShadowEvaluationResult):
        """打印评估结果"""
        print("\n" + "=" * 60)
        print("Shadow Evaluation Summary")
        print("=" * 60)
        print(f"Total Steps: {result.total_steps}")
        print(f"Divergence Rate: {result.divergence_rate:.1%}")
        print(f"PPO Better: {result.ppo_better_count} ({result.ppo_better_count/max(1,result.total_steps):.1%})")
        print(f"Teacher Better: {result.teacher_better_count} ({result.teacher_better_count/max(1,result.total_steps):.1%})")
        print(f"Avg Reward Gap: {result.avg_reward_gap:.3f}")

        if result.divergence_rate < 0.1:
            print("\n✅ PPO 表现接近 Teacher")
        elif result.divergence_rate < 0.3:
            print("\n⚠️ PPO 与 Teacher 有一定差异")
        else:
            print("\n❌ PPO 与 Teacher 差异较大，需要更多训练")


def main():
    """主函数：演示 Shadow Evaluation"""
    print("=" * 60)
    print("Shadow Evaluator Demo")
    print("=" * 60)

    # 加载预训练模型 (v3)
    print("\n[1] 加载 Policy Network...")
    policy = PolicyNetwork()

    # 优先加载 v3, 然后是 v2, 最后是原始
    checkpoint_paths = [
        "checkpoints/bc_policy_v3.pt",
        "checkpoints/bc_policy_v2.pt",
        "checkpoints/bc_policy.pt",
    ]
    loaded = False
    for ckpt_path in checkpoint_paths:
        if os.path.exists(ckpt_path):
            checkpoint = torch.load(ckpt_path)
            policy.load_state_dict(checkpoint["policy_state_dict"])
            print(f"  模型已加载: {ckpt_path}")
            loaded = True
            break
    if not loaded:
        print("  警告: 未找到预训练模型，使用随机初始化")

    # 创建 Shadow Evaluator
    print("\n[2] 创建 Shadow Evaluator...")
    evaluator = ShadowEvaluator(policy)

    # 评估
    print("\n[3] 评估...")
    result = evaluator.evaluate_episode(
        env_config={"arrival_rate": 15.0, "burst_prob": 0.15},
        max_steps=200,
    )

    # 打印结果
    evaluator.print_summary(result)


if __name__ == "__main__":
    main()
