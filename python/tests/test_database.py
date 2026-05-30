# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Database Tests

数据库层单元测试
"""

import os
import sys
import tempfile
import shutil
from pathlib import Path
from datetime import datetime

import pytest

# 添加父目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from soloforge_ai_society.config import AISocietyConfig, set_config
from soloforge_ai_society.database import (
    DatabaseManager,
    ConnectionPool,
    MigrationManager,
    HealthChecker,
    BackupManager,
    CURRENT_VERSION,
)


class TestConnectionPool:
    """连接池测试"""

    @pytest.fixture
    def temp_db(self):
        """临时数据库"""
        temp_dir = tempfile.mkdtemp()
        db_path = Path(temp_dir) / "test.db"
        yield db_path
        import gc
        gc.collect()
        try:
            shutil.rmtree(temp_dir)
        except PermissionError:
            pass  # 忽略 Windows 文件锁问题

    def test_create_connection(self, temp_db):
        """测试创建连接"""
        pool = ConnectionPool(temp_db)
        conn = pool.get_connection()
        assert conn is not None
        conn.execute("SELECT 1")
        pool.close_all()

    def test_connection_reuse(self, temp_db):
        """测试连接复用"""
        pool = ConnectionPool(temp_db)
        conn1 = pool.get_connection()
        conn2 = pool.get_connection()
        # 同一线程应该复用连接
        assert conn1 is conn2
        pool.close_all()

    def test_transaction(self, temp_db):
        """测试事务"""
        pool = ConnectionPool(temp_db)

        with pool.connection() as conn:
            conn.execute("CREATE TABLE test (id INTEGER PRIMARY KEY)")
            conn.execute("INSERT INTO test VALUES (1)")
            conn.commit()

        # 验证数据
        with pool.connection() as conn:
            cursor = conn.execute("SELECT * FROM test")
            rows = cursor.fetchall()
            assert len(rows) == 1

        pool.close_all()

    def test_stats(self, temp_db):
        """测试统计"""
        pool = ConnectionPool(temp_db)
        pool.get_connection()
        pool.get_connection()
        stats = pool.get_stats()
        assert stats["acquired"] >= 2
        pool.close_all()


class TestMigration:
    """迁移测试"""

    @pytest.fixture
    def temp_db(self):
        """临时数据库"""
        import sqlite3
        temp_dir = tempfile.mkdtemp()
        db_path = Path(temp_dir) / "test.db"
        conn = sqlite3.connect(str(db_path))
        conn.close()
        yield db_path
        # Windows 文件锁问题：确保连接完全关闭
        import gc
        gc.collect()
        try:
            shutil.rmtree(temp_dir)
        except PermissionError:
            pass  # 忽略 Windows 文件锁问题

    def test_migrate_to_v2(self, temp_db):
        """测试迁移到v2"""
        manager = MigrationManager(temp_db)
        applied = manager.migrate(2)

        assert applied == 1

        status = manager.get_status()
        assert status["current_version"] == 2
        assert not status["needs_migration"]

    def test_migration_history(self, temp_db):
        """测试迁移历史"""
        manager = MigrationManager(temp_db)
        manager.migrate(2)

        status = manager.get_status()
        assert len(status["history"]) == 1
        assert status["history"][0]["version"] == 2


class TestHealthChecker:
    """健康检查测试"""

    @pytest.fixture
    def temp_db(self):
        """临时数据库"""
        temp_dir = tempfile.mkdtemp()
        db_path = Path(temp_dir) / "test.db"

        # 创建一些测试数据
        import sqlite3
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE economy (id TEXT PRIMARY KEY, agent_id TEXT UNIQUE)")
        conn.execute("INSERT INTO economy VALUES ('1', 'agent_1')")
        conn.commit()
        conn.close()

        yield db_path
        import gc
        gc.collect()
        try:
            shutil.rmtree(temp_dir)
        except PermissionError:
            pass  # 忽略 Windows 文件锁问题

    def test_healthy_db(self, temp_db):
        """测试健康数据库"""
        checker = HealthChecker(temp_db)
        result = checker.check()

        assert result.healthy
        assert "tables" in result.details
        assert len(result.details["tables"]) > 0

    def test_performance_metrics(self, temp_db):
        """测试性能指标"""
        checker = HealthChecker(temp_db)
        metrics = checker.get_performance_metrics()

        assert "cache_size_mb" in metrics
        assert "journal_mode" in metrics
        # 临时数据库可能是 delete 模式，连接池创建的才是 wal
        assert metrics["journal_mode"] in ("wal", "delete")


class TestBackupManager:
    """备份管理测试"""

    @pytest.fixture
    def temp_db(self):
        """临时数据库"""
        temp_dir = tempfile.mkdtemp()
        db_path = Path(temp_dir) / "test.db"

        # 创建测试数据
        import sqlite3
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE test (id INTEGER PRIMARY KEY)")
        conn.execute("INSERT INTO test VALUES (1), (2), (3)")
        conn.commit()
        conn.close()

        yield db_path
        import gc
        gc.collect()
        try:
            shutil.rmtree(temp_dir)
        except PermissionError:
            pass  # 忽略 Windows 文件锁问题

    def test_create_backup(self, temp_db):
        """测试创建备份"""
        manager = BackupManager(temp_db)
        info = manager.create_backup("test_backup")

        assert info.path.exists()
        assert info.size_bytes > 0

    def test_restore_backup(self, temp_db):
        """测试恢复备份"""
        manager = BackupManager(temp_db)

        # 创建备份
        info = manager.create_backup()

        # 删除原表
        import sqlite3
        conn = sqlite3.connect(str(temp_db))
        conn.execute("DROP TABLE test")
        conn.commit()
        conn.close()

        # 恢复
        assert manager.restore_backup(info.path)

        # 验证数据恢复
        conn = sqlite3.connect(str(temp_db))
        cursor = conn.execute("SELECT COUNT(*) as count FROM test")
        count = cursor.fetchone()[0]
        conn.close()
        assert count == 3

    def test_list_backups(self, temp_db):
        """测试列出备份"""
        manager = BackupManager(temp_db)

        # 创建多个备份
        manager.create_backup("backup_1")
        manager.create_backup("backup_2")

        backups = manager.list_backups()
        assert len(backups) == 2


class TestDatabaseManager:
    """数据库管理器测试"""

    @pytest.fixture
    def temp_config(self):
        """临时配置"""
        temp_dir = tempfile.mkdtemp()
        config = AISocietyConfig(data_dir=Path(temp_dir))
        set_config(config)
        yield config
        shutil.rmtree(temp_dir)

    def test_initialize(self, temp_config):
        """测试初始化"""
        db = DatabaseManager()
        db.initialize()

        assert db.pool is not None
        assert db.get_lancedb() is not None

        db.close()

    def test_migration_on_init(self, temp_config):
        """测试初始化时自动迁移"""
        db = DatabaseManager()
        db.initialize()

        status = db.get_migration_status()
        assert status["current_version"] == CURRENT_VERSION

        db.close()

    def test_pool_stats(self, temp_config):
        """测试连接池统计"""
        db = DatabaseManager()
        db.initialize()

        # 执行一些操作
        db.pool.get_connection()

        stats = db.get_pool_stats()
        assert "acquired" in stats

        db.close()

    def test_vacuum(self, temp_config):
        """测试数据库整理"""
        db = DatabaseManager()
        db.initialize()

        # 插入一些数据
        with db.pool.connection() as conn:
            conn.execute("CREATE TABLE vacuum_test (id INTEGER PRIMARY KEY)")
            for i in range(100):
                conn.execute("INSERT INTO vacuum_test VALUES (?)", (i,))
            conn.commit()

        # 执行 vacuum
        db.vacuum()

        # 验证表仍然存在
        with db.pool.connection() as conn:
            cursor = conn.execute("SELECT COUNT(*) FROM vacuum_test")
            count = cursor.fetchone()[0]
            assert count == 100

        db.close()

    def test_checkpoint(self, temp_config):
        """测试 WAL 检查点"""
        db = DatabaseManager()
        db.initialize()

        # 执行检查点
        db.checkpoint()

        db.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
