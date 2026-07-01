# -*- coding: utf-8 -*-
"""
SoloForge 数据库备份调度器
Path: python/tools/backup_scheduler.py
Date: 2026-06-30

D1 备份是手工一次性做的 (2026-05-30)。本工具做日常自动备份:

  1. 扫描所有 SQLite 数据库文件 (python/data/**/*.db)
  2. 用 SQLite Backup API (在线热备份, 不锁库) 复制到 backups/<date>/<name>.db
  3. 保留最近 N 份 (默认 7 天), 自动清理老的
  4. 记录备份元信息 (size / mtime / md5 / source path)
  5. 退出码: 0=成功 / 1=部分失败 / 2=完全失败

用法:
  python -m python.tools.backup_scheduler                          # 立即备份一次
  python -m python.tools.backup_scheduler --keep 14               # 保留 14 份
  python -m python.tools.backup_scheduler --target bin/backups/    # 自定义目录
  python -m python.tools.backup_scheduler --dry-run               # 只看会做什么
  python -m python.tools.backup_scheduler --cleanup-only           # 只清理老的

可以放 cron / Task Scheduler:
  - Linux:   0 3 * * *  cd /path/to/SoloForge && python -m python.tools.backup_scheduler
  - Windows: schtasks /create /tn soloforge_backup /tr "python -m python.tools.backup_scheduler" /sc daily /st 03:00
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any, Optional

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
DEFAULT_TARGET = PROJECT_DIR / "bin" / "backups"
FALLBACK_TARGET = PROJECT_DIR / "python" / "data" / "ai_society" / "backups"
DB_PATTERNS = [
    "python/data/ai_society/*.db",
    "python/data/test_ai_society/*.db",
]
EXCLUDE_DIR_NAMES = {"backups", ".deprecated", "baseline.2026-06-30"}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("backup_scheduler")


def compute_md5(p: Path, chunk: int = 65536) -> str:
    h = hashlib.md5()
    with open(p, "rb") as f:
        while True:
            data = f.read(chunk)
            if not data:
                break
            h.update(data)
    return h.hexdigest()


def backup_one_sqlite(source: Path, dest_dir: Path, dry_run: bool = False) -> Dict[str, Any]:
    """热备份单个 SQLite 文件到 dest_dir/YYYYMMDD/source_name.db

    用 SQLite 在线 backup API, 不锁库, 不破坏 WAL。
    """
    result = {
        "source": str(source.relative_to(PROJECT_DIR)),
        "dest": None,
        "size_bytes": source.stat().st_size,
        "md5": None,
        "ok": False,
        "error": None,
    }
    date_str = datetime.now().strftime("%Y%m%d")
    target_subdir = dest_dir / date_str
    dest = target_subdir / source.name
    result["dest"] = str(dest.relative_to(PROJECT_DIR))

    if dry_run:
        result["ok"] = True
        return result

    try:
        target_subdir.mkdir(parents=True, exist_ok=True)
        # 在线热备份 (SQLite 官方推荐方式, 不锁源库)
        src_conn = sqlite3.connect(str(source))
        try:
            dst_conn = sqlite3.connect(str(dest))
            try:
                with dst_conn:
                    src_conn.backup(dst_conn)
            finally:
                dst_conn.close()
        finally:
            src_conn.close()
        result["md5"] = compute_md5(dest)
        result["ok"] = True
        logger.info(f"  ✓ {source.name} → {dest.relative_to(PROJECT_DIR)} ({result['size_bytes']/1024:.1f}KB md5={result['md5'][:8]})")
    except Exception as e:
        result["error"] = str(e)
        logger.error(f"  ✗ {source.name}: {e}")
    return result


def cleanup_old_backups(target_dir: Path, keep: int, dry_run: bool = False) -> int:
    """保留最近 N 份日期目录, 删掉更早的"""
    if not target_dir.is_dir():
        return 0
    # 按日期目录名 (YYYYMMDD) 排序
    date_dirs = sorted([d for d in target_dir.iterdir() if d.is_dir() and d.name.isdigit() and len(d.name) == 8])
    if len(date_dirs) <= keep:
        return 0
    to_delete = date_dirs[:-keep]
    deleted = 0
    for d in to_delete:
        if dry_run:
            logger.info(f"  [dry-run] would delete {d.relative_to(PROJECT_DIR)}")
        else:
            try:
                shutil.rmtree(d)
                logger.info(f"  ✓ 删除老备份: {d.relative_to(PROJECT_DIR)}")
                deleted += 1
            except Exception as e:
                logger.error(f"  ✗ 删除失败: {d.relative_to(PROJECT_DIR)}: {e}")
    return deleted


def discover_databases() -> List[Path]:
    """发现所有 SQLite 数据库 (排除备份目录和 deprecated)"""
    found: List[Path] = []
    for pat in DB_PATTERNS:
        for p in PROJECT_DIR.glob(pat):
            if not p.is_file():
                continue
            # 排除 backup / deprecated / baseline 目录
            rel = p.relative_to(PROJECT_DIR)
            if any(part in EXCLUDE_DIR_NAMES for part in rel.parts):
                continue
            if p.name.endswith((".db", ".sqlite", ".sqlite3")):
                found.append(p)
    return sorted(set(found))


def write_backup_index(target_dir: Path, results: List[Dict[str, Any]], dry_run: bool) -> Optional[Path]:
    """写每次备份的 index.json (审计用)"""
    if dry_run:
        return None
    today = datetime.now().strftime("%Y%m%d")
    idx = target_dir / today / "index.json"
    payload = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "total": len(results),
        "ok_count": sum(1 for r in results if r["ok"]),
        "results": results,
    }
    try:
        idx.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info(f"  ✓ 备份索引: {idx.relative_to(PROJECT_DIR)}")
        return idx
    except Exception as e:
        logger.error(f"  ✗ 写索引失败: {e}")
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="SoloForge 数据库备份调度器")
    ap.add_argument("--keep", type=int, default=7, help="保留最近 N 份日期目录 (默认 7)")
    ap.add_argument("--target", default=None, help=f"备份目标目录 (默认 {DEFAULT_TARGET.relative_to(PROJECT_DIR)}, fallback {FALLBACK_TARGET.relative_to(PROJECT_DIR)})")
    ap.add_argument("--dry-run", action="store_true", help="只打印会做什么, 不真做")
    ap.add_argument("--cleanup-only", action="store_true", help="只清理老备份, 不备份")
    ap.add_argument("--no-cleanup", action="store_true", help="跳过清理 (只做新备份)")
    ap.add_argument("--verbose", "-v", action="store_true", help="DEBUG 级别日志")
    args = ap.parse_args()

    if args.verbose:
        logger.setLevel(logging.DEBUG)

    # 决定目标目录
    if args.target:
        target_dir = Path(args.target).resolve()
    elif DEFAULT_TARGET.exists() or not FALLBACK_TARGET.exists():
        target_dir = DEFAULT_TARGET
    else:
        target_dir = FALLBACK_TARGET
    logger.info(f"[INFO] 目标目录: {target_dir.relative_to(PROJECT_DIR)}")
    logger.info(f"[INFO] 保留份数: {args.keep}")

    # 1. 清理 (可选)
    if not args.no_cleanup and not args.cleanup_only is False:
        logger.info("[STEP] 清理老备份...")
        deleted = cleanup_old_backups(target_dir, args.keep, dry_run=args.dry_run)
        logger.info(f"  删了 {deleted} 份老备份")

    if args.cleanup_only:
        logger.info("[DONE] cleanup-only 模式结束")
        return 0

    # 2. 备份
    dbs = discover_databases()
    logger.info(f"[STEP] 发现 {len(dbs)} 个数据库:")
    for d in dbs:
        logger.info(f"  - {d.relative_to(PROJECT_DIR)}")

    if not dbs:
        logger.warning("  没有数据库可备份")
        return 2

    results = []
    for db in dbs:
        r = backup_one_sqlite(db, target_dir, dry_run=args.dry_run)
        results.append(r)

    # 3. 写 index
    idx = write_backup_index(target_dir, results, args.dry_run)

    # 4. 总结
    ok_count = sum(1 for r in results if r["ok"])
    fail_count = len(results) - ok_count
    logger.info(f"\n=== 备份总结 ===")
    logger.info(f"  ok:   {ok_count}/{len(results)}")
    logger.info(f"  fail: {fail_count}")
    logger.info(f"  target: {target_dir.relative_to(PROJECT_DIR)}")
    if idx:
        logger.info(f"  index: {idx.relative_to(PROJECT_DIR)}")

    if fail_count == 0:
        logger.info(f"✅ 全部备份完成")
        return 0
    if ok_count > 0:
        logger.warning(f"⚠️  部分失败 ({fail_count}/{len(results)})")
        return 1
    logger.error(f"❌ 全部失败")
    return 2


if __name__ == "__main__":
    sys.exit(main())