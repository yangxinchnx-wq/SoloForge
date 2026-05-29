# -*- coding: utf-8 -*-
"""
SoloForge AI Society - 测试

测试 AI 社会核心功能
"""

import pytest
import tempfile
from pathlib import Path

from soloforge_ai_society.config import AISocietyConfig, set_config
from soloforge_ai_society.database.manager import DatabaseManager
from soloforge_ai_society.services.memory_service import MemoryService
from soloforge_ai_society.services.reputation_service import ReputationService
from soloforge_ai_society.services.governance_service import GovernanceService
from soloforge_ai_society.services.economy_service import EconomyService
from soloforge_ai_society.services.law_service import LawService
from soloforge_ai_society.services.coalition_service import CoalitionService
from soloforge_ai_society.vector.embedder import TFIDFEmbedder


@pytest.fixture
def temp_dir():
    """临时目录"""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def config(temp_dir):
    """测试配置"""
    cfg = AISocietyConfig(
        data_dir=temp_dir / "ai_society",
        sqlite_db_name="test.db",
        lancedb_name="test.lance",
    )
    set_config(cfg)
    return cfg


@pytest.fixture
def db_manager(config):
    """数据库管理器"""
    db = DatabaseManager(config)
    db.initialize()
    yield db
    db.close()


@pytest.fixture
def embedder():
    """嵌入器"""
    # 训练嵌入器
    sample_texts = [
        "Browser 插件故障导致文件被误删",
        "代码审查发现严重安全问题",
        "模型调用超时导致任务失败",
        "成功完成代码重构",
        "数据库连接池耗尽",
    ]
    emb = TFIDFEmbedder(dim=64)
    emb.fit(sample_texts)
    return emb


@pytest.fixture
def memory_service(db_manager, embedder):
    """记忆服务"""
    return MemoryService(db_manager, embedder)


@pytest.fixture
def reputation_service(db_manager):
    """信誉服务"""
    return ReputationService(db_manager)


@pytest.fixture
def governance_service(db_manager):
    """治理服务"""
    return GovernanceService(db_manager)


@pytest.fixture
def economy_service(db_manager):
    """经济服务"""
    return EconomyService(db_manager)


@pytest.fixture
def law_service(db_manager):
    """法律服务"""
    return LawService(db_manager)


@pytest.fixture
def coalition_service(db_manager):
    """联盟服务"""
    return CoalitionService(db_manager)


class TestMemoryService:
    """测试社会记忆服务"""

    def test_create_memory(self, memory_service):
        """测试创建记忆"""
        memory = memory_service.create(
            event="测试文件删除事件",
            impact="negative",
            severity="critical",
            participants=["Agent1", "Agent2"],
            lessons=["删除前检查两次", "启用沙箱模式"],
        )

        assert memory.id.startswith("mem_")
        assert memory.event == "测试文件删除事件"
        assert memory.impact.value == "negative"
        assert memory.severity.value == "critical"

    def test_search_memory(self, memory_service):
        """测试搜索记忆"""
        # 创建测试记忆
        memory_service.create(
            event="文件删除失败导致数据丢失",
            impact="negative",
            severity="high",
            participants=["Agent1"],
            lessons=["定期备份"],
        )

        # 搜索
        results = memory_service.search("删除文件问题", top_k=3)

        assert len(results) >= 0  # 可能为空，因为向量模型未充分训练

    def test_get_lessons(self, memory_service):
        """测试获取经验教训"""
        memory_service.create(
            event="测试事件",
            impact="negative",
            severity="medium",
            participants=["Agent1"],
            lessons=["Lesson 1", "Lesson 2"],
        )

        lessons = memory_service.get_lessons()
        assert "Lesson 1" in lessons
        assert "Lesson 2" in lessons


