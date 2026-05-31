# python/marl_service/server_optimized.py
# 优化版: MessagePack + 批量处理 + 模型预热
import os
import sys
import logging
import asyncio
import threading
from typing import Dict, Any, List, Optional

# Fix Windows encoding
if sys.platform == 'win32':
    os.environ['PYTHONIOENCODING'] = 'utf-8'
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

import msgpack

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("MarlServer")

# 端口配置
HOST = "127.0.0.1"
PORT = 18765


class MAPPOGovernor:
    """
    简化的 MAPPO 资源控流决策器

    支持: 单请求 + 批量请求
    """

    def __init__(self):
        self._lock = threading.Lock()
        logger.info("MAPPO Governor initialized")

    def evaluate(self, global_state: List[float], local_obs: List[float]) -> int:
        """评估单个请求"""
        cpu = global_state[0] if global_state else 0.0

        # 熔断逻辑
        if cpu > 0.95:
            return 2  # 硬熔断
        elif cpu > 0.70:
            return 1  # 性能降级
        return 0  # 正常

    def evaluate_batch(self, requests: List[Dict]) -> List[int]:
        """批量评估"""
        with self._lock:
            return [
                self.evaluate(req.get("globalState", []), req.get("localObs", []))
                for req in requests
            ]


class OptimizedServer:
    """优化版 IPC 服务器: MessagePack + 批量处理"""

    def __init__(self):
        self.governor = MAPPOGovernor()
        self.running = False
        logger.info(f"Server initialized, will bind to {HOST}:{PORT}")

    async def handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        """处理客户端连接"""
        addr = writer.get_extra_info('peername')
        logger.info(f"Client connected: {addr}")

        connection = IPCConnectionOptimized(reader, writer)

        try:
            while self.running:
                # 接收消息
                msg = await connection.recv()
                if msg is None:
                    break

                # 处理请求
                response = self.process_message(msg)

                # 发送响应
                await connection.send(response)

        except Exception as e:
            logger.error(f"Error handling client {addr}: {e}")
        finally:
            writer.close()
            await writer.wait_closed()
            logger.info(f"Client disconnected: {addr}")

    def process_message(self, msg: Dict[str, Any]) -> Dict[str, Any]:
        """处理消息，支持批量请求"""
        msg_id = msg.get("id", "")

        # 批量请求
        if "batch" in msg:
            requests = msg["batch"]
            results = self.governor.evaluate_batch(requests)
            return {
                "id": msg_id,
                "results": results,
            }

        # 单个请求
        global_state = msg.get("globalState", [])
        local_obs = msg.get("localObs", [])
        action = self.governor.evaluate(global_state, local_obs)

        return {
            "id": msg_id,
            "action": action,
        }

    async def start(self):
        """启动服务器"""
        self.running = True
        server = await asyncio.start_server(
            self.handle_client, HOST, PORT
        )

        addr = server.sockets[0].getsockname()
        logger.info(f"Server started on {addr}")

        async with server:
            await server.serve_forever()


class IPCConnectionOptimized:
    """优化的 IPC 连接，处理粘包"""

    HEADER_SIZE = 4

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self._recv_buffer = b""

    async def recv(self) -> Optional[Dict[str, Any]]:
        """接收消息"""
        # 读取长度头
        header = await self.reader.read(self.HEADER_SIZE)
        if len(header) < self.HEADER_SIZE:
            return None

        length = int.from_bytes(header, 'big')

        # 读取数据
        data = b""
        while len(data) < length:
            chunk = await self.reader.read(length - len(data))
            if not chunk:
                return None
            data += chunk

        # 解码
        return msgpack.unpackb(data, raw=False)

    async def send(self, data: Dict[str, Any]) -> None:
        """发送消息"""
        # 编码
        msg_bytes = msgpack.packb(data, use_bin_type=True)

        # 发送长度头 + 数据
        header = len(msg_bytes).to_bytes(self.HEADER_SIZE, 'big')
        self.writer.write(header + msg_bytes)
        await self.writer.drain()


async def warmup_governor(governor: MAPPOGovernor):
    """预热模型"""
    logger.info("Warming up MAPPO Governor...")

    warmup_states = [
        ([0.1, 0.2, 0.2], [0.0, 0.0]),
        ([0.5, 0.3, 0.3], [0.0, 0.0]),
        ([0.8, 0.5, 0.4], [0.0, 0.0]),
    ]

    for state, obs in warmup_states:
        governor.evaluate(state, obs)

    logger.info("MAPPO Governor warmed up")


async def main():
    server = OptimizedServer()

    # 预热
    await warmup_governor(server.governor)

    # 启动服务
    await server.start()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped")
