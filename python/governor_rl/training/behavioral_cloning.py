# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Behavioral Cloning
# Path: python/governor_rl/training/behavioral_cloning.py
#
# 第一阶段：Imitation Learning
# 目标：让 PPO 学习成为 V3 的近似
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
import numpy as np
from typing import List, Dict, Tuple, Optional
import json

# 设置 UTF-8
sys.stdout.reconfigure(encoding='utf-8')

# 添加路径
script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.env import ACTION_MAP


class DemonstrationDataset(Dataset):
    """
    Teacher Demonstrations Dataset

    从 timeline JSONL 加载 demonstrations
    """

    def __init__(self, demonstrations: List[Dict]):
        self.demonstrations = demonstrations

    def __len__(self) -> int:
        return len(self.demonstrations)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        demo = self.demonstrations[idx]
        obs = torch.FloatTensor(demo["obs"])
        action = torch.LongTensor([demo["action"]])[0]
        return obs, action


class BehavioralCloning:
    """
    Behavioral Cloning Trainer

    使用 Teacher demonstrations 训练 Policy Network
    """

    def __init__(
        self,
        policy: PolicyNetwork = None,
        learning_rate: float = 3e-4,
        batch_size: int = 256,
        epochs: int = 10,
    ):
        self.policy = policy or PolicyNetwork()
        self.learning_rate = learning_rate
        self.batch_size = batch_size
        self.epochs = epochs

        self.optimizer = optim.Adam(self.policy.parameters(), lr=learning_rate)
        self.criterion = nn.CrossEntropyLoss()

        self.train_loss_history = []

    def train(self, dataset: DemonstrationDataset) -> Dict[str, List[float]]:
        """
        训练 Policy

        Args:
            dataset: Teacher demonstrations

        Returns:
            training history
        """
        dataloader = DataLoader(
            dataset,
            batch_size=self.batch_size,
            shuffle=True,
        )

        for epoch in range(self.epochs):
            epoch_loss = 0.0
            num_batches = 0

            for obs, action in dataloader:
                # Forward
                logits = self.policy(obs)  # (batch, 5)
                loss = self.criterion(logits, action)

                # Backward
                self.optimizer.zero_grad()
                loss.backward()
                self.optimizer.step()

                epoch_loss += loss.item()
                num_batches += 1

            avg_loss = epoch_loss / num_batches
            self.train_loss_history.append(avg_loss)

            if (epoch + 1) % 2 == 0:
                print(f"  Epoch {epoch+1}/{self.epochs}, Loss: {avg_loss:.4f}")

        return {"train_loss": self.train_loss_history}

    def evaluate(self, dataset: DemonstrationDataset) -> Dict[str, float]:
        """
        评估 Policy

        Args:
            dataset: Test demonstrations

        Returns:
            evaluation metrics
        """
        self.policy.eval()

        correct = 0
        total = 0
        total_loss = 0.0

        with torch.no_grad():
            for obs, action in dataset:
                obs_batch = obs.unsqueeze(0)
                logits = self.policy(obs_batch)
                loss = self.criterion(logits, action.unsqueeze(0))

                pred = torch.argmax(logits, dim=-1)
                correct += (pred == action).item()
                total += 1
                total_loss += loss.item()

        accuracy = correct / total if total > 0 else 0.0
        avg_loss = total_loss / total if total > 0 else 0.0

        self.policy.train()

        return {
            "accuracy": accuracy,
            "loss": avg_loss,
        }

    def save(self, path: str):
        """保存模型"""
        torch.save({
            "policy_state_dict": self.policy.state_dict(),
            "optimizer_state_dict": self.optimizer.state_dict(),
            "train_loss_history": self.train_loss_history,
        }, path)
        print(f"[BehavioralCloning] 模型已保存: {path}")

    def load(self, path: str):
        """加载模型"""
        checkpoint = torch.load(path)
        self.policy.load_state_dict(checkpoint["policy_state_dict"])
        self.optimizer.load_state_dict(checkpoint["optimizer_state_dict"])
        self.train_loss_history = checkpoint.get("train_loss_history", [])
        print(f"[BehavioralCloning] 模型已加载: {path}")