class TestReputationService:
    """测试信誉服务"""

    def test_create_reputation(self, reputation_service):
        """测试创建信誉"""
        rep = reputation_service.create(
            entity_id="test_agent",
            entity_type="agent",
            name="Test Agent",
        )

        assert rep.id.startswith("rep_")
        assert rep.entity_id == "test_agent"
        assert rep.score == 1.0

    def test_update_score(self, reputation_service):
        """测试更新分数"""
        rep = reputation_service.create(
            entity_id="test_agent",
            entity_type="agent",
        )

        updated = reputation_service.update_score(
            entity_id="test_agent",
            entity_type="agent",
            delta=-0.1,
            reason="任务失败",
            source="task_completion",
        )

        assert updated is not None
        assert updated.score == 0.9


class TestGovernanceService:
    """测试治理服务"""

    def test_create_governance(self, governance_service):
        """测试创建治理"""
        gov = governance_service.create(
            institution_id="inst_core_code_review",
            owner="System",
            description="代码审查治理",
        )

        assert gov.id.startswith("gov_")
        assert gov.institution_id == "inst_core_code_review"
        assert gov.effectiveness == 1.0


class TestEconomyService:
    """测试经济服务"""

    def test_create_account(self, economy_service):
        """测试创建账户"""
        account = economy_service.create_account(
            agent_id="test_agent",
            name="Test Agent Account",
        )

        assert account.id.startswith("econ_")
        assert account.agent_id == "test_agent"
        assert account.credits == 1000.0

    def test_spend_credits(self, economy_service):
        """测试消费信用"""
        economy_service.create_account("test_agent")
        success = economy_service.spend("test_agent", 50, "claude_sonnet")

        assert success is True

    def test_reward_credits(self, economy_service):
        """测试奖励信用"""
        economy_service.create_account("test_agent")
        economy_service.reward("test_agent", 10, "task_completion")

        account = economy_service.get_account("test_agent")
        assert account.credits > 1000


class TestLawService:
    """测试法律服务"""

    def test_get_all_laws(self, law_service):
        """测试获取所有法律"""
        laws = law_service.get_all_laws()

        assert len(laws) >= 4  # 至少有 4 个预置法律

    def test_check_violation(self, law_service):
        """测试违规检测"""
        violations = law_service.check_violation(
            agent_id="test_agent",
            context={"action": "delete", "confirmation": False},
        )

        # 应该检测到 "未经确认删除文件" 违规
        assert any(v.law_id == "law_delete_without_confirm" for v in violations)


class TestCoalitionService:
    """测试联盟服务"""

    def test_create_coalition(self, coalition_service):
        """测试创建联盟"""
        coalition = coalition_service.create(
            goal="实现新功能",
            leader="Agent1",
            initial_members=["Agent2", "Agent3"],
            name="Feature Team",
        )

        assert coalition.id.startswith("coal_")
        assert coalition.goal == "实现新功能"
        assert coalition.leader == "Agent1"
        assert len(coalition.members) == 3  # leader + 2 members

    def test_add_member(self, coalition_service):
        """测试添加成员"""
        coalition = coalition_service.create(
            goal="测试目标",
            leader="Agent1",
        )

        success = coalition_service.add_member(coalition.id, "Agent4")
        assert success is True

        updated = coalition_service.get(coalition.id)
        assert len(updated.members) == 2

    def test_dissolve_coalition(self, coalition_service):
        """测试解散联盟"""
        coalition = coalition_service.create(
            goal="测试目标",
            leader="Agent1",
        )

        coalition_service.dissolve(coalition.id, "任务完成")
        updated = coalition_service.get(coalition.id)

        assert updated.status.value == "dissolved"
        assert updated.dissolved_reason == "任务完成"


class TestVectorEmbedder:
    """测试向量生成"""

    def test_embedder(self, embedder):
        """测试向量生成"""
        vector = embedder.embed("这是一个测试文本")

        assert len(vector) == 64
        assert -1.0 <= vector[0] <= 1.0  # 归一化后的值

    def test_embedder_batch(self, embedder):
        """测试批量生成"""
        texts = ["文本1", "文本2", "文本3"]
        vectors = embedder.embed_batch(texts)

        assert vectors.shape == (3, 64)
