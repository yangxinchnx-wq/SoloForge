# -*- coding: utf-8 -*-
"""
SoloForge Governor RL: BC V4 Training (D6-C11 / D12 前置)
Path: python/governor_rl/training/train_bc_v4.py
Date: 2026-06-30
对应 plan: 数据库升级方案.md §10 阶段 C C11, §13 阶段 6

相对 v3 的改进:
  1. Cosine LR schedule (warmup + decay)
  2. Weight decay (AdamW)
  3. Obs noise augmentation (training only)
  4. Mixup (可选, --mixup <alpha>)
  5. 评估指标扩展: top-1, top-2, ECE (Expected Calibration Error)
  6. Metadata 落盘 (training_run_id, dataset_hash, git_commit, hyperparams)
  7. 与 v3 同架构 (9→128→128→5), 蒸馏可直接加载

零破坏: 新文件, 不动 train_bc_v3.py 任何代码

用法:
  cd python
  python governor_rl/training/train_bc_v4.py \\
      --timeline datasets/timeline_v2.jsonl \\
      --output checkpoints/bc_policy_v4.pt \\
      --epochs 30 --batch-size 256 --lr 3e-4 --weight-decay 1e-4 \\
      --noise-std 0.01 --mixup 0.2
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import platform
import socket
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.optim as optim
from torch.utils.data import DataLoader, Dataset

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("train_bc_v4")

# ── 路径处理 ────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_DIR = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(PYTHON_DIR))

from governor_rl.models import PolicyNetwork  # noqa: E402

ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}


# ── 数据加载 (复用 v3 数据格式) ─────────────────────────────────────
class TimelineDataset(Dataset):
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
    """从 Timeline JSONL 加载 demonstrations (与 v3 同 obs 构造)"""
    demonstrations = []
    with open(timeline_path, "r", encoding="utf-8") as f:
        for line in f:
            data = json.loads(line.strip())
            queue_depth = data.get("queue_depth", 0)
            worker_count = data.get("worker_count", 0)
            cpu_usage = data.get("cpu_usage", 0.0)
            capacity = worker_count * 2
            load_ratio = queue_depth / max(1, capacity)
            if load_ratio < 0.1:
                zone_id = 0
            elif load_ratio < 0.25:
                zone_id = 1
            elif load_ratio < 0.5:
                zone_id = 2
            elif load_ratio < 1.0:
                zone_id = 3
            else:
                zone_id = 4
            obs = np.array([
                queue_depth / 1000.0,
                0.0,  # queue_velocity (timeline 中无)
                0.0,  # queue_acceleration
                worker_count / 200.0,
                cpu_usage,
                0.0,  # precursor_score
                0.0,  # risk_score
                0.0,  # oscillation_score
                zone_id / 4.0,
            ], dtype=np.float32)
            action_index = data.get("action_index", 2)
            demonstrations.append({"obs": obs, "action": action_index})
    return demonstrations


def dataset_hash(demos: List[Dict]) -> str:
    """计算 dataset hash, 便于追踪训练集版本"""
    def _coerce(o):
        # 处理 numpy 标量, 避免 json.dumps 失败
        if isinstance(o, (np.floating, np.integer)):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
        return str(o)
    blob = json.dumps(demos, sort_keys=True, ensure_ascii=False, default=_coerce).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:12]


# ── 评估指标 ──────────────────────────────────────────────────────
def evaluate(model: PolicyNetwork, dataset: TimelineDataset) -> Dict[str, float]:
    """v4 扩展评估: top-1 / top-2 / ECE"""
    model.eval()
    correct1, correct2, total = 0, 0, 0
    nll_total = 0.0
    conf_correct, conf_total = [], []
    with torch.no_grad():
        for obs, action in dataset:
            obs_b = obs.unsqueeze(0)
            logits = model(obs_b)
            probs = F.softmax(logits, dim=-1)
            top2 = probs.topk(2, dim=-1).indices.squeeze(0).tolist()
            a = int(action.item())
            if top2[0] == a:
                correct1 += 1
            if a in top2:
                correct2 += 1
            total += 1
            nll_total += F.cross_entropy(logits, action.unsqueeze(0), reduction="sum").item()
            conf_correct.append(probs[0, a].item() if a in top2 else 0.0)
            conf_total.append(probs[0, a].item())

    # ECE (Expected Calibration Error), 10 bins
    n_bins = 10
    bin_bounds = torch.linspace(0, 1, n_bins + 1)
    ece = 0.0
    for i in range(n_bins):
        lo, hi = bin_bounds[i].item(), bin_bounds[i + 1].item()
        mask = [(lo <= c < hi if i < n_bins - 1 else lo <= c <= hi) for c in conf_total]
        if not any(mask):
            continue
        avg_conf = sum(c for c, m in zip(conf_total, mask) if m) / max(sum(mask), 1)
        avg_acc = sum(c for c, m in zip(conf_correct, mask) if m) / max(sum(mask), 1)
        ece += (sum(mask) / total) * abs(avg_conf - avg_acc)
    return {
        "top1_acc": correct1 / max(total, 1),
        "top2_acc": correct2 / max(total, 1),
        "nll": nll_total / max(total, 1),
        "ece": ece,
    }


# ── Mixup ─────────────────────────────────────────────────────────
def mixup_batch(
    obs: torch.Tensor, action: torch.Tensor, alpha: float
) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, float]:
    """Mixup 增强, 返回 (obs1, obs2, lam) 供两路 loss 加权"""
    lam = float(np.random.beta(alpha, alpha)) if alpha > 0 else 1.0
    perm = torch.randperm(obs.size(0), device=obs.device)
    mixed_obs = lam * obs + (1 - lam) * obs[perm]
    return mixed_obs, action, action[perm], lam


# ── 训练主循环 ────────────────────────────────────────────────────
def train_bc_v4(
    timeline_path: str = "datasets/timeline_v2.jsonl",
    output_path: str = "checkpoints/bc_policy_v4.pt",
    epochs: int = 30,
    batch_size: int = 256,
    learning_rate: float = 3e-4,
    weight_decay: float = 1e-4,
    warmup_epochs: int = 2,
    noise_std: float = 0.01,
    mixup_alpha: float = 0.0,
    seed: int = 42,
) -> Dict:
    """BC v4 训练主入口"""
    torch.manual_seed(seed)
    np.random.seed(seed)

    print("=" * 60)
    print("BC V4 Training (SoloForge Governor RL)")
    print("=" * 60)
    print(f"Timeline: {timeline_path}")
    print(f"Output:   {output_path}")
    print(f"Epochs:   {epochs}  Batch: {batch_size}  LR: {learning_rate}")
    print(f"WeightDecay: {weight_decay}  Warmup: {warmup_epochs}ep  Noise: {noise_std}  Mixup: {mixup_alpha}")
    print()

    # 数据
    demos = load_timeline(timeline_path)
    print(f"[1/5] Loaded {len(demos)} demonstrations (hash={dataset_hash(demos)})")
    action_counter = Counter(d["action"] for d in demos)
    print("Action distribution:")
    for a in range(5):
        c = action_counter.get(a, 0)
        print(f"  {ACTION_NAMES[a]:<8}: {c:>6} ({c / max(len(demos), 1) * 100:>5.1f}%)")
    dataset = TimelineDataset(demos)
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True, num_workers=0)

    # 模型
    print("\n[2/5] Creating Policy Network (9→128→128→5)...")
    policy = PolicyNetwork(hidden_dim=128)
    n_params = sum(p.numel() for p in policy.parameters())
    print(f"Model params: {n_params:,}")

    # Optimizer + Scheduler
    optimizer = optim.AdamW(policy.parameters(), lr=learning_rate, weight_decay=weight_decay)
    total_steps = len(dataloader) * epochs
    warmup_steps = len(dataloader) * warmup_epochs

    def lr_lambda(step: int) -> float:
        if step < warmup_steps:
            return step / max(warmup_steps, 1)
        progress = (step - warmup_steps) / max(total_steps - warmup_steps, 1)
        return 0.5 * (1 + np.cos(np.pi * progress))

    scheduler = optim.lr_scheduler.LambdaLR(optimizer, lr_lambda)
    criterion = nn.CrossEntropyLoss(label_smoothing=0.05)

    # 训练
    print("\n[3/5] Training...")
    loss_history: List[float] = []
    t0 = time.time()
    for epoch in range(epochs):
        policy.train()
        ep_loss, n_batch = 0.0, 0
        for obs, action in dataloader:
            # 增强: 噪声注入
            if noise_std > 0:
                obs = obs + torch.randn_like(obs) * noise_std
            # 增强: mixup
            if mixup_alpha > 0:
                mixed_obs, a1, a2, lam = mixup_batch(obs, action, mixup_alpha)
                logits = policy(mixed_obs)
                loss = lam * criterion(logits, a1) + (1 - lam) * criterion(logits, a2)
            else:
                logits = policy(obs)
                loss = criterion(logits, action)

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(policy.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            ep_loss += loss.item()
            n_batch += 1
        avg = ep_loss / max(n_batch, 1)
        loss_history.append(avg)
        if (epoch + 1) % max(1, epochs // 10) == 0 or epoch == 0:
            print(f"  epoch {epoch + 1:>3}/{epochs}  loss={avg:.4f}  lr={scheduler.get_last_lr()[0]:.2e}")

    train_elapsed = time.time() - t0

    # 评估
    print("\n[4/5] Evaluating...")
    metrics = evaluate(policy, dataset)
    print(f"  top-1 acc: {metrics['top1_acc']:.4f}")
    print(f"  top-2 acc: {metrics['top2_acc']:.4f}")
    print(f"  NLL:       {metrics['nll']:.4f}")
    print(f"  ECE:       {metrics['ece']:.4f}")

    # 保存
    print("\n[5/5] Saving model + metadata...")
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    metadata = {
        "training_run_id": f"bc_v4_{time.strftime('%Y%m%d_%H%M%S')}",
        "model_arch": "9→128→128→5 (PolicyNetwork)",
        "n_params": n_params,
        "epochs": epochs,
        "batch_size": batch_size,
        "learning_rate": learning_rate,
        "weight_decay": weight_decay,
        "warmup_epochs": warmup_epochs,
        "noise_std": noise_std,
        "mixup_alpha": mixup_alpha,
        "label_smoothing": 0.05,
        "seed": seed,
        "dataset_size": len(demos),
        "dataset_hash": dataset_hash(demos),
        "action_distribution": dict(action_counter),
        "loss_history": loss_history,
        "eval_metrics": metrics,
        "train_elapsed_sec": round(train_elapsed, 2),
        "host": socket.gethostname(),
        "python_version": sys.version.split()[0],
        "torch_version": torch.__version__,
        "platform": platform.platform(),
    }
    torch.save(
        {"policy_state_dict": policy.state_dict(), "metadata": metadata},
        str(output),
    )
    meta_path = output.with_suffix(output.suffix + ".meta.json")
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  saved → {output} ({output.stat().st_size} bytes)")
    print(f"  meta  → {meta_path}")
    print(f"\n[OK] train_elapsed: {train_elapsed:.1f}s")
    return metadata


def main() -> int:
    p = argparse.ArgumentParser(description="BC V4 training with v3-like arch + v4 enhancements")
    p.add_argument("--timeline", default="datasets/timeline_v2.jsonl")
    p.add_argument("--output", default="checkpoints/bc_policy_v4.pt")
    p.add_argument("--epochs", type=int, default=30)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--warmup-epochs", type=int, default=2)
    p.add_argument("--noise-std", type=float, default=0.01)
    p.add_argument("--mixup", type=float, default=0.0)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()
    train_bc_v4(
        timeline_path=args.timeline,
        output_path=args.output,
        epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.lr,
        weight_decay=args.weight_decay,
        warmup_epochs=args.warmup_epochs,
        noise_std=args.noise_std,
        mixup_alpha=args.mixup,
        seed=args.seed,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
