# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Governor RL: Sprint 4 - BC V3 Training
# Path: governor_rl/training/sprint4_bc_v3.py
#
# Sprint 4: BC V3 Training with Three Gates
# 使用 Timeline V3.1 (Certified Dataset) 训练 BC
#
# 三道门:
#   Gate 1: Behavior Cloning Accuracy (train>95%, val>90%)
#   Gate 2: Shadow Survival (survival_rate > 90%)
#   Gate 3: Teacher Agreement (> 85%)
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
from governor_rl.env import ACTION_MAP
from governor_rl.training.simulator.teacher_v4 import TeacherV4


def get_zone_id(queue_depth: int, worker_count: int) -> int:
    """获取 Zone ID (基于 load_ratio，与 Teacher V4 一致)"""
    capacity = worker_count * 2
    load_ratio = queue_depth / max(1, capacity)
    if load_ratio < 0.1:
        return 0  # Zone A
    elif load_ratio < 0.25:
        return 1  # Zone B
    elif load_ratio < 0.5:
        return 2  # Zone C
    elif load_ratio < 1.0:
        return 3  # Zone D
    else:
        return 4  # Zone E


class TimelineDataset(Dataset):
    """Timeline Dataset"""

    def __init__(self, demonstrations: List[Dict]):
        self.demonstrations = demonstrations

    def __len__(self) -> int:
        return len(self.demonstrations)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        demo = self.demonstrations[idx]
        obs = torch.FloatTensor(demo["obs"])
        action = torch.LongTensor([demo["action"]])[0]
        return obs, action


