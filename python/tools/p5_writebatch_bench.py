# -*- coding: utf-8 -*-
"""
P5 BadgerDB WriteBatch 压测验收
Path: python/tools/p5_writebatch_bench.py
Date: 2026-06-30
对应 plan: 数据库升级方案.md §24 P5

对比三种写法的 QPS / 延迟:
  A) 单条 put()      — 不走 batch, 1 fsync/次
  B) 手动 batch_put  — 攒 N 条后一次 batch, 1 fsync/批
  C) 自动 BatchedWriter — write-behind 队列, 1000 条或 50ms 触发

零破坏: 新文件, 不动任何业务代码。

用法:
  # 先启动 badger-gateway.exe (port 7001)
  python -m python.tools.p5_writebatch_bench --scenario all
  python -m python.tools.p5_writebatch_bench --scenario single
  python -m python.tools.p5_writebatch_bench --scenario batch
  python -m python.tools.p5_writebatch_bench --scenario writer
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

# 允许独立运行
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from soloforge_ai_society.services.badger_grpc_client import (  # noqa: E402
    BatchedWriter,
    BatchedWriterConfig,
    BadgerGatewayClient,
    BadgerGatewayConfig,
)


def _percentile(values, p):
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * p
    f = int(k)
    c = min(f + 1, len(s) - 1)
    if f == c:
        return s[f]
    return s[f] + (s[c] - s[f]) * (k - f)


def bench_single_put(client, total, value_size):
    """A) 单条 put() — 每次一次 fsync"""
    value = b"x" * value_size
    latencies = []
    t0 = time.perf_counter()
    for i in range(total):
        ts = time.perf_counter()
        client.put(f"p5:single:{i}", value)
        latencies.append((time.perf_counter() - ts) * 1000)
    elapsed = time.perf_counter() - t0
    return {
        "scenario": "A_single_put",
        "total": total,
        "elapsed_sec": round(elapsed, 3),
        "qps": round(total / elapsed, 1),
        "latency_ms": {
            "p50": round(_percentile(latencies, 0.5), 3),
            "p95": round(_percentile(latencies, 0.95), 3),
            "p99": round(_percentile(latencies, 0.99), 3),
            "max": round(max(latencies), 3),
        },
    }


def bench_manual_batch(client, total, batch_size, value_size):
    """B) 手动 batch_put — 每 batch_size 条一次 batch_put"""
    value = b"x" * value_size
    latencies = []  # batch 提交延迟
    t0 = time.perf_counter()
    for i in range(0, total, batch_size):
        batch = [(f"p5:batch:{i + j}", value, None) for j in range(min(batch_size, total - i))]
        ts = time.perf_counter()
        client.batch_put(batch)
        latencies.append((time.perf_counter() - ts) * 1000)
    elapsed = time.perf_counter() - t0
    n_batches = len(latencies)
    return {
        "scenario": f"B_manual_batch_{batch_size}",
        "total": total,
        "n_batches": n_batches,
        "batch_size": batch_size,
        "elapsed_sec": round(elapsed, 3),
        "qps": round(total / elapsed, 1),
        "batch_qps": round(n_batches / elapsed, 1),
        "latency_ms": {
            "p50": round(_percentile(latencies, 0.5), 3),
            "p95": round(_percentile(latencies, 0.95), 3),
            "p99": round(_percentile(latencies, 0.99), 3),
            "max": round(max(latencies), 3),
        },
    }


def bench_batched_writer(client, total, value_size, size_threshold=1000, interval_ms=50):
    """C) 自动 BatchedWriter — 后台线程 1000 条/50ms 触发"""
    value = b"x" * value_size
    writer = BatchedWriter(
        client,
        BatchedWriterConfig(
            size_threshold=size_threshold,
            flush_interval_ms=interval_ms,
        ),
    )
    writer.start()
    enqueue_latencies = []
    t0 = time.perf_counter()
    for i in range(total):
        ts = time.perf_counter()
        writer.put(f"p5:writer:{i}", value)
        enqueue_latencies.append((time.perf_counter() - ts) * 1000)
    enqueue_elapsed = time.perf_counter() - t0
    writer.stop(drain=True)
    drain_elapsed = time.perf_counter() - t0
    stats = writer.stats()
    return {
        "scenario": f"C_batched_writer_{size_threshold}_{int(interval_ms)}ms",
        "total": total,
        "enqueue_elapsed_sec": round(enqueue_elapsed, 3),
        "enqueue_qps": round(total / enqueue_elapsed, 1),
        "total_elapsed_sec": round(drain_elapsed, 3),
        "total_qps": round(total / drain_elapsed, 1),
        "enqueue_latency_us": {
            "p50": round(_percentile(enqueue_latencies, 0.5) * 1000, 1),
            "p95": round(_percentile(enqueue_latencies, 0.95) * 1000, 1),
            "p99": round(_percentile(enqueue_latencies, 0.99) * 1000, 1),
        },
        "writer_stats": stats,
    }


def main():
    ap = argparse.ArgumentParser(description="P5 BadgerDB WriteBatch 压测")
    ap.add_argument("--scenario", choices=["single", "batch", "writer", "all"], default="all")
    ap.add_argument("--total", type=int, default=10000, help="总写入条数")
    ap.add_argument("--batch-size", type=int, default=200, help="manual_batch 的批大小")
    ap.add_argument("--value-size", type=int, default=256, help="value 字节数")
    ap.add_argument("--writer-threshold", type=int, default=1000)
    ap.add_argument("--writer-interval-ms", type=float, default=50.0)
    ap.add_argument("--base-url", default="http://127.0.0.1:7001")
    ap.add_argument(
        "--out",
        default=str(Path(__file__).parent.parent / "docs" / "p5_writebatch_bench.json"),
    )
    args = ap.parse_args()

    cfg = BadgerGatewayConfig(base_url=args.base_url, timeout_sec=10.0)
    client = BadgerGatewayClient(cfg)

    # 探活
    if not client.is_alive():
        print(f"[FATAL] badger-gateway 不可达: {args.base_url}", file=sys.stderr)
        sys.exit(1)
    health = client.health()
    print(f"[INFO] gateway ok: engine={health.get('engine')} version={health.get('version')}")

    results = []
    scenarios = (
        ["single", "batch", "writer"] if args.scenario == "all" else [args.scenario]
    )
    for s in scenarios:
        if s == "single":
            r = bench_single_put(client, args.total, args.value_size)
        elif s == "batch":
            r = bench_manual_batch(client, args.total, args.batch_size, args.value_size)
        elif s == "writer":
            r = bench_batched_writer(
                client,
                args.total,
                args.value_size,
                args.writer_threshold,
                args.writer_interval_ms,
            )
        results.append(r)
        print(json.dumps(r, ensure_ascii=False, indent=2))

    # 总结
    print("\n=== P5 WriteBatch 压测总结 ===")
    by_qps = sorted(results, key=lambda x: x.get("qps") or x.get("total_qps") or 0, reverse=True)
    baseline = by_qps[-1].get("qps", 0) or 1
    for r in by_qps:
        q = r.get("qps") or r.get("total_qps") or 0
        speedup = q / baseline
        print(
            f"  {r['scenario']:<40} QPS={q:>9.1f}  vs baseline {speedup:>5.2f}x"
        )

    out = {
        "timestamp": time.time(),
        "config": vars(args),
        "results": results,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n[INFO] 结果已写入: {out_path}")


if __name__ == "__main__":
    main()
