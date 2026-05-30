# -*- coding: utf-8 -*-
"""
Rebalance dataset for certification - V3
Strategy: Use backup (more balanced zones) + v2 (Zone E) + large_cluster (Zone C/D)
"""

import sys
import os
import json
import random
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))
python_dir = os.path.dirname(os.path.dirname(script_dir))
sys.path.insert(0, python_dir)


def get_zone(queue_depth: int, worker_count: int = 200) -> str:
    """获取 Zone (基于 load_ratio)"""
    capacity = worker_count * 2
    load_ratio = queue_depth / max(1, capacity)
    if load_ratio < 0.1: return "A"
    elif load_ratio < 0.25: return "B"
    elif load_ratio < 0.5: return "C"
    elif load_ratio < 1.0: return "D"
    else: return "E"


def get_worker_bucket(worker_count: int) -> str:
    """获取 worker bucket"""
    if worker_count <= 20: return "1-20"
    elif worker_count <= 50: return "20-50"
    elif worker_count <= 100: return "50-100"
    elif worker_count <= 200: return "100-200"
    else: return "200+"


def load_entries(path: str, max_lines: int = None) -> list:
    """加载 entries"""
    entries = []
    with open(path, 'r', encoding='utf-8') as f:
        for i, line in enumerate(f):
            entries.append(json.loads(line.strip()))
            if max_lines and i >= max_lines - 1:
                break
    return entries


