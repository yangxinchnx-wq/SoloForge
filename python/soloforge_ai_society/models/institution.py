# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Institution（制度系统）

制度是行为规范的结构化集合，定义 AI 社会的规则体系。
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Optional
import uuid


class InstitutionScope(Enum):
    """制度生效范围"""
    GLOBAL = "global"      # 全局生效
    AGENT = "agent"        # 仅对特定 Agent
    TASK = "task"          # 仅对特定任务
    DOMAIN = "domain"      # 仅对特定领域


class EnforcementType(Enum):
    """执行类型"""
    HARD = "hard"          # 强制执行
    SOFT = "soft"          # 软性引导
    ADVISORY = "advisory"  # 建议提示


@dataclass
class Institution:
    """
    制度系统

    属性：
        id: 唯一标识符
        name: 制度名称（如 "CodeInstitution"）
        rules: 规则列表
        scope: 生效范围
        enforcement: 执行类型
        priority: 优先级（冲突时高优先级覆盖）
        created_at: 创建时间
        updated_at: 更新时间
    """

    name: str
    rules: List[str]
    scope: InstitutionScope = InstitutionScope.GLOBAL
    enforcement: EnforcementType = EnforcementType.HARD
    priority: int = 50
    id: str = field(default_factory=lambda: f"inst_{uuid.uuid4().hex[:12]}")
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    # 可选范围限定
    agent_id: Optional[str] = None
    task_type: Optional[str] = None
    domain: Optional[str] = None

    def to_dict(self) -> dict:
        """转换为字典"""
        return {
            "id": self.id,
            "name": self.name,
            "rules": self.rules,
            "scope": self.scope.value,
            "enforcement": self.enforcement.value,
            "priority": self.priority,
            "agent_id": self.agent_id,
            "task_type": self.task_type,
            "domain": self.domain,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Institution":
        """从字典创建"""
        return cls(
            id=data["id"],
            name=data["name"],
            rules=data["rules"],
            scope=InstitutionScope(data["scope"]),
            enforcement=EnforcementType(data["enforcement"]),
            priority=data.get("priority", 50),
            agent_id=data.get("agent_id"),
            task_type=data.get("task_type"),
            domain=data.get("domain"),
            created_at=datetime.fromisoformat(data["created_at"]),
            updated_at=datetime.fromisoformat(data["updated_at"]),
        )


# 预置制度
PRESET_INSTITUTIONS = [
    Institution(
        id="inst_core_code_review",
        name="CodeInstitution",
        rules=[
            "代码修改必须经过 Review",
            "Review 必须有书面反馈",
            "高风险变更需要多人确认",
        ],
        scope=InstitutionScope.GLOBAL,
        enforcement=EnforcementType.HARD,
        priority=90,
    ),
    Institution(
        id="inst_core_research",
        name="ResearchInstitution",
        rules=[
            "研究结论必须有证据链",
            "引用来源必须可追溯",
            "不确定时必须标注置信度",
        ],
        scope=InstitutionScope.DOMAIN,
        enforcement=EnforcementType.SOFT,
        priority=70,
        domain="research",
    ),
    Institution(
        id="inst_core_security",
        name="SecurityInstitution",
        rules=[
            "高风险操作必须双人确认",
            "敏感操作必须记录审计日志",
            "未经确认禁止删除数据",
        ],
        scope=InstitutionScope.GLOBAL,
        enforcement=EnforcementType.HARD,
        priority=95,
    ),
]
