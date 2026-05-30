# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Law Service

法律服务
"""

import logging
import re
from datetime import datetime
from typing import Dict, List, Optional, Any

from ..database.manager import DatabaseManager
from ..models.law import Law, LawViolation, LawSeverity, PRESET_LAWS

logger = logging.getLogger(__name__)


class LawService:
    """
    法律服务

    管理违规检测和处罚执行
    """

    def __init__(self, db_manager: DatabaseManager):
        self.db_manager = db_manager
        self._init_table()
        self._init_preset_laws()

    def _init_table(self) -> None:
        """初始化表"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()

        # Law 表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS law (
                id TEXT PRIMARY KEY,
                name TEXT,
                description TEXT,
                condition TEXT NOT NULL,
                consequence TEXT NOT NULL,
                severity TEXT NOT NULL,
                appeals INTEGER DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)

        # Law Violation 表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS law_violation (
                id TEXT PRIMARY KEY,
                law_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                violation_context TEXT NOT NULL,
                consequence_applied TEXT NOT NULL,
                status TEXT DEFAULT 'active',
                appeal_reason TEXT,
                appeal_result TEXT,
                created_at TEXT NOT NULL,
                resolved_at TEXT,
                FOREIGN KEY (law_id) REFERENCES law(id)
            )
        """)

        # 创建索引
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_violation_agent ON law_violation(agent_id, status)
        """)

        conn.commit()

    def _init_preset_laws(self) -> None:
        """初始化预置法律"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()

        for law in PRESET_LAWS:
            cursor.execute(
                "INSERT OR IGNORE INTO law (id, name, description, condition, consequence, severity, appeals, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    law.id,
                    law.name,
                    law.description,
                    law.condition,
                    law.consequence,
                    law.severity.value,
                    1 if law.appeals else 0,
                    law.created_at.isoformat(),
                    law.updated_at.isoformat(),
                ),
            )

        conn.commit()

    def create_law(
        self,
        condition: str,
        consequence: str,
        severity: str = "moderate",
        name: Optional[str] = None,
        description: Optional[str] = None,
        appeals: bool = True,
    ) -> Law:
        """创建法律"""
        law = Law(
            condition=condition,
            consequence=consequence,
            severity=LawSeverity(severity),
            name=name,
            description=description,
            appeals=appeals,
        )

        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO law (id, name, description, condition, consequence, severity, appeals, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                law.id,
                law.name,
                law.description,
                law.condition,
                law.consequence,
                law.severity.value,
                1 if law.appeals else 0,
                law.created_at.isoformat(),
                law.updated_at.isoformat(),
            ),
        )
        conn.commit()

        logger.info(f"Created law: {law.id} - {law.name}")
        return law

    def get_law(self, law_id: str) -> Optional[Law]:
        """获取法律"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM law WHERE id = ?", (law_id,))
        row = cursor.fetchone()

        if not row:
            return None

        return Law(
            id=row["id"],
            name=row["name"],
            description=row["description"],
            condition=row["condition"],
            consequence=row["consequence"],
            severity=LawSeverity(row["severity"]),
            appeals=bool(row["appeals"]),
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    def _evaluate_condition(self, condition: str, context: Dict[str, Any]) -> bool:
        """
        评估条件

        Args:
            condition: 条件表达式
            context: 上下文变量

        Returns:
            是否触发
        """
        try:
            # 预处理：把布尔字面量转为 Python 格式
            expr = re.sub(r'\bfalse\b', 'False', condition, flags=re.IGNORECASE)
            expr = re.sub(r'\btrue\b', 'True', expr, flags=re.IGNORECASE)

            # 转换 AND/OR 为 Python 关键字 and/or
            expr = re.sub(r'\bAND\b', 'and', expr, flags=re.IGNORECASE)
            expr = re.sub(r'\bOR\b', 'or', expr, flags=re.IGNORECASE)

            # 构建 eval 上下文
            eval_context = {"__builtins__": {}}

            # 处理点号访问（如 component.status -> 获取值）
            def replace_dot_access(match):
                obj, attr = match.group(1), match.group(2)
                obj_val = context.get(obj, {})
                if isinstance(obj_val, dict):
                    attr_val = obj_val.get(attr, None)
                    var_name = f"__dot_{obj}_{attr}"
                    eval_context[var_name] = attr_val
                    return var_name
                return match.group(0)

            expr = re.sub(r'(\w+)\.(\w+)', replace_dot_access, expr)

            # 将所有上下文变量添加到 eval 上下文
            for key, value in context.items():
                if '.' not in key:
                    eval_context[key] = value

            # 处理乘法表达式（如 budget * 1.2 -> 预先计算）
            for match in re.finditer(r'(\w+)\s*\*\s*([\d.]+)', expr):
                var = match.group(1)
                mult = float(match.group(2))
                val = context.get(var, 0)
                expr = expr.replace(match.group(0), str(val * mult))

            # 安全化表达式：保留引号
            safe_chars = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_=<>!andornot (){}[].\"'+- ")
            safe_expr = "".join(c for c in expr if c in safe_chars)

            return eval(safe_expr, eval_context)

        except Exception as e:
            logger.error(f"Failed to evaluate condition: {condition} - {e}")
            return False

    def check_violation(
        self,
        agent_id: str,
        context: Dict[str, Any],
    ) -> List[LawViolation]:
        """
        检查违规

        Args:
            agent_id: Agent ID
            context: 上下文变量

        Returns:
            违规列表
        """
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM law")
        rows = cursor.fetchall()

        violations = []
        for row in rows:
            law = Law(
                id=row["id"],
                name=row["name"],
                description=row["description"],
                condition=row["condition"],
                consequence=row["consequence"],
                severity=LawSeverity(row["severity"]),
                appeals=bool(row["appeals"]),
                created_at=datetime.fromisoformat(row["created_at"]),
                updated_at=datetime.fromisoformat(row["updated_at"]),
            )

            if self._evaluate_condition(law.condition, context):
                violation = self._record_violation(agent_id, law, context)
                violations.append(violation)

        return violations

    def _record_violation(
        self,
        agent_id: str,
        law: Law,
        context: Dict[str, Any],
    ) -> LawViolation:
        """记录违规"""
        violation = LawViolation(
            law_id=law.id,
            agent_id=agent_id,
            violation_context=str(context),
            consequence_applied=law.consequence,
        )

        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO law_violation (id, law_id, agent_id, violation_context, consequence_applied, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                violation.id,
                violation.law_id,
                violation.agent_id,
                violation.violation_context,
                violation.consequence_applied,
                violation.status,
                violation.created_at.isoformat(),
            ),
        )
        conn.commit()

        logger.warning(f"Violation recorded: {agent_id} - {law.name}")
        return violation

    def get_active_violations(self, agent_id: str) -> List[LawViolation]:
        """获取活跃违规"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM law_violation WHERE agent_id = ? AND status = 'active' ORDER BY created_at DESC",
            (agent_id,),
        )

        violations = []
        for row in cursor.fetchall():
            violations.append(
                LawViolation(
                    id=row["id"],
                    law_id=row["law_id"],
                    agent_id=row["agent_id"],
                    violation_context=row["violation_context"],
                    consequence_applied=row["consequence_applied"],
                    status=row["status"],
                    appeal_reason=row["appeal_reason"],
                    appeal_result=row["appeal_result"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                    resolved_at=datetime.fromisoformat(row["resolved_at"]) if row["resolved_at"] else None,
                )
            )

        return violations

    def resolve_violation(self, violation_id: str) -> None:
        """解决违规"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE law_violation SET status = 'resolved', resolved_at = ?
            WHERE id = ?
            """,
            (datetime.now().isoformat(), violation_id),
        )
        conn.commit()

    def appeal_violation(self, violation_id: str, reason: str) -> None:
        """申诉违规"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE law_violation SET appeal_reason = ?, status = 'appealed'
            WHERE id = ?
            """,
            (reason, violation_id),
        )
        conn.commit()

    def get_all_laws(self) -> List[Law]:
        """获取所有法律"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM law")

        laws = []
        for row in cursor.fetchall():
            laws.append(
                Law(
                    id=row["id"],
                    name=row["name"],
                    description=row["description"],
                    condition=row["condition"],
                    consequence=row["consequence"],
                    severity=LawSeverity(row["severity"]),
                    appeals=bool(row["appeals"]),
                    created_at=datetime.fromisoformat(row["created_at"]),
                    updated_at=datetime.fromisoformat(row["updated_at"]),
                )
            )

        return laws
