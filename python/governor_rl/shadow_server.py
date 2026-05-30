# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Shadow Governor: TCP Socket 服务
# Path: python/governor_rl/shadow_server.py
#
# 功能：接收 Node.js 推送的 telemetry，返回 PPO action
# 模式：Shadow Governor - 只观察，不执行
# 兼容性：支持 Windows (TCP) 和 Linux (TCP/Unix Socket)
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import socket
import threading
import argparse
import signal
from typing import Optional, Dict, Any

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# 添加父目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from governor_rl.runtime_governor_platform import GovernorAgent, Config
    import torch
    HAS_TORCH = True
except ImportError as e:
    print(f"[Shadow Server] PyTorch 未安装: {e}")
    print("[Shadow Server] 使用随机策略 fallback")
    HAS_TORCH = False


class ShadowGovernorServer:
    """
    Shadow Governor TCP Socket 服务

    职责：
    1. 接收 Node.js 推送的 10 维 telemetry
    2. PPO 模型推理，返回 action
    3. 不执行任何 Runtime 操作（Shadow 模式）
    """

    def __init__(self, host: str = '127.0.0.1', port: int = 8765):
        self.host = host
        self.port = port
        self.agent = None
        self.device = None
        self.running = False
        self.server_socket = None

        # 统计
        self.stats = {
            'requests_received': 0,
            'predictions_made': 0,
            'errors': 0,
        }

        # 加载模型
        self._load_model()

    def _load_model(self):
        """加载 PPO 模型"""
        if not HAS_TORCH:
            print("[Shadow Server] 使用随机策略")
            return

        try:
            self.device = torch.device("cpu")
            self.agent = GovernorAgent().to(self.device)

            # 尝试加载预训练权重
            model_path = os.path.join(
                os.path.dirname(__file__),
                'checkpoints',
                'runtime_ppo_governor.pt'
            )

            if os.path.exists(model_path):
                self.agent.load_state_dict(torch.load(model_path, map_location=self.device, weights_only=True))
                print(f"[Shadow Server] 加载模型: {model_path}")
            else:
                print("[Shadow Server] 无预训练模型，使用随机初始化")

            self.agent.eval()

        except Exception as e:
            print(f"[Shadow Server] 模型加载失败: {e}")
            self.agent = None

    def predict(self, obs: list) -> Dict[str, Any]:
        """
        PPO 模型推理

        Args:
            obs: 10 维 telemetry 向量

        Returns:
            {
                'action': 0-5,
                'action_name': str,
                'prob': float
            }
        """
        if not self.agent:
            # Fallback: 随机策略
            import random
            action = random.randint(0, 5)
            return {
                'action': action,
                'action_name': self._action_names()[action],
                'prob': 0.17  # 随机策略
            }

        try:
            with torch.no_grad():
                obs_tensor = torch.FloatTensor(obs).unsqueeze(0).to(self.device)
                action, logprob, entropy, value = self.agent.get_action_and_value(obs_tensor)
                prob = torch.exp(logprob).item()

            return {
                'action': action.item(),
                'action_name': self._action_names()[action.item()],
                'prob': prob,
                'value': value.item()
            }

        except Exception as e:
            print(f"[Shadow Server] 推理错误: {e}")
            return {
                'action': 0,
                'action_name': 'no_op',
                'prob': 0.0
            }

    def _action_names(self) -> list:
        """动作名称映射"""
        return [
            'no_op',
            'spawn_agent',
            'pause_background',
            'switch_small_model',
            'reduce_context',
            'enable_gc'
        ]

    def handle_request(self, conn: socket.socket, addr):
        """处理单个连接"""
        buffer = ""

        try:
            while True:
                data = conn.recv(4096)
                if not data:
                    break

                buffer += data.decode('utf-8')

                # 处理所有完整消息
                while '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        # 解析请求
                        request = json.loads(line)
                        self.stats['requests_received'] += 1

                        # PPO 推理
                        obs = request.get('obs', [])
                        result = self.predict(obs)
                        self.stats['predictions_made'] += 1

                        # 构造响应
                        response = {
                            'id': request.get('id'),
                            **result
                        }

                        # 发送响应
                        conn.sendall((json.dumps(response) + '\n').encode('utf-8'))

                    except json.JSONDecodeError as e:
                        error = {'error': 'JSON_PARSE_ERROR', 'message': str(e)}
                        conn.sendall((json.dumps(error) + '\n').encode('utf-8'))
                        self.stats['errors'] += 1

                    except Exception as e:
                        error = {'error': 'RUNTIME_ERROR', 'message': str(e)}
                        conn.sendall((json.dumps(error) + '\n').encode('utf-8'))
                        self.stats['errors'] += 1

        except Exception as e:
            print(f"[Shadow Server] 连接错误 ({addr}): {e}")
            self.stats['errors'] += 1

        finally:
            conn.close()

    def start(self):
        """启动服务"""
        # 设置信号处理器（支持热重载）
        self._setup_signal_handlers()

        self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server_socket.bind((self.host, self.port))
        self.server_socket.listen(5)

        self.running = True
        print(f"[Shadow Server] 启动: {self.host}:{self.port}")
        print(f"[Shadow Server] 等待连接...")

        try:
            while self.running:
                conn, addr = self.server_socket.accept()
                thread = threading.Thread(target=self.handle_request, args=(conn, addr))
                thread.daemon = True
                thread.start()

        except KeyboardInterrupt:
            print("[Shadow Server] 收到停止信号")
        finally:
            self.running = False
            if self.server_socket:
                self.server_socket.close()
            print(f"[Shadow Server] 已停止")
            print(f"[Shadow Server] 统计: {self.stats}")

    def stop(self):
        """停止服务"""
        self.running = False

    def reload_model(self):
        """热重载模型（无需重启服务）"""
        print("[Shadow Server] 收到重载信号，重新加载模型...")
        self._load_model()
        print("[Shadow Server] 模型重载完成")

    def _setup_signal_handlers(self):
        """设置信号处理器（支持热重载）"""
        def handle_sighup(signum, frame):
            print(f"[Shadow Server] 收到 SIGHUP 信号")
            self.reload_model()

        def handle_sigterm(signum, frame):
            print(f"[Shadow Server] 收到 SIGTERM 信号")
            self.stop()

        if hasattr(signal, 'SIGHUP'):
            signal.signal(signal.SIGHUP, handle_sighup)
        signal.signal(signal.SIGTERM, handle_sigterm)


def main():
    parser = argparse.ArgumentParser(description="SoloForge Shadow Governor Server")
    parser.add_argument('--host', default='127.0.0.1', help='监听地址')
    parser.add_argument('--port', type=int, default=8765, help='监听端口')
    args = parser.parse_args()

    server = ShadowGovernorServer(args.host, args.port)
    server.start()


if __name__ == '__main__':
    main()
