# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Database Health Check & Backup

数据库健康检查与备份

功能：
- 健康状态监控
- 自动备份
- 数据完整性检查
- 性能指标
"""

import json
import logging
import os
import shutil
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class HealthStatus:
    """健康状态"""
    healthy: bool
    message: str
    details: dict


@dataclass
class BackupInfo:
    """备份信息"""
    path: Path
    size_bytes: int
    created_at: datetime
    version: int


class HealthChecker:
    """数据库健康检查器"""

    def __init__(self, db_path: Path):
        self.db_path = db_path

    def check(self) -> HealthStatus:
        """
        执行健康检查

        Returns:
            健康状态
        """
        try:
            conn = sqlite3.connect(str(self.db_path))
            apply_p6_baseline(conn)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            issues = []
            details = {}

            # 1. 检查数据库文件
            if not self.db_path.exists():
                return HealthStatus(False, "数据库文件不存在", {})

            details["db_size_bytes"] = self.db_path.stat().st_size

            # 2. 检查 WAL 文件
            wal_path = Path(str(self.db_path) + "-wal")
            if wal_path.exists():
                details["wal_size_bytes"] = wal_path.stat().st_size
                # WAL 文件过大的警告
                if wal_path.stat().st_size > 100 * 1024 * 1024:  # 100MB
                    issues.append("WAL 文件过大，建议执行检查点")

            # 3. 检查表完整性
            cursor.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name NOT LIKE 'sqlite_%'
            """)
            tables = [row[0] for row in cursor.fetchall()]
            details["tables_count"] = len(tables)
            details["tables"] = tables

            # 4. 检查索引
            cursor.execute("""
                SELECT name, tbl_name FROM sqlite_master
                WHERE type='index' AND name NOT LIKE 'sqlite_%'
            """)
            indexes = [dict(row) for row in cursor.fetchall()]
            details["indexes_count"] = len(indexes)

            # 5. 检查孤立记录
            issues.extend(self._check_orphans(cursor))

            # 6. 检查 schema 版本
            try:
                cursor.execute("SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1")
                row = cursor.fetchone()
                details["schema_version"] = row["version"] if row else 0
            except sqlite3.OperationalError:
                details["schema_version"] = 0

            # 7. 检查表大小
            table_sizes = {}
            for table in tables:
                try:
                    cursor.execute(f"SELECT COUNT(*) as count FROM {table}")
                    table_sizes[table] = cursor.fetchone()["count"]
                except sqlite3.OperationalError:
                    table_sizes[table] = -1
            details["table_sizes"] = table_sizes

            # 8. 检查最近写入时间
            try:
                cursor.execute("""
                    SELECT MAX(updated_at) as last_write FROM (
                        SELECT updated_at FROM economy ORDER BY updated_at DESC LIMIT 1
                        UNION ALL
                        SELECT updated_at FROM reputation ORDER BY updated_at DESC LIMIT 1
                    )
                """)
                row = cursor.fetchone()
                details["last_write"] = row["last_write"] if row and row["last_write"] else None
            except sqlite3.OperationalError:
                details["last_write"] = None

            conn.close()

            # 汇总
            if issues:
                return HealthStatus(
                    healthy=True,
                    message=f"发现 {len(issues)} 个问题",
                    details={**details, "issues": issues}
                )

            return HealthStatus(
                healthy=True,
                message="数据库健康",
                details=details
            )

        except Exception as e:
            logger.error(f"健康检查失败: {e}")
            return HealthStatus(False, f"检查失败: {e}", {})

    def _check_orphans(self, cursor: sqlite3.Cursor) -> list:
        """检查孤立记录"""
        issues = []

        # 检查治理记录是否引用存在的治理
        try:
            cursor.execute("""
                SELECT COUNT(*) as count FROM governance_record gr
                LEFT JOIN governance g ON gr.governance_id = g.id
                WHERE g.id IS NULL
            """)
            orphan_count = cursor.fetchone()["count"]
            if orphan_count > 0:
                issues.append(f"存在 {orphan_count} 条孤立的治理记录")
        except sqlite3.OperationalError:
            pass

        # 检查信誉记录是否引用存在的信誉
        try:
            cursor.execute("""
                SELECT COUNT(*) as count FROM reputation_record rr
                LEFT JOIN reputation r ON rr.reputation_id = r.id
                WHERE r.id IS NULL
            """)
            orphan_count = cursor.fetchone()["count"]
            if orphan_count > 0:
                issues.append(f"存在 {orphan_count} 条孤立的信誉记录")
        except sqlite3.OperationalError:
            pass

        return issues

    def get_performance_metrics(self) -> dict:
        """获取性能指标"""
        try:
            conn = sqlite3.connect(str(self.db_path))
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            # 查询缓存命中率
            cursor.execute("PRAGMA cache_size")
            cache_size = cursor.fetchone()[0]

            cursor.execute("PRAGMA page_size")
            page_size = cursor.fetchone()[0]

            # 估算内存使用
            memory_usage = (cache_size * page_size) / (1024 * 1024)

            # WAL 状态
            cursor.execute("PRAGMA journal_mode")
            journal_mode = cursor.fetchone()[0]

            conn.close()

            return {
                "cache_size_pages": cache_size,
                "cache_size_mb": round(memory_usage, 2),
                "page_size_bytes": page_size,
                "journal_mode": journal_mode,
            }

        except Exception as e:
            logger.error(f"获取性能指标失败: {e}")
            return {}


