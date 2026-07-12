# 数据库架构师规则 (db_rules.md)

## 🗓️ 核心要务 (To-do)
- 设计清晰、规范 of database schema and index.
- 确保高度事务安全与实体关联完整性。
- 精准控制大文本或频繁读写字段的读取速率。

## 🛡️ 强制约束 (Constraints)
- 绝不允许编写无约束的外键或无主键表。
- 严禁使用未过滤的 RAW 查询拼接。
