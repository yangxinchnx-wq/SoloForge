# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Dataset Balancer
# Path: python/governor_rl/training/dataset_balancer.py
#
# 核心模块：平衡 Action Distribution，强制覆盖完整 Runtime 行为
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import numpy as np
from typing import Dict, List, Optional, Tuple
from collections import Counter
from dataclasses import dataclass

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)


@dataclass
class BalanceStats:
    """平衡统计"""
    total_samples: int
    original_distribution: Dict[int, int]
    target_distribution: Dict[int, float]
    final_distribution: Dict[int, int]
    
    original_entropy: float
    final_entropy: float
    
    samples_removed: int
    samples_duplicated: int
    net_change: int


class DatasetBalancer:
    """
    Dataset Balancer
    
    核心职责：强制平衡 Action Distribution，确保 BC 学会完整行为
    """
    
    # 目标分布（固定）
    TARGET_DIST = {
        -2: 0.15,  # fast shrink
        -1: 0.20,  # slow shrink
         0: 0.30,  # no-op
        +1: 0.20,  # slow expand
        +2: 0.15,  # fast expand
    }
    
    # 最小 entropy 阈值
    MIN_ENTROPY = 1.2
    
    def __init__(self, target_distribution: Dict[int, float] = None):
        self.target_distribution = target_distribution or self.TARGET_DIST
    
    def compute_entropy(self, distribution: Dict[int, int]) -> float:
        """
        计算 action entropy
        
        H(A) = -sum(p(a) * log(p(a)))
        """
        total = sum(distribution.values())
        if total == 0:
            return 0.0
        
        entropy = 0.0
        for action, count in distribution.items():
            if count > 0:
                p = count / total
                entropy -= p * np.log2(p)
        
        return entropy
    
    def analyze_distribution(self, samples: List[Dict]) -> Tuple[Counter, float]:
        """
        分析样本分布
        
        Returns:
            (action_counter, entropy)
        """
        actions = [s["action"] for s in samples]
        counter = Counter(actions)
        entropy = self.compute_entropy(dict(counter))
        return counter, entropy
    
    def balance(
        self,
        samples: List[Dict],
        verbose: bool = True,
    ) -> Tuple[List[Dict], BalanceStats]:
        """
        平衡数据集
        
        Args:
            samples: 原始样本 [{"obs": ..., "action": ...}, ...]
            verbose: 是否打印统计
            
        Returns:
            (平衡后的样本, 平衡统计)
        """
        if not samples:
            return [], BalanceStats(
                total_samples=0,
                original_distribution={},
                target_distribution=self.target_distribution,
                final_distribution={},
                original_entropy=0.0,
                final_entropy=0.0,
                samples_removed=0,
                samples_duplicated=0,
                net_change=0,
            )
        
        # 统计原始分布
        original_counter, original_entropy = self.analyze_distribution(samples)
        total = len(samples)
        
        if verbose:
            print("\n" + "=" * 50)
            print("Dataset Balancing")
            print("=" * 50)
            print(f"原始样本数: {total}")
            print(f"原始分布: {dict(original_counter)}")
            print(f"原始 Entropy: {original_entropy:.3f}")
        
        # 计算目标数量
        target_counts = {}
        for action, target_ratio in self.target_distribution.items():
            target_counts[action] = int(total * target_ratio)
        
        # 调整以确保总数不变
        diff = total - sum(target_counts.values())
        target_counts[0] += diff  # 给 no-op
        
        if verbose:
            print(f"\n目标分布: {target_counts}")
            print(f"目标 Entropy: {self.compute_entropy(target_counts):.3f}")
        
        # 分桶
        buckets = {action: [] for action in [-2, -1, 0, 1, 2]}
        for sample in samples:
            action = sample["action"]
            if action in buckets:
                buckets[action].append(sample)
        
        # 平衡
        balanced = []
        samples_removed = 0
        samples_duplicated = 0
        
        for action, target in target_counts.items():
            current = buckets.get(action, [])
            current_count = len(current)
            
            if current_count == 0:
                if verbose:
                    print(f"\n⚠️ 警告: 没有 action={action} 的样本!")
                continue
            
            if current_count > target:
                # 下采样
                keep_indices = np.random.choice(current_count, target, replace=False)
                balanced.extend([current[i] for i in keep_indices])
                samples_removed += current_count - target
            elif current_count < target:
                # 上采样（复制）
                repeat_times = (target + current_count - 1) // current_count
                oversample = []
                for _ in range(repeat_times):
                    oversample.extend(current)
                balanced.extend(oversample[:target])
                samples_duplicated += target - current_count
            else:
                # 正好
                balanced.extend(current)
        
        # 打乱顺序
        np.random.shuffle(balanced)
        
        # 统计最终分布
        final_counter, final_entropy = self.analyze_distribution(balanced)
        
        stats = BalanceStats(
            total_samples=total,
            original_distribution=dict(original_counter),
            target_distribution=self.target_distribution,
            final_distribution=dict(final_counter),
            original_entropy=original_entropy,
            final_entropy=final_entropy,
            samples_removed=samples_removed,
            samples_duplicated=samples_duplicated,
            net_change=len(balanced) - total,
        )
        
        if verbose:
            print(f"\n最终样本数: {len(balanced)}")
            print(f"最终分布: {dict(final_counter)}")
            print(f"最终 Entropy: {final_entropy:.3f}")
            print(f"移除: {samples_removed}, 复制: {samples_duplicated}")
            
            # 评估
            print("\n" + "-" * 50)
            if final_entropy >= self.MIN_ENTROPY:
                print(f"✅ Entropy 达标 ({final_entropy:.3f} >= {self.MIN_ENTROPY})")
            else:
                print(f"❌ Entropy 未达标 ({final_entropy:.3f} < {self.MIN_ENTROPY})")
        
        return balanced, stats
    
    def validate(self, samples: List[Dict]) -> Dict[str, any]:
        """
        验证数据集质量
        
        Returns:
            验证报告
        """
        if not samples:
            return {"valid": False, "reason": "Empty dataset"}
        
        counter, entropy = self.analyze_distribution(samples)
        total = len(samples)
        
        # 计算每个动作的比例
        ratios = {action: counter.get(action, 0) / total for action in [-2, -1, 0, 1, 2]}
        
        # 评估
        valid = True
        issues = []
        
        if entropy < self.MIN_ENTROPY:
            valid = False
            issues.append(f"Entropy 太低: {entropy:.3f} < {self.MIN_ENTROPY}")
        
        # 检查是否有缺失的动作
        missing_actions = [a for a in [-2, -1, 0, 1, 2] if counter.get(a, 0) == 0]
        if missing_actions:
            valid = False
            issues.append(f"缺失动作: {missing_actions}")
        
        # 检查固定动作比例
        dominant_ratio = max(ratios.values())
        if dominant_ratio > 0.5:
            issues.append(f"主导动作比例过高: {dominant_ratio:.1%}")
        
        return {
            "valid": valid,
            "issues": issues,
            "entropy": entropy,
            "total_samples": total,
            "distribution": dict(counter),
            "ratios": ratios,
        }


