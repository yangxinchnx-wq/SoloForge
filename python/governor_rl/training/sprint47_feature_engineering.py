# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 4.7 - Feature Engineering
# Path: governor_rl/training/sprint47_feature_engineering.py
#
# Sprint 4.7: Feature Engineering
# 问题：BC 使用 raw queue/worker，Teacher 使用 load_ratio
# 解决方案：直接输入 load_ratio，让 BC 学习 Zone→Action 映射
# ─────────────────────────────────────────────────────────────────

import sys
import os
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader, random_split
import numpy as np
from typing import List, Dict, Tuple
import json
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.training.simulator.teacher_v4 import TeacherV4


# 新增：增强版 Policy Network（10 维输入）
class PolicyNetworkV2(nn.Module):
    """增强版 Policy Network，支持 load_ratio 特征"""

    def __init__(self, input_dim: int = 10, hidden_dim: int = 128, num_actions: int = 5):
        super().__init__()

        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, num_actions),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def compute_load_ratio(queue_depth: int, worker_count: int) -> float:
    """计算 load_ratio"""
    return queue_depth / max(worker_count * 2, 1)


def get_zone_id(queue_depth: int, worker_count: int) -> int:
    """获取 Zone ID"""
    load_ratio = compute_load_ratio(queue_depth, worker_count)
    if load_ratio < 0.1:
        return 0
    elif load_ratio < 0.25:
        return 1
    elif load_ratio < 0.5:
        return 2
    elif load_ratio < 1.0:
        return 3
    else:
        return 4


class TimelineDatasetV2(Dataset):
    """Timeline Dataset V2 - 包含 load_ratio 特征"""

    def __init__(self, demonstrations: List[Dict]):
        self.demonstrations = demonstrations

    def __len__(self) -> int:
        return len(self.demonstrations)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        demo = self.demonstrations[idx]
        obs = torch.FloatTensor(demo["obs"])
        action = torch.LongTensor([demo["action"]])[0]
        return obs, action


def load_timeline_v2(timeline_path: str, include_load_ratio: bool = True) -> List[Dict]:
    """加载 Timeline V2，包含 load_ratio 特征"""
    demonstrations = []

    with open(timeline_path, 'r', encoding='utf-8') as f:
        for line in f:
            data = json.loads(line.strip())

            queue_depth = data.get("queue_depth", 0)
            worker_count = data.get("worker_count", 200)
            cpu_usage = data.get("cpu_usage", 0.0)

            zone_id = get_zone_id(queue_depth, worker_count)
            load_ratio = compute_load_ratio(queue_depth, worker_count)

            # 归一化 load_ratio: 使用 log 变换保留区分度
            # log(1 + x) 变换将大值压缩，保留相对关系
            # max_lr = 21.5 (从数据中观察到的最大值)
            max_lr = 21.5
            load_ratio_norm = np.log(1 + load_ratio) / np.log(1 + max_lr)

            if include_load_ratio:
                # 10 维特征：原始 9 维 + load_ratio
                obs = np.array([
                    queue_depth / 1000.0,      # 0: queue_depth
                    0.0,                        # 1: queue_velocity
                    0.0,                        # 2: queue_acceleration
                    worker_count / 200.0,       # 3: worker_count
                    cpu_usage,                   # 4: cpu_usage
                    0.0,                        # 5: precursor_score
                    0.0,                        # 6: risk_score
                    0.0,                        # 7: oscillation_score
                    zone_id / 4.0,            # 8: zone_id
                    load_ratio_norm,           # 9: load_ratio (新增)
                ], dtype=np.float32)
            else:
                # 9 维特征：原始
                obs = np.array([
                    queue_depth / 1000.0,
                    0.0,
                    0.0,
                    worker_count / 200.0,
                    cpu_usage,
                    0.0,
                    0.0,
                    0.0,
                    zone_id / 4.0,
                ], dtype=np.float32)

            action_index = data.get("action_index", 2)

            demonstrations.append({
                "obs": obs,
                "action": action_index,
                "queue_depth": queue_depth,
                "worker_count": worker_count,
            })

    return demonstrations


