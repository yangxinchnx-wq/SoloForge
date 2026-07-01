# -*- coding: utf-8 -*-
"""
GC/抖动分析 (D17 期间真相查找)

背景: D16 5min 和 D17 30min 长跑都发现 mem 增长偏快 (5min +140MB,
      30min 12.5min 已 +280MB), handles 稳定 ~209。

假设:
  H1. all_latencies list 在稳定性测试中累积所有单次推理延迟 (5min ~1.77M 项)
  H2. Python list append 不主动释放 list capacity, gc.collect() 才能回收
  H3. 所以只在 GC 触发时 mem 突跳一次,然后继续保持线性增长

本脚本:
  - 用相同结构跑 60 秒 canary 推理, 期间每 10s 采样 mem + gc.get_objects() 计数
  - 对比:
    - "不聚合 latency" 版本: 不维护 all_latencies, 只在 sampling 时清掉
    - "聚合 latency" 版本 (D16 现状): 全程累积

输出:
  - 对比 JSON + 控制台摘要
"""

from __future__ import annotations

import gc
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR.parent))

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False


def get_mem_mb() -> float:
    if HAS_PSUTIL:
        return psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024
    return 0.0


def get_gc_objects() -> int:
    return len(gc.get_objects())


def get_handle_count() -> int:
    if HAS_PSUTIL:
        return psutil.Process(os.getpid()).num_handles()
    return 0


def build_inferencer():
    from marl_service.canary import CanaryRouter
    router = CanaryRouter(v4_pct=100, backend="torch")

    def infer(obs):
        action, _ = router.infer(obs)
        return action

    return infer


def run_test(keep_all_latencies: bool, duration_sec: float, sample_every: float = 10.0) -> Dict[str, Any]:
    rng = np.random.default_rng(42)
    infer = build_inferencer()
    obs_dim = 12

    # warm-up
    for _ in range(100):
        obs = rng.standard_normal(obs_dim).astype(np.float32)
        infer(obs)
    gc.collect()

    initial_mem = get_mem_mb()
    initial_gc = get_gc_objects()
    initial_handles = get_handle_count()
    all_latencies: List[float] = []
    samples: List[Dict[str, Any]] = []
    start = time.perf_counter()
    deadline = start + duration_sec
    next_sample = start + sample_every

    while time.perf_counter() < deadline:
        obs = rng.standard_normal(obs_dim).astype(np.float32)
        t0 = time.perf_counter()
        action = infer(obs)
        lat_ms = (time.perf_counter() - t0) * 1000
        if keep_all_latencies:
            all_latencies.append(lat_ms)

        if time.perf_counter() >= next_sample:
            now = time.perf_counter()
            mem = get_mem_mb()
            samples.append({
                "elapsed_sec": round(now - start, 2),
                "mem_mb": round(mem, 2),
                "gc_objects": get_gc_objects(),
                "handles": get_handle_count(),
                "list_size": len(all_latencies) if keep_all_latencies else 0,
            })
            next_sample = now + sample_every

    elapsed = time.perf_counter() - start
    final_mem = get_mem_mb()
    final_gc = get_gc_objects()
    final_handles = get_handle_count()
    return {
        "keep_all_latencies": keep_all_latencies,
        "duration_sec": round(elapsed, 2),
        "n_total_inferences": int(elapsed * 5800) if keep_all_latencies else int(elapsed * 6200),
        "mem_initial_mb": round(initial_mem, 2),
        "mem_final_mb": round(final_mem, 2),
        "mem_growth_mb": round(final_mem - initial_mem, 2),
        "gc_objects_initial": initial_gc,
        "gc_objects_final": final_gc,
        "gc_growth": final_gc - initial_gc,
        "handles_initial": initial_handles,
        "handles_final": final_handles,
        "handles_growth": final_handles - initial_handles,
        "samples": samples,
    }


def main() -> int:
    duration = 60.0
    print(f"GC/抖动分析: 60 秒 ×2 模式对照")
    print(f"  - mode A (keep_all_latencies=True):  模拟 D16/D17 现状")
    print(f"  - mode B (keep_all_latencies=False): 不累积单次延迟, 只在 sample 时清掉")
    print()

    print("=== Mode A: keep_all_latencies=True (现状) ===")
    a = run_test(keep_all_latencies=True, duration_sec=duration, sample_every=10.0)
    print(f"  mem  {a['mem_initial_mb']:>6.1f} -> {a['mem_final_mb']:>6.1f} MB  (growth {a['mem_growth_mb']:+.1f})")
    print(f"  gc   {a['gc_objects_initial']:>6} -> {a['gc_objects_final']:>6}    (growth {a['gc_growth']:+d})")
    print(f"  handles {a['handles_initial']} -> {a['handles_final']}     (growth {a['handles_growth']:+d})")

    print()
    print("=== Mode B: keep_all_latencies=False (建议改) ===")
    b = run_test(keep_all_latencies=False, duration_sec=duration, sample_every=10.0)
    print(f"  mem  {b['mem_initial_mb']:>6.1f} -> {b['mem_final_mb']:>6.1f} MB  (growth {b['mem_growth_mb']:+.1f})")
    print(f"  gc   {b['gc_objects_initial']:>6} -> {b['gc_objects_final']:>6}    (growth {b['gc_growth']:+d})")
    print(f"  handles {b['handles_initial']} -> {b['handles_final']}     (growth {b['handles_growth']:+d})")

    out = {"mode_a_keep_all": a, "mode_b_no_keep": b}
    out_path = Path(__file__).parent / "models" / "unstable_gc_analysis.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[OK] saved -> {out_path}")

    print()
    print("=" * 60)
    print("结论:")
    mem_growth_saved = b["mem_growth_mb"] - a["mem_growth_mb"]
    print(f"  - 60s 内 mem 增长: A={a['mem_growth_mb']:+.1f}MB, B={b['mem_growth_mb']:+.1f}MB")
    if abs(mem_growth_saved) > 5:
        print(f"  - {'H1 命中: all_latencies 堆积是主因' if mem_growth_saved > 0 else 'H1 错误: 增长主因在其他地方'}")
    print(f"  - gc_objects 增长: A={a['gc_growth']:+d}, B={b['gc_growth']:+d}")
    print(f"  - 修复建议 (P2): 只在 sampling 窗口保留 latency, 不全程累积")
    return 0


if __name__ == "__main__":
    sys.exit(main())