def load_timeline_as_samples(timeline_path: str) -> List[Dict]:
    """
    从时间线文件加载样本
    
    Args:
        timeline_path: 时间线 JSONL 文件路径
        
    Returns:
        样本列表 [{"obs": ..., "action": ...}, ...]
    """
    samples = []
    
    with open(timeline_path, 'r', encoding='utf-8') as f:
        for line in f:
            data = json.loads(line.strip())
            
            # 跳过 metadata
            if data.get("type") == "metadata":
                continue
            
            # 解析 observation
            obs = np.array([
                data.get("queue_depth", 0) / 1000.0,
                0.0,  # velocity
                0.0,  # acceleration
                data.get("worker_count", 0) / 200.0,
                data.get("cpu_usage", 0.0),
                data.get("precursor_score", 0.0),
                data.get("precursor_score", 0.0),  # risk_score
                data.get("oscillation_score", 0.0),
                0.5,  # regime_id
            ], dtype=np.float32)
            
            # 解析 action
            action_type = data.get("action_type", "no_op")
            action_to_delta = {
                "spawn_worker": 1,
                "spawn_workers": 2,
                "reduce_workers": -1,
                "reduce_workers_batch": -2,
                "no_op": 0,
                "enable_reflection": 0,
                "disable_reflection": 0,
            }
            action = action_to_delta.get(action_type, 0)
            
            samples.append({
                "obs": obs.tolist(),
                "action": action,
                "tick": data.get("tick", 0),
                "scenario": data.get("scenario_name", ""),
            })
    
    return samples


def load_multiple_timelines(directory: str) -> List[Dict]:
    """
    从目录加载多个时间线文件
    """
    samples = []
    
    if not os.path.exists(directory):
        return samples
    
    for filename in os.listdir(directory):
        if filename.endswith('.jsonl'):
            filepath = os.path.join(directory, filename)
            try:
                file_samples = load_timeline_as_samples(filepath)
                samples.extend(file_samples)
                print(f"  加载: {filename} ({len(file_samples)} samples)")
            except Exception as e:
                print(f"  跳过 {filename}: {e}")
    
    return samples


def main():
    """主函数：演示数据平衡"""
    print("=" * 60)
    print("Dataset Balancer Demo")
    print("=" * 60)
    
    # 模拟不平衡数据
    print("\n模拟不平衡数据（90% 是 no-op）...")
    unbalanced = []
    for _ in range(900):
        unbalanced.append({"obs": [0.1] * 9, "action": 0})
    for _ in range(100):
        unbalanced.append({"obs": [0.1] * 9, "action": 1})
    
    print(f"原始样本数: {len(unbalanced)}")
    counter = Counter([s["action"] for s in unbalanced])
    print(f"原始分布: {dict(counter)}")
    
    # 平衡
    balancer = DatasetBalancer()
    balanced, stats = balancer.balance(unbalanced, verbose=True)
    
    # 验证
    print("\n验证结果:")
    report = balancer.validate(balanced)
    print(f"  Valid: {report['valid']}")
    print(f"  Entropy: {report['entropy']:.3f}")
    print(f"  Distribution: {report['distribution']}")


if __name__ == "__main__":
    main()