def train_bc_v3_1(
    timeline_path: str,
    output_path: str,
    include_load_ratio: bool = True,
    epochs: int = 30,
    batch_size: int = 256,
    learning_rate: float = 0.002,
    val_split: float = 0.2,
) -> Dict:
    """训练 BC V3.1 (带 load_ratio)"""
    print("=" * 60)
    print("SPRINT 4.7: BC V3.1 with load_ratio Feature")
    print("=" * 60)
    print(f"Timeline: {timeline_path}")
    print(f"Include load_ratio: {include_load_ratio}")
    print(f"Output: {output_path}")
    print()

    # 加载数据
    print("[1/5] Loading Timeline...")
    demonstrations = load_timeline_v2(timeline_path, include_load_ratio)
    print(f"Loaded {len(demonstrations)} demonstrations")

    input_dim = len(demonstrations[0]["obs"])
    print(f"Input dimension: {input_dim}")

    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}

    # Action 分布
    action_counter = Counter(d["action"] for d in demonstrations)
    print("\nAction Distribution:")
    for aid in range(5):
        count = action_counter.get(aid, 0)
        pct = count / len(demonstrations) * 100
        print(f"  {ACTION_NAMES[aid]:<8}: {count:>6} ({pct:>5.1f}%)")

    # 创建 dataset
    print("\n[2/5] Creating Dataset...")
    dataset = TimelineDatasetV2(demonstrations)

    train_size = int(len(dataset) * (1 - val_split))
    val_size = len(dataset) - train_size
    train_dataset, val_dataset = random_split(dataset, [train_size, val_size])

    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)

    print(f"Train: {train_size}, Val: {val_size}")

    # 创建模型
    print("\n[3/5] Creating Policy Network V2...")
    model = PolicyNetworkV2(input_dim=input_dim, hidden_dim=128)
    print(f"Model: {model}")

    # 训练
    print("\n[4/5] Training...")
    optimizer = optim.Adam(model.parameters(), lr=learning_rate)
    criterion = nn.CrossEntropyLoss()

    loss_history = []
    val_acc_history = []

    for epoch in range(epochs):
        # Train
        model.train()
        train_loss = 0.0
        train_correct = 0
        train_total = 0

        for obs, action in train_loader:
            logits = model(obs)
            loss = criterion(logits, action)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            train_loss += loss.item()
            preds = torch.argmax(logits, dim=-1)
            train_correct += (preds == action).sum().item()
            train_total += action.size(0)

        avg_train_loss = train_loss / len(train_loader)
        train_acc = train_correct / train_total

        # Validate
        model.eval()
        val_correct = 0
        val_total = 0

        with torch.no_grad():
            for obs, action in val_loader:
                logits = model(obs)
                preds = torch.argmax(logits, dim=-1)
                val_correct += (preds == action).sum().item()
                val_total += action.size(0)

        val_acc = val_correct / val_total
        loss_history.append(avg_train_loss)
        val_acc_history.append(val_acc)

        if (epoch + 1) % 5 == 0 or epoch == 0:
            print(f"  Epoch {epoch+1}/{epochs}: Loss={avg_train_loss:.4f}, Train={train_acc:.4f}, Val={val_acc:.4f}")

    # Teacher Agreement
    print("\n[5/5] Computing Teacher Agreement...")
    teacher = TeacherV4()
    model.eval()

    agreements = 0
    total = len(demonstrations)

    with torch.no_grad():
        for demo in demonstrations:
            obs = torch.FloatTensor(demo["obs"]).unsqueeze(0)
            bc_action = torch.argmax(model(obs), dim=-1).item()

            teacher_action = {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4}[
                teacher.decide(demo["queue_depth"], demo["worker_count"])
            ]

            if bc_action == teacher_action:
                agreements += 1

    agreement_rate = agreements / total

    print(f"\nTeacher Agreement Rate: {agreement_rate:.4f} ({agreements}/{total})")

    # 保存
    print("\nSaving model...")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    torch.save({
        "policy_state_dict": model.state_dict(),
        "input_dim": input_dim,
        "loss_history": loss_history,
        "val_acc_history": val_acc_history,
        "train_acc": train_acc,
        "val_acc": val_acc,
        "agreement_rate": agreement_rate,
    }, output_path)
    print(f"Model saved: {output_path}")

    return {
        "epochs": epochs,
        "loss_history": loss_history,
        "val_acc_history": val_acc_history,
        "train_acc": train_acc,
        "val_acc": val_acc,
        "agreement_rate": agreement_rate,
        "input_dim": input_dim,
    }


