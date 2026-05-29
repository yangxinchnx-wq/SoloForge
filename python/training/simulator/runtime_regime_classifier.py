# -*- coding: utf-8 -*-
# ─────────────────────────────────────────────────────────────────
# SoloForge Runtime Regime Classifier
# Path: python/training/simulator/runtime_regime_classifier.py
#
# 核心功能：自动识别 Runtime 病理模式
# ─────────────────────────────────────────────────────────────────

import sys
import os
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field
from enum import Enum

# 设置 UTF-8 输出
sys.stdout.reconfigure(encoding='utf-8')

# 添加项目根目录到路径
script_dir = os.path.dirname(os.path.abspath(__file__))
training_dir = os.path.dirname(script_dir)
python_dir = os.path.dirname(training_dir)
sys.path.insert(0, python_dir)

from training.simulator.timeline_recorder import RuntimeTimelineRecorder


class RuntimeRegime(Enum):
    """Runtime 稳定性 Regime"""
    HYPER_REACTIVE = "hyper_reactive"      # Mode A: 高振荡、高churn、低队列
    HEALTHY_DYNAMIC = "healthy_dynamic"    # 平衡：适度振荡、可控队列
    UNDER_REACTIVE = "under_reactive"      # Mode B: 低振荡、低churn、队列爆炸
    DEAD_RUNTIME = "dead_runtime"          # Mode C: 零churn、零振荡、完全死去
    MIXED = "mixed"                        # 混合状态
    UNKNOWN = "unknown"                    # 未知


@dataclass
class RegimeThresholds:
    """Regime 分类阈值"""
    # Hyper-Reactive 阈值
    hyper_oscillation_min: float = 0.3
    hyper_churn_min: float = 0.2
    hyper_queue_max: int = 500

    # Under-Reactive 阈值
    under_oscillation_max: float = 0.15
    under_queue_min: int = 3000
    under_churn_max: float = 0.05

    # Dead Runtime 阈值
    dead_churn_max: float = 0.01
    dead_oscillation_max: float = 0.05

    # Healthy Dynamic 范围
    healthy_oscillation_max: float = 0.25
    healthy_oscillation_min: float = 0.05
    healthy_queue_max: int = 1000
    healthy_churn_max: float = 0.15


@dataclass
class RegimeClassification:
    """Regime 分类结果"""
    regime: RuntimeRegime
    confidence: float  # 0-1
    features: Dict[str, Any]
    diagnostics: Dict[str, Any]
    recommendations: List[str]


