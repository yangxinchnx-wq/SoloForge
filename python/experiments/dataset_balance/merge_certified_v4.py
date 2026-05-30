# -*- coding: utf-8 -*-
"""
Rebalance dataset for certification - V4 (Final)
Strategy: Precise Zone distribution to satisfy Action < 40%
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


def get_zone_lr(queue_depth: int, worker_count: int) -> str:
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


def main():
    """重新平衡数据集"""
    print("=" * 60)
    print("Dataset Rebalance V4 - Final Certification")
    print("=" * 60)

    # 加载数据集
    print("\nLoading datasets...")
    with open("datasets/timeline_v3_1_backup.jsonl", 'r') as f:
        backup = [json.loads(line) for line in f]
    with open("datasets/timeline_v2.jsonl", 'r') as f:
        v2 = [json.loads(line) for line in f]
    with open("datasets/timeline_v3_1_large_cluster.jsonl", 'r') as f:
        large = [json.loads(line) for line in f]
    print(f"  Backup: {len(backup):,}")
    print(f"  V2: {len(v2):,}")
    print(f"  Large: {len(large):,}")

    # 按 load_ratio Zone 分组
    def group_by_zone(entries):
        zones = {z: [] for z in 'ABCDE'}
        for e in entries:
            z = get_zone_lr(e['queue_depth'], e['worker_count'])
            zones[z].append(e)
        return zones

    backup_z = group_by_zone(backup)
    v2_z = group_by_zone(v2)
    large_z = group_by_zone(large)

    print("\nAvailable by Zone (load_ratio based):")
    for z in 'ABCDE':
        print(f"  Zone {z}: backup={len(backup_z[z]):,}, v2={len(v2_z[z]):,}, large={len(large_z[z]):,}")

    # 目标：每种 Action < 40%
    # 基于历史分布：
    # Zone A: 26.7% shrink2, 73.3% noop
    # Zone B: 55.3% shrink1, 44.7% noop
    # Zone C: 100% noop
    # Zone D: 100% expand1
    # Zone E: 主要 expand1, 小部分 expand2

    # 目标分布（手动计算以满足约束）
    # noop = Zone_A*0.733 + Zone_B*0.447 + Zone_C*1.0 < 0.40
    # expand1 = Zone_D*1.0 + Zone_E*0.999 < 0.40

    # 选择：Zone_A=5%, Zone_B=5%, Zone_C=27%, Zone_D=30%, Zone_E=33%
    # noop = 5%*0.733 + 5%*0.447 + 27% = 3.7% + 2.2% + 27% = 32.9% ✅
    # expand1 = 30% + 33% = 63% ❌

    # 重新选择：Zone_A=15%, Zone_B=5%, Zone_C=15%, Zone_D=30%, Zone_E=35%
    # noop = 15%*0.733 + 5%*0.447 + 15% = 11.0% + 2.2% + 15% = 28.2% ✅
    # expand1 = 30% + 35% = 65% ❌

    # 需要减少 Zone D/E，增加 Zone A
    # 最终选择：Zone_A=25%, Zone_B=8%, Zone_C=20%, Zone_D=22%, Zone_E=25%
    # noop = 25%*0.733 + 8%*0.447 + 20% = 18.3% + 3.6% + 20% = 41.9% ❌

    # 继续调整：Zone_A=20%, Zone_B=8%, Zone_C=18%, Zone_D=25%, Zone_E=29%
    # noop = 20%*0.733 + 8%*0.447 + 18% = 14.7% + 3.6% + 18% = 36.3% ✅
    # expand1 = 25% + 29% = 54% ❌

    # 需要减少 Zone D/E，增加 Zone C
    # Zone_A=18%, Zone_B=7%, Zone_C=25%, Zone_D=25%, Zone_E=25%
    # noop = 18%*0.733 + 7%*0.447 + 25% = 13.2% + 3.1% + 25% = 41.3% ❌

    # Zone_A=15%, Zone_B=7%, Zone_C=28%, Zone_D=25%, Zone_E=25%
    # noop = 15%*0.733 + 7%*0.447 + 28% = 11.0% + 3.1% + 28% = 42.1% ❌

    # Zone_A=12%, Zone_B=6%, Zone_C=30%, Zone_D=26%, Zone_E=26%
    # noop = 12%*0.733 + 6%*0.447 + 30% = 8.8% + 2.7% + 30% = 41.5% ❌

    # Zone_A=10%, Zone_B=5%, Zone_C=35%, Zone_D=25%, Zone_E=25%
    # noop = 10%*0.733 + 5%*0.447 + 35% = 7.3% + 2.2% + 35% = 44.5% ❌

    # Zone_C 不能减少太多，因为它 100% 是 noop
    # 问题是 backup 数据中 Zone C 比例低，Zone D/E 比例高

    # 最终目标：Zone_A=18%, Zone_B=8%, Zone_C=25%, Zone_D=24%, Zone_E=25%
    # noop = 18%*0.733 + 8%*0.447 + 25% = 13.2% + 3.6% + 25% = 41.8% ❌

    # 极端方案：Zone_A=30%, Zone_B=10%, Zone_C=10%, Zone_D=25%, Zone_E=25%
    # noop = 30%*0.733 + 10%*0.447 + 10% = 22.0% + 4.5% + 10% = 36.5% ✅
    # expand1 = 25% + 25% = 50% ❌

    # 需要：expand1 < 40%，所以 Zone_D + Zone_E < 40%
    # 如果 Zone_D=20%, Zone_E=20%，剩余 Zone_A+Zone_B+Zone_C=60%
    # Zone_A=25%, Zone_B=10%, Zone_C=25%
    # noop = 25%*0.733 + 10%*0.447 + 25% = 18.3% + 4.5% + 25% = 47.8% ❌

    # 结论：backup 数据集的结构性问题导致无法同时满足 noop<40% 和 expand1<40%
    # 解决方案：从 v2 和 large 补充 Zone C，减少 Zone D/E

    # 最终方案：Zone_A=20%, Zone_B=8%, Zone_C=32%, Zone_D=20%, Zone_E=20%
    target_zones = {'A': 20, 'B': 8, 'C': 32, 'D': 20, 'E': 20}
    total_target = 120000
    target_counts = {z: int(total_target * p / 100) for z, p in target_zones.items()}

    print(f"\nTarget distribution ({total_target:,} total):")
    for z in 'ABCDE':
        print(f"  Zone {z}: {target_counts[z]:,} ({target_zones[z]:.0f}%)")

    # 计算预期 Action
    noop_expected = (target_counts['A'] * 0.733 + target_counts['B'] * 0.447 + target_counts['C']) / total_target
    expand1_expected = (target_counts['D'] + target_counts['E'] * 0.999) / total_target
    print(f"\nExpected: noop={noop_expected:.1%}, expand1={expand1_expected:.1%}")

    # 采样
    sampled = []

    # Zone A: 从 backup
    za_entries = random.sample(backup_z['A'], min(len(backup_z['A']), target_counts['A']))
    sampled.extend(za_entries)
    print(f"\nSampled Zone A: {len(za_entries):,} from backup")

    # Zone B: 从 backup
    zb_entries = random.sample(backup_z['B'], min(len(backup_z['B']), target_counts['B']))
    sampled.extend(zb_entries)
    print(f"Sampled Zone B: {len(zb_entries):,} from backup")

    # Zone C: 主要从 backup，补充从 large
    n_c_from_backup = min(len(backup_z['C']), int(target_counts['C'] * 0.8))
    n_c_from_large = target_counts['C'] - n_c_from_backup
    zc_entries = random.sample(backup_z['C'], n_c_from_backup)
    if n_c_from_large > 0 and len(large_z['C']) > 0:
        zc_entries.extend(random.sample(large_z['C'], min(len(large_z['C']), n_c_from_large)))
    sampled.extend(zc_entries)
    print(f"Sampled Zone C: {len(zc_entries):,} (backup + large)")

    # Zone D: 主要从 backup，补充从 large
    n_d_from_backup = min(len(backup_z['D']), int(target_counts['D'] * 0.8))
    n_d_from_large = target_counts['D'] - n_d_from_backup
    zd_entries = random.sample(backup_z['D'], n_d_from_backup)
    if n_d_from_large > 0 and len(large_z['D']) > 0:
        zd_entries.extend(random.sample(large_z['D'], min(len(large_z['D']), n_d_from_large)))
    sampled.extend(zd_entries)
    print(f"Sampled Zone D: {len(zd_entries):,} (backup + large)")

    # Zone E: 从 v2（大部分）和 backup（少量）
    n_e_from_v2 = min(len(v2_z['E']), int(target_counts['E'] * 0.7))
    n_e_from_backup = target_counts['E'] - n_e_from_v2
    ze_entries = random.sample(v2_z['E'], n_e_from_v2)
    if n_e_from_backup > 0 and len(backup_z['E']) > 0:
        ze_entries.extend(random.sample(backup_z['E'], min(len(backup_z['E']), n_e_from_backup)))
    sampled.extend(ze_entries)
    print(f"Sampled Zone E: {len(ze_entries):,} (v2 + backup)")

    random.shuffle(sampled)

    # 分析结果
    print("\n" + "=" * 60)
    print("After Rebalance")
    print("=" * 60)

    ACTION_NAMES = {0: "shrink2", 1: "shrink1", 2: "noop", 3: "expand1", 4: "expand2"}
    zone_counter = Counter(get_zone_lr(e["queue_depth"], e["worker_count"]) for e in sampled)
    action_counter = Counter(e["action_index"] for e in sampled)
    bucket_counter = Counter(get_worker_bucket(e["worker_count"]) for e in sampled)

    print(f"\nTotal: {len(sampled):,} entries")

    print("\nZone Distribution:")
    for z in 'ABCDE':
        count = zone_counter.get(z, 0)
        ratio = count / len(sampled)
        target_pct = target_zones[z]
        status = "✅" if abs(ratio * 100 - target_pct) < 5 else "⚠️"
        print(f"  Zone {z}: {count:,} ({ratio:.1%}) target={target_pct:.0f}% {status}")

    print("\nAction Distribution:")
    max_action = 0
    for aid in range(5):
        count = action_counter.get(aid, 0)
        ratio = count / len(sampled)
        max_action = max(max_action, ratio)
        status = "✅" if ratio <= 0.40 else "❌"
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
    action_pass = max_action <= 0.40
    print(f"  Action Distribution (max < 40%): {'✅ PASS' if action_pass else '❌ FAIL'}")
    print(f"  Worker Bucket (each > 5%): {'✅ PASS' if bucket_pass else '❌ FAIL'}")
    all_pass = action_pass and bucket_pass
    print(f"\n{'🎉 READY FOR CERTIFICATION' if all_pass else '❌ NEEDS MORE WORK'}")

    return {"total": len(sampled), "max_action": max_action, "all_pass": all_pass}


if __name__ == "__main__":
    main()