def evaluate_boundary_cases(model: PolicyNetworkV2, include_load_ratio: bool = True) -> Dict:
    """评估边界情况"""
    print("\n" + "=" * 60)
    print("BOUNDARY CASE EVALUATION")
    print("=" * 60)

    ACTION_NAMES = {0: 'shrink2', 1: 'shrink1', 2: 'noop', 3: 'expand1', 4: 'expand2'}

    teacher = TeacherV4()

    # 测试用例
    test_cases = [
        # In-Domain (Zone D - 应该是 expand1)
        {"name": "In-Domain D1", "queue": 100, "worker": 200},  # lr=0.25, Zone C
        {"name": "In-Domain D2", "queue": 300, "worker": 400},  # lr=0.375, Zone C
        # In-Domain (Zone E - 应该是 expand2)
        {"name": "In-Domain E1", "queue": 500, "worker": 100},  # lr=2.5, Zone E
        {"name": "In-Domain E2", "queue": 800, "worker": 150},  # lr=2.67, Zone E
        # Near-OOD
        {"name": "Near-OOD 1", "queue": 1000, "worker": 200},  # lr=2.5, Zone E
        {"name": "Near-OOD 2", "queue": 2000, "worker": 300},  # lr=3.33, Zone E
        # Far-OOD
        {"name": "Far-OOD 1", "queue": 5000, "worker": 100},  # lr=25, Zone E
        {"name": "Far-OOD 2", "queue": 10000, "worker": 200},  # lr=25, Zone E
    ]

    model.eval()
    results = []

    print(f"\n{'Case':>12} {'Queue':>8} {'Worker':>8} {'LR':>6} {'Zone':>5} {'BC':>8} {'Teacher':>8} {'Match':>6}")
    print("-" * 70)

    for case in test_cases:
        q, w = case["queue"], case["worker"]
        zone = get_zone_id(q, w)
        lr = compute_load_ratio(q, w)
        lr_norm = min(lr / 10.0, 1.0)

        # 构建观察（与训练一致）
        # 使用 log 归一化
        max_lr = 21.5
        lr_norm = np.log(1 + lr) / np.log(1 + max_lr)

        obs = np.array([
            q / 1000.0,      # 0: queue_depth
            0.0,              # 1: queue_velocity
            0.0,              # 2: queue_acceleration
            w / 200.0,       # 3: worker_count
            0.5,              # 4: cpu_usage
            0.0,              # 5: precursor_score
            0.0,              # 6: risk_score
            0.0,              # 7: oscillation_score
            zone / 4.0,      # 8: zone_id
            lr_norm,          # 9: load_ratio (log-normalized)
        ], dtype=np.float32)

        obs_tensor = torch.FloatTensor(obs).unsqueeze(0)

        with torch.no_grad():
            bc_action = torch.argmax(model(obs_tensor), dim=-1).item()

        teacher_action = {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4}[teacher.decide(q, w)]
        match = bc_action == teacher_action

        print(f"{case['name']:>12} {q:>8} {w:>8} {lr:>6.2f} {zone:>5} {ACTION_NAMES[bc_action]:>8} {ACTION_NAMES[teacher_action]:>8} {'YES' if match else 'NO':>6}")

        results.append({"case": case, "bc_action": bc_action, "teacher_action": teacher_action, "match": match, "lr": lr})

    agreements = sum(1 for r in results if r["match"])
    rate = agreements / len(results)

    print(f"\nBoundary Agreement: {rate:.2%} ({agreements}/{len(results)})")

    return {"results": results, "agreement_rate": rate}


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Sprint 4.7: Feature Engineering")
    parser.add_argument("--timeline", type=str, default="datasets/timeline_v3_1.jsonl")
    parser.add_argument("--output", type=str, default="checkpoints/bc_policy_v3_1.pt")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--lr", type=float, default=0.002)
    parser.add_argument("--no-load-ratio", action="store_true", help="Don't include load_ratio feature")

    args = parser.parse_args()

    include_load_ratio = not args.no_load_ratio

    result = train_bc_v3_1(
        timeline_path=args.timeline,
        output_path=args.output,
        include_load_ratio=include_load_ratio,
        epochs=args.epochs,
        batch_size=args.batch,
        learning_rate=args.lr,
    )

    # 评估边界情况
    if include_load_ratio:
        model = PolicyNetworkV2(input_dim=result["input_dim"])
        checkpoint = torch.load(args.output, map_location='cpu')
        model.load_state_dict(checkpoint['policy_state_dict'])
        evaluate_boundary_cases(model, include_load_ratio=True)

    print("\n" + "=" * 60)
    print("SPRINT 4.7 COMPLETE")
    print("=" * 60)
    print(f"Train Acc: {result['train_acc']:.4f}")
    print(f"Val Acc: {result['val_acc']:.4f}")
    print(f"Teacher Agreement: {result['agreement_rate']:.4f}")
    print("=" * 60)


if __name__ == "__main__":
    main()
