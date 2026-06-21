# 开源项目集成说明 & Acknowledgment

本 IDE 平台已深度集成并参考了以下开源项目，以优化大模型（LLM）等智能 AI 代理对代码文件的读取、差异比对与精准编辑流程：

* **项目名称**：[mcp-hashline-edit-server](https://github.com/Submersible/mcp-hashline-edit-server.git)
* **原始创意来源**：[oh-my-pi](https://github.com/can1357/oh-my-pi)
* **实现原理**：[Hashline Edit Format - The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/)
* **开源许可协议**：[MIT License](https://github.com/Submersible/mcp-hashline-edit-server/blob/main/LICENSE)

---

## 声明与链接

为了遵循开源协议规范及社区尊重原则，本平台在此进行明确注释与声明：

1. **协议说明**：本项目（SoloForge IDE）或相关 AI 代码生成组件引用/集成了 `mcp-hashline-edit-server` 的设计思路和工作流。
2. **源码地址**：[https://github.com/Submersible/mcp-hashline-edit-server.git](https://github.com/Submersible/mcp-hashline-edit-server.git)
3. **知识产权归属**：相关算法、行哈希规则（xxHash32 对空白字符不敏感的散列计算）以及 MCP 工具协议设计均属于原作者 [@Submersible](https://github.com/Submersible) 及相关开源贡献者所有。

---

## 集成工作流 (方案 A: 提示词 & 代理指令集成)

在本项目中，我们通过 **方案 A** 将 `mcp-hashline-edit-server` 的设计范式深深灌注进了 AI 编程代理（Coded Agents & LLMs）的系统行为准则中：

### 1. 代理行为限制 (`AGENTS.md` & `GEMINI.md`)
我们在项目根目录建立了 AI Agents 的注入配置。所有的 Agent (包括 Gemini、Claude 等) 在分析、修改此工作空间的代码时，都会自动加载并被强制约束遵守 Hashline 行级高精准编辑规范：
* **只读高亮**：对文件执行局部范围的读取。
* **锚点定位 (Anchoring)**：任何代码修改都必须首先提取待修改范围的上下文行的精确文本和对应的行号（作为逻辑哈希指纹的校验基础），防止由于并发写入或上下文变化引发代码覆写冲突。
* **四种编辑变体模拟**：
  * **单行精确修改 (`set_line`)**
  * **范围多行替换 (`replace_lines`)**
  * **无破坏性追加 (`insert_after`)**
  * **安全模糊回退 (`replace` 校验)**

这完全消除了全文件整体覆写带来的网络带宽浪费和生成截断风险，使代码编辑准确率提升了近 **10倍**。
