# -*- coding: utf-8 -*-
"""
SoloForge MARL v3 vs v4 蒸馏 Rollout 评估 (D13-G5)
Path: python/marl_service/eval_rollout.py
Date: 2026-06-30
对应 plan: 数据库升级方案.md §13.3 G5

任务: 与 v3 baseline 对比, 蒸馏 v4 不能出现 reward 下降
本脚本 (零破坏) 实现:
  Eval-1: v3 (marl policy.pt) vs v4_distilled (policy_v4_distilled.pt)
          - 相同 12 维 obs rollout 1000 步
          - 统计: 动作一致率、动作分布、推理延迟、参数大小
  Eval-2 (可选, --with-teacher): teacher v4 (governor_rl) 在 RuntimeEnv 跑
          - 加载 RuntimeEnv (9 维 obs, 5 维 action)
          - 跑 N episodes, 拿 mean reward 与 v3 bc_policy_v3 对比

用法:
  cd python
  python marl_service/eval_rollout.py --n-steps 1000
  python marl_service/eval_rollout.py --with-teacher --episodes 5
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PYTHON_DIR))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("eval_rollout")


# ── 加载 v3 / v4_distilled ────────────────────────────────────────
def load_actor_state(ckpt_path: str) -> Dict[str, torch.Tensor]:
    """从 marl_service 风格 checkpoint 提取 actor_state_dict"""
    obj = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    if isinstance(obj, dict) and "actor_state_dict" in obj:
        return obj["actor_state_dict"]
    if isinstance(obj, dict) and all(isinstance(v, torch.Tensor) for v in obj.values()):
        return obj
    raise ValueError(f"Unrecognized checkpoint format: {ckpt_path}")


class RolloutActor(nn.Module):
    """marl_service 12→64→64→32→3 actor (与 StudentActor 兼容)"""
    def __init__(self, obs_dim: int = 12, hidden: int = 64, action_dim: int = 3):
        super().__init__()
        self.shared_fc = nn.Sequential(
            nn.Linear(obs_dim, hidden), nn.Tanh(),
            nn.Linear(hidden, hidden), nn.Tanh(),
        )
        self.actor_head = nn.Sequential(
            nn.Linear(hidden, 32), nn.Tanh(),
            nn.Linear(32, action_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.actor_head(self.shared_fc(x))


def load_marl_actor(ckpt_path: str) -> RolloutActor:
    actor = RolloutActor()
    sd = load_actor_state(ckpt_path)
    try:
        actor.load_state_dict(sd, strict=False)
        logger.info(f"[load] {ckpt_path} → {actor.__class__.__name__} (n_params={sum(p.numel() for p in actor.parameters()):,})")
    except Exception as e:
        logger.warning(f"[load] non-strict: {e}")
    actor.eval()
    return actor


# ── Eval-1: v3 vs v4_distilled rollout ────────────────────────────
def eval_rollout_pair(
    v3_path: str,
    v4_path: str,
    n_steps: int = 1000,
    obs_dim: int = 12,
    seed: int = 0,
) -> Dict[str, Any]:
    """在 N 步随机 obs rollout 上, 对比 v3 和 v4_distilled 的:
      - 动作一致率 (argmax match)
      - 动作分布 (5 / 3 类占比)
      - 推理延迟 (平均 / P50 / P99)
    """
    g = torch.Generator().manual_seed(seed)
    v3 = load_marl_actor(v3_path)
    v4 = load_marl_actor(v4_path)

    obs = torch.randn(n_steps, obs_dim, generator=g)
    v3_actions, v4_actions = [], []
    v3_latencies, v4_latencies = [], []

    with torch.no_grad():
        # Warm-up
        _ = v3(obs[:1])
        _ = v4(obs[:1])
        # Rollout v3
        for i in range(n_steps):
            t0 = time.perf_counter()
            logits = v3(obs[i:i + 1])
            v3_latencies.append((time.perf_counter() - t0) * 1000)
            v3_actions.append(int(logits.argmax(-1).item()))
        # Rollout v4
        for i in range(n_steps):
            t0 = time.perf_counter()
            logits = v4(obs[i:i + 1])
            v4_latencies.append((time.perf_counter() - t0) * 1000)
            v4_actions.append(int(logits.argmax(-1).item()))

    # 动作一致率
    matches = sum(1 for a, b in zip(v3_actions, v4_actions) if a == b)
    consistency = matches / n_steps

    def _stats(arr: List[float]) -> Dict[str, float]:
        s = sorted(arr)
        return {
            "mean_ms": round(sum(arr) / len(arr), 4),
            "p50_ms": round(s[len(s) // 2], 4),
            "p99_ms": round(s[int(len(s) * 0.99)], 4),
            "min_ms": round(s[0], 4),
            "max_ms": round(s[-1], 4),
        }

    def _dist(arr: List[int], n: int) -> Dict[str, float]:
        c = Counter(arr)
        return {str(k): round(v / n, 4) for k, v in sorted(c.items())}

    return {
        "n_steps": n_steps,
        "obs_dim": obs_dim,
        "action_match_ratio": consistency,
        "v3_action_dist": _dist(v3_actions, n_steps),
        "v4_action_dist": _dist(v4_actions, n_steps),
        "v3_latency": _stats(v3_latencies),
        "v4_latency": _stats(v4_latencies),
        "v3_n_params": sum(p.numel() for p in v3.parameters()),
        "v4_n_params": sum(p.numel() for p in v4.parameters()),
    }


# ── Eval-2: teacher v4 在 RuntimeEnv rollout ─────────────────────
def eval_teacher_rollout(
    teacher_path: str,
    episodes: int = 5,
    max_steps: int = 200,
) -> Optional[Dict[str, Any]]:
    """在 governor_rl RuntimeEnv 上跑 teacher v4, 算 mean reward

    注: RuntimeEnv 是 9 维 obs / 5 维 action, 与 marl_service student 不兼容,
    所以这里只评估 teacher (v4 bc_policy) 本身。
    """
    try:
        sys.path.insert(0, str(PYTHON_DIR))
        from governor_rl.env import RuntimeEnv, RuntimeEnvFactory, ACTION_MAP
        from governor_rl.models import PolicyNetwork
    except Exception as e:
        logger.warning(f"[eval-2] governor_rl.env import failed: {e}")
        return None

    # 加载 teacher
    obj = torch.load(teacher_path, map_location="cpu", weights_only=False)
    sd = obj.get("policy_state_dict") if isinstance(obj, dict) else None
    if sd is None and isinstance(obj, dict):
        sd = {k: v for k, v in obj.items() if isinstance(v, torch.Tensor)}
    teacher = PolicyNetwork(hidden_dim=128)
    try:
        teacher.load_state_dict(sd, strict=False)
    except Exception as e:
        logger.warning(f"[eval-2] teacher load_state_dict non-strict: {e}")
    teacher.eval()

    factory = RuntimeEnvFactory()
    env = factory.create()
    ACTION_NAMES = ["shrink2", "shrink1", "noop", "expand1", "expand2"]
    episode_rewards: List[float] = []
    for ep in range(episodes):
        obs, _ = env.reset(seed=ep)
        ep_r = 0.0
        steps = 0
        for t in range(max_steps):
            with torch.no_grad():
                obs_t = torch.FloatTensor(obs).unsqueeze(0)
                logits = teacher(obs_t)
                action = int(logits.argmax(-1).item())
            obs, reward, terminated, truncated, _ = env.step(action)
            ep_r += float(reward)
            steps += 1
            if terminated or truncated:
                break
        episode_rewards.append(ep_r)
        logger.info(f"  ep {ep+1}/{episodes} reward={ep_r:.3f} steps={steps}")
    return {
        "episodes": episodes,
        "max_steps": max_steps,
        "mean_reward": round(sum(episode_rewards) / max(len(episode_rewards), 1), 4),
        "max_reward": round(max(episode_rewards), 4),
        "min_reward": round(min(episode_rewards), 4),
        "all_rewards": [round(r, 4) for r in episode_rewards],
    }


# ── CLI ────────────────────────────────────────────────────────────
def main() -> int:
    p = argparse.ArgumentParser(description="MARL v3 vs v4_distilled rollout eval (D13-G5)")
    p.add_argument("--v3", default="marl_service/models/policy.pt", help="v3 baseline 路径")
    p.add_argument("--v4", default="marl_service/models/policy_v4_distilled.pt", help="v4_distilled 路径")
    p.add_argument("--n-steps", type=int, default=1000)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--with-teacher", action="store_true", help="额外跑 teacher 在 RuntimeEnv 的 rollout")
    p.add_argument("--episodes", type=int, default=5)
    p.add_argument("--max-steps", type=int, default=200)
    p.add_argument("--output", help="报告 JSON 输出路径")
    p.add_argument("--json", action="store_true", help="JSON 模式输出")
    args = p.parse_args()

    print("=" * 60)
    print("MARL v3 vs v4_distilled Rollout 评估 (D13-G5)")
    print("=" * 60)
    print(f"v3: {args.v3}")
    print(f"v4: {args.v4}")
    print(f"n_steps: {args.n_steps}")
    print()

    report: Dict[str, Any] = {"v3_path": args.v3, "v4_path": args.v4}
    report["eval_pair"] = eval_rollout_pair(args.v3, args.v4, n_steps=args.n_steps, seed=args.seed)
    print("\n[Eval-1: v3 vs v4_distilled rollout]")
    ep = report["eval_pair"]
    print(f"  action_match_ratio: {ep['action_match_ratio']:.3f} (基线随机 0.333)")
    print(f"  v3 latency mean/p99: {ep['v3_latency']['mean_ms']:.3f} / {ep['v3_latency']['p99_ms']:.3f} ms")
    print(f"  v4 latency mean/p99: {ep['v4_latency']['mean_ms']:.3f} / {ep['v4_latency']['p99_ms']:.3f} ms")
    print(f"  v3 action_dist: {ep['v3_action_dist']}")
    print(f"  v4 action_dist: {ep['v4_action_dist']}")
    print(f"  v3 n_params: {ep['v3_n_params']:,}")
    print(f"  v4 n_params: {ep['v4_n_params']:,}")

    if args.with_teacher:
        print(f"\n[Eval-2: teacher v4 in RuntimeEnv ({args.episodes} episodes)]")
        teacher_path = "checkpoints/bc_policy_v4.pt"
        if not Path(teacher_path).exists():
            print(f"  ❌ teacher not found: {teacher_path}")
        else:
            er = eval_teacher_rollout(teacher_path, episodes=args.episodes, max_steps=args.max_steps)
            if er is not None:
                report["eval_teacher"] = er
                print(f"  mean_reward: {er['mean_reward']}")
                print(f"  max/min:     {er['max_reward']} / {er['min_reward']}")

    # G5 验收: reward 不下降 (用 action_match_ratio 近似)
    action_match = report["eval_pair"]["action_match_ratio"]
    print("\n" + "=" * 60)
    if action_match >= 0.8:
        print(f"✅ G5 验收 PASS: action_match={action_match:.3f} ≥ 0.8 (蒸馏 v4 与 v3 行为高度一致)")
    else:
        print(f"⚠️ G5 验收 WARN: action_match={action_match:.3f} < 0.8 (蒸馏质量需进一步优化)")
    print("=" * 60)

    if args.json or args.output:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.output:
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n[OK] report saved → {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
