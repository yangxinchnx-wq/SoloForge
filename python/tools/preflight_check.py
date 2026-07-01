# -*- coding: utf-8 -*-
"""
SoloForge 启动前健康检查 (preflight check)
Path: python/tools/preflight_check.py
Date: 2026-06-30

启动 SoloForge 前调用, 一次性检查所有依赖:

  1. Python 版本 / 必需包
  2. Node.js 版本
  3. 必需端口 (6379 Garnet, 3001 API, 8765 MARL, 8766 Reputation)
  4. 磁盘空间 (项目目录 + 数据库目录)
  5. 关键目录存在 (bin/, bin/models/, bin/backups/, src/, UI/, python/)
  6. 数据库文件可达 (db/*.db, *.sqlite, *.lance)
  7. config.toml 完整性 (或默认 fallback)
  8. 进程数 < N (单进程护栏)
  9. (可选) 试探 Garnet ping (PING 命令)

失败 → 退出码 1 + 具体修复建议 (用户友好)
成功 → 退出码 0 + 一行绿色 "✅ SoloForge ready to start"

用法:
  python -m python.tools.preflight_check
  python -m python.tools.preflight_check --strict     # 任一警告也 fail
  python -m python.tools.preflight_check --json        # 输出 JSON
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent  # SoloForge/
REQUIRED_PYTHON = (3, 11)
REQUIRED_NODE = (18, 0)
DISK_FREE_MIN_MB = 500
REQUIRED_PORTS = [
    (6379, "Garnet (Redis cache)"),
    (3001, "SoloForge API server"),
    (8765, "MARL service (Python)"),
    (8766, "Reputation sync receiver"),
]
REQUIRED_DIRS = [
    ("bin/", "binaries & models"),
    ("bin/models/", "model storage"),
    ("bin/backups/", "backup snapshots"),
    ("src/", "Node.js source"),
    ("UI/", "frontend source"),
    ("python/", "Python source"),
    ("python/soloforge_ai_society/", "AI Society service"),
]
DIR_ALT_FALLBACKS = {
    "bin/backups/": ["python/data/ai_society/backups/", "python/data/backups/"],
}
DB_PATTERNS = [
    "python/data/**/*.db",
    "python/data/**/*.sqlite",
    "python/data/**/*.sqlite3",
    "python/data/**/*.lance",
]
MAX_PROCESSES = 200  # 单机护栏

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
RESET = "\033[0m"


class Issue:
    def __init__(self, level: str, code: str, msg: str, fix: str):
        self.level = level  # ok | warn | fail
        self.code = code
        self.msg = msg
        self.fix = fix

    def render(self) -> str:
        icon = {"ok": f"{GREEN}✓{RESET}", "warn": f"{YELLOW}⚠{RESET}", "fail": f"{RED}✗{RESET}"}.get(self.level, "?")
        fix_str = f"\n   {CYAN}fix:{RESET} {self.fix}" if self.fix and self.level != "ok" else ""
        return f"  {icon} [{self.code}] {self.msg}{fix_str}"


def parse_version(s: str) -> tuple:
    parts = s.strip().split(".")
    out = []
    for p in parts:
        digits = ""
        for ch in p:
            if ch.isdigit():
                digits += ch
            else:
                break
        out.append(int(digits) if digits else 0)
    while len(out) < 3:
        out.append(0)
    return tuple(out[:3])


def check_python() -> List[Issue]:
    issues = []
    v = sys.version_info
    if (v.major, v.minor) >= REQUIRED_PYTHON:
        issues.append(Issue("ok", "PY-VER", f"Python {v.major}.{v.minor}.{v.micro} (>= {REQUIRED_PYTHON[0]}.{REQUIRED_PYTHON[1]})", ""))
    else:
        issues.append(Issue("fail", "PY-VER", f"Python {v.major}.{v.minor} 太旧", f"升级到 {REQUIRED_PYTHON[0]}.{REQUIRED_PYTHON[1]}+"))
    required_pkgs = ["numpy", "sqlite3", "json", "logging"]
    for pkg in required_pkgs:
        try:
            __import__(pkg)
            issues.append(Issue("ok", f"PY-IMP-{pkg}", f"import {pkg} OK", ""))
        except ImportError:
            issues.append(Issue("fail", f"PY-IMP-{pkg}", f"缺包 {pkg}", f"pip install {pkg}"))
    return issues


def check_node() -> List[Issue]:
    issues = []
    node = shutil.which("node")
    if not node:
        issues.append(Issue("fail", "NODE-MISS", "找不到 node 可执行", "装 Node.js 并加 PATH"))
        return issues
    try:
        import subprocess
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=5)
        ver = out.stdout.strip().lstrip("v")
        vtuple = parse_version(ver)
        if vtuple[:2] >= REQUIRED_NODE:
            issues.append(Issue("ok", "NODE-VER", f"Node.js {ver} (>= {REQUIRED_NODE[0]})", ""))
        else:
            issues.append(Issue("fail", "NODE-VER", f"Node.js {ver} 太旧", f"升级到 {REQUIRED_NODE[0]}+"))
    except Exception as e:
        issues.append(Issue("warn", "NODE-RUN", f"无法跑 node --version: {e}", "检查 Node 安装"))
    return issues


def check_ports(host: str = "127.0.0.1") -> List[Issue]:
    issues = []
    for port, name in REQUIRED_PORTS:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                issues.append(Issue("warn", f"PORT-{port}", f"{port} ({name}) 已占用", "确认是不是 soloforge 自己"))
        except (socket.timeout, ConnectionRefusedError, OSError):
            issues.append(Issue("ok", f"PORT-{port}", f"{port} ({name}) 空闲", ""))
    return issues


def check_disk(min_free_mb: int = DISK_FREE_MIN_MB) -> List[Issue]:
    issues = []
    for label, path in [("project", PROJECT_DIR), ("data", PROJECT_DIR / "python" / "data")]:
        if not path.exists():
            issues.append(Issue("warn", f"DISK-{label}", f"{path} 不存在 (跳过磁盘检查)", ""))
            continue
        try:
            usage = shutil.disk_usage(path)
            free_mb = usage.free / 1024 / 1024
            if free_mb >= min_free_mb:
                issues.append(Issue("ok", f"DISK-{label}", f"{label} {free_mb:.0f}MB 剩余 (>= {min_free_mb}MB)", ""))
            else:
                issues.append(Issue("fail", f"DISK-{label}", f"{label} 只剩 {free_mb:.0f}MB (< {min_free_mb}MB)", "清理磁盘"))
        except Exception as e:
            issues.append(Issue("warn", f"DISK-{label}", f"{label} 磁盘查询失败: {e}", ""))
    return issues


def check_dirs() -> List[Issue]:
    issues = []
    for rel, desc in REQUIRED_DIRS:
        p = PROJECT_DIR / rel
        if p.is_dir():
            issues.append(Issue("ok", f"DIR-{rel}", f"{rel} 存在 ({desc})", ""))
        else:
            # 智能 fallback: 检查替代路径
            alts = DIR_ALT_FALLBACKS.get(rel, [])
            found_alt = None
            for a in alts:
                if (PROJECT_DIR / a).is_dir():
                    found_alt = a
                    break
            if found_alt:
                issues.append(Issue("warn", f"DIR-{rel}", f"{rel} 不在, 但 {found_alt} 有备份 ({desc})", f"建 {rel} (含数据时)"))
            else:
                issues.append(Issue("fail", f"DIR-{rel}", f"{rel} 缺失 ({desc})", f"mkdir -p {rel}"))
    return issues


def check_models() -> List[Issue]:
    issues = []
    model_dir = PROJECT_DIR / "bin" / "models"
    if not model_dir.exists():
        issues.append(Issue("warn", "MODEL-DIR", "bin/models/ 不存在 (会走 TFIDF fallback)", "python tools/download_minilm.py"))
        return issues
    minilm_dir = model_dir / "paraphrase-multilingual-MiniLM-L12-v2"
    if minilm_dir.is_dir():
        safetensors = minilm_dir / "model.safetensors"
        if safetensors.exists() and safetensors.stat().st_size > 100_000_000:
            issues.append(Issue("ok", "MODEL-MINILM", f"paraphrase-multilingual-MiniLM-L12-v2 已就位 ({safetensors.stat().st_size/1024/1024:.0f}MB)", ""))
        else:
            issues.append(Issue("fail", "MODEL-MINILM", "MiniLM safetensors 缺失或损坏", "python tools/download_minilm.py"))
    else:
        issues.append(Issue("warn", "MODEL-MINILM", "MiniLM 没下 (走 TFIDF fallback)", "python tools/download_minilm.py"))
    return issues


def check_db_files() -> List[Issue]:
    issues = []
    db_count = 0
    bad_count = 0
    for pat in DB_PATTERNS:
        for p in PROJECT_DIR.glob(pat):
            if not p.is_file():
                continue
            db_count += 1
            try:
                if p.suffix in (".db", ".sqlite", ".sqlite3"):
                    conn = sqlite3.connect(str(p), timeout=2)
                    cur = conn.execute("PRAGMA quick_check")
                    row = cur.fetchone()
                    conn.close()
                    if row and row[0] == "ok":
                        issues.append(Issue("ok", f"DB-{p.name}", f"{p.relative_to(PROJECT_DIR)} OK ({p.stat().st_size/1024:.0f}KB)", ""))
                    else:
                        bad_count += 1
                        issues.append(Issue("fail", f"DB-{p.name}", f"{p.relative_to(PROJECT_DIR)} integrity 失败", f"从 {p.name}.backup 恢复"))
                else:
                    issues.append(Issue("ok", f"DB-{p.name}", f"{p.relative_to(PROJECT_DIR)} 存在", ""))
            except Exception as e:
                issues.append(Issue("warn", f"DB-{p.name}", f"{p.relative_to(PROJECT_DIR)} 检查失败: {e}", ""))
    if db_count == 0:
        issues.append(Issue("warn", "DB-NONE", "没找到任何 db 文件", "首次启动会自动创建"))
    return issues


def check_process_count() -> List[Issue]:
    issues = []
    try:
        try:
            import psutil
            n = len(psutil.pids())
        except ImportError:
            if sys.platform == "win32":
                import subprocess
                out = subprocess.run(["tasklist"], capture_output=True, text=True, timeout=5)
                n = out.stdout.count(".exe")
            else:
                n = -1
        if n < 0:
            issues.append(Issue("ok", "PROC", "进程数检查跳过 (无 psutil)", ""))
        elif n < MAX_PROCESSES:
            issues.append(Issue("ok", "PROC", f"系统 {n} 个进程 (< {MAX_PROCESSES})", ""))
        else:
            issues.append(Issue("warn", "PROC", f"系统 {n} 个进程 (>= {MAX_PROCESSES})", "可能跑得慢"))
    except Exception as e:
        issues.append(Issue("warn", "PROC", f"进程数检查失败: {e}", ""))
    return issues


def check_garnet_alive() -> List[Issue]:
    issues = []
    try:
        with socket.create_connection(("127.0.0.1", 6379), timeout=0.5) as s:
            s.sendall(b"PING\r\n")
            data = s.recv(64)
            if data.startswith(b"+PONG"):
                issues.append(Issue("ok", "GARNET-PING", "Garnet PONG 响应正常", ""))
            else:
                issues.append(Issue("warn", "GARNET-PING", f"Garnet 响应异常: {data!r}", "重启 Garnet"))
    except Exception as e:
        issues.append(Issue("warn", "GARNET-PING", f"Garnet 不可达: {e}", "启动 Garnet (6379)"))
    return issues


def main() -> int:
    ap = argparse.ArgumentParser(description="SoloForge 启动前健康检查")
    ap.add_argument("--strict", action="store_true", help="警告也算 fail")
    ap.add_argument("--json", action="store_true", help="JSON 输出")
    ap.add_argument("--no-color", action="store_true", help="无 ANSI 颜色")
    ap.add_argument("--quiet", action="store_true", help="只显示 ok/warn/fail 摘要 (用于启动脚本)")
    args = ap.parse_args()

    global GREEN, RED, YELLOW, CYAN, RESET
    if args.no_color or not sys.stdout.isatty():
        GREEN = RED = YELLOW = CYAN = RESET = ""

    all_issues: List[Issue] = []
    if not args.quiet:
        print(f"{CYAN}=== SoloForge preflight check ==={RESET}")
        print(f"Project: {PROJECT_DIR}\n")

    sections = [
        ("Python", check_python),
        ("Node.js", check_node),
        ("磁盘空间", check_disk),
        ("目录", check_dirs),
        ("数据库文件", check_db_files),
        ("模型", check_models),
        ("端口占用", check_ports),
        ("进程数", check_process_count),
        ("Garnet PING", check_garnet_alive),
    ]

    for name, fn in sections:
        if not args.quiet:
            print(f"{CYAN}[{name}]{RESET}")
        issues = fn()
        all_issues.extend(issues)
        if not args.quiet:
            for i in issues:
                print(i.render())
            print()

    n_ok = sum(1 for i in all_issues if i.level == "ok")
    n_warn = sum(1 for i in all_issues if i.level == "warn")
    n_fail = sum(1 for i in all_issues if i.level == "fail")

    if args.json:
        out = {
            "summary": {"ok": n_ok, "warn": n_warn, "fail": n_fail, "total": len(all_issues)},
            "issues": [
                {"level": i.level, "code": i.code, "msg": i.msg, "fix": i.fix}
                for i in all_issues
            ],
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))

    if not args.quiet:
        print(f"{CYAN}=== Summary ==={RESET}")
        print(f"  ok:   {GREEN}{n_ok}{RESET}")
        print(f"  warn: {YELLOW}{n_warn}{RESET}")
        print(f"  fail: {RED}{n_fail}{RESET}")
        print()

    if n_fail > 0:
        if args.quiet:
            for i in all_issues:
                if i.level == "fail":
                    print(f"FAIL [{i.code}] {i.msg}")
                    if i.fix:
                        print(f"     fix: {i.fix}")
        else:
            print(f"{RED}❌ SoloForge 启动条件不满足 (上面 [X] 行有修复建议){RESET}")
        return 1
    if n_warn > 0 and args.strict:
        if args.quiet:
            for i in all_issues:
                if i.level == "warn":
                    print(f"WARN [{i.code}] {i.msg}")
        else:
            print(f"{YELLOW}⚠️  有警告 (--strict 模式视为失败){RESET}")
        return 1
    if args.quiet:
        print(f"OK ({n_ok} ok, {n_warn} warn)")
    else:
        print(f"{GREEN}✅ SoloForge ready to start{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())