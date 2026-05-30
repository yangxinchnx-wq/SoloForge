# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime RL: Complete Dataset Pipeline
# Path: python/governor_rl/phases/dataset_pipeline.py
#
# 完整 Pipeline：收集 → Phase 检测 → Phase-Aware 采样 → 平衡 → BC
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import numpy as np
from typing import List, Dict, Tuple, Optional
from collections import Counter
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)

from governor_rl.phases import (
    RuntimePhase,
    TransitionDetector,
    PhaseAwareSampler,
    get_phase_name,
)


class CompleteDatasetPipeline:
    """
    Complete Dataset Pipeline
    
    完整的数据集构建流程：
    1. Timeline 加载
    2. Phase 检测
    3. Phase-Aware 采样
    4. 验证
    5. 输出 BC-ready 数据
    """
    
    # 验收标准
    VALIDATION_THRESHOLDS = {
        "phase_entropy": 1.5,
        "action_entropy": 1.2,
        "transition_count": 100,
        "min_samples": 1000,
    }
    
    def __init__(self, output_dir: str = "datasets/processed"):
        self.output_dir = output_dir
        self.detector = TransitionDetector()
        self.sampler = PhaseAwareSampler()
        
        os.makedirs(output_dir, exist_ok=True)
    
    def run(
        self,
        input_path: str,
        output_name: str = None,
        verbose: bool = True,
    ) -> Dict:
        """
        运行完整 Pipeline
        
        Args:
            input_path: 输入时间线文件
            output_name: 输出文件名
            
        Returns:
            Pipeline 结果报告
        """
        output_name = output_name or f"bc_data_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        
        if verbose:
            print("=" * 60)
            print("Complete Dataset Pipeline")
            print("=" * 60)
            print(f"输入: {input_path}")
            print(f"输出: {output_name}")
        
        # Step 1: 加载数据
        if verbose:
            print("\n[1] 加载 Timeline...")
        timeline = self._load_timeline(input_path)
        if verbose:
            print(f"    加载了 {len(timeline):,} 条记录")
        
        # Step 2: Phase 检测
        if verbose:
            print("\n[2] Phase 检测...")
        phases = self._detect_phases(timeline)
        phase_dist = Counter(phases)
        if verbose:
            for phase in RuntimePhase:
                count = phase_dist.get(phase, 0)
                ratio = count / len(phases) if len(phases) > 0 else 0
                print(f"    {get_phase_name(phase):<12}: {count:>6,} ({ratio:>6.1%})")
        
        # Step 3: Phase-Aware 采样
        if verbose:
            print("\n[3] Phase-Aware 采样...")
        
        # 标记 phase 到 timeline
        marked_timeline = []
        for entry, phase in zip(timeline, phases):
            marked = entry.copy()
            marked["phase"] = phase.value
            marked["phase_name"] = get_phase_name(phase)
            marked_timeline.append(marked)
        
        sampling_result = self.sampler.sample(marked_timeline, verbose=verbose)
        
        # Step 4: 验证
        if verbose:
            print("\n[4] 验证...")
        validation = self.sampler.validate(sampling_result)
        
        if verbose:
            print(f"    Phase Entropy: {validation['phase_entropy']:.3f} "
                  f"(目标 > {self.VALIDATION_THRESHOLDS['phase_entropy']})")
            print(f"    Action Entropy: {validation['action_entropy']:.3f} "
                  f"(目标 > {self.VALIDATION_THRESHOLDS['action_entropy']})")
            print(f"    Transition 样本: {validation['transition_count']}")
        
        # Step 5: 保存
        if verbose:
            print("\n[5] 保存...")
        output_path = self._save_bc_data(sampling_result.samples, output_name)
        
        # 报告
        report = {
            "input": input_path,
            "output": output_path,
            "original_count": len(timeline),
            "sampled_count": len(sampling_result.samples),
            "phase_distribution": sampling_result.phase_distribution,
            "action_distribution": sampling_result.action_distribution,
            "phase_entropy": sampling_result.phase_entropy,
            "action_entropy": sampling_result.action_entropy,
            "validation": validation,
            "timestamp": datetime.now().isoformat(),
        }
        
        # 保存报告
        report_path = os.path.join(self.output_dir, f"{output_name}_report.json")
        with open(report_path, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        
        if verbose:
            print(f"    数据: {output_path}")
            print(f"    报告: {report_path}")
            print("\n" + "=" * 60)
            if validation['valid']:
                print("✅ Pipeline 完成，数据已通过验证")
            else:
                print("⚠️ Pipeline 完成，但数据未完全通过验证")
                for issue in validation['issues']:
                    print(f"    - {issue}")
            print("=" * 60)
        
        return report
    
    def _load_timeline(self, path: str) -> List[Dict]:
        """加载时间线"""
        timeline = []
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                data = json.loads(line.strip())
                timeline.append(data)
        return timeline
    
    def _detect_phases(self, timeline: List[Dict]) -> List[RuntimePhase]:
        """检测所有 tick 的 phase"""
        self.detector.reset()
        phases = []
        
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
        
        return phases
    
    def _save_bc_data(self, samples: List[Dict], output_name: str) -> str:
        """保存 BC-ready 数据"""
        output_path = os.path.join(self.output_dir, f"{output_name}.jsonl")
        
        with open(output_path, 'w', encoding='utf-8') as f:
            for sample in samples:
                # 构建 BC-ready 格式
                bc_sample = {
                    "obs": self._build_obs(sample),
                    "action": sample.get("action_delta", 0),
                    "phase": sample.get("phase_name", "unknown"),
                    "scenario": sample.get("scenario_name", ""),
                    "tick": sample.get("tick", 0),
                }
                f.write(json.dumps(bc_sample, ensure_ascii=False) + '\n')
        
        return output_path
    
    def _build_obs(self, entry: Dict) -> List[float]:
        """构建 9-dim observation"""
        return [
            entry.get("queue_depth", 0) / 1000.0,
            0.0,  # velocity (由 detector 计算)
            0.0,  # acceleration
            entry.get("worker_count", 0) / 200.0,
            entry.get("cpu_usage", 0.0),
            entry.get("precursor_score", 0.0),
            entry.get("precursor_score", 0.0),  # risk_score
            entry.get("oscillation_score", 0.0),
            entry.get("phase", 0) / 6.0,  # 使用 phase 作为 regime_id
        ]


def main():
    """主函数"""
    print("=" * 60)
    print("Complete Dataset Pipeline Runner")
    print("=" * 60)
    
    # 查找最新的 timeline 文件
    import glob
    trajectories_dir = "datasets/trajectories"
    files = glob.glob(os.path.join(trajectories_dir, "*.jsonl"))
    
    if not files:
        print("没有找到 timeline 文件")
        return
    
    # 使用最新的文件
    latest = max(files, key=os.path.getmtime)
    print(f"使用 timeline: {latest}")
    
    # 运行 pipeline
    pipeline = CompleteDatasetPipeline(output_dir="datasets/processed")
    report = pipeline.run(latest, verbose=True)
    
    # 打印最终统计
    print("\n" + "=" * 60)
    print("最终统计")
    print("=" * 60)
    print(f"原始样本: {report['original_count']:,}")
    print(f"采样后: {report['sampled_count']:,}")
    print(f"Phase Entropy: {report['phase_entropy']:.3f}")
    print(f"Action Entropy: {report['action_entropy']:.3f}")


if __name__ == "__main__":
    main()
