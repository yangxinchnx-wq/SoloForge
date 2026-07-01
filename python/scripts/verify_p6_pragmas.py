"""
D0 P6 PRAGMA 验证脚本
1. 直接 import pool 模块（已被修改）
2. 创建一个临时 :memory: 连接走 _create_connection
3. 读取所有 PRAGMA 当前值，与基线对照

只读，不修改任何业务数据。
"""
import sys
from pathlib import Path

# 把 python 目录加入 sys.path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# 直接 import pool 模块（避免触发 manager.initialize 全流程）
from soloforge_ai_society.database.pool import ConnectionPool

# 用一个临时 sqlite 文件（不是 :memory:，因为 _create_connection 是固定 db_path）
import tempfile, os
tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
tmp.close()
db_path = Path(tmp.name)

try:
    pool = ConnectionPool(db_path=db_path, max_connections=1)
    conn = pool._create_connection()

    prags = [
        ("journal_mode", "PRAGMA journal_mode"),
        ("synchronous", "PRAGMA synchronous"),
        ("cache_size", "PRAGMA cache_size"),
        ("mmap_size", "PRAGMA mmap_size"),
        ("temp_store", "PRAGMA temp_store"),
        ("foreign_keys", "PRAGMA foreign_keys"),
        ("busy_timeout", "PRAGMA busy_timeout"),
    ]

    print("=" * 60)
    print(f"D0 P6 PRAGMA 验证 @ {db_path}")
    print("=" * 60)
    print(f"{'名称':<15} {'查询结果':<15} {'期望':<15} {'状态':<6}")
    print("-" * 60)
    expectations = {
        "journal_mode": "wal",
        "synchronous": "1",       # NORMAL
        "cache_size": "-65536",   # 64MB
        "mmap_size": "268435456", # 256MB
        "temp_store": "2",        # MEMORY
        "foreign_keys": "1",
        "busy_timeout": "30000",
    }
    all_ok = True
    for name, sql in prags:
        cur = conn.execute(sql)
        val = cur.fetchone()[0]
        expected = expectations[name]
        ok = str(val) == expected
        if not ok:
            all_ok = False
        status = "[OK]" if ok else "[!!]"
        print(f"{name:<15} {str(val):<15} {expected:<15} {status}")

    print("-" * 60)
    print("整体:", "[PASS]" if all_ok else "[FAIL]")

    pool.close_all()
finally:
    try:
        os.unlink(db_path)
    except OSError:
        pass