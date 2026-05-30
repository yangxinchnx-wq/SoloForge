# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge IPC Protocol: MessagePack 协议封装
# Path: python/marl_service/ipc/protocol.py
#
# 消息格式: [4字节长度header][msgpack数据]
# ─────────────────────────────────────────────────────────────────

import struct
import logging

logger = logging.getLogger(__name__)

# 长度头格式: 4字节无符号大端序整数
HEADER_FORMAT = '!I'
HEADER_SIZE = 4


class MsgPackProtocol:
    """
    MessagePack 协议处理器

    封装:
    - 消息打包 (Python dict → bytes)
    - 消息解包 (bytes → Python dict)
    - 粘包处理 (长度前缀协议)
    """

    @staticmethod
    def pack(data: dict) -> bytes:
        """
        打包消息

        Args:
            data: 待发送的字典数据

        Returns:
            [4字节长度][msgpack数据]
        """
        import msgpack

        # 序列化
        msg_bytes = msgpack.packb(data, use_bin_type=True)

        # 添加长度头
        length = len(msg_bytes)
        header = struct.pack(HEADER_FORMAT, length)

        return header + msg_bytes

    @staticmethod
    def unpack(data: bytes) -> dict:
        """
        解包消息

        Args:
            data: 包含长度头的 msgpack 数据

        Returns:
            解压后的字典
        """
        import msgpack

        return msgpack.unpackb(data, raw=False)

    @staticmethod
    def unpack_partial(buffer: bytes) -> tuple:
        """
        从缓冲区解析一条完整消息

        Args:
            buffer: 累积的字节缓冲区

        Returns:
            (完整消息或None, 剩余缓冲区)
        """
        if len(buffer) < HEADER_SIZE:
            return None, buffer

        # 解析长度头
        length, = struct.unpack(HEADER_FORMAT, buffer[:HEADER_SIZE])
        total_length = HEADER_SIZE + length

        if len(buffer) < total_length:
            # 数据不完整
            return None, buffer

        # 提取消息体
        msg_bytes = buffer[HEADER_SIZE:total_length]
        msg = MsgPackProtocol.unpack(msg_bytes)

        # 返回消息和剩余数据
        return msg, buffer[total_length:]


class IPCConnection:
    """
    IPC 连接封装

    处理读写逻辑，支持粘包
    """

    def __init__(self, sock):
        self.sock = sock
        self.sock.settimeout(30.0)  # 30秒读超时
        self._recv_buffer = b''

    def send(self, data: dict) -> bool:
        """
        发送消息

        Args:
            data: 待发送的字典

        Returns:
            是否成功
        """
        try:
            packet = MsgPackProtocol.pack(data)
            self.sock.sendall(packet)
            return True
        except Exception as e:
            logger.error(f"[IPC] 发送失败: {e}")
            return False

    def recv(self) -> dict | None:
        """
        接收消息（阻塞）

        Returns:
            接收到的字典，连接关闭则返回 None
        """
        try:
            while True:
                # 尝试从缓冲区解析
                msg, self._recv_buffer = MsgPackProtocol.unpack_partial(self._recv_buffer)
                if msg is not None:
                    return msg

                # 缓冲区数据不完整，接收更多
                chunk = self.sock.recv(4096)
                if not chunk:
                    # 连接关闭
                    return None

                self._recv_buffer += chunk

        except socket.timeout:
            return None
        except Exception as e:
            logger.error(f"[IPC] 接收失败: {e}")
            return None

    def close(self) -> None:
        """关闭连接"""
        try:
            self.sock.close()
        except Exception:
            pass
