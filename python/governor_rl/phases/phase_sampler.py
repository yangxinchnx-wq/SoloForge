# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Phase-Aware Sampler
# Path: python/governor_rl/phases/phase_sampler.py
#
# 核心职责：按 Runtime Dynamics 采样，而非随机采样
# 保留所有 Transition 数据，下采样稳定状态
# ─────────────────────────────────────────────────────────────────

import numpy as np
from typing import List, Dict, Tuple, Optional
from collections import Counter
from dataclasses import dataclass

from .runtime_phase import RuntimePhase, get_phase_name
from .transition_detector import TransitionDetector, PhaseFeatures


# Phase 采样概率（冻结）
# stable: 极低价值，大量冗余 no-op，必须下采样
# expanding/shrinking/precursor/recovery/saturated: 高价值，必须全保留
# oscillating: 中等价值
PHASE_KEEP_PROBS = {
    RuntimePhase.STABLE: 0.02,       # 只保留 2%
    RuntimePhase.EXPANDING: 1.0,       # 全保留
    RuntimePhase.SHRINKING: 1.0,       # 全保留
    RuntimePhase.PRECURSOR: 1.0,       # 全保留（Decision Boundary）
    RuntimePhase.RECOVERY: 1.0,         # 全保留
    RuntimePhase.OSCILLATING: 0.8,     # 高保留
    RuntimePhase.SATURATED: 1.0,       # 全保留
}


@dataclass
class PhaseStats:
    """Phase 统计"""
    phase: RuntimePhase
    original_count: int
    sampled_count: int
    keep_prob: float


@dataclass
class SamplingResult:
    """采样结果"""
    samples: List[Dict]
    phase_distribution: Dict[str, int]
    phase_entropy: float
    action_distribution: Dict[int, int]
    action_entropy: float
    stats: List[PhaseStats]


class PhaseAwareSampler:
    """
    Phase-Aware Sampler
    
    核心思想：不是随机采样 tick，而是按 Runtime Dynamics 采样
    - 保留所有 Transition 数据（高价值）
    - 下采样稳定状态（低价值）
    
    这是解决"BC 学到的是 no-op"的根本方案
    """
    
    def __init__(self, random_seed: int = None):
        self.detector = TransitionDetector()
        if random_seed is not None:
            np.random.seed(random_seed)
    
    def sample(
        self,
        timeline: List[Dict],
        verbose: bool = True,
    ) -> SamplingResult:
        """
        Phase-Aware 采样
        
        Args:
            timeline: 时间线数据，每项包含:
                - queue_depth
                - worker_count
                - action_delta
                - oscillation_score
                - precursor_score
                - cpu_usage
                
        Returns:
            SamplingResult
        """
        if not timeline:
            return SamplingResult(
                samples=[],
                phase_distribution={},
                phase_entropy=0.0,
                action_distribution={},
                action_entropy=0.0,
                stats=[],
            )
        
        # Phase 检测
        phases: List[RuntimePhase] = []
        features_list: List[PhaseFeatures] = []
        
        self.detector.reset()
        
        for entry in timeline:
            phase = self.detector.update(
                queue_depth=entry.get("queue_depth", 0),
                precursor_score=entry.get("precursor_score", 0.0),
                oscillation_score=entry.get("oscillation_score", 0.0),
                worker_count=entry.get("worker_count", 0),
                action_delta=entry.get("action_delta", 0),
                cpu_usage=entry.get("cpu_usage", 0.0),
            )
            phases.append(phase)
        
        # Phase 分布统计
        phase_counter = Counter(phases)
        
        if verbose:
            print("\n" + "=" * 50)
            print("Phase-Aware Sampling")
            print("=" * 50)
            print(f"原始样本数: {len(timeline)}")
            print("\n原始 Phase 分布:")
            for phase in RuntimePhase:
                count = phase_counter.get(phase, 0)
                ratio = count / len(phases) if len(phases) > 0 else 0
                print(f"  {get_phase_name(phase):<12}: {count:>6,} ({ratio:>6.1%})")
        
        # Phase-Aware 采样
        sampled = []
        phase_stats = []
        
        for i, (entry, phase) in enumerate(zip(timeline, phases)):
            keep_prob = PHASE_KEEP_PROBS.get(phase, 1.0)
            
            if np.random.random() < keep_prob:
                # 添加 phase 信息到样本
                sample = entry.copy()
                sample["phase"] = phase.value
                sample["phase_name"] = get_phase_name(phase)
                sampled.append(sample)
            
            # 记录统计
            if i == 0 or phases[i] != phases[i-1]:
                phase_stats.append(PhaseStats(
                    phase=phase,
                    original_count=phase_counter.get(phase, 0),
                    sampled_count=0,
                    keep_prob=keep_prob,
                ))
        
        # 重新统计采样后分布
        sampled_phases = [s["phase"] for s in sampled]
        sampled_phase_counter = Counter(sampled_phases)
        
        # 更新统计中的 sampled_count
        for stat in phase_stats:
            stat.sampled_count = sampled_phase_counter.get(stat.phase.value, 0)
        
        # 采样后分布
        sampled_distribution = {
            get_phase_name(RuntimePhase(p)): c 
            for p, c in sampled_phase_counter.items()
        }
        
        # 计算 Phase Entropy
        phase_entropy = self._compute_entropy(
            {get_phase_name(RuntimePhase(k)): v for k, v in sampled_phase_counter.items()},
            len(sampled)
        )
        
        # Action 分布
        action_counter = Counter(s["action_delta"] for s in sampled)
        action_distribution = dict(action_counter)
        
        # Action Entropy
        action_entropy = self._compute_entropy(action_distribution, len(sampled))
        
        if verbose:
            print("\n采样后分布:")
            for phase in RuntimePhase:
                count = sampled_phase_counter.get(phase.value, 0)
                ratio = count / len(sampled) if len(sampled) > 0 else 0
                print(f"  {get_phase_name(phase):<12}: {count:>6,} ({ratio:>6.1%})")
            
            print(f"\n采样后样本数: {len(sampled)}")
            print(f"Phase Entropy: {phase_entropy:.3f}")
            print(f"Action Entropy: {action_entropy:.3f}")
        
        return SamplingResult(
            samples=sampled,
            phase_distribution=sampled_distribution,
            phase_entropy=phase_entropy,
            action_distribution=action_distribution,
            action_entropy=action_entropy,
            stats=phase_stats,
        )
    
    def _compute_entropy(self, distribution: Dict, total: int) -> float:
        """计算 entropy"""
        if total == 0:
            return 0.0
        entropy = 0.0
        for key, count in distribution.items():
            if count > 0:
                p = count / total
                entropy -= p * np.log2(p)
        return entropy
    
    def validate(self, result: SamplingResult) -> Dict:
        """
        验证采样结果
        
        Returns:
            验证报告
        """
        valid = True
        issues = []
        
        # 检查 Phase Entropy
        if result.phase_entropy < 1.5:
            issues.append(f"Phase Entropy 太低: {result.phase_entropy:.3f} < 1.5")
            valid = False
        
        # 检查 Action Entropy
        if result.action_entropy < 1.2:
            issues.append(f"Action Entropy 太低: {result.action_entropy:.3f} < 1.2")
            valid = False
        
        # 检查是否保留了足够的 Transition 样本
        transition_phases = [
            RuntimePhase.EXPANDING,
            RuntimePhase.SHRINKING,
            RuntimePhase.PRECURSOR,
            RuntimePhase.RECOVERY,
            RuntimePhase.SATURATED,
        ]
        transition_count = sum(
            result.phase_distribution.get(get_phase_name(p), 0)
            for p in transition_phases
        )
        
        if transition_count < 100:
            issues.append(f"Transition 样本太少: {transition_count} < 100")
            valid = False
        
        return {
            "valid": valid,
            "issues": issues,
            "phase_entropy": result.phase_entropy,
            "action_entropy": result.action_entropy,
            "transition_count": transition_count,
            "total_samples": len(result.samples),
        }


