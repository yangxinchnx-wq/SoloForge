# -*- coding: utf-8 -*-
"""
P0 验证: server_prod.py 启动时 8766 HTTP server 也启动
Path: python/tools/p0_8766_live_test.py
Date: 2026-07-01

之前 audit B2 修复加了 HTTP server, 但只 __main__ 自测启动, 生产无人调。
本测试: 启 server_prod 5 秒, 看 netstat 上 8766 是否有 LISTENING。
"""
from __future__ import annotations

import socket
import subprocess
import sys
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent


def is_port_listening(port: int, host: str = "127.0.0.1", timeout: float = 1.0) -> bool:
    """不靠 netstat, 直接尝试 connect"""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (ConnectionRefusedError, socket.timeout, OSError):
        return False


def main() -> int:
    print("=== P0 验证: server_prod 启动时 8766 HTTP server 也起 ===\n")

    # 启动 server_prod
    python = PROJECT_DIR / "bin" / "python-3.13" / "python.exe"
    server = PROJECT_DIR / "python" / "marl_service" / "server_prod.py"
    cmd = [str(python), str(server)]

    print(f"[1] 启动 server_prod: {cmd[0]} ... server_prod.py")

    # 用 CREATE_NEW_PROCESS_GROUP 避免子进程抢控制台
    proc = subprocess.Popen(
        cmd,
        cwd=str(PROJECT_DIR / "python"),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0,
    )
    print(f"    pid={proc.pid}")

    # 异步读 stdout
    import threading as _t
    captured = [""]
    def _reader():
        try:
            for line in iter(proc.stdout.readline, b""):
                captured[0] += line.decode("utf-8", errors="ignore") + "\n"
                if len(captured[0]) > 8000:
                    break
        except Exception:
            pass
    rd = _t.Thread(target=_reader, daemon=True)
    rd.start()

    # 等待启动, 间隔检查 8766
    print("\n[2] 等待启动, 间隔 1s 检查 8766 端口...")
    started_8766 = False
    started_8765 = False
    start_time = time.time()
    deadline = start_time + 30  # 给 30s 启动时间 (MARL 加载可能慢)
    last_log_lines = []
    while time.time() < deadline:
        if not started_8766 and is_port_listening(8766):
            started_8766 = True
            elapsed = time.time() - start_time
            print(f"    ✓ 8766 LISTENING (t={elapsed:.1f}s)")
        if not started_8765 and is_port_listening(8765):
            started_8765 = True
            elapsed = time.time() - start_time
            print(f"    ✓ 8765 LISTENING (t={elapsed:.1f}s)")
        if started_8765 and started_8766:
            time.sleep(2)  # 多等 2s 稳定
            break
        time.sleep(1.0)

    # 收点日志
    try:
        proc.stdout.flush() if proc.stdout else None
    except Exception:
        pass

    # 关掉
    print(f"\n[3] 关闭 server_prod (pid={proc.pid})")
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

    # 打 captured 出来看实际启动日志
    print(f"\n[4] server_prod 启动日志 (最后 60 行):")
    log_lines = captured[0].strip().splitlines()
    for ln in log_lines[-60:]:
        print(f"    {ln}")

    # 验证
    print(f"\n=== 验证结果 ===")
    print(f"  8765 (MARL TCP):    {'✓ LISTENING' if started_8765 else '✗ NOT LISTENING'}")
    print(f"  8766 (Reputation HTTP): {'✓ LISTENING' if started_8766 else '✗ NOT LISTENING'}")

    if not started_8765:
        print(f"\n  ⚠️  8765 都没起, server_prod 启动可能失败")
        print(f"  ⚠️  这不是 P0 测试本身的问题, 是 server_prod 自身问题")
        return 1

    if not started_8766:
        print(f"\n  ✗ FAIL: 8766 没起, P0 修复未生效")
        print(f"  → 检查 server_prod.py 启动代码是否被引入")
        return 1

    print(f"\n  ✅ PASS: 8766 HTTP server 跟 8765 MARL TCP 并行启动")
    return 0


if __name__ == "__main__":
    sys.exit(main())
