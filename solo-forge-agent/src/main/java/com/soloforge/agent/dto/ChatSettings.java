package com.soloforge.agent.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

/**
 * 聊天设置 (前端 ChatSettings 透传)
 *
 * 这些字段在原 Node.js 架构中被丢弃，Java 重构后全部接入 System Prompt 拼装。
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ChatSettings {

    /** 人格: professional / sarcastic / zen / geek, 或自定义 (custom_*) */
    @Builder.Default
    private String personality = "professional";

    /**
     * 自定义人格描述 (前端 localStorage 透传)
     * <p>当 personality 不在内置 4 个之中时 (如 custom_xxx), 使用此描述注入 System Prompt。
     * 内置人格时此字段可为 null, 由 SystemPromptBuilder 走内置映射表。
     */
    private String personalityDesc;

    /** 语气: detailed / concise / humorous */
    @Builder.Default
    private String tone = "detailed";

    /** emoji 模式: standard / kaomoji / mixed / off */
    @Builder.Default
    private String emojiMode = "off";

    /** emoji 是否启用 (前端老字段，等价于 emojiMode != "off") */
    @Builder.Default
    private Boolean emojiEnabled = false;

    /** emoji 类型: standard / kaomoji / mixed */
    @Builder.Default
    private String emojiType = "standard";

    /** 启用的 Skill ID 列表 */
    @Builder.Default
    private List<String> enabledSkills = List.of();

    /** 启用的工具 ID 列表 (前端资源管理器选中, 如 browser_devtools, win_powershell) */
    @Builder.Default
    private List<String> enabledTools = List.of();

    /** 启用的知识库 ID 列表 */
    @Builder.Default
    private List<String> enabledKnowledge = List.of();

    /** Agent ID (手动选择，默认 code_agent) */
    @Builder.Default
    private String agentId = "code_agent";

    /** 工作目录 */
    private String workspaceFolder;

    /** 画布 ID (如果从画布发起) */
    private String canvasId;

    /** chat 会话 ID */
    private String chatSessionId;

    /** 请求方 chat session ID (画布回填用) */
    private String requesterChatSessionId;

    /** 额外上下文 (画布节点信息等) */
    private Map<String, Object> extraContext;
}
