# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Database CLI

数据库管理命令行工具

用法:
    python -m soloforge_ai_society.scripts.db_cli <command>

命令:
    status      - 查看数据库状态
    migrate     - 运行迁移
    health      - 健康检查
    backup      - 创建备份
    restore     - 恢复备份
    list-backups - 列出备份
    vacuum      - 整理数据库
    stats       - 查看统计信息
"""

import argparse
import json
import sys
from pathlib import Path

# 添加父目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from soloforge_ai_society.config import get_config
from soloforge_ai_society.database import (
    DatabaseManager,
    run_migrations,
    get_migration_status,
    HealthChecker,
    BackupManager,
    ConnectionPool,
)


def cmd_status(args):
    """查看数据库状态"""
    config = get_config()

    print("=" * 60)
    print("  AI Society 数据库状态")
    print("=" * 60)

    print(f"\n[*] 数据目录: {config.data_dir}")
    print(f"[*] SQLite: {config.sqlite_path}")
    print(f"[*] LanceDB: {config.lancedb_path}")

    # 迁移状态
    print("\n[*] 迁移状态:")
    status = get_migration_status(config.sqlite_path)
    print(f"   当前版本: v{status['current_version']}")
    print(f"   目标版本: v{status['target_version']}")

    if status['history']:
        print("   迁移历史:")
        for h in status['history']:
            print(f"     - v{h['version']}: {h['description']} ({h['applied_at']})")

    # 文件大小
    print("\n[*] 文件大小:")
    if config.sqlite_path.exists():
        size = config.sqlite_path.stat().st_size
        print(f"   SQLite: {size / 1024 / 1024:.2f} MB")

    if config.lancedb_path.exists():
        size = config.lancedb_path.stat().st_size
        print(f"   LanceDB: {size / 1024 / 1024:.2f} MB")


def cmd_migrate(args):
    """运行迁移"""
    config = get_config()

    print("=" * 60)
    print("  运行数据库迁移")
    print("=" * 60)

    try:
        migrated = run_migrations(config.sqlite_path)
        print(f"\n[OK] 完成！执行了 {migrated} 个迁移")
    except Exception as e:
        print(f"\n[FAIL] 迁移失败: {e}")
        sys.exit(1)


def cmd_health(args):
    """健康检查"""
    config = get_config()

    print("=" * 60)
    print("  数据库健康检查")
    print("=" * 60)

    checker = HealthChecker(config.sqlite_path)
    result = checker.check()

    print(f"\n{'[OK] 健康' if result.healthy else '[FAIL] 异常'}: {result.message}")

    if result.details:
        print("\n[*] 详细信息:")
        for key, value in result.details.items():
            if key == 'issues':
                if value:
                    print("   问题列表:")
                    for issue in value:
                        print(f"     [!] {issue}")
            elif key == 'tables':
                print(f"   表数量: {len(value)}")
            elif key == 'table_sizes':
                print("   表记录数:")
                for table, count in value.items():
                    print(f"     {table}: {count} 条")
            elif key == 'db_size_bytes':
                print(f"   数据库大小: {value / 1024 / 1024:.2f} MB")
            else:
                print(f"   {key}: {value}")


def cmd_backup(args):
    """创建备份"""
    config = get_config()

    print("=" * 60)
    print("  创建数据库备份")
    print("=" * 60)

    manager = BackupManager(config.sqlite_path)

    name = args.name if hasattr(args, 'name') else None

    try:
        info = manager.create_backup(name)
        print(f"\n[OK] 备份创建成功!")
        print(f"   路径: {info.path}")
        print(f"   大小: {info.size_bytes / 1024 / 1024:.2f} MB")
        print(f"   版本: v{info.version}")
    except Exception as e:
        print(f"\n[FAIL] 备份失败: {e}")
        sys.exit(1)


def cmd_restore(args):
    """恢复备份"""
    config = get_config()

    if not args.backup:
        print("[FAIL] 请指定备份文件路径: --backup <path>")
        sys.exit(1)

    print("=" * 60)
    print("  恢复数据库备份")
    print("=" * 60)

    manager = BackupManager(config.sqlite_path)
    backup_path = Path(args.backup)

    if not backup_path.exists():
        print(f"[FAIL] 备份文件不存在: {backup_path}")
        sys.exit(1)

    try:
        if manager.restore_backup(backup_path):
            print(f"\n[OK] 备份恢复成功!")
        else:
            print(f"\n[FAIL] 恢复失败")
            sys.exit(1)
    except Exception as e:
        print(f"\n[FAIL] 恢复失败: {e}")
        sys.exit(1)


def cmd_list_backups(args):
    """列出备份"""
    config = get_config()

    print("=" * 60)
    print("  数据库备份列表")
    print("=" * 60)

    manager = BackupManager(config.sqlite_path)
    backups = manager.list_backups()

    if not backups:
        print("\n暂无备份")
        return

    print(f"\n共 {len(backups)} 个备份:\n")
    print(f"{'备份文件':<40} {'大小':<12} {'创建时间':<20}")
    print("-" * 72)

    for backup in backups:
        size_str = f"{backup.size_bytes / 1024 / 1024:.2f} MB"
        time_str = backup.created_at.strftime("%Y-%m-%d %H:%M:%S")
        print(f"{backup.path.name:<40} {size_str:<12} {time_str:<20}")


def cmd_vacuum(args):
    """整理数据库"""
    config = get_config()

    print("=" * 60)
    print("  整理数据库")
    print("=" * 60)

    try:
        db = DatabaseManager()
        db.initialize()
        db.vacuum()
        print("\n[OK] 数据库整理完成")
    except Exception as e:
        print(f"\n[FAIL] 整理失败: {e}")
        sys.exit(1)


def cmd_stats(args):
    """查看统计信息"""
    config = get_config()

    print("=" * 60)
    print("  数据库统计信息")
    print("=" * 60)

    pool = ConnectionPool(config.sqlite_path)

    print("\n[*] 连接池统计:")
    stats = pool.get_stats()
    for key, value in stats.items():
        print(f"   {key}: {value}")

    print("\n[*] 表统计:")

    import sqlite3
    conn = sqlite3.connect(str(config.sqlite_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.execute("""
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
    """)

    tables = [row[0] for row in cursor.fetchall()]

    for table in tables:
        try:
            cursor.execute(f"SELECT COUNT(*) as count FROM {table}")
            count = cursor.fetchone()[0]
            print(f"   {table}: {count} 条记录")
        except Exception as e:
            print(f"   {table}: 查询失败 ({e})")

    conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="AI Society 数据库管理工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    subparsers = parser.add_subparsers(dest="command", help="子命令")

    # status
    subparsers.add_parser("status", help="查看数据库状态")

    # migrate
    subparsers.add_parser("migrate", help="运行迁移")

    # health
    subparsers.add_parser("health", help="健康检查")

    # backup
    backup_parser = subparsers.add_parser("backup", help="创建备份")
    backup_parser.add_argument("--name", help="备份名称（可选）")

    # restore
    restore_parser = subparsers.add_parser("restore", help="恢复备份")
    restore_parser.add_argument("--backup", required=True, help="备份文件路径")

    # list-backups
    subparsers.add_parser("list-backups", help="列出备份")

    # vacuum
    subparsers.add_parser("vacuum", help="整理数据库")

    # stats
    subparsers.add_parser("stats", help="查看统计信息")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # 执行命令
    commands = {
        "status": cmd_status,
        "migrate": cmd_migrate,
        "health": cmd_health,
        "backup": cmd_backup,
        "restore": cmd_restore,
        "list-backups": cmd_list_backups,
        "vacuum": cmd_vacuum,
        "stats": cmd_stats,
    }

    commands[args.command](args)


if __name__ == "__main__":
    main()
