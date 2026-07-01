# -*- coding: utf-8 -*-
"""
SoloForge 稳定性压测 (D16 阶段 7)
Path: python/marl_service/stability_test.py
Date: 2026-06-30

跑 N 分钟连续推理, 监控:
  - 内存峰值 / 增长率 (应 < 50MB / N 分钟)
  - 句柄数 / fd (应稳定)
  - 推理延迟 P99 (应 < 10ms 持续)
  - 异常率 (应 = 0)

零破坏: 只读, 不修改任何业务代码
输出: 稳定性报告 JSON + 控制台摘要

用法:
  cd python
  python marl_service/stability_test.py --mode canary_100 --duration-sec 300
  python marl_service/stability_test.py --mode v4_onnx --duration-sec 60 --sample-every 5
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
import traceback
from collections import deque
from pathlib import Path
from typing import Any, Dict, List

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PYTHON_DIR))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("stability_test")


# ── RingBuffer (P2 GC 修复) ────────────────────────────────────────
class RingBuffer:
    """固定大小环形缓冲, 满了覆盖写入, 不增长内存

    替代 stability_test 原本的 `all_latencies: List[float]`,
    后者 30min 沉淀 ~19.7MB / 60s (8.9M 元素 × 8B = 71MB),
    RingBuffer 容量 100K = 0.8MB (88x 内存节省)。

    用法:
        rb = RingBuffer(100_000)
        rb.append(1.5)
        ...
        sorted_data = rb.snapshot()  # 拷贝一份再排序
    """

    __slots__ = ("_data", "_size", "_idx", "_filled")

    def __init__(self, size: int) -> None:
        if size <= 0:
            raise ValueError("RingBuffer size must be > 0")
        self._data: List[float] = [0.0] * size
        self._size = size
        self._idx = 0
        self._filled = 0

    def append(self, value: float) -> None:
        self._data[self._idx] = value
        self._idx = (self._idx + 1) % self._size
        if self._filled < self._size:
            self._filled += 1

    def __len__(self) -> int:
        return self._filled

    def snapshot(self) -> List[float]:
        """返回当前数据快照 (按写入顺序, 旧 → 新)"""
        if self._filled < self._size:
            return self._data[:self._filled]
        # 满了, 从 _idx 开始是"最老的"
        return self._data[self._idx:] + self._data[:self._idx]

    def extend_recent(self, n: int) -> List[float]:
        """返回最近 n 个 (按时间顺序)"""
        snap = self.snapshot()
        return snap[-n:] if n <= len(snap) else snap


# ── 内存监控 (psutil optional) ─────────────────────────────────────
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False


def get_mem_mb() -> float:
    if HAS_PSUTIL:
        return psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024
    return 0.0


def get_handle_count() -> int:
    if HAS_PSUTIL:
        return psutil.Process(os.getpid()).num_handles()
    return 0


# ── 推理器加载 ────────────────────────────────────────────────────
def build_inferencer(mode: str):
    if mode == "v3":
        import torch
        import torch.nn as nn
        from marl_service.load_test import StudentActor, _load_state_dict
        m = StudentActor()
        m.load_state_dict(_load_state_dict("marl_service/models/policy.pt"), strict=False)
        m.eval()
        def infer(obs):
            with torch.no_grad():
                return int(m(torch.FloatTensor(obs).unsqueeze(0)).argmax(-1).item())
        return "torch", infer
    if mode == "v4_torch":
        import torch
        from marl_service.load_test import StudentActor, _load_state_dict
        m = StudentActor()
        m.load_state_dict(_load_state_dict("marl_service/models/policy_v4_distilled.pt"), strict=False)
        m.eval()
        def infer(obs):
            with torch.no_grad():
                return int(m(torch.FloatTensor(obs).unsqueeze(0)).argmax(-1).item())
        return "torch", infer
    if mode == "v4_onnx":
        import onnxruntime as ort
        sess = ort.InferenceSession(
            "marl_service/models/policy_v4_distilled.onnx",
            providers=["CPUExecutionProvider"],
        )
        def infer(obs):
            out = sess.run(None, {"obs": obs.reshape(1, -1).astype(np.float32)})[0]
            return int(out.argmax(-1).item())
        return "onnx", infer
    if mode == "canary_100":
        from marl_service.canary import CanaryRouter
        router = CanaryRouter(v4_pct=100, backend="torch")
        def infer(obs):
            action, _ = router.infer(obs)
            return action
        return "canary", infer
    raise ValueError(f"Unknown mode: {mode}")


# ── 稳定性主循环 ──────────────────────────────────────────────────

# P2 GC 修复: RingBuffer 容量 — 100K 个延迟样本 ≈ 0.8MB (原 List 71MB)
RING_BUFFER_SIZE = 100_000
# P2 GC 修复: 主动 gc.collect() 频率 (每 N 次推理一次)
GC_COLLECT_EVERY = 50_000


def run_stability(
    mode: str,
    duration_sec: float,
    sample_every_sec: float = 10.0,
    obs_dim: int = 12,
    seed: int = 42,
) -> Dict[str, Any]:
    """跑 duration_sec 秒, 每 sample_every_sec 秒采样一次

    Returns:
        报告 dict, 含 time_series (内存/句柄/延迟 随时间变化)

    P2 GC 修复 (2026-06-30):
      - all_latencies: List[float]  →  latency_ring: RingBuffer
        节省 88x 内存 (8.9M 元素 × 8B = 71MB → 0.8MB)
      - 主动 gc.collect() 每 50K 次推理一次
      - SLA 阈值保持 50MB 但实际现在会 < 5MB
    """
    rng = np.random.default_rng(seed)
    kind, infer = build_inferencer(mode)
    logger.info(f"[setup] mode={mode} kind={kind} duration={duration_sec}s "
                f"(P2 GC fix: RingBuffer={RING_BUFFER_SIZE}, gc.collect/{GC_COLLECT_EVERY})")

    # Warm-up
    for _ in range(100):
        obs = rng.standard_normal(obs_dim).astype(np.float32)
        infer(obs)
    gc.collect()

    start = time.perf_counter()
    deadline = start + duration_sec
    sample_interval_samples = max(1, int(sample_every_sec * 1000))  # 假设 ~1k fps
    sample_interval_sec = sample_every_sec

    time_series: List[Dict[str, Any]] = []
    # P2 GC 修复: 改用 RingBuffer
    latency_ring = RingBuffer(RING_BUFFER_SIZE)
    error_count = 0
    total_inferences = 0
    next_sample = start + sample_interval_sec

    initial_mem = get_mem_mb()
    initial_handles = get_handle_count()
    last_sample_mem = initial_mem
    last_sample_inferences = 0

    while time.perf_counter() < deadline:
        obs = rng.standard_normal(obs_dim).astype(np.float32)
        t0 = time.perf_counter()
        try:
            action = infer(obs)
            ok = True
        except Exception as e:
            error_count += 1
            ok = False
            if error_count <= 3:
                logger.error(f"[infer error #{error_count}] {e}\n{traceback.format_exc()[:200]}")
        latency_ms = (time.perf_counter() - t0) * 1000
        # P2 GC 修复: append 到 RingBuffer
        latency_ring.append(latency_ms)
        total_inferences += 1

        # P2 GC 修复: 主动 gc.collect() 周期性触发
        if total_inferences % GC_COLLECT_EVERY == 0:
            gc.collect()

        if time.perf_counter() >= next_sample:
            now = time.perf_counter()
            mem = get_mem_mb()
            handles = get_handle_count()
            sample_window = total_inferences - last_sample_inferences
            window_qps = sample_window / (now - (next_sample - sample_interval_sec))
            # P2 GC 修复: 从 RingBuffer 取最近 window
            window_latencies = latency_ring.extend_recent(sample_window)
            window_p99 = (sorted(window_latencies)[int(len(window_latencies) * 0.99)]
                          if window_latencies else 0.0)
            time_series.append({
                "elapsed_sec": round(now - start, 2),
                "mem_mb": round(mem, 2),
                "handles": handles,
                "qps": round(window_qps, 1),
                "p99_ms": round(window_p99, 4),
                "errors": error_count,
            })
            logger.info(
                f"[t={now - start:>6.1f}s] mem={mem:>7.1f}MB handles={handles:>4} "
                f"qps={window_qps:>5.0f} p99={window_p99:.3f}ms errors={error_count}"
            )
            last_sample_mem = mem
            last_sample_inferences = total_inferences
            next_sample = now + sample_interval_sec

    total_elapsed = time.perf_counter() - start
    final_mem = get_mem_mb()
    final_handles = get_handle_count()
    mem_growth = final_mem - initial_mem
    handles_growth = final_handles - initial_handles
    error_rate = error_count / max(total_inferences, 1)
    qps = total_inferences / total_elapsed
    # P2 GC 修复: 全局延迟统计从 RingBuffer snapshot 算
    all_latencies = latency_ring.snapshot()
    p99 = (sorted(all_latencies)[int(len(all_latencies) * 0.99)]
           if all_latencies else 0.0)
    p50 = (sorted(all_latencies)[len(all_latencies) // 2]
           if all_latencies else 0.0)
    p999 = (sorted(all_latencies)[int(len(all_latencies) * 0.999)]
            if all_latencies else 0.0)

    return {
        "mode": mode,
        "kind": kind,
        "duration_sec": round(duration_sec, 2),
        "total_inferences": total_inferences,
        "total_elapsed_sec": round(total_elapsed, 2),
        "qps": round(qps, 1),
        "latency_ms": {
            "p50": round(p50, 4),
            "p99": round(p99, 4),
            "p99.9": round(p999, 4),
            "max": round(max(all_latencies) if all_latencies else 0.0, 4),
        },
        "errors": error_count,
        "error_rate": round(error_rate, 6),
        "mem_initial_mb": round(initial_mem, 2),
        "mem_final_mb": round(final_mem, 2),
        "mem_growth_mb": round(mem_growth, 2),
        "handles_initial": initial_handles,
        "handles_final": final_handles,
        "handles_growth": handles_growth,
        "sla_p99_under_10ms": p99 < 10.0,
        "sla_mem_growth_under_50mb": mem_growth < 50.0,
        "sla_no_errors": error_count == 0,
        "p2_gc_fix": {
            "ring_buffer_size": RING_BUFFER_SIZE,
            "ring_buffer_used": len(latency_ring),
            "gc_collect_every": GC_COLLECT_EVERY,
            "gc_collect_count": total_inferences // GC_COLLECT_EVERY,
        },
        "time_series": time_series,
    }


# ── CLI ────────────────────────────────────────────────────────────
def main() -> int:
    p = argparse.ArgumentParser(description="SoloForge 稳定性压测 (D16)")
    p.add_argument("--mode", required=True, choices=["v3", "v4_torch", "v4_onnx", "canary_100"])
    p.add_argument("--duration-sec", type=float, default=300.0, help="持续秒数 (默认 300s = 5min)")
    p.add_argument("--sample-every", type=float, default=10.0, help="采样间隔秒数")
    p.add_argument("--obs-dim", type=int, default=12)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--output", help="报告 JSON 输出路径")
    args = p.parse_args()

    print("=" * 60)
    print(f"SoloForge 稳定性压测 (D16): mode={args.mode} duration={args.duration_sec}s")
    print("=" * 60)
    if not HAS_PSUTIL:
        print("⚠️ psutil 未安装, 无法监控内存和句柄 (pip install psutil)")

    report = run_stability(
        mode=args.mode,
        duration_sec=args.duration_sec,
        sample_every_sec=args.sample_every,
        obs_dim=args.obs_dim,
        seed=args.seed,
    )
    print("\n" + "=" * 60)
    print(f"稳定性压测完工: {args.mode}")
    print("=" * 60)
    L = report["latency_ms"]
    print(f"  total_inferences:  {report['total_inferences']:,}")
    print(f"  total_elapsed:     {report['total_elapsed_sec']:.1f}s")
    print(f"  QPS (avg):         {report['qps']:.0f}")
    print(f"  latency p50/p99:   {L['p50']:.3f} / {L['p99']:.3f} ms")
    print(f"  latency p99.9/max: {L['p99.9']:.3f} / {L['max']:.3f} ms")
    print(f"  errors / error_rate: {report['errors']} / {report['error_rate']:.6f}")
    print(f"  mem initial/final:  {report['mem_initial_mb']:.1f} / {report['mem_final_mb']:.1f} MB")
    print(f"  mem growth:         {report['mem_growth_mb']:+.1f} MB")
    print(f"  handles initial/final: {report['handles_initial']} / {report['handles_final']}")
    print(f"  handles growth:        {report['handles_growth']:+d}")
    print()
    s_p99 = "✅ PASS" if report["sla_p99_under_10ms"] else "❌ FAIL"
    s_mem = "✅ PASS" if report["sla_mem_growth_under_50mb"] else "❌ FAIL"
    s_err = "✅ PASS" if report["sla_no_errors"] else "❌ FAIL"
    print(f"  SLA p99<10ms:      {s_p99}")
    print(f"  SLA mem growth<50MB: {s_mem}")
    print(f"  SLA no errors:     {s_err}")

    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n[OK] report saved → {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
