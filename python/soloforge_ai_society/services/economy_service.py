# -*- coding: utf-8 -*-
"""
SoloForge AI Society - Economy Service

经济服务
"""

import logging
from datetime import datetime
from typing import Dict, List, Optional

from ..config import get_config
from ..database.manager import DatabaseManager
from ..models.economy import Economy, CreditTransaction, EconomyRecord, RESOURCE_COSTS, TASK_REWARDS

logger = logging.getLogger(__name__)


class EconomyService:
    """
    经济服务

    管理 Agent 的信用分和资源配额
    """

    def __init__(self, db_manager: DatabaseManager):
        self.db_manager = db_manager
        self.config = get_config()
        self._init_table()

    def _init_table(self) -> None:
        """初始化表 - 表已由 DatabaseManager 统一创建"""
        pass

    def create_account(self, agent_id: str, name: Optional[str] = None) -> Economy:
        """创建经济账户"""
        economy = Economy(
            agent_id=agent_id,
            credits=self.config.initial_credits,
            name=name,
        )

        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO economy (id, agent_id, credits, balance, spending, income, name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                economy.id,
                economy.agent_id,
                economy.credits,
                economy.balance,
                "{}",
                "{}",
                economy.name,
                economy.created_at.isoformat(),
                economy.updated_at.isoformat(),
            ),
        )
        conn.commit()

        logger.info(f"Created economy account: {economy.id} for agent {agent_id}")
        return economy

    def get_account(self, agent_id: str) -> Optional[Economy]:
        """获取账户"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM economy WHERE agent_id = ?", (agent_id,))
        row = cursor.fetchone()

        if not row:
            return None

        import json
        return Economy(
            id=row["id"],
            agent_id=row["agent_id"],
            credits=row["credits"],
            balance=row["balance"],
            spending=json.loads(row["spending"]),
            income=json.loads(row["income"]),
            name=row["name"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    def get_or_create_account(self, agent_id: str) -> Economy:
        """获取或创建账户"""
        account = self.get_account(agent_id)
        if not account:
            account = self.create_account(agent_id)
        return account

    def spend(
        self,
        agent_id: str,
        amount: float,
        category: str,
        description: Optional[str] = None,
    ) -> bool:
        """
        消费信用分

        Args:
            agent_id: Agent ID
            amount: 消费数量
            category: 类别
            description: 描述

        Returns:
            是否成功
        """
        account = self.get_or_create_account(agent_id)

        if account.credits < amount:
            logger.warning(f"Insufficient credits: {agent_id} has {account.credits}, needs {amount}")
            return False

        # 更新余额
        account.credits -= amount
        account.spending[category] = account.spending.get(category, 0) + amount
        account.updated_at = datetime.now()

        # 记录交易
        transaction = CreditTransaction(
            economy_id=account.id,
            amount=amount,
            transaction_type="debit",
            category=category,
            description=description,
        )

        # 保存
        import json
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()

        cursor.execute(
            """
            UPDATE economy SET credits = ?, spending = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                account.credits,
                json.dumps(account.spending),
                account.updated_at.isoformat(),
                account.id,
            ),
        )

        cursor.execute(
            """
            INSERT INTO credit_transaction (id, economy_id, amount, transaction_type, category, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                transaction.id,
                transaction.economy_id,
                transaction.amount,
                transaction.transaction_type,
                transaction.category,
                transaction.description,
                transaction.created_at.isoformat(),
            ),
        )

        conn.commit()

        logger.info(f"Spent {amount} credits: {agent_id} - {category}")
        return True

    def reward(
        self,
        agent_id: str,
        amount: float,
        category: str,
        description: Optional[str] = None,
    ) -> None:
        """
        奖励信用分

        Args:
            agent_id: Agent ID
            amount: 奖励数量
            category: 类别
            description: 描述
        """
        account = self.get_or_create_account(agent_id)

        # 更新余额
        account.credits += amount
        account.income[category] = account.income.get(category, 0) + amount
        account.updated_at = datetime.now()

        # 记录交易
        transaction = CreditTransaction(
            economy_id=account.id,
            amount=amount,
            transaction_type="credit",
            category=category,
            description=description,
        )

        # 保存
        import json
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()

        cursor.execute(
            """
            UPDATE economy SET credits = ?, income = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                account.credits,
                json.dumps(account.income),
                account.updated_at.isoformat(),
                account.id,
            ),
        )

        cursor.execute(
            """
            INSERT INTO credit_transaction (id, economy_id, amount, transaction_type, category, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                transaction.id,
                transaction.economy_id,
                transaction.amount,
                transaction.transaction_type,
                transaction.category,
                transaction.description,
                transaction.created_at.isoformat(),
            ),
        )

        conn.commit()

        logger.info(f"Rewarded {amount} credits: {agent_id} - {category}")

    def get_resource_cost(self, resource: str) -> float:
        """获取资源成本"""
        return RESOURCE_COSTS.get(resource, 10)

    def get_task_reward(self, task_type: str) -> float:
        """获取任务奖励"""
        return TASK_REWARDS.get(task_type, 10)

    def get_transactions(self, agent_id: str, limit: int = 20) -> List[CreditTransaction]:
        """获取交易历史"""
        conn = self.db_manager.get_sqlite_connection()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT t.* FROM credit_transaction t
            JOIN economy e ON t.economy_id = e.id
            WHERE e.agent_id = ?
            ORDER BY t.created_at DESC
            LIMIT ?
            """,
            (agent_id, limit),
        )

        transactions = []
        for row in cursor.fetchall():
            transactions.append(
                CreditTransaction(
                    id=row["id"],
                    economy_id=row["economy_id"],
                    amount=row["amount"],
                    transaction_type=row["transaction_type"],
                    category=row["category"],
                    description=row["description"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                )
            )

        return transactions
