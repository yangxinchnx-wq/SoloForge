# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Connection Pool

数据库连接池

功能：
- 多连接复用
- 连接生命周期管理
- 自动重连
- 线程安全（使用 threading.local）
"""

import logging
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Generator, Optional

logger = logging.getLogger(__name__)


class ConnectionPool:
    """
    SQLite 连接池

    使用 ThreadLocal 存储连接，每个线程独立连接
    """

    def __init__(
        self,
        db_path: Path,
        max_connections: int = 5,
        timeout: float = 30.0,
    ):
        """
        初始化连接池

        Args:
            db_path: 数据库路径
            max_connections: 最大连接数
            timeout: 连接超时时间
        """
        self.db_path = db_path
        self.max_connections = max_connections
        self.timeout = timeout

        # ThreadLocal 存储连接
        self._local = threading.local()

        # 连接统计
        self._stats = {
            "acquired": 0,
            "released": 0,
            "created": 0,
            "errors": 0,
        }
        self._stats_lock = threading.Lock()

        # WAL 检查点线程
        self._checkpoint_thread: Optional[threading.Thread] = None
        self._running = False

    def _create_connection(self) -> sqlite3.Connection:
        """创建新连接"""
        conn = sqlite3.connect(
            str(self.db_path),
            timeout=self.timeout,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row

        # 性能优化
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA cache_size = -64000")  # 64MB
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")  # 30秒忙等

        with self._stats_lock:
            self._stats["created"] += 1

        return conn

    def get_connection(self) -> sqlite3.Connection:
        """获取连接"""
        # 尝试获取当前线程的连接
        conn = getattr(self._local, "conn", None)

        if conn is not None:
            try:
                # 检查连接是否有效
                conn.execute("SELECT 1")
                with self._stats_lock:
                    self._stats["acquired"] += 1
                return conn
            except (sqlite3.ProgrammingError, sqlite3.OperationalError):
                # 连接已关闭或无效
                self._local.conn = None
                conn = None

        # 创建新连接
        if conn is None:
            conn = self._create_connection()
            self._local.conn = conn
            logger.debug(f"Created new connection for thread {threading.current_thread().name}")

        with self._stats_lock:
            self._stats["acquired"] += 1

        return conn

    def release_connection(self) -> None:
        """释放当前线程的连接（不关闭，仅标记为可用）"""
        # SQLite 连接不需要显式释放
        with self._stats_lock:
            self._stats["released"] += 1

    def close_connection(self) -> None:
        """关闭当前线程的连接"""
        conn = getattr(self._local, "conn", None)
        if conn:
            try:
                conn.close()
            except Exception:
                pass
            self._local.conn = None
            logger.debug(f"Closed connection for thread {threading.current_thread().name}")

    def close_all(self) -> None:
        """关闭所有连接"""
        self._running = False

        if self._checkpoint_thread:
            self._checkpoint_thread.join(timeout=5)

        self.close_connection()
        logger.info("All connections closed")

    @contextmanager
    def connection(self) -> Generator[sqlite3.Connection, None, None]:
        """
        上下文管理器，自动管理连接

        Usage:
            with pool.connection() as conn:
                cursor = conn.cursor()
                cursor.execute("...")
        """
        conn = self.get_connection()
        try:
            yield conn
        except Exception as e:
            logger.error(f"Database error: {e}")
            # 连接出错，关闭它
            self.close_connection()
            raise
        finally:
            self.release_connection()

    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        """执行单条 SQL"""
        with self.connection() as conn:
            return conn.execute(sql, params)

    def executescript(self, sql: str) -> None:
        """执行多条 SQL"""
        with self.connection() as conn:
            conn.executescript(sql)

    def commit(self) -> None:
        """提交当前事务"""
        conn = self.get_connection()
        conn.commit()

    def rollback(self) -> None:
        """回滚当前事务"""
        conn = self.get_connection()
        conn.rollback()

    def checkpoint(self) -> None:
        """执行 WAL 检查点"""
        with self.connection() as conn:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        logger.debug("WAL checkpoint completed")

    def start_auto_checkpoint(self, interval_seconds: int = 300) -> None:
        """
        启动自动 WAL 检查点

        Args:
            interval_seconds: 检查间隔
        """
        self._running = True

        def checkpoint_loop():
            while self._running:
                time.sleep(interval_seconds)
                if self._running:
                    try:
                        self.checkpoint()
                    except Exception as e:
                        logger.error(f"Auto checkpoint failed: {e}")

        self._checkpoint_thread = threading.Thread(
            target=checkpoint_loop,
            name="sqlite-checkpoint",
            daemon=True,
        )
        self._checkpoint_thread.start()
        logger.info(f"Auto checkpoint started (interval={interval_seconds}s)")

    def get_stats(self) -> dict:
        """获取连接统计"""
        with self._stats_lock:
            return self._stats.copy()

    def vacuum(self) -> None:
        """整理数据库"""
        with self.connection() as conn:
            conn.execute("VACUUM")
        logger.info("Database vacuumed")


# 全局连接池实例
_pool: Optional[ConnectionPool] = None
_pool_lock = threading.Lock()


def get_pool(db_path: Optional[Path] = None) -> ConnectionPool:
    """获取全局连接池"""
    global _pool

    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = ConnectionPool(db_path or Path("./data/ai_society/ai_society.db"))
                logger.info("Connection pool initialized")

    return _pool


def close_pool() -> None:
    """关闭全局连接池"""
    global _pool

    if _pool:
        _pool.close_all()
        _pool = None
        logger.info("Connection pool closed")