def load_demonstrations_from_timeline(
    timeline_path: str,
) -> List[Dict]:
    """
    从 timeline JSONL 加载 demonstrations

    Args:
        timeline_path: timeline 文件路径

    Returns:
        demonstrations list
    """
    demonstrations = []

    with open(timeline_path, 'r', encoding='utf-8') as f:
        for line in f:
            data = json.loads(line.strip())

            # 跳过 metadata
            if data.get("type") == "metadata":
                continue

            # 解析 observation
            state = data.get("state", {})
            derived = data.get("derived_metrics", {})

            obs = np.array([
                state.get("queue_depth", 0) / 1000.0,
                0.0,  # velocity (需要计算)
                0.0,  # acceleration (需要计算)
                state.get("worker_count", 0) / 200.0,
                state.get("cpu_usage", 0.0),
                0.0,  # precursor_score (不在 timeline 中)
                0.0,  # risk_score (不在 timeline 中)
                derived.get("oscillation_score", 0.0),
                0.5,  # regime_id (默认 balanced)
            ], dtype=np.float32)

            # 解析 action
            action_type = data.get("action", {}).get("type", "no_op")
            action_to_id = {
                "spawn_worker": 3,  # slow_expand
                "reduce_workers": 1,  # slow_shrink
                "no_op": 2,
                "enable_reflection": 2,
                "disable_reflection": 2,
            }
            action_id = action_to_id.get(action_type, 2)

            demonstrations.append({
                "obs": obs,
                "action": action_id,
            })

    print(f"[Demonstrations] 加载了 {len(demonstrations)} 个样本")
    return demonstrations


def collect_demonstrations(
    num_episodes: int = 10,
    arrival_rate: float = 15.0,
    duration: int = 500,
    seed: int = 42,
) -> List[Dict]:
    """
    收集 Teacher (Adaptive Governor V3) 的 demonstrations

    Args:
        num_episodes: 收集多少个 episode
        arrival_rate: 工作负载
        duration: 每个 episode 持续时间
        seed: 随机种子

    Returns:
        demonstrations list
    """
    import random

    # 添加路径
    script_dir = os.path.dirname(os.path.abspath(__file__))
    python_dir = os.path.dirname(os.path.dirname(script_dir))
    sys.path.insert(0, python_dir)

    from training.simulator.adaptive_governor import AdaptiveGovernorV3
    from governor_rl.env import ACTION_MAP

    demonstrations = []

    for episode in range(num_episodes):
        random.seed(seed + episode)

        # 创建 Governor
        governor = AdaptiveGovernorV3()
        governor.workload.burst_probability = 0.15
        governor.workload.base_arrival_rate = arrival_rate

        # 运行一个 episode
        for tick in range(duration):
            governor.tick()

            # 获取当前状态
            state = governor.state

            # 构建 observation
            precursor = governor.precursor_detector.update(
                tick=state.tick,
                queue=state.queue_depth,
                workers=state.worker_count,
            )

            obs = np.array([
                state.queue_depth / 1000.0,
                0.0,  # velocity
                0.0,  # acceleration
                state.worker_count / 200.0,
                state.cpu_usage,
                precursor.precursor_score,
                precursor.precursor_score,
                governor.analyzer.compute_metrics(state.tick).oscillation_score,
                0.5,  # regime_id
            ], dtype=np.float32)

            # 获取 Governor 动作
            action = governor.state.action_history[-1] if governor.state.action_history else "no_op"
            action_to_id = {
                "spawn_worker": 3,
                "reduce_workers": 1,
                "no_op": 2,
            }
            action_id = action_to_id.get(action, 2)

            demonstrations.append({
                "obs": obs,
                "action": action_id,
            })

    print(f"[Demonstrations] 收集了 {len(demonstrations)} 个样本 (from {num_episodes} episodes)")
    return demonstrations


def main():
    """主函数：演示 Behavioral Cloning"""
    print("=" * 60)
    print("Behavioral Cloning Demo")
    print("=" * 60)

    # 收集 demonstrations
    print("\n[1] 收集 Teacher demonstrations...")
    demonstrations = collect_demonstrations(
        num_episodes=5,
        arrival_rate=15.0,
        duration=200,
        seed=42,
    )

    # 创建 dataset
    dataset = DemonstrationDataset(demonstrations)

    # 训练
    print("\n[2] 训练 Policy Network...")
    policy = PolicyNetwork()
    trainer = BehavioralCloning(
        policy=policy,
        learning_rate=1e-3,
        batch_size=64,
        epochs=50,
    )

    history = trainer.train(dataset)

    # 评估
    print("\n[3] 评估...")
    metrics = trainer.evaluate(dataset)
    print(f"  Accuracy: {metrics['accuracy']:.2%}")
    print(f"  Loss: {metrics['loss']:.4f}")

    # 保存
    print("\n[4] 保存模型...")
    os.makedirs("checkpoints", exist_ok=True)
    trainer.save("checkpoints/bc_policy.pt")

    print("\n[Behavioral Cloning] 完成!")


if __name__ == "__main__":
    main()
