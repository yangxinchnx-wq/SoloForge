# -*- coding: utf-8 -*-
"""
SoloForge 全链路压测工具 (D15-D16 阶段 7)
Path: python/marl_service/load_test.py
Date: 2026-06-30

覆盖 4 类压测:
  1. v3 推理 50K 帧    (--mode v3, --frames 50000)
  2. v4 ONNX 推理 50K  (--mode v4_onnx)
  3. v4 torch 推理 50K  (--mode v4_torch)
  4. canary 100% 推理   (--mode canary_100)

零破坏:
  - 只读, 不改任何模型 / 配置
  - 单文件, 不引入新依赖 (只用 numpy / torch / onnxruntime)

输出:
  - 控制台: 实时进度 + P50/P95/P99/最大/QPS
  - JSON: 完整报告 → d15_load_test_<mode>.json

用法:
  cd python
  python marl_service/load_test.py --mode v3 --frames 50000
  python marl_service/load_test.py --mode v4_onnx --frames 50000
  python marl_service/load_test.py --mode v4_torch --frames 50000
  python marl_service/load_test.py --mode canary_100 --frames 50000
"""

from __future__ import annotations

import argparse
import gc
import json
import logging
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

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
logger = logging.getLogger("load_test")


# ── 模型定义 ────────────────────────────────────────────────────────
class StudentActor(nn.Module):
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


def _load_state_dict(path: str) -> Dict[str, torch.Tensor]:
    obj = torch.load(path, map_location="cpu", weights_only=False)
    if isinstance(obj, dict) and "actor_state_dict" in obj:
        return obj["actor_state_dict"]
    if isinstance(obj, dict) and all(isinstance(v, torch.Tensor) for v in obj.values()):
        return obj
    raise ValueError(f"Unrecognized checkpoint: {path}")


# ── 推理器抽象 ────────────────────────────────────────────────────
class Inferencer:
    """统一推理接口, 支持 torch / onnx / canary"""
    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.kind: str = ""  # torch | onnx | canary
        self.model: Any = None
        self.action_dist: Dict[int, int] = {}

    def setup(self) -> None:
        if self.mode == "v3":
            self.kind = "torch"
            m = StudentActor()
            m.load_state_dict(_load_state_dict("marl_service/models/policy.pt"), strict=False)
            m.eval()
            self.model = m
        elif self.mode == "v4_torch":
            self.kind = "torch"
            m = StudentActor()
            m.load_state_dict(_load_state_dict("marl_service/models/policy_v4_distilled.pt"), strict=False)
            m.eval()
            self.model = m
        elif self.mode == "v4_onnx":
            self.kind = "onnx"
            import onnxruntime as ort
            self.model = ort.InferenceSession(
                "marl_service/models/policy_v4_distilled.onnx",
                providers=["CPUExecutionProvider"],
            )
        elif self.mode == "canary_100":
            self.kind = "canary"
            # canary 100% v4 走 torch backend (与生产路径一致)
            from marl_service.canary import CanaryRouter
            self.model = CanaryRouter(v4_pct=100, backend="torch")
        else:
            raise ValueError(f"Unknown mode: {self.mode}")

    def infer(self, obs: np.ndarray) -> int:
        if self.kind == "torch":
            with torch.no_grad():
                logits = self.model(torch.FloatTensor(obs).unsqueeze(0))
                return int(logits.argmax(-1).item())
        if self.kind == "onnx":
            out = self.model.run(None, {"obs": obs.reshape(1, -1).astype(np.float32)})[0]
            return int(out.argmax(-1).item())
        if self.kind == "canary":
            action, _route = self.model.infer(obs)
            return action
        raise RuntimeError(self.kind)

    def teardown(self) -> None:
        del self.model
        gc.collect()


# ── 内存监控 ────────────────────────────────────────────────────────
try:
    import psutil

    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False


def get_mem_mb() -> float:
    if HAS_PSUTIL:
        return psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024
    return 0.0


# ── 压测主循环 ────────────────────────────────────────────────────
def percentile(arr: List[float], p: float) -> float:
    if not arr:
        return 0.0
    s = sorted(arr)
    k = max(0, min(len(s) - 1, int(len(s) * p / 100)))
    return s[k]


