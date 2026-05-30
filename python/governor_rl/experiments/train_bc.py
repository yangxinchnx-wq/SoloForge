# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Train BC
# Path: python/governor_rl/experiments/train_bc.py
#
# Stage 1: Behavioral Cloning Training
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))
sys.path.insert(0, python_dir)

from governor_rl.training.behavioral_cloning import BehavioralCloning, DemonstrationDataset


def load_jsonl(path: str):
    """加载 JSONL 文件"""
    data = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            data.append(json.loads(line.strip()))
    return data


def main():
    print("=" * 60)
    print("BC Training")
    print("=" * 60)

    # 数据集路径
    dataset_path = "datasets/dataset_v1/train.jsonl"

    if not os.path.exists(dataset_path):
        print(f"Dataset not found: {dataset_path}")
        print("Run curriculum_rollout first to generate dataset.")
        return

    # 加载数据集
    print(f"\n[1] Loading dataset: {dataset_path}")
    demos = load_jsonl(dataset_path)
    dataset = DemonstrationDataset(demos)
    print(f"    Samples: {len(dataset)}")

    # 创建 BC Trainer
    print("\n[2] Creating BC Trainer")
    bc = BehavioralCloning()

    # 训练
    print("\n[3] Training")
    history = bc.train(dataset)

    # 保存
    print("\n[4] Saving model")
    bc.save("checkpoints/bc_policy.pt")

    print("\n✅ BC Training Complete")
    print(f"    Model: checkpoints/bc_policy.pt")


if __name__ == "__main__":
    main()
