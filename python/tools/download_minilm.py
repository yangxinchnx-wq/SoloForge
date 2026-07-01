# -*- coding: utf-8 -*-
"""
MiniLM 模型下载脚本 (N4)
Path: python/tools/download_minilm.py
Date: 2026-06-30

下载 paraphrase-multilingual-MiniLM-L12-v2 (sentence-transformers) 到:
  bin/models/paraphrase-multilingual-MiniLM-L12-v2/

源:
  - 默认 HuggingFace: https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/resolve/main/
  - 国内镜像: https://hf-mirror.com/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/resolve/main/

零破坏: 新文件, 不改任何业务代码。

用法:
  python -m python.tools.download_minilm
  python -m python.tools.download_minilm --mirror
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

# 必需文件 (sentence-transformers 模型组成)
FILES = [
    "config.json",
    "modules.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
    "model.safetensors",
    "sentence_bert_config.json",
    "1_Pooling/config.json",
    "special_tokens_map.json",
]

# HF main 分支, 加上分支前缀
HF_BASE = "https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/resolve/main"
MIRROR_BASE = "https://hf-mirror.com/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/resolve/main"

REPO_DIR = Path(__file__).resolve().parent.parent.parent / "bin" / "models" / "paraphrase-multilingual-MiniLM-L12-v2"


def download(url: str, dest: Path, timeout: float = 60.0) -> bool:
    """下载单个文件, 返回是否成功"""
    if dest.exists() and dest.stat().st_size > 1024:
        print(f"  [SKIP] {dest.name} (exists, {dest.stat().st_size} bytes)")
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        req = Request(url, headers={"User-Agent": "SoloForge/1.0"})
        print(f"  [GET]  {dest.name} from {url}")
        t0 = time.time()
        with urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        dest.write_bytes(data)
        elapsed = time.time() - t0
        size_mb = len(data) / 1024 / 1024
        speed = size_mb / elapsed if elapsed > 0 else 0
        print(f"  [OK]   {dest.name} {size_mb:.1f} MB in {elapsed:.1f}s ({speed:.2f} MB/s)")
        return True
    except (HTTPError, URLError, TimeoutError) as e:
        print(f"  [FAIL] {dest.name}: {e}", file=sys.stderr)
        if dest.exists():
            dest.unlink(missing_ok=True)
        return False


def main():
    ap = argparse.ArgumentParser(description="下载 paraphrase-multilingual-MiniLM-L12-v2")
    ap.add_argument("--mirror", action="store_true", help="用 hf-mirror.com 国内镜像")
    ap.add_argument("--target", default=str(REPO_DIR), help="目标目录")
    ap.add_argument("--only", default=None, help="只下载某个文件名 (调试)")
    args = ap.parse_args()

    base = MIRROR_BASE if args.mirror else HF_BASE
    target = Path(args.target)
    target.mkdir(parents=True, exist_ok=True)
    print(f"[INFO] source: {base}")
    print(f"[INFO] target: {target}")
    print(f"[INFO] files:  {len(FILES)}")

    only = args.only
    failures = []
    t0 = time.time()
    for name in FILES:
        if only and only != name:
            continue
        url = f"{base}/{name}"
        dest = target / name
        if not download(url, dest):
            failures.append(name)
    elapsed = time.time() - t0

    # 校验
    total_size = 0
    if not only:
        print("\n=== 校验 ===")
        for name in FILES:
            f = target / name
            if f.exists():
                size = f.stat().st_size
                total_size += size
                print(f"  ✓ {name:<35} {size:>12,} bytes")
            else:
                print(f"  ✗ {name:<35} MISSING")
                failures.append(name)

    print(f"\n[INFO] 总耗时: {elapsed:.1f}s, 总大小: {total_size/1024/1024:.1f} MB")
    if failures:
        print(f"[FAIL] {len(failures)} 个文件下载失败: {failures}", file=sys.stderr)
        sys.exit(1)
    else:
        print("[OK] 全部下载完成")


if __name__ == "__main__":
    main()