# -*- coding: utf-8 -*-
# 完整训练 Pipeline：收集 → 平衡 → BC 训练
import sys
import os
import json
import numpy as np
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.training.dataset_balancer import DatasetBalancer


def analyze_and_balance(input_path, output_path):
    """分析并平衡数据"""
    print("=" * 60)
    print("Dataset Balance Pipeline")
    print("=" * 60)
    
    # 加载样本
    print(f"\n[1] 加载数据: {input_path}")
    samples = []
    with open(input_path, 'r', encoding='utf-8') as f:
        for line in f:
            data = json.loads(line.strip())
            samples.append({
                "obs": [
                    data.get("queue_depth", 0) / 1000.0,
                    0.0, 0.0,
                    data.get("worker_count", 0) / 200.0,
                    data.get("cpu_usage", 0.0),
                    0.0, 0.0,
                    data.get("oscillation_score", 0.0),
                    0.5,
                ],
                "action": data.get("action_delta", 0),
                "scenario": data.get("scenario_name", ""),
            })
    
    print(f"    加载了 {len(samples):,} 个样本")
    
    # 分析原始分布
    counter = Counter([s["action"] for s in samples])
    total = len(samples)
    
    print(f"\n[2] 原始分布:")
    for action in [-2, -1, 0, 1, 2]:
        count = counter.get(action, 0)
        print(f"    action={action:+d}: {count:>6,} ({count/total*100:>5.1f}%)")
    
    # 计算 entropy
    entropy = 0
    for action in [-2, -1, 0, 1, 2]:
        count = counter.get(action, 0)
        if count > 0:
            p = count / total
            entropy -= p * np.log2(p)
    print(f"\n    Entropy: {entropy:.3f}")
    
    # 平衡
    print(f"\n[3] 执行平衡...")
    balancer = DatasetBalancer()
    balanced, stats = balancer.balance(samples, verbose=True)
    
    # 保存平衡后数据
    print(f"\n[4] 保存平衡数据: {output_path}")
    with open(output_path, 'w', encoding='utf-8') as f:
        for sample in balanced:
            f.write(json.dumps(sample, ensure_ascii=False) + '\n')
    
    print(f"    保存了 {len(balanced):,} 个样本")
    
    return balanced, stats


if __name__ == "__main__":
    input_path = "datasets/trajectories/demo_20260530_012640.jsonl"
    output_path = "datasets/balanced/bc_training_data.jsonl"
    
    os.makedirs("datasets/balanced", exist_ok=True)
    
    balanced, stats = analyze_and_balance(input_path, output_path)
    
    print("\n" + "=" * 60)
    print("完成!")
    print("=" * 60)
