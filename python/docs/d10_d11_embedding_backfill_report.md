# D10/D11 Embedding 回填完工报告

**对应 plan**: `C:\Users\yangx\Desktop\SoloForge\数据库升级方案.md` §12 阶段 5
**日期**: 2026-06-30
**状态**: ✅ 全部交付物完成, 零破坏

---

## 1. 交付物清单

| ID | 任务 | 交付物 | 状态 |
|----|------|--------|------|
| D10-F1 | 写迁移脚本 | `python/tools/migrate_social_memory.py` | ✅ |
| D10-F2 | `--dry-run` 模式 | 同上 (默认 dry-run, 需 `--commit` 才写) | ✅ |
| D10-F3 | 零破坏 (不动 SQLite) | 只读 SQLite, 不删行 | ✅ |
| D10-F4 | 零破坏 (不动旧 LanceDB) | `.lance.deprecated.2026-06-30` 归档保留 | ✅ |
| D11-F5 | 全量回填 | social_memory 3/3 + culture 4/4 + institution 3/3 = 10/10 | ✅ |
| D11-F6 | 召回率校验 (`>80% recall@3`) | `python/tools/verify_qdrant_recall.py`, 实测 100% | ✅ |
| D10-F7 | `db_cli.py migrate-to-qdrant` 子命令 | `python/soloforge_ai_society/scripts/db_cli.py` | ✅ |

---

## 2. 关键设计: UUIDv5 命名空间幂等

```python
namespace = uuid.UUID(hashlib.md5(collection.encode()).hexdigest())
point_id = str(uuid.uuid5(namespace, f"{src}:{r['id']}"))
```

- 同一 `(collection, source, row.id)` 三元组 → 永远生成同一 `point_id`
- 重复跑 `migrate` → Qdrant upsert 覆盖, **count 不变** (57 → 57)
- 重跑验证: 第二次跑 `commit --source all` 后 Qdrant count 仍 57 ✅

---

## 3. 实测结果 (2026-06-30 19:10)

### 3.1 回填统计

| Source | 行数 | upserted | failed | 耗时 |
|--------|------|----------|--------|------|
| social_memory | 3 | 3 | 0 | 32.6s (含 MiniLM cold start ~30s) |
| culture | 4 | 4 | 0 | 0.12s |
| institution | 3 | 3 | 0 | 0.12s |
| **合计** | **10** | **10** | **0** | — |

- Qdrant collection `ai_society_events` 旧 points: 47
- 回填后 points: **57** (新增 10)
- 二次回填后 points: **57** (幂等覆盖, count 不变)

### 3.2 召回率 (D11-F6 验收)

```
total_queries: 10
recall@1:      1.000    ← 验收要求 ≥0.8 ✅
recall@3:      1.000
recall@5:      1.000
mean_sim:      1.0000
mean_latency:  ~100ms (除 cold start 30s)
```

按 source 拆分:

| Source | n | R@1 | R@3 | R@5 | sim |
|--------|---|-----|-----|-----|-----|
| social_memory | 3 | 1.000 | 1.000 | 1.000 | 1.0000 |
| culture | 4 | 1.000 | 1.000 | 1.000 | 1.0000 |
| institution | 3 | 1.000 | 1.000 | 1.000 | 1.0000 |

---

## 4. 零破坏验证

| 资源 | 状态 |
|------|------|
| `data/ai_society/ai_society.db` | 原样保留, 3+4+3=10 行 social_memory/culture/institution 未变 |
| `.lance/` 旧 LanceDB | 未触碰 (D6 阶段已归档为 `.lance.deprecated.2026-06-30`) |
| Qdrant 旧 47 points | 未删, 仅新增 10 + 覆盖式更新 (同 point_id) |
| D8/D9 集成测试 | 仍 6/6 PASS (本阶段未触碰集成层) |

---

## 5. 调试过程小结

调试中发现的两个关键 bug:

1. **Migration 脚本 `build_payload` 不含 `id` 字段**
   - 现象: 召回率 0%, 但 `mean_sim=1.0` (top-1 是自己)
   - 原因: `it["payload"].get("id")` 永远 None, 所以 `source_id` 永远不写入
   - 修复: 在 `items.append` 处直接传 `source_id=str(r["id"])`, 摆脱对 `build_payload` 的隐式依赖
   - 见 `python/tools/migrate_social_memory.py:230-239`

2. **Qdrant 1.18 废弃 `search()`**
   - 现象: `AttributeError: 'QdrantClient' object has no attribute 'search'`
   - 修复: 改用 `query_points(collection_name=..., query=..., limit=5, with_payload=True).points`
   - 见 `python/tools/verify_qdrant_recall.py:141-147`

---

## 6. 命令清单 (供后续复现)

```bash
# 干跑 (默认)
cd python
python tools/migrate_social_memory.py --dry-run --source all
python -m soloforge_ai_society.scripts.db_cli migrate-to-qdrant --dry-run --source all

# 实际回填
python tools/migrate_social_memory.py --commit --source all
python -m soloforge_ai_society.scripts.db_cli migrate-to-qdrant --source all

# 召回率校验
python tools/verify_qdrant_recall.py --source all --limit 5
```

---

## 7. 阶段 5 (D10/D11) 完工签字

- ✅ F1 迁移脚本
- ✅ F2 dry-run
- ✅ F3 零破坏 (SQLite)
- ✅ F4 零破坏 (LanceDB)
- ✅ F5 全量回填
- ✅ F6 召回率 (R@3=1.0 ≥ 0.8 阈值)
- ✅ F7 db_cli.py 子命令

**阶段 5 完结。可进入阶段 6 (D12 MARL v4 蒸馏 / D15-D16 压测)**
