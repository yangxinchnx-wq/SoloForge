# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge MARL Service: MAPPO 资源调度服务
# Path: python/marl_service/server.py
#
# 统一协议：兼容两种请求格式
#   格式A (mappo-client.ts): {id, globalState, localObs}
#   格式B (独立调用): {_id, state, obs, episode_count}
# ─────────────────────────────────────────────────────────────────

import sys
import json
import os

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# 添加父目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 导入 MAPPO 网络
from marl_service.mappo_net import MAPPOPolicy, create_default_policy

print("[MAPPO] SoloForge MARL 服务启动中...")


class MARLGovernorService:
    """
    MARL 资源调度服务

    使用 MAPPO (Multi-Agent PPO) 强化学习进行资源调度决策
    """

    def __init__(self):
        self.policy = create_default_policy()
        self.episode_count = 0

        # 查找模型文件
        model_path = os.path.join(
            os.path.dirname(__file__),
            'models',
            'policy.pt'
        )

        if os.path.exists(model_path):
            try:
                self.policy.load_model(model_path)
                print(f"[MAPPO] ✓ 加载预训练模型: {model_path}")
            except Exception as e:
                print(f"[MAPPO] ⚠ 模型加载失败，使用随机初始化: {e}")
        else:
            print("[MAPPO] ⚠ 无预训练模型，使用随机初始化权重")

    def evaluate(
        self,
        global_state: list,
        local_obs: list,
        use_neural: bool = True
    ) -> dict:
        """
        评估状态并做出决策

        Args:
            global_state: 全局状态向量 [CPU, Memory, Latency, Token, Agents, Tools, ...]
            local_obs: 本地观察向量
            use_neural: 是否使用神经网络（False 则用启发式）

        Returns:
            决策结果
        """
        if not use_neural:
            return self._heuristic_fallback(global_state)

        try:
            action, action_prob, state_value = self.policy.evaluate(
                global_state,
                local_obs
            )

            action_names = ['NO_OP', 'PERFORMANCE_MODE', 'CIRCUIT_BREAKER']

            return {
                'action': int(action),
                'mode': 'NEURAL_NETWORK_MAPPO_ACTIVE',
                'reason': f'action_prob={action_prob:.3f}, state_value={state_value:.3f}',
                'action_name': action_names[action],
                'prob': float(action_prob),
                'value': float(state_value),
            }

        except Exception as e:
            print(f"[MAPPO] ⚠ 推理错误，回退到启发式: {e}")
            return self._heuristic_fallback(global_state)

    def _heuristic_fallback(self, global_state: list) -> dict:
        """
        启发式 fallback（安全保证）

        宪法级安全规则：
        1. CPU > 95% → 立即熔断
        2. CPU > 85% → 降级
        3. 其他 → 正常运行
        """
        if not global_state or len(global_state) == 0:
            return {
                'action': 0,
                'mode': 'HEURISTIC_FALLBACK',
                'reason': 'EMPTY_STATE_MATRIX'
            }

        cpu_load = global_state[0]  # 约定：索引0为CPU负载

        if cpu_load > 0.95:
            return {
                'action': 2,
                'mode': 'HEURISTIC_CIRCUIT_BREAKER',
                'reason': f'CPU_CRITICAL ({cpu_load:.1%})'
            }

        if cpu_load > 0.85:
            return {
                'action': 1,
                'mode': 'HEURISTIC_PERFORMANCE_REDUCTION',
                'reason': f'CPU_WARNING ({cpu_load:.1%})'
            }

        return {
            'action': 0,
            'mode': 'HEURISTIC_STEADY_STATE',
            'reason': f'NOMINAL ({cpu_load:.1%})'
        }

    def record_episode(self) -> None:
        """记录一个 episode（用于训练数据收集）"""
        self.episode_count += 1

    def should_use_neural(self) -> bool:
        """
        判断是否应该使用神经网络

        策略：
        - 冷启动阶段（< 10000 episodes）使用启发式 + 探索
        - 之后根据策略选择（ε-greedy）
        """
        if self.episode_count < 10000:
            return False

        # ε-greedy: 10% 概率随机探索
        import random
        return random.random() > 0.1


def parse_packet(packet: dict) -> tuple:
    """
    统一解析两种协议格式
    返回: (packet_id, global_state, local_obs, episode_count)
    """
    # 格式A: mappo-client.ts 发送
    # {id, globalState, localObs}
    packet_id = packet.get('id')
    global_state = packet.get('globalState', [])
    local_obs = packet.get('localObs', [])
    episode_count = packet.get('episode_count', 0)

    # 格式B: 独立调用
    # {_id, state, obs, episode_count}
    if packet_id is None:
        packet_id = packet.get('_id')
    if not global_state:
        global_state = packet.get('state', [])
    if not local_obs:
        local_obs = packet.get('obs', [])
    if episode_count == 0:
        episode_count = packet.get('episode_count', 0)

    return packet_id, global_state, local_obs, episode_count


def main():
    """主循环"""
    # 强制将标准输出切换为无缓冲流
    sys.stdout.reconfigure(line_buffering=True)

    print("[MAPPO] ✓ 服务就绪，等待请求...")

    service = MARLGovernorService()

    # 锁定标准输入流进行行阻塞轮询
    for line in sys.stdin:
        try:
            line = line.strip()
            if not line:
                continue

            packet = json.loads(line)

            # 统一解析
            packet_id, global_state, local_obs, episode_count = parse_packet(packet)

            # 判断使用哪种模式
            use_neural = service.should_use_neural()
            service.episode_count = episode_count

            # 执行评估
            result = service.evaluate(global_state, local_obs, use_neural)

            # 注入 packet_id
            result['id'] = packet_id

            # 发送响应
            sys.stdout.write(json.dumps(result) + '\n')
            sys.stdout.flush()

        except json.JSONDecodeError as e:
            error = {
                'error': 'JSON_PARSE_ERROR',
                'message': str(e)
            }
            sys.stderr.write(json.dumps(error) + '\n')
            sys.stderr.flush()

        except Exception as e:
            error = {
                'error': 'RUNTIME_ERROR',
                'message': str(e)
            }
            sys.stderr.write(json.dumps(error) + '\n')
            sys.stderr.flush()


if __name__ == '__main__':
    main()
