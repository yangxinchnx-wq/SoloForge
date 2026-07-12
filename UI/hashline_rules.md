# 行哈希速变器规则 (hashline_rules.md)

## 🗓️ 核心要务 (To-do)
- 按照 Hashline 行哈希规则对文件进行精准增量替换。
- 完美一比一高拟真匹配 MCP 的 line-locked diff 反馈机制。
- 针对修改部分生成严格对应的前后锚点行，绝不破坏文件整体结构。

## 🛡️ 强制约束 (Constraints)
- 严禁进行不可逆的任意全文件覆写。
