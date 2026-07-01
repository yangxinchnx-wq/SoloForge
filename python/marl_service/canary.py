# -*- coding: utf-8 -*-
"""
SoloForge MARL v3/v4 Canary Router (D14-G6/G7)
Path: python/marl_service/canary.py
Date: 2026-06-30
对应 plan: 数据库升级方案.md §13.4 灰度方案 (Stage 1: 1% / Stage 2: 10% / Stage 3: 50% / Stage 4: 100%)

零破坏:
  - 不修改 server_prod.py / evaluator.py / mappo_net.py
  - 旁挂实现, 业务代码可选择性 import 替代直接加载 policy.pt

路由策略:
  - env var MARL_CANARY_V4_PCT (0-100, 默认 0)
  - 对每个请求的 obs 算 hash → 取模 → 决定 v3 vs v4
  - 同 obs 永远路由到同一模型 (一致性)

用法:
  # 0% v4 (默认, 全 v3)
  python marl_service/canary.py --demo 1000

  # 1% v4 (Stage 1 灰度)
  MARL_CANARY_V4_PCT=1 python marl_service/canary.py --demo 1000

  # 100% v4 (Stage 4 全量)
  MARL_CANARY_V4_PCT=100 python marl_service/canary.py --demo 1000
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PYTHON_DIR))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("canary")


# ── 路由策略 ────────────────────────────────────────────────────────
def canary_decision(obs_bytes: bytes, v4_pct: int) -> str:
    """根据 obs 哈希和 v4_pct 决定走 v3 还是 v4

    同 obs 永远返回同一决策 (一致性)

    Args:
        obs_bytes: obs 序列化后的 bytes (用 tobytes())
        v4_pct: v4 流量比例 (0-100)

    Returns:
        "v3" 或 "v4"
    """
    if v4_pct <= 0:
        return "v3"
    if v4_pct >= 100:
        return "v4"
    h = int(hashlib.md5(obs_bytes).hexdigest()[:8], 16) % 100
    return "v4" if h < v4_pct else "v3"


# ── 模型加载 (轻量, 不依赖 MAPPONetwork) ──────────────────────────
class _StudentActor(torch.nn.Module):
    def __init__(self, obs_dim: int = 12, hidden: int = 64, action_dim: int = 3):
        super().__init__()
        self.shared_fc = torch.nn.Sequential(
            torch.nn.Linear(obs_dim, hidden), torch.nn.Tanh(),
            torch.nn.Linear(hidden, hidden), torch.nn.Tanh(),
        )
        self.actor_head = torch.nn.Sequential(
            torch.nn.Linear(hidden, 32), torch.nn.Tanh(),
            torch.nn.Linear(32, action_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.actor_head(self.shared_fc(x))


def _load_state_dict(ckpt_path: str) -> Dict[str, torch.Tensor]:
    obj = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    if isinstance(obj, dict) and "actor_state_dict" in obj:
        return obj["actor_state_dict"]
    if isinstance(obj, dict) and all(isinstance(v, torch.Tensor) for v in obj.values()):
        return obj
    raise ValueError(f"Unrecognized checkpoint: {ckpt_path}")


# ── 双轨推理器 ────────────────────────────────────────────────────
# D17 v3 修复 (2026-07-01): 引入局部 RingBuffer 避免长跑慢漏内存
#   之前 CanaryStats 用 List[float] 累积 v3/v4 延迟 → 30min × 6800 qps × 8B ≈ 96MB leak
#   现在限制每路 50K 样本循环复用, 同时周期性 gc
_CANARY_LATENCY_RING = 50_000  # 每路最多保留 50K 延迟样本 (~400KB)


class _LatencyRing:
    """固定容量循环缓冲: append 永不增长; 满了覆盖最老"""

    __slots__ = ("_buf", "_size", "_idx", "_filled")

    def __init__(self, capacity: int):
        self._buf: list = [0.0] * capacity
        self._size = capacity
        self._idx = 0
        self._filled = 0

    def append(self, v: float) -> None:
        self._buf[self._idx] = v
        self._idx = (self._idx + 1) % self._size
        if self._filled < self._size:
            self._filled += 1

    def snapshot(self) -> List[float]:
        return self._buf[: self._filled]


@dataclass
class CanaryStats:
    """canary 统计 (per session)
    D17 v3 修复 (2026-07-01): 延迟数组改 RingBuffer, 避免 30min 长跑 +96MB leak
    """
    v3_count: int = 0
    v4_count: int = 0
    v3_action_dist: Counter = field(default_factory=Counter)
    v4_action_dist: Counter = field(default_factory=Counter)
    v3_latencies_ms: _LatencyRing = field(default_factory=lambda: _LatencyRing(_CANARY_LATENCY_RING))
    v4_latencies_ms: _LatencyRing = field(default_factory=lambda: _LatencyRing(_CANARY_LATENCY_RING))

    def add(self, route: str, action: int, latency_ms: float) -> None:
        if route == "v3":
            self.v3_count += 1
            self.v3_action_dist[action] += 1
            self.v3_latencies_ms.append(latency_ms)
        else:
            self.v4_count += 1
            self.v4_action_dist[action] += 1
            self.v4_latencies_ms.append(latency_ms)

    def summary(self) -> Dict[str, Any]:
        total = self.v3_count + self.v4_count
        actual_v4_pct = (self.v4_count / total * 100) if total else 0.0
        # D17 v3 修复 (2026-07-01): RingBuffer.snapshot() 替代直接传 List
        def _lat(ring) -> Dict[str, float]:
            arr = ring.snapshot() if hasattr(ring, "snapshot") else list(ring)
            if not arr:
                return {"mean_ms": 0, "p50_ms": 0, "p99_ms": 0, "n": 0}
            s = sorted(arr)
            return {
                "mean_ms": round(sum(arr) / len(arr), 4),
                "p50_ms": round(s[len(s) // 2], 4),
                "p99_ms": round(s[int(len(s) * 0.99)], 4),
                "n": len(arr),
            }
        def _dist(c: Counter, n: int) -> Dict[str, float]:
            return {str(k): round(v / max(n, 1), 4) for k, v in sorted(c.items())}
        return {
            "total_requests": total,
            "v3_count": self.v3_count,
            "v4_count": self.v4_count,
            "actual_v4_pct": round(actual_v4_pct, 3),
            "v3_latency": _lat(self.v3_latencies_ms),
            "v4_latency": _lat(self.v4_latencies_ms),
            "v3_action_dist": _dist(self.v3_action_dist, self.v3_count),
            "v4_action_dist": _dist(self.v4_action_dist, self.v4_count),
        }


class CanaryRouter:
    """v3 / v4 双轨推理路由器 (G6 / G7)"""

    def __init__(
        self,
        v3_path: Optional[str] = None,
        v4_path: Optional[str] = None,
        v4_pct: Optional[int] = None,
        backend: str = "torch",  # torch | onnx
    ) -> None:
        self.v3_path = v3_path or os.environ.get(
            "MARL_V3_PATH", "marl_service/models/policy.pt"
        )
        self.v4_path = v4_path or os.environ.get(
            "MARL_V4_PATH", "marl_service/models/policy_v4_distilled.pt"
        )
        self.v4_pct = v4_pct if v4_pct is not None else int(
            os.environ.get("MARL_CANARY_V4_PCT", "0")
        )
        self.backend = backend
        if not 0 <= self.v4_pct <= 100:
            raise ValueError(f"MARL_CANARY_V4_PCT must be 0-100, got {self.v4_pct}")

        self.v3_model = self._load_v3()
        self.v4_model = self._load_v4() if self.v4_pct > 0 or backend == "onnx" else None
        self.stats = CanaryStats()
        self.logger = logging.getLogger("canary.router")
        self.logger.info(
            f"[canary] v4_pct={self.v4_pct}% backend={backend} "
            f"v3={self.v3_path} v4={self.v4_path if self.v4_model else 'lazy'}"
        )

    def _load_v3(self) -> _StudentActor:
        m = _StudentActor()
        m.load_state_dict(_load_state_dict(self.v3_path), strict=False)
        m.eval()
        return m

    def _load_v4(self) -> Any:
        if self.backend == "onnx":
            try:
                import onnxruntime as ort
                sess = ort.InferenceSession(
                    self.v4_path, providers=["CPUExecutionProvider"]
                )
                return sess
            except ImportError:
                self.logger.warning("onnxruntime 不可用, 回退 torch")
        m = _StudentActor()
        m.load_state_dict(_load_state_dict(self.v4_path), strict=False)
        m.eval()
        return m

    def infer(self, obs: np.ndarray) -> Tuple[int, str]:
        """推理单个 obs, 返回 (action, route)

        零破坏: 不修改 obs 内容, 纯推理
        """
        obs = np.asarray(obs, dtype=np.float32).reshape(-1)
        route = canary_decision(obs.tobytes(), self.v4_pct)
        model = self.v3_model if route == "v3" else self.v4_model
        if model is None:
            # 0% v4 时不会到这里; 100% 时 v4_model 必加载
            raise RuntimeError(f"route={route} 但对应模型未加载")
        t0 = time.perf_counter()
        if isinstance(model, _StudentActor):
            with torch.no_grad():
                logits = model(torch.FloatTensor(obs).unsqueeze(0))
                action = int(logits.argmax(-1).item())
        else:
            # onnxruntime
            out = model.run(None, {"obs": obs.reshape(1, -1).astype(np.float32)})[0]
            action = int(out.argmax(-1).item())
        latency_ms = (time.perf_counter() - t0) * 1000
        self.stats.add(route, action, latency_ms)
        return action, route

    def stats_report(self) -> Dict[str, Any]:
        return {
            "v4_pct_configured": self.v4_pct,
            "v3_path": self.v3_path,
            "v4_path": self.v4_path,
            "backend": self.backend,
            **self.stats.summary(),
        }


# ── Demo 模式 ──────────────────────────────────────────────────────
def demo_run(n_steps: int, v4_pct: int, seed: int = 0) -> Dict[str, Any]:
    """用随机 obs 演示 canary 路由

    用 SHA1 头部比对 (同一 obs → 同 route) 来证明路由一致性
    """
    g = np.random.default_rng(seed)
    router = CanaryRouter(v4_pct=v4_pct)

    # 路由一致性测试
    consistency_pass = 0
    consistency_total = 0
    for _ in range(50):
        obs = g.standard_normal(12).astype(np.float32)
        r1 = canary_decision(obs.tobytes(), v4_pct)
        r2 = canary_decision(obs.tobytes(), v4_pct)
        consistency_total += 1
        if r1 == r2:
            consistency_pass += 1

    # 实际推理
    for i in range(n_steps):
        obs = g.standard_normal(12).astype(np.float32)
        router.infer(obs)

    report = router.stats_report()
    report["consistency_test"] = {
        "tested": consistency_total,
        "consistent": consistency_pass,
        "ratio": round(consistency_pass / max(consistency_total, 1), 3),
    }
    return report


# ── CLI ────────────────────────────────────────────────────────────
def main() -> int:
    p = argparse.ArgumentParser(description="SoloForge MARL v3/v4 canary router (D14-G6/G7)")
    p.add_argument("--v3", help="v3 checkpoint 路径 (默认 env MARL_V3_PATH 或 policy.pt)")
    p.add_argument("--v4", help="v4_distilled 路径 (默认 env MARL_V4_PATH 或 policy_v4_distilled.pt)")
    p.add_argument("--v4-pct", type=int, help="v4 流量比例 0-100 (默认 env MARL_CANARY_V4_PCT=0)")
    p.add_argument("--backend", default="torch", choices=["torch", "onnx"])
    p.add_argument("--demo", type=int, default=0, help="demo 模式: 跑 N 步随机 obs")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--output", help="报告 JSON 输出路径")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    # 用 demo 模式 (最简验证入口)
    if args.demo:
        v4_pct = args.v4_pct if args.v4_pct is not None else int(
            os.environ.get("MARL_CANARY_V4_PCT", "0")
        )
        report = demo_run(args.demo, v4_pct, seed=args.seed)
        print("\n" + "=" * 60)
        print(f"MARL v3/v4 Canary Router Demo (v4_pct={v4_pct}%)")
        print("=" * 60)
        s = report
        print(f"  total_requests:     {s['total_requests']}")
        print(f"  v3_count / v4_count: {s['v3_count']} / {s['v4_count']}")
        print(f"  actual_v4_pct:      {s['actual_v4_pct']:.3f}% (configured {s['v4_pct_configured']}%)")
        print(f"  consistency_test:   {s['consistency_test']['consistent']}/{s['consistency_test']['tested']} "
              f"({s['consistency_test']['ratio']:.3f})")
        print(f"  v3 latency mean/p99: {s['v3_latency']['mean_ms']:.3f} / {s['v3_latency']['p99_ms']:.3f} ms "
              f"(n={s['v3_latency']['n']})")
        print(f"  v4 latency mean/p99: {s['v4_latency']['mean_ms']:.3f} / {s['v4_latency']['p99_ms']:.3f} ms "
              f"(n={s['v4_latency']['n']})")
        print(f"  v3 action_dist: {s['v3_action_dist']}")
        print(f"  v4 action_dist: {s['v4_action_dist']}")

        # G6 验收: 配置 = 实际
        if abs(s["actual_v4_pct"] - s["v4_pct_configured"]) < 5:  # 5% 误差容许
            print(f"\n✅ G6 验收 PASS: canary 路由精度 < 5% 误差")
        else:
            print(f"\n⚠️ G6 验收: 实际 {s['actual_v4_pct']}% 与配置 {s['v4_pct_configured']}% 偏差 > 5%")
        if s["consistency_test"]["ratio"] == 1.0:
            print(f"✅ 路由一致性: 同 obs 永远路由到同模型")

        if args.json or args.output:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        if args.output:
            Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"\n[OK] report saved → {args.output}")
    else:
        # 单次推理
        router = CanaryRouter(v3_path=args.v3, v4_path=args.v4, v4_pct=args.v4_pct, backend=args.backend)
        rng = np.random.default_rng(0)
        for _ in range(5):
            obs = rng.standard_normal(12).astype(np.float32)
            action, route = router.infer(obs)
            print(f"  obs[:3]={obs[:3]}  →  action={action}  route={route}")
        print(json.dumps(router.stats_report(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
