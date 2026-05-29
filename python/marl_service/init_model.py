# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge MAPPO: 模型初始化脚本
# Path: python/marl_service/init_model.py
#
# 运行此脚本生成默认策略模型
# ─────────────────────────────────────────────────────────────────

import sys
import os

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# 添加父目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from marl_service.mappo_net import create_default_policy

def main():
    print("=== SoloForge MAPPO 模型初始化 ===")

    # 创建默认策略
    policy = create_default_policy()

    # 保存模型
    script_dir = os.path.dirname(os.path.abspath(__file__))
    models_dir = os.path.join(script_dir, 'models')
    os.makedirs(models_dir, exist_ok=True)

    model_path = os.path.join(models_dir, 'policy.pt')
    policy.save_model(model_path)

    print(f"✅ 默认模型已保存: {model_path}")

    # 测试推理
    print("\n=== 测试推理 ===")

    test_cases = [
        # (global_state, local_obs, description)
        ([0.3, 0.4, 50, 1000, 5, 10, 0.1, 0.2], [0.1, 0.2, 0.3, 0.4], "低负载"),
        ([0.7, 0.8, 200, 8000, 20, 30, 0.5, 0.6], [0.4, 0.5, 0.6, 0.7], "中等负载"),
        ([0.96, 0.95, 500, 10000, 50, 80, 0.9, 0.95], [0.8, 0.9, 0.95, 1.0], "高负载(熔断)"),
    ]

    for global_state, local_obs, desc in test_cases:
        action, prob, value = policy.evaluate(global_state, local_obs)
        action_names = ['NO_OP', 'PERFORMANCE_MODE', 'CIRCUIT_BREAKER']
        print(f"{desc}: action={action_names[action]}({action}), prob={prob:.3f}, value={value:.3f}")

if __name__ == '__main__':
    main()
