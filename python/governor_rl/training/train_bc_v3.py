# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: BC V3 Training with Timeline V3
# Path: python/governor_rl/training/train_bc_v3.py
#
# Sprint 4: BC V3 Training
# 使用 Timeline V3 (Teacher V4) 训练 BC
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
import numpy as np
from typing import List, Dict, Tuple
import json
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.env import ACTION_MAP


class TimelineV3Dataset(Dataset):
    """Timeline V3 Dataset"""

    def __init__(self, demonstrations: List[Dict]):
        self.demonstrations = demonstrations

    def __len__(self) -> int:
        return len(self.demonstrations)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        demo = self.demonstrations[idx]
        obs = torch.FloatTensor(demo["obs"])
        action = torch.LongTensor([demo["action"]])[0]
        return obs, action


def load_timeline_v3(timeline_path: str) -> List[Dict]:
    """从 Timeline V3 JSONL 加载 demonstrations"""
    demonstrations = []

    with open(timeline_path, 'r', encoding='utf-8') as f:
        for line in f:
            data = json.loads(line.strip())

            # 解析 observation (9维)
            # 使用 queue_depth 和 worker_count 构建 observation
            queue_depth = data.get("queue_depth", 0)
            worker_count = data.get("worker_count", 0)
            cpu_usage = data.get("cpu_usage", 0.0)

            # Zone 计算 (基于 load_ratio，与 Teacher V4 一致)
            capacity = worker_count * 2
            load_ratio = queue_depth / max(1, capacity)
            if load_ratio < 0.1:
                zone_id = 0  # Zone A
            elif load_ratio < 0.25:
                zone_id = 1  # Zone B
            elif load_ratio < 0.5:
                zone_id = 2  # Zone C
            elif load_ratio < 1.0:
                zone_id = 3  # Zone D
            else:
                zone_id = 4  # Zone E

            # 计算 queue velocity 和 acceleration (简化版)
            # 这里使用固定值，因为在 timeline 中没有历史数据
            queue_velocity = 0.0
            queue_acceleration = 0.0
            oscillation_score = 0.0

            obs = np.array([
                queue_depth / 1000.0,           # 0: queue_depth (归一化)
                queue_velocity,                   # 1: queue_velocity
                queue_acceleration,             # 2: queue_acceleration
                worker_count / 200.0,           # 3: worker_count (归一化)
                cpu_usage,                      # 4: cpu_usage
                0.0,                            # 5: precursor_score
                0.0,                            # 6: risk_score
                oscillation_score,               # 7: oscillation_score
                zone_id / 4.0,                  # 8: regime_id
            ], dtype=np.float32)

            # 解析 action (使用 action_index)
            action_index = data.get("action_index", 2)

            demonstrations.append({
                "obs": obs,
                "action": action_index,
            })

    return demonstrations


def train_bc_v3(
    timeline_path: str = "datasets/timeline_v2.jsonl",
    output_path: str = "checkpoints/bc_policy_v3.pt",
    epochs: int = 10,
    batch_size: int = 256,
    learning_rate: float = 3e-4,
) -> Dict:
    """
    使用 Timeline V3 训练 BC

    Args:
        timeline_path: Timeline V3 文件路径
        output_path: 输出模型路径
        epochs: 训练轮数
        batch_size: 批次大小
        learning_rate: 学习率

    Returns:
        训练结果
    """
    print("=" * 60)
    print("BC V3 Training with Timeline V3")
    print("=" * 60)
    print(f"Timeline: {timeline_path}")
    print(f"Output: {output_path}")
    print(f"Epochs: {epochs}, Batch: {batch_size}, LR: {learning_rate}")
    print()

    # 加载数据
    print("[1/5] Loading Timeline V3...")
    demonstrations = load_timeline_v3(timeline_path)
    print(f"Loaded {len(demonstrations)} demonstrations")

    # 统计 action 分布
    action_counter = Counter(d["action"] for d in demonstrations)
    print("\nAction Distribution:")
    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}
    for action_id in range(5):
        count = action_counter.get(action_id, 0)
        pct = count / len(demonstrations) * 100
        print(f"  {ACTION_NAMES[action_id]:<8}: {count:>6} ({pct:>5.1f}%)")

    # 创建 dataset
    dataset = TimelineV3Dataset(demonstrations)

    # 创建 model
    print("\n[2/5] Creating Policy Network...")
    policy = PolicyNetwork(hidden_dim=128)
    print(f"Model: {policy}")

    # 创建 optimizer
    optimizer = optim.Adam(policy.parameters(), lr=learning_rate)
    criterion = nn.CrossEntropyLoss()

    # 训练
    print("\n[3/5] Training...")
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    loss_history = []
    for epoch in range(epochs):
        epoch_loss = 0.0
        num_batches = 0

        for obs, action in dataloader:
            # Forward
            logits = policy(obs)
            loss = criterion(logits, action)

            # Backward
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            epoch_loss += loss.item()
            num_batches += 1

        avg_loss = epoch_loss / num_batches
        loss_history.append(avg_loss)

        if (epoch + 1) % 2 == 0 or epoch == 0:
            print(f"  Epoch {epoch+1}/{epochs}, Loss: {avg_loss:.4f}")

    # 评估
    print("\n[4/5] Evaluating...")
    policy.eval()
    correct = 0
    total = 0

    with torch.no_grad():
        for obs, action in dataset:
            obs_batch = obs.unsqueeze(0)
            logits = policy(obs_batch)
            pred = torch.argmax(logits, dim=-1)
            correct += (pred == action).item()
            total += 1

    accuracy = correct / total if total > 0 else 0.0
    print(f"Accuracy: {accuracy:.4f} ({correct}/{total})")

    # 预测分布
    print("\nPrediction Distribution:")
    pred_counter = Counter()
    with torch.no_grad():
        for obs, action in dataset:
            obs_batch = obs.unsqueeze(0)
            logits = policy(obs_batch)
            pred = torch.argmax(logits, dim=-1)
            pred_counter[pred.item()] += 1

    for action_id in range(5):
        count = pred_counter.get(action_id, 0)
        pct = count / total * 100
        print(f"  {ACTION_NAMES[action_id]:<8}: {count:>6} ({pct:>5.1f}%)")

    policy.train()

    # 保存
    print("\n[5/5] Saving model...")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    torch.save({
        "policy_state_dict": policy.state_dict(),
        "optimizer_state_dict": optimizer.state_dict(),
        "loss_history": loss_history,
        "accuracy": accuracy,
    }, output_path)
    print(f"Model saved: {output_path}")

    return {
        "epochs": epochs,
        "loss_history": loss_history,
        "accuracy": accuracy,
        "action_distribution": dict(action_counter),
        "prediction_distribution": dict(pred_counter),
    }


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="BC V3 Training")
    parser.add_argument("--timeline", type=str, default="datasets/timeline_v2.jsonl")
    parser.add_argument("--output", type=str, default="checkpoints/bc_policy_v3.pt")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--lr", type=float, default=3e-4)

    args = parser.parse_args()

    result = train_bc_v3(
        timeline_path=args.timeline,
        output_path=args.output,
        epochs=args.epochs,
        batch_size=args.batch,
        learning_rate=args.lr,
    )

    print("\n" + "=" * 60)
    print("BC V3 Training Complete!")
    print("=" * 60)
    print(f"Final Loss: {result['loss_history'][-1]:.4f}")
    print(f"Accuracy: {result['accuracy']:.4f}")


if __name__ == "__main__":
    main()
