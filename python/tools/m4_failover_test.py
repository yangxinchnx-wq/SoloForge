# -*- coding: utf-8 -*-
"""
BatchedWriter M4 失败 fallback 验证 (audit 2026-06-30 M4 修复)
Path: python/tools/m4_failover_test.py
Date: 2026-07-01

场景:
  1. mock 一个 BadgerGatewayClient 永远抛 BadgerGatewayError
  2. BatchedWriter.put 10 条, flush
  3. 期望: 全部 10 条落盘到 failover 目录, 不丢
  4. mock gateway 恢复正常, 启动第二个 BatchedWriter
  5. 期望: retry_pending 把 10 条重新发出去, 文件被删
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_DIR / "python"))


def main() -> int:
    print("=== BatchedWriter M4 failover 验证 (audit 2026-06-30) ===\n")

    # 隔离的 failover 目录
    tmp_failover = Path(tempfile.mkdtemp(prefix="m4_failover_"))
    print(f"[SETUP] failover dir: {tmp_failover}")
    import os
    os.environ["SOLOFORGE_BADGER_FAILOVER_DIR"] = str(tmp_failover)

    from soloforge_ai_society.services.badger_grpc_client import (
        BatchedWriter,
        BatchedWriterConfig,
        BadgerGatewayError,
    )

    # ── 阶段 1: gateway 挂, batch 必须落盘 ──
    print("\n[阶段 1] mock gateway 永远失败, BatchedWriter 应落盘而不丢")
    mock_client_fail = MagicMock()
    mock_client_fail.batch_put.side_effect = BadgerGatewayError("simulated gateway down")

    w1 = BatchedWriter(mock_client_fail, BatchedWriterConfig(
        size_threshold=5,
        flush_interval_ms=100,
    ))
    w1.start()

    for i in range(10):
        w1.put(f"key_{i:02d}".encode(), f"value_{i:02d}".encode())
    time.sleep(0.3)  # 等 flush
    w1.stop()

    failover_files = list(tmp_failover.glob("failover_*.jsonl"))
    print(f"  failover 文件: {len(failover_files)}")
    for fp in failover_files:
        lines = fp.read_text(encoding="utf-8").splitlines()
        print(f"    {fp.name}: {len([l for l in lines if l])} 行")

    if len(failover_files) == 0:
        print("  ✗ FAIL: 没有 failover 文件, M4 修复未生效")
        return 1

    s1 = w1.stats()
    print(f"  total_failover_writes: {s1['total_failover_writes']}")
    print(f"  total_errors: {s1['total_errors']}")
    if s1["total_failover_writes"] != 10:
        print(f"  ✗ FAIL: 期望 10 条落盘, 实际 {s1['total_failover_writes']}")
        return 1
    print(f"  ✓ 阶段 1 PASS: 10 条全部落盘 (0 丢失)")

    # ── 阶段 2: gateway 恢复, retry_pending 应自动 replay ──
    print("\n[阶段 2] mock gateway 恢复, 启动新 writer, 应自动 retry")
    mock_client_ok = MagicMock()
    mock_client_ok.batch_put.return_value = 10  # 假装成功

    w2 = BatchedWriter(mock_client_ok, BatchedWriterConfig(
        size_threshold=5,
        flush_interval_ms=100,
    ))
    w2.start()  # start() 里调 retry_pending
    time.sleep(0.3)
    w2.stop()

    s2 = w2.stats()
    print(f"  total_failover_recovered: {s2['total_failover_recovered']}")
    print(f"  batch_put calls: {mock_client_ok.batch_put.call_count}")

    remaining_files = list(tmp_failover.glob("failover_*.jsonl"))
    print(f"  剩余 failover 文件: {len(remaining_files)}")

    if s2["total_failover_recovered"] != 10:
        print(f"  ✗ FAIL: 期望回收 10 条, 实际 {s2['total_failover_recovered']}")
        return 1
    if len(remaining_files) != 0:
        print(f"  ✗ FAIL: 期望 0 剩余, 实际 {len(remaining_files)}")
        return 1
    if mock_client_ok.batch_put.call_count < 1:
        print(f"  ✗ FAIL: batch_put 没被调用")
        return 1

    # 验证调用时的参数
    call_args = mock_client_ok.batch_put.call_args
    recovered_batch = call_args[0][0]
    print(f"  replay batch 大小: {len(recovered_batch)}")
    if len(recovered_batch) != 10:
        print(f"  ✗ FAIL: replay 期望 10 条, 实际 {len(recovered_batch)}")
        return 1
    print(f"  ✓ 阶段 2 PASS: 10 条全部 replay 成功, 文件已清理")

    # ── 阶段 3: gateway 仍挂时, 旧文件不应被删 ──
    print("\n[阶段 3] gateway 仍挂, retry_pending 应保留文件, 不删")
    mock_client_still_fail = MagicMock()
    mock_client_still_fail.batch_put.side_effect = BadgerGatewayError("still down")

    # 先制造一个 failover 文件
    w3 = BatchedWriter(mock_client_still_fail, BatchedWriterConfig(
        size_threshold=5,
        flush_interval_ms=100,
    ))
    for i in range(5):
        w3.put(f"k3_{i}".encode(), f"v3_{i}".encode())
    time.sleep(0.3)
    w3.stop()

    pre_files = list(tmp_failover.glob("failover_*.jsonl"))
    pre_count = len(pre_files)
    print(f"  制造了 {pre_count} 个 failover 文件")

    # 新 writer start, gateway 仍挂
    w4 = BatchedWriter(mock_client_still_fail, BatchedWriterConfig(
        size_threshold=5,
        flush_interval_ms=100,
    ))
    w4.start()
    time.sleep(0.3)
    w4.stop()

    s4 = w4.stats()
    post_files = list(tmp_failover.glob("failover_*.jsonl"))
    print(f"  retry 后剩余: {len(post_files)} (total_failover_recovered: {s4['total_failover_recovered']})")
    if len(post_files) < pre_count:
        print(f"  ✗ FAIL: 文件不应被删 (gateway 仍挂)")
        return 1
    if s4["total_failover_recovered"] != 0:
        print(f"  ✗ FAIL: 期望回收 0 条, 实际 {s4['total_failover_recovered']}")
        return 1
    print(f"  ✓ 阶段 3 PASS: gateway 仍挂时文件保留, 下次再试")

    # 清理
    shutil.rmtree(tmp_failover, ignore_errors=True)

    print("\n=== 总结 ===")
    print(f"  阶段 1 (落盘):  ✓ 10/10 条落盘, 0 丢失")
    print(f"  阶段 2 (replay): ✓ 10/10 条自动 replay, 文件清理")
    print(f"  阶段 3 (挂时保留): ✓ 文件保留等下次")
    print(f"\n  ✅ PASS (audit M4: 已修)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
