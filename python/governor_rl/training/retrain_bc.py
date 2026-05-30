# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Retrain BC
# Path: python/governor_rl/training/retrain_bc.py
#
# 训练协议 v1: BC Retraining
# - 加载 v2 dataset
# - 训练 PolicyNetwork
# - Stress test evaluation
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
import numpy as np
from typing import Dict, List, Tuple, Optional
from collections import Counter
import random

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.models import PolicyNetwork
from governor_rl.env import RuntimeEnvFactory


# ═══════════════════════════════════════════════════════════════════════════════
# BC TRAINING CONSTANTS (FROZEN)
# ═══════════════════════════════════════════════════════════════════════════════

BC_TRAINING_CONFIG = {
    "epochs": 10,
    "batch_size": 256,
    "learning_rate": 3e-4,
}

BC_EVALUATION_GATE = {
    "avg_queue": 2000,       # < 2000
    "worker_variance": 5,    # > 5
    "unseen_survival": 0.80, # > 80%
    "action_entropy": 0.8,   # > 0.8
}


class BCDataset(Dataset):
    """BC Training Dataset"""

    # Action mapping: {-1: 0, 0: 1, 1: 2} (CrossEntropyLoss needs 0-indexed)
    ACTION_MAP = {-1: 0, 0: 1, 1: 2}

    def __init__(self, transitions: List[Dict]):
        self.obs = []
        self.actions = []

        for t in transitions:
            self.obs.append(t["obs"])
            # Remap action from {-1, 0, 1} to {0, 1, 2}
            original_action = t["action"]
            mapped_action = self.ACTION_MAP.get(original_action, original_action + 1)
            self.actions.append(mapped_action)

        self.obs = np.array(self.obs, dtype=np.float32)
        self.actions = np.array(self.actions, dtype=np.int64)

    def __len__(self) -> int:
        return len(self.obs)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        return torch.FloatTensor(self.obs[idx]), torch.LongTensor([self.actions[idx]])[0]