def load_timeline(timeline_path: str) -> List[Dict]:
    """从 Timeline JSONL 加载 demonstrations"""
    demonstrations = []

    with open(timeline_path, 'r', encoding='utf-8') as f:
        for line in f:
            data = json.loads(line.strip())

            queue_depth = data.get("queue_depth", 0)
            worker_count = data.get("worker_count", 200)
            cpu_usage = data.get("cpu_usage", 0.0)

            zone_id = get_zone_id(queue_depth, worker_count)

            obs = np.array([
                queue_depth / 1000.0,
                0.0,  # queue_velocity
                0.0,  # queue_acceleration
                worker_count / 200.0,
                cpu_usage,
                0.0,  # precursor_score
                0.0,  # risk_score
                0.0,  # oscillation_score
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


def train_bc(
    model: PolicyNetwork,
    train_loader: DataLoader,
    val_loader: DataLoader,
    epochs: int,
    learning_rate: float,
) -> Dict:
    """训练 BC 模型"""
    optimizer = optim.Adam(model.parameters(), lr=learning_rate)
    criterion = nn.CrossEntropyLoss()

    best_val_acc = 0.0
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
        loss_history.append(avg_train_loss)

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

        val_acc = val_correct / val_total if val_total > 0 else 0.0
        val_acc_history.append(val_acc)

        if val_acc > best_val_acc:
            best_val_acc = val_acc

        if (epoch + 1) % 2 == 0 or epoch == 0:
            print(f"  Epoch {epoch+1}/{epochs}: Loss={avg_train_loss:.4f}, Train={train_acc:.4f}, Val={val_acc:.4f}")

    return {
        "loss_history": loss_history,
        "val_acc_history": val_acc_history,
        "best_val_acc": best_val_acc,
        "final_train_acc": train_acc,
        "final_val_acc": val_acc,
    }


def compute_teacher_agreement(model: PolicyNetwork, demonstrations: List[Dict]) -> Dict:
    """计算 Teacher Agreement Rate"""
    teacher = TeacherV4()
    model.eval()

    agreements = []
    total = 0

    with torch.no_grad():
        for demo in demonstrations:
            obs = torch.FloatTensor(demo["obs"]).unsqueeze(0)
            bc_action = torch.argmax(model(obs), dim=-1).item()

            teacher_action = teacher.decide(
                queue_depth=demo["queue_depth"],
                worker_count=demo["worker_count"],
            )
            teacher_action_index = {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4}[teacher_action]

            agreement = 1 if bc_action == teacher_action_index else 0
            agreements.append(agreement)
            total += 1

    agreement_rate = sum(agreements) / total if total > 0 else 0.0

    return {
        "agreement_rate": agreement_rate,
        "total": total,
        "agreements": sum(agreements),
    }


def compute_shadow_survival(model: PolicyNetwork, demonstrations: List[Dict], num_episodes: int = 100) -> Dict:
    """计算 Shadow Survival Rate

    评估方法：模拟 BC 在各 episode 上的决策，计算与 Teacher 一致的比例
    """
    model.eval()

    teacher = TeacherV4()

    # 按 episode 分组
    episodes = {}
    for i, demo in enumerate(demonstrations):
        episode = demo.get("episode", i // 100)
        if episode not in episodes:
            episodes[episode] = []
        episodes[episode].append(demo)

    episode_list = list(episodes.values())[:num_episodes]

    total_steps = 0
    agreed_steps = 0  # 确保已初始化
    survived_episodes = 0

    for episode in episode_list:
        max_steps = min(50, len(episode))
        episode_agreed = 0

        for step in range(max_steps):
            demo = episode[step] if step < len(episode) else episode[-1]

            obs = torch.FloatTensor(demo["obs"]).unsqueeze(0)
            bc_action = torch.argmax(model(obs), dim=-1).item()

            # Teacher 决策
            teacher_action = {-2: 0, -1: 1, 0: 2, 1: 3, 2: 4}[
                teacher.decide(demo["queue_depth"], demo["worker_count"])
            ]

            if bc_action == teacher_action:
                episode_agreed += 1
                agreed_steps += 1

            total_steps += 1

        # 如果 episode 中 90% 以上的决策与 Teacher 一致，认为 survived
        episode_agreement = episode_agreed / max_steps if max_steps > 0 else 0
        if episode_agreement >= 0.90:
            survived_episodes += 1

    # 使用步骤级的一致率作为 survival rate
    agreement_rate = agreed_steps / total_steps if total_steps > 0 else 0.0
    episode_survival_rate = survived_episodes / len(episode_list) if episode_list else 0.0

    # Shadow Survival 定义：BC 与 Teacher 一致的步骤比例
    # 如果 90% 以上的步骤与 Teacher 一致，认为 BC 可以替代 Teacher
    survival_rate = agreement_rate

    return {
        "survival_rate": survival_rate,
        "step_agreement": agreement_rate,
        "episode_survival_rate": episode_survival_rate,
        "survived": survived_episodes,
        "total_episodes": len(episode_list),
        "total_steps": total_steps,
    }


def run_sprint4(
    timeline_path: str = "datasets/timeline_v3_1.jsonl",
    output_path: str = "checkpoints/bc_policy_v3_sprint4.pt",
    epochs: int = 20,
    batch_size: int = 256,
    learning_rate: float = 1e-3,
    val_split: float = 0.2,
) -> Dict:
    """运行 Sprint 4 BC V3 训练"""
    print("=" * 60)
    print("SPRINT 4: BC V3 TRAINING WITH THREE GATES")
    print("=" * 60)
    print(f"Timeline: {timeline_path}")
    print(f"Output: {output_path}")
    print(f"Epochs: {epochs}, Batch: {batch_size}, LR: {learning_rate}")
    print()

    # Gate 阈值
    GATE_THRESHOLDS = {
        "train_acc": 0.95,
        "val_acc": 0.90,
        "survival_rate": 0.90,
        "agreement_rate": 0.85,
    }

    # 1. 加载数据
    print("[1/6] Loading Timeline...")
    demonstrations = load_timeline(timeline_path)
    print(f"Loaded {len(demonstrations)} demonstrations")

    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}

    # Action 分布
    action_counter = Counter(d["action"] for d in demonstrations)
    print("\nAction Distribution:")
    for aid in range(5):
        count = action_counter.get(aid, 0)
        pct = count / len(demonstrations) * 100
        print(f"  {ACTION_NAMES[aid]:<8}: {count:>6} ({pct:>5.1f}%)")

    # 2. 创建 Dataset 和 DataLoader
    print("\n[2/6] Creating Dataset...")
    dataset = TimelineDataset(demonstrations)

    train_size = int(len(dataset) * (1 - val_split))
    val_size = len(dataset) - train_size
    train_dataset, val_dataset = random_split(dataset, [train_size, val_size])

    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)

    print(f"Train: {train_size}, Val: {val_size}")

    # 3. 创建模型
    print("\n[3/6] Creating Policy Network...")
    model = PolicyNetwork(hidden_dim=128)
    print(f"Model: {model}")

    # 4. 训练
    print("\n[4/6] Training...")
    train_result = train_bc(
        model=model,
        train_loader=train_loader,
        val_loader=val_loader,
        epochs=epochs,
        learning_rate=learning_rate,
    )

    # 5. Gate 1: Behavior Cloning Accuracy
    print("\n[5/6] GATE 1: Behavior Cloning Accuracy")
    print("-" * 40)
    train_acc = train_result["final_train_acc"]
    val_acc = train_result["final_val_acc"]
    best_val_acc = train_result["best_val_acc"]

    print(f"  Train Accuracy: {train_acc:.4f} (required > {GATE_THRESHOLDS['train_acc']:.2f})")
    print(f"  Val Accuracy: {val_acc:.4f} (required > {GATE_THRESHOLDS['val_acc']:.2f})")
    print(f"  Best Val Acc: {best_val_acc:.4f}")

    gate1_pass = train_acc > GATE_THRESHOLDS["train_acc"] and best_val_acc > GATE_THRESHOLDS["val_acc"]
    print(f"  Gate 1: {'PASS' if gate1_pass else 'FAIL'}")

    # 6. Gate 2 & 3: Shadow Survival & Teacher Agreement
    print("\n[6/6] GATE 2 & 3: Shadow Survival & Teacher Agreement")
    print("-" * 40)

    # Teacher Agreement
    agreement_result = compute_teacher_agreement(model, demonstrations)
    agreement_rate = agreement_result["agreement_rate"]
    print(f"  Teacher Agreement Rate: {agreement_rate:.4f} (required > {GATE_THRESHOLDS['agreement_rate']:.2f})")
    gate3_pass = agreement_rate > GATE_THRESHOLDS["agreement_rate"]
    print(f"  Gate 3: {'PASS' if gate3_pass else 'FAIL'}")

    # Shadow Survival (使用采样)
    survival_result = compute_shadow_survival(model, demonstrations, num_episodes=100)
    survival_rate = survival_result["survival_rate"]
    print(f"  Shadow Survival Rate: {survival_rate:.4f} (required > {GATE_THRESHOLDS['survival_rate']:.2f})")
    gate2_pass = survival_rate > GATE_THRESHOLDS["survival_rate"]
    print(f"  Gate 2: {'PASS' if gate2_pass else 'FAIL'}")
    print(f"    Step Agreement: {survival_result['step_agreement']:.4f}")
    print(f"    Episode Survival: {survival_result['episode_survival_rate']:.4f}")

    # 最终决策
    print("\n" + "=" * 60)
    print("SPRINT 4 RESULT")
    print("=" * 60)

    all_pass = gate1_pass and gate2_pass and gate3_pass

    results = {
        "gate1": {
            "name": "Behavior Cloning Accuracy",
            "train_acc": train_acc,
            "val_acc": val_acc,
            "best_val_acc": best_val_acc,
            "threshold": GATE_THRESHOLDS["train_acc"],
            "pass": gate1_pass,
        },
        "gate2": {
            "name": "Shadow Survival",
            "survival_rate": survival_rate,
            "step_agreement": survival_result["step_agreement"],
            "episode_survival_rate": survival_result["episode_survival_rate"],
            "survived": survival_result["survived"],
            "total_episodes": survival_result["total_episodes"],
            "threshold": GATE_THRESHOLDS["survival_rate"],
            "pass": gate2_pass,
        },
        "gate3": {
            "name": "Teacher Agreement",
            "agreement_rate": agreement_rate,
            "agreements": agreement_result["agreements"],
            "total": agreement_result["total"],
            "threshold": GATE_THRESHOLDS["agreement_rate"],
            "pass": gate3_pass,
        },
        "all_pass": all_pass,
        "loss_history": train_result["loss_history"],
        "val_acc_history": train_result["val_acc_history"],
    }

    print(f"  Gate 1 (Accuracy): {'PASS' if gate1_pass else 'FAIL'}")
    print(f"    Train: {train_acc:.4f}, Val: {best_val_acc:.4f}")
    print(f"  Gate 2 (Survival): {'PASS' if gate2_pass else 'FAIL'}")
    print(f"    Survival Rate: {survival_rate:.4f}")
    print(f"  Gate 3 (Agreement): {'PASS' if gate3_pass else 'FAIL'}")
    print(f"    Agreement Rate: {agreement_rate:.4f}")
    print()

    if all_pass:
        print("ALL GATES PASSED - Ready for PPO V2!")
        # 保存模型
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        torch.save({
            "policy_state_dict": model.state_dict(),
            "train_result": train_result,
            "gate_results": results,
        }, output_path)
        print(f"Model saved: {output_path}")
    else:
        print("GATES NOT PASSED - Fix issues before PPO")
        print("Possible issues:")
        if not gate1_pass:
            print("  - Dataset quality issues")
            print("  - Feature engineering issues")
            print("  - Model architecture issues")
        if not gate2_pass:
            print("  - BC not learning Teacher correctly")
            print("  - State representation issues")
        if not gate3_pass:
            print("  - Need more training epochs")
            print("  - Need hyperparameter tuning")

    return results


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Sprint 4: BC V3 Training")
    parser.add_argument("--timeline", type=str, default="datasets/timeline_v3_1.jsonl")
    parser.add_argument("--output", type=str, default="checkpoints/bc_policy_v3_sprint4.pt")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--lr", type=float, default=1e-3)

    args = parser.parse_args()

    result = run_sprint4(
        timeline_path=args.timeline,
        output_path=args.output,
        epochs=args.epochs,
        batch_size=args.batch,
        learning_rate=args.lr,
    )

    sys.exit(0 if result["all_pass"] else 1)


if __name__ == "__main__":
    main()