class BackupManager:
    """备份管理器"""

    def __init__(
        self,
        db_path: Path,
        backup_dir: Optional[Path] = None,
        max_backups: int = 10,
    ):
        self.db_path = db_path
        self.backup_dir = backup_dir or db_path.parent / "backups"
        self.max_backups = max_backups

        # 确保备份目录存在
        self.backup_dir.mkdir(parents=True, exist_ok=True)

    def create_backup(self, name: Optional[str] = None) -> BackupInfo:
        """
        创建备份

        Args:
            name: 备份名称，不提供则使用时间戳

        Returns:
            备份信息
        """
        if name is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            name = f"backup_{timestamp}"

        # 备份文件名
        backup_path = self.backup_dir / f"{name}.db"

        # 执行在线备份
        start_time = time.time()

        conn_src = sqlite3.connect(str(self.db_path))
        conn_dst = sqlite3.connect(str(backup_path))

        conn_src.backup(conn_dst)

        conn_dst.close()
        conn_src.close()

        elapsed = time.time() - start_time

        # 复制 WAL 文件（如果存在）
        wal_path = Path(str(self.db_path) + "-wal")
        if wal_path.exists():
            wal_backup_path = Path(str(backup_path) + "-wal")
            shutil.copy2(wal_path, wal_backup_path)

        # 获取 schema 版本
        conn = sqlite3.connect(str(backup_path))
        conn.row_factory = sqlite3.Row
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1")
            row = cursor.fetchone()
            version = row["version"] if row else 0
        except sqlite3.OperationalError:
            version = 0
        conn.close()

        info = BackupInfo(
            path=backup_path,
            size_bytes=backup_path.stat().st_size,
            created_at=datetime.now(),
            version=version,
        )

        logger.info(f"Backup created: {backup_path} ({info.size_bytes} bytes, {elapsed:.2f}s)")

        # 清理旧备份
        self._cleanup_old_backups()

        return info

    def restore_backup(self, backup_path: Path) -> bool:
        """
        恢复备份

        Args:
            backup_path: 备份文件路径

        Returns:
            是否成功
        """
        try:
            # 检查备份文件是否存在
            if not backup_path.exists():
                logger.error(f"备份文件不存在: {backup_path}")
                return False

            # 关闭当前连接
            conn = sqlite3.connect(str(self.db_path))
            apply_p6_baseline(conn)
            conn.close()

            # 复制备份文件
            shutil.copy2(backup_path, self.db_path)

            # 恢复 WAL 文件（如果存在）
            wal_backup_path = Path(str(backup_path) + "-wal")
            if wal_backup_path.exists():
                wal_path = Path(str(self.db_path) + "-wal")
                shutil.copy2(wal_backup_path, wal_path)

            logger.info(f"Backup restored from: {backup_path}")
            return True

        except Exception as e:
            logger.error(f"恢复备份失败: {e}")
            return False

    def list_backups(self) -> list[BackupInfo]:
        """列出所有备份"""
        backups = []

        for path in sorted(self.backup_dir.glob("backup_*.db"), reverse=True):
            try:
                stat = path.stat()
                backups.append(BackupInfo(
                    path=path,
                    size_bytes=stat.st_size,
                    created_at=datetime.fromtimestamp(stat.st_mtime),
                    version=0,  # 快速获取
                ))
            except Exception:
                pass

        return backups

    def _cleanup_old_backups(self) -> None:
        """清理旧备份"""
        backups = self.list_backups()

        if len(backups) > self.max_backups:
            for backup in backups[self.max_backups:]:
                try:
                    # 删除主文件
                    backup.path.unlink()
                    # 删除 WAL 文件
                    wal_path = Path(str(backup.path) + "-wal")
                    if wal_path.exists():
                        wal_path.unlink()
                    logger.debug(f"Deleted old backup: {backup.path}")
                except Exception as e:
                    logger.warning(f"删除旧备份失败: {e}")

    def delete_backup(self, backup_path: Path) -> bool:
        """删除备份"""
        try:
            backup_path.unlink()
            wal_path = Path(str(backup_path) + "-wal")
            if wal_path.exists():
                wal_path.unlink()
            logger.info(f"Deleted backup: {backup_path}")
            return True
        except Exception as e:
            logger.error(f"删除备份失败: {e}")
            return False


def run_health_check(db_path: Path) -> HealthStatus:
    """便捷函数：运行健康检查"""
    checker = HealthChecker(db_path)
    return checker.check()


def create_backup(db_path: Path, backup_dir: Optional[Path] = None) -> BackupInfo:
    """便捷函数：创建备份"""
    manager = BackupManager(db_path, backup_dir)
    return manager.create_backup()
