# -*- coding: utf-8 -*-
"""
SoloForge MARL v4 蒸馏脚本 (D12-G2/G3)
Path: python/marl_service/distill_v4_to_marl.py
Date: 2026-06-30
对应 plan: 数据库升级方案.md §13 阶段 6, 任务表 D12-G2/G3

目标:
  把 governor_rl 训练好的 v4 teacher (PolicyNetwork: 9→128→128→5)
  蒸馏到 marl_service 的 student 网络 (12→64→64→32→3)

架构维度不匹配 (plan §13.3 G1 决策点已确认走蒸馏):
  - obs:    teacher 9 维 vs student 12 维  → 取 student obs 的前 9 维作为 teacher 输入
  - action: teacher 5 维 vs student 3 维   → 取 teacher logits 的前 3 维作为蒸馏目标
  - hidden: teacher 128 维 vs student 64 维 (这个无需对齐, 通过损失函数学)

零破坏: 新文件, 不修改任何现有 .pt / 业务代码

G3 损失函数: KL 散度 + MSE + 监督熵
  L_total = α * L_KL (蒸馏) + β * L_MSE (logits 直接回归) + γ * L_CE (动作监督)
  其中:
    L_KL  = T^2 * KL(softmax(student/T) || softmax(teacher/T))    # Hinton KD
    L_MSE = MSE(student_logits, teacher_logits)                     # 直接 logits 对齐
    L_CE  = CrossEntropy(student_logits, teacher_argmax)            # 硬标签模仿

用法:
  cd python
  python marl_service/distill_v4_to_marl.py \\
      --teacher /path/to/v4_teacher.pt \\
      --student-init /path/to/policy.pt \\
      --output /path/to/policy_v4_distilled.pt \\
      --epochs 10 --batch-size 32

  # 演示模式 (无 demonstrations, 随机采样测试蒸馏管道)
  python marl_service/distill_v4_to_marl.py --demo --teacher ... --output ...
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset, TensorDataset

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("distill_v4_to_marl")


# ── 维度常量 ────────────────────────────────────────────────────────
TEACHER_OBS_DIM = 9       # governor_rl PolicyNetwork
TEACHER_ACTION_DIM = 5
TEACHER_HIDDEN = 128

STUDENT_OBS_DIM = 12      # marl_service/policy.pt 实际导出
STUDENT_ACTION_DIM = 3
STUDENT_HIDDEN = 64


# ── Teacher / Student 网络 ─────────────────────────────────────────
class TeacherActor(nn.Module):
    """governor_rl PolicyNetwork 兼容 (9→128→128→5)"""

    def __init__(self, obs_dim: int = TEACHER_OBS_DIM, hidden: int = TEACHER_HIDDEN, action_dim: int = TEACHER_ACTION_DIM):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(obs_dim, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, action_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class StudentActor(nn.Module):
    """marl_service/policy.pt actor 兼容 (12→64→64→32→3)"""

    def __init__(self, obs_dim: int = STUDENT_OBS_DIM, hidden: int = STUDENT_HIDDEN, action_dim: int = STUDENT_ACTION_DIM):
        super().__init__()
        self.shared_fc = nn.Sequential(
            nn.Linear(obs_dim, hidden),
            nn.Tanh(),
            nn.Linear(hidden, hidden),
            nn.Tanh(),
        )
        self.actor_head = nn.Sequential(
            nn.Linear(hidden, 32),
            nn.Tanh(),
            nn.Linear(32, action_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = self.shared_fc(x)
        return self.actor_head(h)


# ── 维度适配器 ─────────────────────────────────────────────────────
class DimAdapter:
    """处理 obs 和 action 维度不匹配

    obs 适配: 取 student obs 的前 teacher_obs_dim 维
              (或用线性投影, 默认前者, 因为 student obs 实际是 teacher obs 的超集)
    action 适配: 取 teacher logits 的前 student_action_dim 维
    """

    def __init__(self, teacher_obs_dim: int = TEACHER_OBS_DIM, student_action_dim: int = STUDENT_ACTION_DIM):
        self.teacher_obs_dim = teacher_obs_dim
        self.student_action_dim = student_action_dim

    def adapt_obs_for_teacher(self, student_obs: torch.Tensor) -> torch.Tensor:
        """student obs (B, 12) → teacher obs (B, 9)"""
        if student_obs.shape[-1] < self.teacher_obs_dim:
            pad = torch.zeros(*student_obs.shape[:-1], self.teacher_obs_dim - student_obs.shape[-1],
                              device=student_obs.device, dtype=student_obs.dtype)
            return torch.cat([student_obs, pad], dim=-1)
        return student_obs[..., :self.teacher_obs_dim]

    def adapt_teacher_logits(self, teacher_logits: torch.Tensor) -> torch.Tensor:
        """teacher logits (B, 5) → student target (B, 3)"""
        if teacher_logits.shape[-1] < self.student_action_dim:
            pad = torch.zeros(*teacher_logits.shape[:-1], self.student_action_dim - teacher_logits.shape[-1],
                              device=teacher_logits.device, dtype=teacher_logits.dtype)
            return torch.cat([teacher_logits, pad], dim=-1)
        return teacher_logits[..., :self.student_action_dim]


# ── 损失函数 (G3 任务: KL+MSE+CE) ──────────────────────────────────
@dataclass
class DistillLossWeights:
    """蒸馏损失权重"""
    alpha_kl: float = 0.5    # KD 软目标权重
    beta_mse: float = 0.3    # logits MSE 权重
    gamma_ce: float = 0.2    # 硬标签 CE 权重
    temperature: float = 2.0 # KD 温度 T


def distillation_loss(
    student_logits: torch.Tensor,
    teacher_logits: torch.Tensor,
    weights: DistillLossWeights = field(default_factory=DistillLossWeights),
) -> Tuple[torch.Tensor, Dict[str, float]]:
    """G3 蒸馏损失: KL(soft) + MSE + CE(hard)

    Args:
        student_logits: (B, action_dim)
        teacher_logits: (B, action_dim) — 已经过 DimAdapter 投影到 student 维度
        weights: 损失权重配置

    Returns:
        (loss, metrics_dict)
    """
    T = weights.temperature
    # KD 软目标: KL(student/T || teacher/T) * T^2
    student_log_probs_T = F.log_softmax(student_logits / T, dim=-1)
    teacher_probs_T = F.softmax(teacher_logits / T, dim=-1)
    l_kl = F.kl_div(student_log_probs_T, teacher_probs_T, reduction="batchmean") * (T * T)

    # Logits MSE: 直接回归
    l_mse = F.mse_loss(student_logits, teacher_logits)

    # 硬标签 CE: 用 teacher argmax 作为伪标签
    teacher_action = teacher_logits.argmax(dim=-1)
    l_ce = F.cross_entropy(student_logits, teacher_action)

    loss = weights.alpha_kl * l_kl + weights.beta_mse * l_mse + weights.gamma_ce * l_ce

    return loss, {
        "loss": float(loss.item()),
        "kl": float(l_kl.item()),
        "mse": float(l_mse.item()),
        "ce": float(l_ce.item()),
    }


# ── Checkpoint 加载 ────────────────────────────────────────────────
def load_teacher(checkpoint_path: Path) -> TeacherActor:
    """加载 teacher checkpoint (支持多种命名约定)"""
    obj = torch.load(str(checkpoint_path), map_location="cpu", weights_only=False)
    # 识别顶层 state_dict 命名: state_dict / policy_state_dict / actor_state_dict / 直接 Tensor dict
    sd: Optional[Dict[str, torch.Tensor]] = None
    if isinstance(obj, dict):
        for key in ("state_dict", "policy_state_dict", "actor_state_dict", "model_state_dict"):
            if key in obj and isinstance(obj[key], dict):
                sd = obj[key]
                break
        if sd is None and all(isinstance(v, torch.Tensor) for v in obj.values()):
            sd = obj
    if sd is None:
        raise ValueError(f"Unrecognized teacher checkpoint format: {type(obj)}, keys={list(obj.keys()) if isinstance(obj, dict) else 'N/A'}")

    teacher = TeacherActor()
    # 兼容命名: net.0.weight → net.0.weight (PolicyNetwork 本身就是 Sequential)
    try:
        teacher.load_state_dict(sd, strict=False)
    except Exception as e:
        logger.warning(f"[teacher] load_state_dict non-strict: {e}")
    teacher.eval()
    return teacher


def load_student(checkpoint_path: Optional[Path]) -> StudentActor:
    """加载 student 初始化权重

    如果提供 checkpoint, 用其 actor_state_dict 初始化 (含 fc/head 命名)
    如果不提供, 随机初始化
    """
    student = StudentActor()
    if checkpoint_path is None:
        logger.info("[student] random init (no --student-init)")
        return student
    obj = torch.load(str(checkpoint_path), map_location="cpu", weights_only=False)
    sd: Optional[Dict[str, torch.Tensor]] = None
    if isinstance(obj, dict) and "actor_state_dict" in obj:
        sd = obj["actor_state_dict"]
    elif isinstance(obj, dict) and all(isinstance(v, torch.Tensor) for v in obj.values()):
        sd = obj
    if sd is None:
        logger.warning(f"[student] no actor_state_dict in {checkpoint_path}, use random init")
        return student
    # 适配命名: shared_fc.0.weight → shared_fc.0.weight (StudentActor 用 Sequential)
    # marl_service actor: shared_fc[0/2], actor_head[0/2]
    try:
        student.load_state_dict(sd, strict=False)
        logger.info(f"[student] loaded from {checkpoint_path}")
    except Exception as e:
        logger.warning(f"[student] load_state_dict non-strict: {e}")
    student.train()
    return student


def save_student(student: StudentActor, output_path: Path, metadata: Dict[str, Any]) -> None:
    """保存蒸馏后的 student

    兼容 marl_service 加载: dict 顶层有 'actor_state_dict'
    """
    actor_sd = student.state_dict()
    out = {
        "actor_state_dict": actor_sd,
        "critic_state_dict": {},  # 蒸馏只更新 actor, critic 保留原状由调用方合并
        "metadata": metadata,
    }
    torch.save(out, str(output_path))
    logger.info(f"[student] saved → {output_path} ({output_path.stat().st_size} bytes)")
    meta_path = output_path.with_suffix(output_path.suffix + ".meta.json")
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")


# ── 蒸馏训练循环 ───────────────────────────────────────────────────
def build_dataloader(
    student_obs_dim: int,
    n_samples: int,
    batch_size: int,
    seed: int = 42,
) -> DataLoader:
    """构造 demo dataset (随机 student obs, 模拟真实数据)

    真实生产用法应传入历史 obs 序列 (从 log 提取), 这里为管道验证用随机数据。
    """
    g = torch.Generator().manual_seed(seed)
    obs = torch.randn(n_samples, student_obs_dim, generator=g)
    # 模拟标签: teacher 在 9 维子空间上的 argmax (避免全 0)
    teacher_obs = obs[..., :TEACHER_OBS_DIM]
    target_action = teacher_obs.sum(dim=-1).long().abs() % STUDENT_ACTION_DIM
    ds = TensorDataset(obs, target_action)
    return DataLoader(ds, batch_size=batch_size, shuffle=True)


def distillation_train(
    teacher: TeacherActor,
    student: StudentActor,
    adapter: DimAdapter,
    dataloader: DataLoader,
    epochs: int,
    lr: float,
    weights: DistillLossWeights,
    device: str = "cpu",
    log_every: int = 10,
) -> Dict[str, Any]:
    """G2 主训练循环"""
    teacher.to(device).eval()
    student.to(device).train()
    optimizer = torch.optim.Adam(student.parameters(), lr=lr)

    history: List[Dict[str, float]] = []
    final_action_match = 0.0

    for ep in range(1, epochs + 1):
        ep_metrics: List[Dict[str, float]] = []
        for batch_idx, (obs, _) in enumerate(dataloader, start=1):
            obs = obs.to(device)
            with torch.no_grad():
                teacher_obs = adapter.adapt_obs_for_teacher(obs)
                teacher_logits_full = teacher(teacher_obs)
                teacher_logits = adapter.adapt_teacher_logits(teacher_logits_full)

            student_logits = student(obs)
            loss, metrics = distillation_loss(student_logits, teacher_logits, weights)

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(student.parameters(), max_norm=1.0)
            optimizer.step()

            ep_metrics.append(metrics)
            if batch_idx % log_every == 0:
                logger.info(
                    f"[ep {ep}/{epochs} batch {batch_idx}] "
                    f"loss={metrics['loss']:.4f} kl={metrics['kl']:.4f} "
                    f"mse={metrics['mse']:.4f} ce={metrics['ce']:.4f}"
                )

        # epoch 汇总
        avg = {k: sum(m[k] for m in ep_metrics) / max(len(ep_metrics), 1) for k in ep_metrics[0]}
        avg["epoch"] = ep
        history.append(avg)

        # 评估动作匹配率
        with torch.no_grad():
            sample_obs = next(iter(dataloader))[0][:64].to(device)
            teacher_obs = adapter.adapt_obs_for_teacher(sample_obs)
            t_logits = adapter.adapt_teacher_logits(teacher(teacher_obs))
            s_logits = student(sample_obs)
            match = (t_logits.argmax(-1) == s_logits.argmax(-1)).float().mean().item()
            avg["action_match"] = match
            final_action_match = match

        logger.info(
            f"[ep {ep}/{epochs} DONE] "
            f"avg_loss={avg['loss']:.4f} action_match={match:.3f}"
        )

    return {
        "epochs": epochs,
        "final_action_match": final_action_match,
        "history": history,
    }


# ── 评估函数 (G5 准备) ─────────────────────────────────────────────
def evaluate(teacher: TeacherActor, student: StudentActor, adapter: DimAdapter, n_samples: int = 200) -> Dict[str, float]:
    """评估蒸馏后 student 与 teacher 动作分布一致性"""
    teacher.eval()
    student.eval()
    obs = torch.randn(n_samples, STUDENT_OBS_DIM)
    with torch.no_grad():
        teacher_obs = adapter.adapt_obs_for_teacher(obs)
        t_logits = adapter.adapt_teacher_logits(teacher(teacher_obs))
        s_logits = student(obs)
        t_action = t_logits.argmax(-1)
        s_action = s_logits.argmax(-1)
        match = (t_action == s_action).float().mean().item()
        # KL(student || teacher) 平均
        kl = F.kl_div(
            F.log_softmax(s_logits, dim=-1),
            F.softmax(t_logits, dim=-1),
            reduction="batchmean",
        ).item()
        # logit MSE
        mse = F.mse_loss(s_logits, t_logits).item()
    return {
        "n_samples": n_samples,
        "action_match_ratio": match,
        "kl_divergence": kl,
        "logit_mse": mse,
    }


# ── CLI ────────────────────────────────────────────────────────────
def main() -> int:
    p = argparse.ArgumentParser(description="SoloForge MARL v4 蒸馏 (D12-G2/G3)")
    p.add_argument("--teacher", required=True, help="teacher checkpoint 路径 (.pt)")
    p.add_argument("--student-init", help="student 初始化 checkpoint 路径 (可选, 默认随机)")
    p.add_argument("--output", required=True, help="蒸馏后 student 输出路径 (.pt)")
    p.add_argument("--epochs", type=int, default=5)
    p.add_argument("--batch-size", type=int, default=32)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--n-samples", type=int, default=200, help="demo 数据集大小")
    p.add_argument("--alpha-kl", type=float, default=0.5)
    p.add_argument("--beta-mse", type=float, default=0.3)
    p.add_argument("--gamma-ce", type=float, default=0.2)
    p.add_argument("--temperature", type=float, default=2.0)
    p.add_argument("--device", default="cpu")
    p.add_argument("--demo", action="store_true", help="演示模式 (随机数据)")
    p.add_argument("--json", action="store_true", help="JSON 输出")
    args = p.parse_args()

    weights = DistillLossWeights(
        alpha_kl=args.alpha_kl,
        beta_mse=args.beta_mse,
        gamma_ce=args.gamma_ce,
        temperature=args.temperature,
    )
    adapter = DimAdapter(teacher_obs_dim=TEACHER_OBS_DIM, student_action_dim=STUDENT_ACTION_DIM)

    teacher = load_teacher(Path(args.teacher))
    student = load_student(Path(args.student_init) if args.student_init else None)
    logger.info(
        f"[setup] teacher={TEACHER_OBS_DIM}→{TEACHER_HIDDEN}→{TEACHER_ACTION_DIM} "
        f"student={STUDENT_OBS_DIM}→{STUDENT_HIDDEN}→{STUDENT_ACTION_DIM} "
        f"T={weights.temperature}"
    )

    dataloader = build_dataloader(
        student_obs_dim=STUDENT_OBS_DIM,
        n_samples=args.n_samples,
        batch_size=args.batch_size,
    )
    t0 = time.time()
    train_report = distillation_train(
        teacher=teacher, student=student, adapter=adapter,
        dataloader=dataloader, epochs=args.epochs, lr=args.lr,
        weights=weights, device=args.device,
    )
    train_elapsed = time.time() - t0

    eval_report = evaluate(teacher, student, adapter, n_samples=200)

    metadata = {
        "teacher_path": str(Path(args.teacher).resolve()),
        "student_init_path": str(Path(args.student_init).resolve()) if args.student_init else None,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "n_samples": args.n_samples,
        "loss_weights": vars(weights),
        "train_elapsed_sec": round(train_elapsed, 3),
        "train_history": train_report["history"],
        "eval": eval_report,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    save_student(student, output, metadata)

    print("\n" + "=" * 60)
    print("MARL v4 蒸馏完工 (D12-G2/G3)")
    print("=" * 60)
    print(f"  output:    {output}")
    print(f"  epochs:    {args.epochs}")
    print(f"  elapsed:   {train_elapsed:.1f}s")
    print(f"  action_match (eval): {eval_report['action_match_ratio']:.3f}")
    print(f"  KL(student||teacher): {eval_report['kl_divergence']:.4f}")
    print(f"  logit_mse:            {eval_report['logit_mse']:.4f}")
    print("=" * 60)

    if args.json:
        print("\n--- JSON ---")
        print(json.dumps({"metadata": metadata, "eval": eval_report},
                         ensure_ascii=False, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
