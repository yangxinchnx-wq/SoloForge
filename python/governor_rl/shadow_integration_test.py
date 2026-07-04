# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Shadow Governor: 集成测试
# Path: python/governor_rl/shadow_integration_test.py
#
# 测试 TCP Socket 通信和 PPO 推理
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import time
import threading
import socket
import unittest

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from governor_rl.shadow_server import ShadowGovernorServer


class TestShadowGovernor(unittest.TestCase):
    """Shadow Governor 集成测试"""

    @classmethod
    def setUpClass(cls):
        """启动 Shadow Server"""
        cls.host = '127.0.0.1'
        cls.port = 18766  # 本地测试端口（避免与 8765 冲突）
        cls.server = ShadowGovernorServer(cls.host, cls.port)
        cls.server_thread = threading.Thread(target=cls.server.start)
        cls.server_thread.daemon = True
        cls.server_thread.start()
        time.sleep(0.5)  # 等待服务启动

    @classmethod
    def tearDownClass(cls):
        """停止 Shadow Server"""
        cls.server.stop()

    def test_socket_connection(self):
        """测试 socket 连接"""
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.settimeout(5.0)
        try:
            client.connect((self.host, self.port))
            connected = True
        except Exception as e:
            print(f"连接失败: {e}")
            connected = False
        finally:
            client.close()

        self.assertTrue(connected, "应该能够连接到 Shadow Server")

    def test_prediction_request(self):
        """测试预测请求"""
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.settimeout(5.0)

        try:
            client.connect((self.host, self.port))

            # 发送请求
            request = {
                'id': 'test_001',
                'obs': [0.5, 0.3, 0.2, 0.1, 0.4, 0.15, 0.2, 0.0, 0.0, 0.3]
            }
            client.sendall((json.dumps(request) + '\n').encode('utf-8'))

            # 接收响应
            response_data = b''
            while True:
                chunk = client.recv(4096)
                if not chunk:
                    break
                response_data += chunk
                if b'\n' in chunk:
                    break

            response = json.loads(response_data.decode('utf-8').strip())

            # 验证响应
            self.assertEqual(response['id'], 'test_001')
            self.assertIn('action', response)
            self.assertIn('action_name', response)
            self.assertIn('prob', response)
            self.assertGreaterEqual(response['action'], 0)
            self.assertLess(response['action'], 6)

            print(f"预测成功: action={response['action_name']}, prob={response['prob']:.3f}")

        finally:
            client.close()

    def test_batch_predictions(self):
        """测试批量预测"""
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.settimeout(10.0)

        try:
            client.connect((self.host, self.port))

            results = []
            for i in range(5):
                request = {
                    'id': f'batch_{i}',
                    'obs': [0.1 * i, 0.2 * i, 0.3 * i, 0.1, 0.4, 0.1, 0.2, 0.0, 0.0, 0.3]
                }
                client.sendall((json.dumps(request) + '\n').encode('utf-8'))

            # 接收所有响应
            responses = []
            while len(responses) < 5:
                chunk = client.recv(4096)
                if not chunk:
                    break
                lines = chunk.decode('utf-8').split('\n')
                for line in lines:
                    if line.strip():
                        try:
                            responses.append(json.loads(line.strip()))
                        except:
                            pass

            self.assertEqual(len(responses), 5)
            print(f"批量预测成功: {len(responses)} 个请求")

        finally:
            client.close()

    def test_invalid_request(self):
        """测试无效请求"""
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.settimeout(5.0)

        try:
            client.connect((self.host, self.port))

            # 发送无效 JSON
            client.sendall(b'invalid json\n')

            # 接收错误响应
            chunk = client.recv(4096)
            response = json.loads(chunk.decode('utf-8').strip())

            self.assertIn('error', response)
            print(f"错误处理正确: {response['error']}")

        finally:
            client.close()


def main():
    print("=" * 60)
    print("SoloForge Shadow Governor 集成测试")
    print("=" * 60)

    unittest.main(verbosity=2)


if __name__ == '__main__':
    main()