class RuntimeRegimeClassifier:
    """
    Runtime Regime 分类器

    识别模式：
    | Regime          | 特征                       |
    | --------------- | -------------------------- |
    | Hyper-Reactive  | 高 churn 高 osc            |
    | Healthy Dynamic | 中等 osc + 低 queue         |
    | Under-Reactive  | 低 osc + queue 增长         |
    | Dead Runtime    | 零 churn + queue collapse  |
    """

    def __init__(self, thresholds: Optional[RegimeThresholds] = None):
        self.thresholds = thresholds or RegimeThresholds()

    def classify_from_timeline(self, filepath: str) -> RegimeClassification:
        """从时间线文件分类"""
        recorder = RuntimeTimelineRecorder()
        if not recorder.load(filepath):
            return RegimeClassification(
                regime=RuntimeRegime.UNKNOWN,
                confidence=0.0,
                features={},
                diagnostics={},
                recommendations=["Failed to load timeline"]
            )

        return self.classify_from_recorder(recorder)

    def classify_from_recorder(self, recorder: RuntimeTimelineRecorder) -> RegimeClassification:
        """从 recorder 分类"""
        # 提取特征
        features = self._extract_features(recorder)

        # 分类
        regime = self._classify_regime(features)

        # 计算置信度
        confidence = self._compute_confidence(regime, features)

        # 诊断
        diagnostics = self._diagnose(features, regime)

        # 建议
        recommendations = self._recommend(regime, features)

        return RegimeClassification(
            regime=regime,
            confidence=confidence,
            features=features,
            diagnostics=diagnostics,
            recommendations=recommendations
        )

    def _extract_features(self, recorder: RuntimeTimelineRecorder) -> Dict[str, Any]:
        """提取特征"""
        if not recorder.entries:
            return {}

        features = {
            "num_entries": len(recorder.entries),
            "duration_ticks": recorder.entries[-1].tick - recorder.entries[0].tick,
        }

        # 提取派生指标
        osc_scores = [e.derived_metrics.oscillation_score for e in recorder.entries]
        churn_rates = [e.derived_metrics.worker_churn_rate for e in recorder.entries]
        action_freqs = [e.derived_metrics.action_frequency for e in recorder.entries]

        features["oscillation_avg"] = sum(osc_scores) / len(osc_scores)
        features["oscillation_max"] = max(osc_scores)
        features["oscillation_final"] = osc_scores[-1]

        features["churn_avg"] = sum(churn_rates) / len(churn_rates)
        features["churn_max"] = max(churn_rates)
        features["churn_final"] = churn_rates[-1]

        features["action_freq_avg"] = sum(action_freqs) / len(action_freqs)

        # 队列和 Worker
        queues = [e.state.queue_depth for e in recorder.entries]
        workers = [e.state.worker_count for e in recorder.entries]

        features["queue_min"] = min(queues)
        features["queue_max"] = max(queues)
        features["queue_avg"] = sum(queues) / len(queues)
        features["queue_final"] = queues[-1]

        features["workers_min"] = min(workers)
        features["workers_max"] = max(workers)
        features["workers_avg"] = sum(workers) / len(workers)
        features["workers_final"] = workers[-1]

        # 控制能量
        control_energy = 0
        for i in range(1, len(workers)):
            control_energy += abs(workers[i] - workers[i-1])
        features["control_energy"] = control_energy

        # Queue Recovery Integral (QRI)
        features["qri"] = sum(queues)

        # Cooldown 阻塞率
        blocked_count = sum(1 for e in recorder.entries if e.action.blocked_by_cooldown)
        features["cooldown_block_rate"] = blocked_count / len(recorder.entries)

        # 动作统计
        action_counts = {}
        for e in recorder.entries:
            action_counts[e.action.type] = action_counts.get(e.action.type, 0) + 1
        features["action_counts"] = action_counts
        features["expansion_count"] = action_counts.get("spawn_worker", 0)
        features["contraction_count"] = action_counts.get("reduce_workers", 0)

        # 事件统计
        event_counts = {}
        for e in recorder.entries:
            for event in e.events:
                event_counts[event.type] = event_counts.get(event.type, 0) + 1
        features["event_counts"] = event_counts

        return features

    def _classify_regime(self, features: Dict[str, Any]) -> RuntimeRegime:
        """分类 Regime"""
        if not features:
            return RuntimeRegime.UNKNOWN

        osc = features.get("oscillation_avg", 0)
        churn = features.get("churn_avg", 0)
        queue = features.get("queue_avg", 0)
        queue_final = features.get("queue_final", 0)

        # Dead Runtime: 零churn、零振荡
        if (churn <= self.thresholds.dead_churn_max and
            osc <= self.thresholds.dead_oscillation_max):
            return RuntimeRegime.DEAD_RUNTIME

        # Hyper-Reactive: 高振荡、高churn、低队列
        if (osc >= self.thresholds.hyper_oscillation_min and
            churn >= self.thresholds.hyper_churn_min and
            queue_final < self.thresholds.hyper_queue_max):
            return RuntimeRegime.HYPER_REACTIVE

        # Under-Reactive: 低振荡、低churn、队列爆炸
        if (osc <= self.thresholds.under_oscillation_max and
            queue_final >= self.thresholds.under_queue_min):
            return RuntimeRegime.UNDER_REACTIVE

        # Healthy Dynamic: 适度振荡、可控队列
        if (self.thresholds.healthy_oscillation_min <= osc <= self.thresholds.healthy_oscillation_max and
            queue_final < self.thresholds.healthy_queue_max):
            return RuntimeRegime.HEALTHY_DYNAMIC

        # Mixed 或 Unknown
        if osc > 0.3 or queue_final > 2000:
            return RuntimeRegime.MIXED

        return RuntimeRegime.UNKNOWN

    def _compute_confidence(self, regime: RuntimeRegime, features: Dict[str, Any]) -> float:
        """计算分类置信度"""
        if not features or regime == RuntimeRegime.UNKNOWN:
            return 0.0

        osc = features.get("oscillation_avg", 0)
        churn = features.get("churn_avg", 0)
        queue = features.get("queue_final", 0)

        if regime == RuntimeRegime.DEAD_RUNTIME:
            # 越接近零越好
            confidence = 1.0 - (osc + churn) / 2
            return max(0.5, confidence)

        if regime == RuntimeRegime.HYPER_REACTIVE:
            # 振荡和churn越高，置信度越高
            confidence = min(1.0, (osc + churn) / 2)
            return max(0.6, confidence)

        if regime == RuntimeRegime.UNDER_REACTIVE:
            # 低振荡 + 高队列
            confidence = min(1.0, (1 - osc) * 0.5 + (queue / 10000) * 0.5)
            return max(0.6, confidence)

        if regime == RuntimeRegime.HEALTHY_DYNAMIC:
            # 中等振荡 + 低队列
            confidence = 1.0 - abs(osc - 0.15) - (queue / 1000) * 0.1
            return max(0.5, confidence)

        return 0.5

    def _diagnose(self, features: Dict[str, Any], regime: RuntimeRegime) -> Dict[str, Any]:
        """诊断"""
        diagnostics = {
            "regime_name": regime.value,
            "is_stable": regime in [RuntimeRegime.HEALTHY_DYNAMIC, RuntimeRegime.DEAD_RUNTIME],
            "is_responsive": regime in [RuntimeRegime.HYPER_REACTIVE, RuntimeRegime.HEALTHY_DYNAMIC],
            "is_healthy": regime == RuntimeRegime.HEALTHY_DYNAMIC,
        }

        # 具体问题诊断
        issues = []
        if regime == RuntimeRegime.HYPER_REACTIVE:
            issues.append("Governor 过度反应，导致频繁扩容/缩容")
            issues.append("系统处于振荡状态")
        elif regime == RuntimeRegime.UNDER_REACTIVE:
            issues.append("Governor 反应不足，队列持续堆积")
            issues.append("系统失去调节能力")
        elif regime == RuntimeRegime.DEAD_RUNTIME:
            issues.append("系统完全死去，无任何调节动作")
            issues.append("Governor 处于休眠状态")
        elif regime == RuntimeRegime.HEALTHY_DYNAMIC:
            issues.append("系统处于动态平衡状态")
        elif regime == RuntimeRegime.MIXED:
            issues.append("系统状态不稳定，可能处于过渡期")

        diagnostics["issues"] = issues

        # 关键指标
        diagnostics["key_metrics"] = {
            "oscillation": f"{features.get('oscillation_avg', 0):.3f}",
            "churn": f"{features.get('churn_avg', 0):.3f}",
            "queue": features.get('queue_final', 0),
            "workers": features.get('workers_final', 0),
            "control_energy": features.get('control_energy', 0),
        }

        return diagnostics

    def _recommend(self, regime: RuntimeRegime, features: Dict[str, Any]) -> List[str]:
        """建议"""
        recommendations = []

        if regime == RuntimeRegime.HYPER_REACTIVE:
            recommendations.append("增加 cooldown 时间以减少振荡")
            recommendations.append("考虑增大 hysteresis gap")
            recommendations.append("当前状态：过度控制，需要放松")
        elif regime == RuntimeRegime.UNDER_REACTIVE:
            recommendations.append("减少 cooldown 时间以提高响应性")
            recommendations.append("考虑减小 hysteresis gap")
            recommendations.append("当前状态：控制不足，需要收紧")
        elif regime == RuntimeRegime.DEAD_RUNTIME:
            recommendations.append("系统已死，需要完全重新设计 Governor")
            recommendations.append("当前状态：过度阻尼，需要大幅减少 cooldown")
        elif regime == RuntimeRegime.HEALTHY_DYNAMIC:
            recommendations.append("系统状态良好，保持当前配置")
            recommendations.append("可以微调参数寻找更优点")
        elif regime == RuntimeRegime.MIXED:
            recommendations.append("系统处于过渡状态，建议观察")
            recommendations.append("可能需要自适应调整参数")

        # 通用建议
        qri = features.get("qri", 0)
        if qri > 1000000:
            recommendations.append("警告：Queue Recovery Integral 过高，建议优化")

        cooldown_block = features.get("cooldown_block_rate", 0)
        if cooldown_block > 0.8:
            recommendations.append("警告：Cooldown 阻塞率过高 (>80%)，Governor 决策被过度限制")

        return recommendations