# 辅助函数
def load_and_sample(
    timeline_path: str,
    random_seed: int = None,
) -> SamplingResult:
    """
    加载时间线并执行 Phase-Aware 采样
    """
    import json
    
    timeline = []
    with open(timeline_path, 'r', encoding='utf-8') as f:
        for line in f:
            data = json.loads(line.strip())
            timeline.append(data)
    
    sampler = PhaseAwareSampler(random_seed=random_seed)
    return sampler.sample(timeline)


def main():
    """演示"""
    print("=" * 60)
    print("Phase-Aware Sampler Demo")
    print("=" * 60)
    
    # 模拟数据
    timeline = []
    for i in range(1000):
        # 模拟不同 phase
        if i < 200:
            # STABLE
            phase = RuntimePhase.STABLE
            queue = 100
        elif i < 400:
            # EXPANDING
            phase = RuntimePhase.EXPANDING
            queue = 100 + (i - 200) * 5
        elif i < 600:
            # PRECURSOR
            phase = RuntimePhase.PRECURSOR
            queue = 1100
        else:
            # RECOVERY
            phase = RuntimePhase.RECOVERY
            queue = 1100 - (i - 600) * 5
        
        timeline.append({
            "queue_depth": queue,
            "worker_count": 50,
            "action_delta": 0,
            "oscillation_score": 0.0,
            "precursor_score": 1.0 if phase == RuntimePhase.PRECURSOR else 0.0,
            "cpu_usage": 0.5,
        })
    
    sampler = PhaseAwareSampler(random_seed=42)
    result = sampler.sample(timeline)
    
    validation = sampler.validate(result)
    print(f"\n验证结果: {'✅ 通过' if validation['valid'] else '❌ 失败'}")
    for issue in validation['issues']:
        print(f"  - {issue}")


if __name__ == "__main__":
    main()
