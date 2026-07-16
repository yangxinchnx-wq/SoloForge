"""
AI 社会一次性初始化脚本

功能:
  1. 运行 v1 + v2 迁移,补齐 9 张主表 + 4 张流水表
  2. 初始化 LanceDB 目录
  3. 灌入 PRESET_INSTITUTIONS (3 条) + PRESET_CULTURES (4 条)
  4. 验证表/索引/预置数据是否全部就绪
"""
import sys
from pathlib import Path

# 确保以仓库根为 cwd,config._default_data_dir 不依赖 cwd
ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "python"))

from soloforge_ai_society.config import get_config
from soloforge_ai_society.database.manager import DatabaseManager
from soloforge_ai_society.database.migration import get_migration_status


def main() -> int:
    print("=" * 70)
    print("AI Society one-shot initializer")
    print("=" * 70)

    cfg = get_config()
    print(f"\n[config] sqlite_path  = {cfg.sqlite_path}")
    print(f"[config] qdrant       = {cfg.qdrant_host}:{cfg.qdrant_http_port} (collection: {cfg.qdrant_collection})")
    print(f"[config] data_dir     = {cfg.data_dir}")

    if not cfg.sqlite_path.exists():
        print(f"\n[error] sqlite file missing: {cfg.sqlite_path}")
        return 1

    # 1) 迁移状态
    print("\n[step 1] Migration status BEFORE init:")
    before = get_migration_status(cfg.sqlite_path)
    print(f"  current_version={before.get('current_version')}  "
          f"target={before.get('target_version')}  "
          f"needs={before.get('needs_migration')}")

    # 2) 走 manager.initialize() (含迁移 + 建表 + 预置)
    print("\n[step 2] DatabaseManager.initialize() ...")
    mgr = DatabaseManager(cfg)
    mgr.initialize()
    print("  done.")

    # 3) 迁移状态 after
    print("\n[step 3] Migration status AFTER init:")
    after = get_migration_status(cfg.sqlite_path)
    print(f"  current_version={after.get('current_version')}  "
          f"target={after.get('target_version')}")
    for h in after.get("history", []):
        print(f"    - v{h.get('version')}: {h.get('description')}  "
              f"applied_at={h.get('applied_at')}")

    # 4) 验证表 + 计数
    print("\n[step 4] Table verification:")
    import sqlite3
    conn = sqlite3.connect(str(cfg.sqlite_path))
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.cursor()
        tables = [r[0] for r in cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )]
        expected = {
            "institution", "governance", "reputation", "culture", "economy",
            "law", "law_violation", "coalition", "social_memory",
            "reputation_sync_log",
            "credit_transaction", "economy_record", "governance_record",
            "reputation_record", "schema_version",
        }
        missing = expected - set(tables)
        if missing:
            print(f"  [FAIL] missing tables: {sorted(missing)}")
            return 2
        for t in tables:
            n = cur.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
            print(f"  {t:25s} -> {n} row(s)")

        # 索引
        idx = [r[0] for r in cur.execute(
            "SELECT name FROM sqlite_master WHERE type='index' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
        print(f"\n  indexes ({len(idx)}):")
        for i in idx:
            print(f"    - {i}")
    finally:
        conn.close()

    # 5) Qdrant 健康检查（仅提示, 不阻塞 SQLite 初始化）
    print("\n[step 5] Qdrant health check (skip if not running):")
    try:
        from soloforge_ai_society.services.qdrant_client import get_qdrant_client
        qc = get_qdrant_client()
        ok = qc.health_check()
        print(f"  [{'OK' if ok else 'WARN'}] Qdrant {cfg.qdrant_host}:{cfg.qdrant_http_port}  {'healthy' if ok else 'unavailable'}")
    except Exception as e:
        print(f"  [WARN] Qdrant check skipped: {e}")

    # 6) 预置数据抽样
    print("\n[step 6] Preset data sample:")
    import sqlite3
    conn = sqlite3.connect(str(cfg.sqlite_path))
    try:
        for t in ("institution", "culture"):
            rows = list(conn.execute(f"SELECT * FROM {t}"))
            print(f"  -- {t} ({len(rows)}) --")
            for r in rows[:5]:
                print(f"    {dict(zip([c[0] for c in r.cursor_description], r))}"
                      if hasattr(r, "cursor_description") else f"    {tuple(r)}")
    finally:
        conn.close()

    print("\n[done] AI society database is fully initialized.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