def print_classification(classification: RegimeClassification, title: str = "Runtime Regime Classification"):
    """打印分类结果"""
    print("=" * 70)
    print(f"🎯 {title}")
    print("=" * 70)

    print(f"\n[Regime] {classification.regime.value.upper()}")
    print(f"[置信度] {classification.confidence:.1%}")

    print(f"\n[关键指标]")
    for key, value in classification.diagnostics.get("key_metrics", {}).items():
        print(f"  {key}: {value}")

    print(f"\n[诊断]")
    for issue in classification.diagnostics.get("issues", []):
        print(f"  ⚠️  {issue}")

    print(f"\n[建议]")
    for rec in classification.recommendations:
        print(f"  💡 {rec}")


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Runtime Regime Classifier")
    parser.add_argument("files", nargs="+", help="时间线文件路径")
    parser.add_argument("--verbose", "-v", action="store_true", help="详细输出")

    args = parser.parse_args()

    classifier = RuntimeRegimeClassifier()

    for filepath in args.files:
        if not os.path.exists(filepath):
            print(f"[Classifier] 文件不存在: {filepath}")
            continue

        classification = classifier.classify_from_timeline(filepath)
        print_classification(classification, f"Runtime Regime: {os.path.basename(filepath)}")

        if args.verbose:
            print(f"\n[完整特征]")
            for key, value in classification.features.items():
                print(f"  {key}: {value}")


if __name__ == '__main__':
    main()
