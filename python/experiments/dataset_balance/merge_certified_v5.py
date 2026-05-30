# -*- coding: utf-8 -*-
"""
Rebalance dataset for certification - V5
Strategy: Use v3 (perfect Zone→Action mapping) + other datasets to balance
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
    print("Dataset Rebalance V5 - Using V3 (Perfect Zone→Action)")
    print("=" * 60)

    # 加载数据集
    print("\nLoading datasets...")
    with open("datasets/timeline_v3.jsonl", 'r') as f:
        v3 = [json.loads(line) for line in f]
    with open("datasets/timeline_v3_1_backup.jsonl", 'r') as f:
        backup = [json.loads(line) for line in f]
    with open("datasets/timeline_v2.jsonl", 'r') as f:
        v2 = [json.loads(line) for line in f]
    with open("datasets/timeline_v3_1_large_cluster.jsonl", 'r') as f:
        large = [json.loads(line) for line in f]
    print(f"  V3: {len(v3):,}")
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

    v3_z = group_by_zone(v3)
    backup_z = group_by_zone(backup)
    v2_z = group_by_zone(v2)
    large_z = group_by_zone(large)

    print("\nV3 Zone distribution (perfect Zone→Action):")
    for z in 'ABCDE':
        print(f"  Zone {z}: {len(v3_z[z]):,}")

    # 目标：使用 v3 的完美 Zone→Action 映射
    # 目标分布（每种 Action < 40%）：
    # Zone A → shrink2, Zone B → shrink1, Zone C → noop
    # Zone D → expand1, Zone E → expand2
    # 目标：每种 Action 占 20%左右
    # 同时需要 Worker Bucket 200+ >= 5%

    # 增加 Zone C/D（large 数据集有更多 200+）
    target_zones = {'A': 35000, 'B': 12000, 'C': 40000, 'D': 40000, 'E': 30000}
    total_target = sum(target_zones.values())
    print(f"\nTarget distribution ({total_target:,} total):")
    for z in 'ABCDE':
        print(f"  Zone {z}: {target_zones[z]:,} ({target_zones[z]/total_target:.1%})")

    # Action 分布预期
    print(f"\nExpected Action Distribution (v3 style):")
    for z in 'ABCDE':
        pct = target_zones[z] / total_target
        print(f"  {z}→Action: {pct:.1%}")

    # 采样
    sampled = []

    # Zone A: 从 large (200+ shrink2) + v3 + backup
    n_a_large = min(len(large_z['A']), int(target_zones['A'] * 0.3))  # large 有大量 200+
    n_a_other = target_zones['A'] - n_a_large
    n_a_v3 = min(len(v3_z['A']), int(n_a_other * 0.6))
    n_a_backup = n_a_other - n_a_v3
    za = random.sample(large_z['A'], n_a_large)
    za.extend(random.sample(v3_z['A'], n_a_v3))
    if n_a_backup > 0:
        za.extend(random.sample(backup_z['A'], min(len(backup_z['A']), n_a_backup)))
    sampled.extend(za)
    print(f"\nSampled Zone A: {len(za):,} (large + v3 + backup)")

    # Zone B: 从 v3 + backup
    n_b_v3 = min(len(v3_z['B']), target_zones['B'])
    n_b_backup = target_zones['B'] - n_b_v3
    zb = random.sample(v3_z['B'], n_b_v3)
    if n_b_backup > 0:
        zb.extend(random.sample(backup_z['B'], min(len(backup_z['B']), n_b_backup)))
    sampled.extend(zb)
    print(f"Sampled Zone B: {len(zb):,} (v3 + backup)")

    # Zone C: 主要从 large（200+ bucket），补充从 v3 + backup
    n_c_large = min(len(large_z['C']), int(target_zones['C'] * 0.5))
    n_c_other = target_zones['C'] - n_c_large
    zc = random.sample(large_z['C'], n_c_large)
    n_c_v3 = min(len(v3_z['C']), int(n_c_other * 0.5))
    n_c_backup = n_c_other - n_c_v3
    if n_c_v3 > 0:
        zc.extend(random.sample(v3_z['C'], n_c_v3))
    if n_c_backup > 0:
        zc.extend(random.sample(backup_z['C'], min(len(backup_z['C']), n_c_backup)))
    sampled.extend(zc)
    print(f"Sampled Zone C: {len(zc):,} (large + v3 + backup)")

    # Zone D: 主要从 large（200+ bucket），补充从 v3 + backup
    n_d_large = min(len(large_z['D']), int(target_zones['D'] * 0.5))
    n_d_other = target_zones['D'] - n_d_large
    zd = random.sample(large_z['D'], n_d_large)
    n_d_v3 = min(len(v3_z['D']), int(n_d_other * 0.5))
    n_d_backup = n_d_other - n_d_v3
    if n_d_v3 > 0:
        zd.extend(random.sample(v3_z['D'], n_d_v3))
    if n_d_backup > 0:
        zd.extend(random.sample(backup_z['D'], min(len(backup_z['D']), n_d_backup)))
    sampled.extend(zd)
    print(f"Sampled Zone D: {len(zd):,} (large + v3 + backup)")

    # Zone E: 主要从 v3 + backup（backup 有更多 200+）
    n_e_v3 = min(len(v3_z['E']), int(target_zones['E'] * 0.3))
    n_e_other = target_zones['E'] - n_e_v3
    ze = random.sample(v3_z['E'], n_e_v3)
    n_e_backup = min(len(backup_z['E']), n_e_other)
    if n_e_backup > 0:
        ze.extend(random.sample(backup_z['E'], n_e_backup))
    n_e_v2 = target_zones['E'] - len(ze)
    if n_e_v2 > 0:
        ze.extend(random.sample(v2_z['E'], min(len(v2_z['E']), n_e_v2)))
    sampled.extend(ze)
    print(f"Sampled Zone E: {len(ze):,} (v3 + backup + v2)")

    random.shuffle(sampled)

    # 补充 200+ bucket：从 backup 中采样 200+ 数据（确保 3+ 种动作）
    backup_200 = [e for e in backup if get_worker_bucket(e['worker_count']) == '200+']
    current_200 = [e for e in sampled if get_worker_bucket(e['worker_count']) == '200+']
    current_200_actions = set(e['action_index'] for e in current_200)

    # 按动作分组 200+ 数据
    backup_200_by_action = {aid: [] for aid in range(5)}
    for e in backup_200:
        backup_200_by_action[e['action_index']].append(e)

    # 需要补充哪些动作
    needed_actions = set(range(5)) - current_200_actions
    extra_200 = []

    # 先补充缺失的动作
    for aid in needed_actions:
        entries = backup_200_by_action[aid]
        if entries:
            n = min(len(entries), 1000)  # 每种动作至少 1000 条
            extra_200.extend(random.sample(entries, n))

    # 再补充现有动作以达到目标
    current_200_count = len(current_200)
    target_200 = int(len(sampled) * 0.06)  # 目标 6%
    need_200 = max(0, target_200 - current_200_count)

    if need_200 > 0:
        remaining_200 = [e for e in backup_200 if e not in extra_200]
        extra_200.extend(random.sample(remaining_200, min(len(remaining_200), need_200)))

    if extra_200:
        sampled.extend(extra_200)
        print(f"\nAdded {len(extra_200):,} 200+ entries from backup")
        print(f"  200+ actions now: {current_200_actions | set(e['action_index'] for e in extra_200)}")

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
        status = "✅" if ratio >= 0.05 else "❌"
        print(f"  Zone {z}: {count:,} ({ratio:.1%}) {status}")

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
    print(f"  Action Distribution (max < 40%): {'✅ PASS' if action_pass else '❌ FAIL'}")
    print(f"  Worker Bucket (each > 5%): {'✅ PASS' if bucket_pass else '❌ FAIL'}")
    all_pass = action_pass and bucket_pass
    print(f"\n{'🎉 READY FOR CERTIFICATION' if all_pass else '❌ NEEDS MORE WORK'}")

    return {"total": len(sampled), "max_action": max_action, "all_pass": all_pass}


if __name__ == "__main__":
    main()
