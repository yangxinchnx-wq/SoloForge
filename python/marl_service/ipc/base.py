# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge IPC Base: 跨平台 Socket 通信抽象层
# Path: python/marl_service/ipc/base.py
#
# 支持:
#   - Unix Domain Socket (Linux/Mac)
#   - Named Pipe (Windows)
# ─────────────────────────────────────────────────────────────────

import os
import sys
import socket
import struct
import logging

logger = logging.getLogger(__name__)


class IPCServer:
    """
    跨平台 IPC 服务端

    使用 Unix Domain Socket (Unix) 或 Named Pipe (Windows)
    """

    SOCKET_NAME = "soloforge_mappo"

    def __init__(self):
        self.socket_path = self._get_socket_path()
        self.server = None
        self._cleanup_socket()

    def _get_socket_path(self) -> str:
        """获取套接字路径"""
        if sys.platform == 'win32':
            # Windows Named Pipe
            return f"\\\\.\\pipe\\{self.SOCKET_NAME}"
        else:
            # Unix Domain Socket
            return f"/tmp/{self.SOCKET_NAME}.sock"

    def _cleanup_socket(self) -> None:
        """清理已存在的套接字"""
        if sys.platform == 'win32':
            # Windows: Named Pipe 不需要清理
            pass
        else:
            # Unix: 删除旧的 socket 文件
            if os.path.exists(self.socket_path):
                try:
                    os.unlink(self.socket_path)
                    logger.info(f"清理旧套接字: {self.socket_path}")
                except OSError:
                    pass

    def start(self) -> None:
        """启动服务"""
        self._cleanup_socket()

        if sys.platform == 'win32':
            # Windows Named Pipe 模式 - 使用 TCP 回退
            # Windows 上使用 localhost TCP 模拟
            self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.server.bind(('127.0.0.1', 18765))
            logger.info(f"[IPC] Windows 模式: TCP 监听 127.0.0.1:18765")
        else:
            # Unix Domain Socket
            self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.server.bind(self.socket_path)
            os.chmod(self.socket_path, 0o600)  # 仅所有者可访问
            logger.info(f"[IPC] Unix 模式: UDS 监听 {self.socket_path}")

        self.server.listen(5)
        self.server.settimeout(1.0)  # 1秒超时，支持优雅退出

    def accept(self):
        """接受连接"""
        try:
            return self.server.accept()
        except socket.timeout:
            return None

    def close(self) -> None:
        """关闭服务"""
        if self.server:
            try:
                self.server.close()
            except Exception:
                pass
        self._cleanup_socket()

    @property
    def is_windows(self) -> bool:
        return sys.platform == 'win32'