class BCTrainer:
    """
    BC Trainer

    训练协议 v1:
    1. 加载 v2 dataset
    2. 训练 PolicyNetwork (10 epochs, batch=256, lr=3e-4)
    3. Stress test evaluation
    4. Gate validation
    """

    def __init__(self, checkpoint_dir: str = "checkpoints"):
        self.checkpoint_dir = checkpoint_dir
        os.makedirs(checkpoint_dir, exist_ok=True)

        self.policy = PolicyNetwork(hidden_dim=128)
        self.optimizer = optim.Adam(
            self.policy.parameters(),
            lr=BC_TRAINING_CONFIG["learning_rate"]
        )
        self.criterion = nn.CrossEntropyLoss()

        self.train_loss_history = []

    def load_dataset(self, dataset_path: str) -> BCDataset:
        """加载 dataset"""
        print(f"Loading dataset: {dataset_path}")

        transitions = []
        with open(dataset_path, 'r', encoding='utf-8') as f:
            for line in f:
                t = json.loads(line.strip())
                transitions.append(t)

        print(f"Loaded {len(transitions):,} transitions")

        # 统计
        actions = Counter(t["action"] for t in transitions)
        phases = Counter(t.get("phase", "unknown") for t in transitions)

        print("\nAction distribution:")
        total = len(transitions)
        for action, count in sorted(actions.items()):
            print(f"  action={action:+d}: {count:>6,} ({count/total:.1%})")

        print("\nPhase distribution:")
        for phase, count in sorted(phases.items()):
            print(f"  {phase:<12}: {count:>6,} ({count/total:.1%})")

        # Action entropy
        entropy = 0.0
        for count in actions.values():
            p = count / total
            entropy -= p * np.log2(p)
        print(f"\nAction entropy: {entropy:.3f}")

        return BCDataset(transitions)

    def train(self, dataset: BCDataset) -> Dict:
        """训练"""
        dataloader = DataLoader(
            dataset,
            batch_size=BC_TRAINING_CONFIG["batch_size"],
            shuffle=True,
        )

        print(f"\nTraining BC ({BC_TRAINING_CONFIG['epochs']} epochs, "
              f"batch={BC_TRAINING_CONFIG['batch_size']})...")

        for epoch in range(BC_TRAINING_CONFIG["epochs"]):
            epoch_loss = 0.0
            num_batches = 0

            for obs, action in dataloader:
                logits = self.policy(obs)
                loss = self.criterion(logits, action)

                self.optimizer.zero_grad()
                loss.backward()
                self.optimizer.step()

                epoch_loss += loss.item()
                num_batches += 1

            avg_loss = epoch_loss / num_batches
            self.train_loss_history.append(avg_loss)

            if (epoch + 1) % 2 == 0:
                print(f"  Epoch {epoch+1}/{BC_TRAINING_CONFIG['epochs']}, Loss: {avg_loss:.4f}")

        return {"train_loss": self.train_loss_history}

    def save(self, path: str):
        """保存模型"""
        torch.save({
            "policy_state_dict": self.policy.state_dict(),
            "optimizer_state_dict": self.optimizer.state_dict(),
            "train_loss_history": self.train_loss_history,
        }, path)
        print(f"Model saved: {path}")

    def stress_test(self) -> Dict:
        """Stress test evaluation"""
        print("\n" + "=" * 60)
        print("BC STRESS TEST")
        print("=" * 60)

        # 测试配置
        test_configs = [
            {"arrival_rate": 8.0, "burst_prob": 0.05, "name": "unseen_low"},
            {"arrival_rate": 25.0, "burst_prob": 0.25, "name": "unseen_high"},
            {"arrival_rate": 35.0, "burst_prob": 0.30, "name": "extreme"},
            {"arrival_rate": 15.0, "burst_prob": 0.40, "name": "high_burst"},
        ]

        results = []

        for config in test_configs:
            print(f"\nTest: {config['name']}")
            result = self._eval_config(config)
            results.append(result)

            print(f"  avg_queue: {result['avg_queue']:.0f}")
            print(f"  worker_variance: {result['worker_variance']:.2f}")
            print(f"  survival: {result['survived']}")

        # 汇总
        avg_queue = np.mean([r["avg_queue"] for r in results])
        avg_variance = np.mean([r["worker_variance"] for r in results])
        survival_rate = sum(1 for r in results if r["survived"]) / len(results)

        # Action entropy (使用原始 action 值 {-1, 0, 1})
        all_actions = []
        for result in results:
            all_actions.extend(result["actions"])
        action_entropy = self._compute_entropy(Counter(all_actions), len(all_actions))

        # Action distribution for debugging
        action_dist = Counter(all_actions)
        print(f"\nAction distribution in stress test:")
        for action in sorted(action_dist.keys()):
            count = action_dist[action]
            ratio = count / len(all_actions) if all_actions else 0
            print(f"  action={action:+d}: {count:>4} ({ratio:.1%})")

        # 检测 fixed policy
        dominant_ratio = max(action_dist.values()) / len(all_actions) if all_actions else 1.0
        fixed_policy = dominant_ratio > 0.9

        print("\n" + "=" * 60)
        print("STRESS TEST SUMMARY")
        print("=" * 60)
        print(f"Avg Queue: {avg_queue:.0f} (target < {BC_EVALUATION_GATE['avg_queue']})")
        print(f"Worker Variance: {avg_variance:.2f} (target > {BC_EVALUATION_GATE['worker_variance']})")
        print(f"Survival Rate: {survival_rate:.1%} (target > {BC_EVALUATION_GATE['unseen_survival']:.0%})")
        print(f"Action Entropy: {action_entropy:.3f} (target > {BC_EVALUATION_GATE['action_entropy']})")
        print(f"Fixed Policy: {'❌ DETECTED' if fixed_policy else '✅ No'}")

        return {
            "avg_queue": avg_queue,
            "worker_variance": avg_variance,
            "survival_rate": survival_rate,
            "action_entropy": action_entropy,
            "fixed_policy": fixed_policy,
        }

    def _eval_config(self, config: Dict) -> Dict:
        """评估单个配置"""
        self.policy.eval()

        env = RuntimeEnvFactory.create(
            arrival_rate=config["arrival_rate"],
            burst_prob=config["burst_prob"],
            duration=500,
        )

        obs, _ = env.reset()

        queues = []
        workers = []
        actions = []
        done = False

        with torch.no_grad():
            for _ in range(500):
                action, _ = self.policy.get_action(obs, deterministic=True)
                next_obs, _, done, _, info = env.step(action)

                queues.append(info.get("queue_depth", 0))
                workers.append(info.get("worker_count", 0))
                actions.append(action)

                obs = next_obs
                if done:
                    break

        self.policy.train()

        # 计算指标
        queues = np.array(queues)
        workers = np.array(workers)

        avg_queue = np.mean(queues)
        worker_variance = np.var(workers) if len(workers) > 1 else 0
        survived = np.max(queues) < 5000  # 没有崩溃

        return {
            "config": config["name"],
            "avg_queue": avg_queue,
            "max_queue": np.max(queues),
            "worker_variance": worker_variance,
            "avg_workers": np.mean(workers),
            "survived": survived,
            "actions": actions,
        }

    def _compute_entropy(self, counter: Counter, total: int) -> float:
        if total == 0:
            return 0.0
        entropy = 0.0
        for count in counter.values():
            if count > 0:
                p = count / total
                entropy -= p * np.log2(p)
        return entropy

    def validate_gate(self, stress_results: Dict) -> Dict:
        """验证 BC Evaluation Gate"""
        print("\n" + "=" * 60)
        print("BC EVALUATION GATE")
        print("=" * 60)

        checks = {
            "avg_queue": stress_results["avg_queue"] < BC_EVALUATION_GATE["avg_queue"],
            "worker_variance": stress_results["worker_variance"] > BC_EVALUATION_GATE["worker_variance"],
            "survival_rate": stress_results["survival_rate"] >= BC_EVALUATION_GATE["unseen_survival"],
            "action_entropy": stress_results["action_entropy"] >= BC_EVALUATION_GATE["action_entropy"],
            "fixed_policy": not stress_results["fixed_policy"],
        }

        all_pass = all(checks.values())

        thresholds = {
            "avg_queue": "<",
            "worker_variance": ">",
            "survival_rate": ">",
            "action_entropy": ">",
            "fixed_policy": "=",
        }

        targets = {
            "avg_queue": BC_EVALUATION_GATE["avg_queue"],
            "worker_variance": BC_EVALUATION_GATE["worker_variance"],
            "survival_rate": BC_EVALUATION_GATE["unseen_survival"],
            "action_entropy": BC_EVALUATION_GATE["action_entropy"],
            "fixed_policy": False,
        }

        actuals = {
            "avg_queue": stress_results["avg_queue"],
            "worker_variance": stress_results["worker_variance"],
            "survival_rate": stress_results["survival_rate"],
            "action_entropy": stress_results["action_entropy"],
            "fixed_policy": stress_results["fixed_policy"],
        }

        print(f"\n{'Metric':<20} {'Actual':>12} {'Target':>12} {'Status':>10}")
        print("-" * 60)

        for metric in checks:
            op = thresholds[metric]
            target = targets[metric]
            actual = actuals[metric]
            passed = checks[metric]
            status = "✅ PASS" if passed else "❌ FAIL"

            if metric == "survival_rate":
                actual_str = f"{actual:.1%}"
                target_str = f"{target:.0%}"
            elif metric == "fixed_policy":
                actual_str = "DETECTED" if actual else "No"
                target_str = "No"
            else:
                actual_str = f"{actual:.3f}"
                target_str = f"{target:.3f}"

            print(f"{metric:<20} {actual_str:>12} {op:>1} {target_str:>11} {status:>10}")

        print("\n" + "=" * 60)
        if all_pass:
            print("✅ BC EVALUATION GATE PASSED")
            print("Ready for Shadow PPO")
        else:
            print("❌ BC EVALUATION GATE FAILED")
            print("Requires iteration")
        print("=" * 60)

        return {"passed": all_pass, "checks": checks}


def main():
    """主函数"""
    import glob

    # 查找最新的 v3 dataset (action-balanced)
    datasets = glob.glob("datasets/teacher_dataset_v3_*.jsonl")
    if not datasets:
        print("No v3 dataset found. Run action_balanced_filter.py first.")
        return

    dataset_path = max(datasets, key=os.path.getmtime)
    print(f"Using action-balanced dataset: {dataset_path}")

    # 训练
    trainer = BCTrainer()
    dataset = trainer.load_dataset(dataset_path)
    trainer.train(dataset)

    # 保存
    model_path = os.path.join(trainer.checkpoint_dir, "bc_policy_v3.pt")
    trainer.save(model_path)

    # Stress test
    stress_results = trainer.stress_test()

    # Gate validation
    gate_result = trainer.validate_gate(stress_results)


if __name__ == "__main__":
    main()