def run_load_test(
    mode: str,
    n_frames: int,
    obs_dim: int = 12,
    seed: int = 42,
    log_every: int = 10000,
) -> Dict[str, Any]:
    """跑 n_frames 帧推理, 统计延迟分布

    Returns:
        报告 dict (含 per-frame latency + 内存采样 + 动作分布)
    """
    rng = np.random.default_rng(seed)
    obs_buffer = rng.standard_normal((n_frames, obs_dim)).astype(np.float32)

    inf = Inferencer(mode)
    t_setup_start = time.perf_counter()
    inf.setup()
    setup_elapsed_ms = (time.perf_counter() - t_setup_start) * 1000

    # Warm-up 50 帧 (排除 init 开销)
    warm_latencies: List[float] = []
    for i in range(50):
        t0 = time.perf_counter()
        inf.infer(obs_buffer[i])
        warm_latencies.append((time.perf_counter() - t0) * 1000)
    warmup_p99 = percentile(warm_latencies, 99)
    logger.info(f"[warm-up] 50 frames, p99={warmup_p99:.3f}ms")

    # 主压测
    latencies: List[float] = []
    actions: List[int] = []
    mem_samples: List[float] = []
    t_start = time.perf_counter()
    for i in range(n_frames):
        t0 = time.perf_counter()
        action = inf.infer(obs_buffer[i])
        latencies.append((time.perf_counter() - t0) * 1000)
        actions.append(action)
        if (i + 1) % log_every == 0:
            mem = get_mem_mb()
            mem_samples.append(mem)
            elapsed = time.perf_counter() - t_start
            current_p99 = percentile(latencies, 99)
            current_qps = (i + 1) / elapsed
            logger.info(
                f"[{mode}] {i+1:>6}/{n_frames}  "
                f"p99={current_p99:.3f}ms  qps={current_qps:.0f}  "
                f"mem={mem:.0f}MB"
            )
    t_total = time.perf_counter() - t_start
    inf.teardown()

    # 统计
    n = len(latencies)
    qps = n / t_total
    action_counter: Dict[int, int] = {}
    for a in actions:
        action_counter[int(a)] = action_counter.get(int(a), 0) + 1
    action_dist = {str(k): round(v / n, 4) for k, v in sorted(action_counter.items())}

    return {
        "mode": mode,
        "n_frames": n,
        "obs_dim": obs_dim,
        "setup_elapsed_ms": round(setup_elapsed_ms, 3),
        "warmup_p99_ms": round(warmup_p99, 4),
        "total_elapsed_sec": round(t_total, 3),
        "qps": round(qps, 2),
        "latency_ms": {
            "mean": round(statistics.mean(latencies), 4),
            "stdev": round(statistics.stdev(latencies), 4) if len(latencies) > 1 else 0,
            "p50": round(percentile(latencies, 50), 4),
            "p95": round(percentile(latencies, 95), 4),
            "p99": round(percentile(latencies, 99), 4),
            "p99_9": round(percentile(latencies, 99.9), 4),
            "max": round(max(latencies), 4),
            "min": round(min(latencies), 4),
        },
        "action_dist": action_dist,
        "mem_samples_mb": [round(m, 1) for m in mem_samples],
        "mem_peak_mb": round(max(mem_samples) if mem_samples else 0.0, 1),
        "mem_growth_mb": round((mem_samples[-1] - mem_samples[0]) if len(mem_samples) >= 2 else 0.0, 1),
        "sla_p99_under_10ms": percentile(latencies, 99) < 10.0,
    }


# ── CLI ────────────────────────────────────────────────────────────
def main() -> int:
    p = argparse.ArgumentParser(description="SoloForge 全链路压测 (D15-D16)")
    p.add_argument("--mode", required=True, choices=["v3", "v4_torch", "v4_onnx", "canary_100"],
                   help="压测目标: v3 (旧), v4_torch (新 torch), v4_onnx (新 ONNX), canary_100 (100% v4)")
    p.add_argument("--frames", type=int, default=50_000, help="压测帧数 (default 50K)")
    p.add_argument("--obs-dim", type=int, default=12)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--output", help="报告 JSON 路径 (默认 d15_load_test_<mode>.json)")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    print("=" * 60)
    print(f"SoloForge 全链路压测 (D15-D16): mode={args.mode} frames={args.frames}")
    print("=" * 60)

    report = run_load_test(
        mode=args.mode, n_frames=args.frames, obs_dim=args.obs_dim, seed=args.seed
    )
    print("\n" + "=" * 60)
    print(f"压测完工: {args.mode}")
    print("=" * 60)
    L = report["latency_ms"]
    print(f"  total_elapsed: {report['total_elapsed_sec']:.2f}s")
    print(f"  QPS:           {report['qps']:.0f}")
    print(f"  latency (ms):  mean={L['mean']:.3f}  p50={L['p50']:.3f}  p95={L['p95']:.3f}  p99={L['p99']:.3f}  p99.9={L['p99_9']:.3f}  max={L['max']:.3f}")
    print(f"  action_dist:   {report['action_dist']}")
    print(f"  mem_peak:      {report['mem_peak_mb']:.1f} MB")
    print(f"  mem_growth:    {report['mem_growth_mb']:.1f} MB")
    if report["sla_p99_under_10ms"]:
        print(f"  ✅ SLA PASS: P99 < 10ms")
    else:
        print(f"  ⚠️ SLA WARN: P99 ≥ 10ms")

    if args.json or args.output:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.output:
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n[OK] report saved → {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