def main():
    """重新平衡数据集"""
    print("=" * 60)
    print("Dataset Rebalance V3 - Certification")
    print("=" * 60)

    # 加载数据集
    print("\nLoading datasets...")
    entries_backup = load_entries("datasets/timeline_v3_1_backup.jsonl")
    entries_v2 = load_entries("datasets/timeline_v2.jsonl")
    entries_large = load_entries("datasets/timeline_v3_1_large_cluster.jsonl")
    print(f"  Backup: {len(entries_backup):,}")
    print(f"  V2: {len(entries_v2):,}")
    print(f"  Large cluster: {len(entries_large):,}")

    # 分析各数据集 Zone 分布
    def analyze(name, entries):
        zones = Counter(get_zone(e["queue_depth"], e["worker_count"]) for e in entries)
        total = len(entries)
        print(f"\n{name} Zone distribution ({total:,} entries):")
        for z in "ABCDE":
            c = zones.get(z, 0)
            print(f"  Zone {z}: {c:,} ({c/total:.1%})")
        return zones

    zones_backup = analyze("Backup", entries_backup)
    zones_v2 = analyze("V2", entries_v2)
    zones_large = analyze("Large", entries_large)

    # 目标：Zone A < 40%, 所有 Zone >= 5%
    # 策略：从 backup 获取 Zone A/B/C/D，从 v2/large 获取 Zone E/C/D

    print("\n" + "=" * 60)
    print("Sampling Strategy")
    print("=" * 60)

    # 计算 backup 中各 Zone 可用数量
    backup_zones = {z: zones_backup.get(z, 0) for z in "ABCDE"}
    v2_zones = {z: zones_v2.get(z, 0) for z in "ABCDE"}
    large_zones = {z: zones_large.get(z, 0) for z in "ABCDE"}

    # 目标分布 (150k total)
    target_total = 150000
    target_zones = {"A": 0.30, "B": 0.10, "C": 0.15, "D": 0.20, "E": 0.25}
    target_counts = {z: int(target_total * r) for z, r in target_zones.items()}

    print("\nTarget distribution:")
    for z in "ABCDE":
        print(f"  Zone {z}: {target_counts[z]:,} ({target_zones[z]:.0%})")

    sampled = []

    # Zone E: 主要从 v2 (97.6% Zone E)，补充从 backup
    # v2 有 ~41k Zone E，取 35k
    # backup Zone E 取 2k
    v2_zone_e = [e for e in entries_v2 if get_zone(e["queue_depth"], e["worker_count"]) == "E"]
    n_v2_e = min(len(v2_zone_e), target_counts["E"] - 2000)
    sampled.extend(random.sample(v2_zone_e, n_v2_e))
    print(f"\nSampled Zone E from v2: {n_v2_e:,}")

    # Zone D: 从 backup (34.7k) 和 large (12k)
    # 取 15k from backup + 15k from large
    backup_zone_d = [e for e in entries_backup if get_zone(e["queue_depth"], e["worker_count"]) == "D"]
    large_zone_d = [e for e in entries_large if get_zone(e["queue_depth"], e["worker_count"]) == "D"]
    n_backup_d = min(len(backup_zone_d), 15000)
    n_large_d = min(len(large_zone_d), 15000)
    sampled.extend(random.sample(backup_zone_d, n_backup_d))
    sampled.extend(random.sample(large_zone_d, n_large_d))
    print(f"Sampled Zone D: {n_backup_d:,} from backup + {n_large_d:,} from large")

    # Zone C: 从 backup (14.2k) 和 large (10.7k)
    # 取 11k from backup + 11k from large
    backup_zone_c = [e for e in entries_backup if get_zone(e["queue_depth"], e["worker_count"]) == "C"]
    large_zone_c = [e for e in entries_large if get_zone(e["queue_depth"], e["worker_count"]) == "C"]
    n_backup_c = min(len(backup_zone_c), 11000)
    n_large_c = min(len(large_zone_c), 11000)
    sampled.extend(random.sample(backup_zone_c, n_backup_c))
    sampled.extend(random.sample(large_zone_c, n_large_c))
    print(f"Sampled Zone C: {n_backup_c:,} from backup + {n_large_c:,} from large")

    # Zone B: 从 backup (8k)
    # 取 15k (稍多于目标 10k，以防不够)
    backup_zone_b = [e for e in entries_backup if get_zone(e["queue_depth"], e["worker_count"]) == "B"]
    n_backup_b = min(len(backup_zone_b), 15000)
    sampled.extend(random.sample(backup_zone_b, n_backup_b))
    print(f"Sampled Zone B from backup: {n_backup_b:,}")

    # Zone A: 从 backup，但限制数量使比例 < 40%
    # 目前已采样: E(35k+2k) + D(15k+15k) + C(11k+11k) + B(15k) = 104k
    # 目标总数 150k，Zone A 应该 < 46k (30%)
    target_a = min(target_counts["A"], 45000)  # 最多 45k
    backup_zone_a = [e for e in entries_backup if get_zone(e["queue_depth"], e["worker_count"]) == "A"]
    n_backup_a = min(len(backup_zone_a), target_a)
    sampled.extend(random.sample(backup_zone_a, n_backup_a))
    print(f"Sampled Zone A from backup: {n_backup_a:,}")

    random.shuffle(sampled)

    # 分析结果
    print("\n" + "=" * 60)
    print("After Rebalance")
    print("=" * 60)

    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}
    zone_counter = Counter(get_zone(e["queue_depth"], e["worker_count"]) for e in sampled)
    action_counter = Counter(e["action_index"] for e in sampled)
    bucket_counter = Counter(get_worker_bucket(e["worker_count"]) for e in sampled)

    print(f"\nTotal: {len(sampled):,} entries")

    print("\nZone Distribution:")
    max_zone_gap = 0
    zone_pass = True
    for z in "ABCDE":
        count = zone_counter.get(z, 0)
        ratio = count / len(sampled)
        target = target_zones[z]
        gap = abs(ratio - target)
        max_zone_gap = max(max_zone_gap, gap)
        if z == "A":
            status = "✅" if ratio <= 0.40 else "❌"
            zone_pass = zone_pass and (ratio <= 0.40)
        else:
            status = "✅" if ratio >= 0.05 else "❌"
            zone_pass = zone_pass and (ratio >= 0.05)
        print(f"  Zone {z}: {count:,} ({ratio:.1%}) target={target:.0%} {status}")

    print("\nAction Distribution:")
    max_action = 0
    action_pass = True
    for aid in range(5):
        count = action_counter.get(aid, 0)
        ratio = count / len(sampled)
        max_action = max(max_action, ratio)
        status = "✅" if ratio <= 0.40 else "❌"
        action_pass = action_pass and (ratio <= 0.40)
        print(f"  {ACTION_NAMES[aid]:<8}: {count:,} ({ratio:.1%}) {status}")

    print("\nWorker Bucket Distribution:")
    bucket_pass = True
    for bucket in ["1-20", "20-50", "50-100", "100-200", "200+"]:
        count = bucket_counter.get(bucket, 0)
        ratio = count / len(sampled)
        status = "✅" if ratio >= 0.05 else "❌"
        bucket_pass = bucket_pass and (ratio >= 0.05)
        print(f"  {bucket:<8}: {count:,} ({ratio:.1%}) {status}")

    # 保存
    output_path = "datasets/timeline_v3_1.jsonl"
    with open(output_path, 'w', encoding='utf-8') as f:
        for entry in sampled:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    print(f"\nSaved {len(sampled):,} entries to: {output_path}")

    # 认证状态
    print("\n" + "=" * 60)
    print("Certification Status")
    print("=" * 60)
    all_pass = zone_pass and action_pass and bucket_pass
    print(f"  Zone Distribution (Zone A < 40%, others > 5%): {'✅ PASS' if zone_pass else '❌ FAIL'}")
    print(f"  Action Distribution (max < 40%): {'✅ PASS' if action_pass else '❌ FAIL'}")
    print(f"  Worker Bucket (each > 5%): {'✅ PASS' if bucket_pass else '❌ FAIL'}")
    print(f"\n{'🎉 READY FOR CERTIFICATION' if all_pass else '❌ NEEDS MORE WORK'}")

    return {
        "total": len(sampled),
        "zone_pass": zone_pass,
        "action_pass": action_pass,
        "bucket_pass": bucket_pass,
        "all_pass": all_pass,
    }


if __name__ == "__main__":
    result = main()
