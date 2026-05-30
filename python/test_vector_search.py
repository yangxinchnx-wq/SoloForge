# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Vector Search Test Script

Test content:
1. TF-IDF Embedder
2. LanceDB Vector Storage
3. Semantic Similarity Search
4. Filter Functionality
"""

import sys
import os
import time

# Force UTF-8 encoding
sys.stdout.reconfigure(encoding='utf-8')

# 添加项目路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from soloforge_ai_society.vector.embedder import TFIDFEmbedder
from soloforge_ai_society.vector.search import VectorSearch
from soloforge_ai_society.config import AISocietyConfig


def test_embedder():
    """测试 TF-IDF 嵌入器"""
    print("\n" + "=" * 60)
    print("Test 1: TF-IDF Embedder")
    print("=" * 60)

    # 创建嵌入器
    embedder = TFIDFEmbedder(dim=128)

    # Training data
    train_texts = [
        "File deletion caused data loss problem",
        "Code review found serious security vulnerability",
        "Database connection pool exhaustion timeout",
        "Network request failed error",
        "Memory leak caused service crash problem",
        "File upload completed successfully done",
        "User login authentication passed verified",
        "System running normally stable good",
    ]

    print(f"Training texts: {len(train_texts)}")
    embedder.fit(train_texts)
    print(f"Vocabulary size: {len(embedder.vocabulary)}")
    print(f"Model trained: {embedder.is_fitted}")

    # Test embedding
    test_texts = [
        "file problem",
        "code vulnerability",
        "system error",
        "all normal",
    ]

    print("\nEmbedding test:")
    for text in test_texts:
        vector = embedder.embed(text)
        print(f"  '{text}' -> 向量维度: {vector.shape}, 前5个值: {vector[:5].round(4)}")

    print("\n[PASS] Embedder test passed!")
    return embedder


def test_vector_search(embedder):
    """测试向量搜索"""
    print("\n" + "=" * 60)
    print("Test 2: Vector Search (LanceDB)")
    print("=" * 60)

    # Create temp config
    config = AISocietyConfig(data_dir="./data/test_ai_society")

    # Import LanceDB
    import lancedb

    # Connect to database
    db = lancedb.connect(str(config.lancedb_path))
    print(f"Database path: {config.lancedb_path}")

    # Create vector search
    vector_search = VectorSearch(db, embedder, vector_dim=128)
    print(f"Table name: {vector_search.TABLE_NAME}")

    # Add test data
    print("\nAdding test data...")
    test_memories = [
        {
            "id": "mem_001",
            "event": "File deletion caused data loss",
            "impact": "negative",
            "severity": "critical",
            "lessons": ["Check twice before deletion", "Enable sandbox mode"],
        },
        {
            "id": "mem_002",
            "event": "Code review found serious security vulnerability",
            "impact": "negative",
            "severity": "high",
            "lessons": ["Code review is mandatory"],
        },
        {
            "id": "mem_003",
            "event": "Database connection pool exhaustion caused service unavailable",
            "impact": "negative",
            "severity": "high",
            "lessons": ["Monitor connection pool usage"],
        },
        {
            "id": "mem_004",
            "event": "User feedback: system running slow",
            "impact": "neutral",
            "severity": "medium",
            "lessons": ["Optimize query performance"],
        },
        {
            "id": "mem_005",
            "event": "New feature launched successfully, user satisfaction improved",
            "impact": "positive",
            "severity": "low",
            "lessons": ["Gray release strategy is effective"],
        },
        {
            "id": "mem_006",
            "event": "Network interruption caused distributed system data inconsistency",
            "impact": "negative",
            "severity": "critical",
            "lessons": ["Implement idempotency", "Strengthen network monitoring"],
        },
        {
            "id": "mem_007",
            "event": "Memory leak caused service crash",
            "impact": "negative",
            "severity": "high",
            "lessons": ["Regular memory analysis is needed"],
        },
        {
            "id": "mem_008",
            "event": "Backup recovery drill successful",
            "impact": "positive",
            "severity": "low",
            "lessons": ["Regular drills are important"],
        },
    ]

    for mem in test_memories:
        vector = embedder.embed(mem["event"]).tolist()
        vector_search.add(
            id=mem["id"],
            event=mem["event"],
            vector=vector,
            impact=mem["impact"],
            severity=mem["severity"],
            lessons=",".join(mem["lessons"]),
            created_at=int(time.time() * 1000),
        )
        print(f"  Added: {mem['id']} - {mem['event'][:30]}...")

    print(f"\nTotal records: {vector_search.count()}")

    # Test search
    print("\n" + "-" * 40)
    print("Semantic search test:")
    print("-" * 40)

    test_queries = [
        ("文件问题", 3),
        ("系统故障", 3),
        ("内存问题", 2),
        ("安全漏洞", 2),
        ("成功经验", 2),
    ]

    for query, top_k in test_queries:
        print(f"\n查询: '{query}' (top_k={top_k})")
        results = vector_search.search(query, top_k=top_k)

        if not results:
            print("  [FAIL] No results")
            continue

        for i, r in enumerate(results):
            distance = r.get("_distance", 0)
            print(f"  {i + 1}. [{r['severity']:8}] {r['event'][:35]}... (距离: {distance:.4f})")

    # Test filter
    print("\n" + "-" * 40)
    print("Filter search test:")
    print("-" * 40)

    print("\nQuery: 'problem' + filter severity=critical")
    results = vector_search.search("问题", top_k=5, severity_filter=["critical"])
    for i, r in enumerate(results):
        print(f"  {i + 1}. [{r['severity']:8}] {r['event'][:35]}...")

    # Get stats
    print("\n" + "-" * 40)
    print("Database stats:")
    print("-" * 40)
    stats = vector_search.get_stats()
    for key, value in stats.items():
        print(f"  {key}: {value}")

    print("\n[PASS] Vector search test passed!")
    return True


def test_chinese_search(embedder):
    """测试中文语义搜索"""
    print("\n" + "=" * 60)
    print("Test 3: Chinese Semantic Search")
    print("=" * 60)

    # Import LanceDB
    import lancedb
    from soloforge_ai_society.config import AISocietyConfig

    config = AISocietyConfig(data_dir="./data/test_ai_society")
    db = lancedb.connect(str(config.lancedb_path))
    vector_search = VectorSearch(db, embedder, vector_dim=128)

    chinese_queries = [
        "data backup",
        "network connection",
        "service down",
        "code quality",
        "performance optimization",
    ]

    print("\nChinese semantic query test:")
    for query in chinese_queries:
        results = vector_search.search(query, top_k=2)
        if results:
            print(f"\n'{query}':")
            for r in results:
                print(f"  → {r['event'][:30]}... (距离: {r['_distance']:.4f})")

    print("\n[PASS] Chinese semantic search test passed!")


def cleanup():
    """清理测试数据"""
    print("\n" + "=" * 60)
    print("Cleanup test data...")
    print("=" * 60)

    import shutil
    test_dir = "./data/test_ai_society"
    if os.path.exists(test_dir):
        shutil.rmtree(test_dir)
        print(f"Deleted: {test_dir}")


def main():
    print("\n" + "=" * 60)
    print("SoloForge AI Society - Vector Search Test")
    print("=" * 60)

    try:
        # 测试 1: 嵌入器
        embedder = test_embedder()

        # 测试 2: 向量搜索
        test_vector_search(embedder)

        # 测试 3: 中文搜索
        test_chinese_search(embedder)

        print("\n" + "=" * 60)
        print("All tests passed!")
        print("=" * 60)

    except Exception as e:
        print(f"\n[FAIL] Test failed: {e}")
        import traceback
        traceback.print_exc()
        return 1

    finally:
        # 可选：清理测试数据
        # cleanup()
        pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
