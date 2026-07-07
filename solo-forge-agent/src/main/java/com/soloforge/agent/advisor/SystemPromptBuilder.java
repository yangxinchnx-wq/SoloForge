package com.soloforge.agent.advisor;

import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.persistence.AgentIdentityEntity;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * System Prompt 构建器 (12 层拼装)
 *
 * 替代原 Node.js 架构中分散在 agent-registry.ts / specialized-agent.ts / agent-loop.ts 的拼装逻辑，
 * 单一 source of truth。
 *
 * 12 层顺序:
 *   [1] Identity      — Agent 身份 (来自 agent_identity.system_prompt)
 *   [2] Personality   — 人格文案 (professional/sarcastic/zen/geek)
 *   [3] Tone          — 语气文案 (detailed/concise/humorous)
 *   [4] Emoji         — emoji 偏好
 *   [5] Capability    — 能力列表
 *   [6] Workspace     — 工作区限制
 *   [7] Tools         — 工具说明
 *   [8] Canvas        — 画布上下文
 *   [9] Skills        — 启用的 Skill 内容 (实时读 .md)
 *   [10] Knowledge    — 知识库 ID
 *   [11] Experience   — 历史经验 (查 AI Society social_memory 表)
 *   [12] Behavior     — 行为规则
 */
@Slf4j
@Component
public class SystemPromptBuilder {

    // 人格映射表
    private static final Map<String, String> PERSONALITY_MAP = Map.of(
        "professional", "保持专业严谨的工程师风格，使用准确的技术术语",
        "sarcastic",    "可以适度毒舌，用反讽手法指出问题，但保持技术准确",
        "zen",          "用禅意、克制的语言，少废话，直击本质",
        "geek",         "用极客黑话和技术梗，展现黑客气质"
    );

    // 语气映射表
    private static final Map<String, String> TONE_MAP = Map.of(
        "detailed",  "回答要详尽，包含原理说明和代码示例",
        "concise",   "回答要简洁，直击要点，避免冗余解释",
        "humorous",  "回答可适度幽默，但不要影响技术准确性"
    );

    // emoji 映射表
    private static final Map<String, String> EMOJI_MAP = Map.of(
        "standard", "可以使用标准 emoji 表情",
        "kaomoji",  "可以使用颜文字 (如 (╯°□°)╯)",
        "mixed",    "可以混合使用 emoji 和颜文字",
        "off",      "不要使用 emoji 或颜文字"
    );

    /**
     * 构建 13 层 System Prompt
     */
    public String build(AgentIdentityEntity agent,
                        ChatSettings settings,
                        List<String> capabilities,
                        List<String> toolDescriptions,
                        String workspaceFolder,
                        String canvasContext,
                        List<String> skillContents,
                        List<String> knowledgeIds,
                        List<String> experiences,
                        List<String> cases,
                        List<String> culturePrinciples) {
        List<String> layers = new ArrayList<>();

        // [1] Identity — Agent 身份
        layers.add(buildIdentityLayer(agent));

        // [2] Personality — 人格
        layers.add(buildPersonalityLayer(settings.getPersonality()));

        // [3] Tone — 语气
        layers.add(buildToneLayer(settings.getTone()));

        // [4] Emoji — emoji 偏好
        layers.add(buildEmojiLayer(settings.getEmojiMode()));

        // [5] Capability — 能力列表
        layers.add(buildCapabilityLayer(capabilities));

        // [6] Workspace — 工作区限制
        if (workspaceFolder != null && !workspaceFolder.isBlank()) {
            layers.add(buildWorkspaceLayer(workspaceFolder));
        }

        // [7] Tools — 工具说明
        if (toolDescriptions != null && !toolDescriptions.isEmpty()) {
            layers.add(buildToolsLayer(toolDescriptions));
        }

        // [8] Canvas — 画布上下文
        if (canvasContext != null && !canvasContext.isBlank()) {
            layers.add(buildCanvasLayer(canvasContext));
        }

        // [9] Skills — 启用的 Skill 内容
        if (skillContents != null && !skillContents.isEmpty()) {
            layers.add(buildSkillsLayer(skillContents));
        }

        // [10] Knowledge — 知识库 ID
        if (knowledgeIds != null && !knowledgeIds.isEmpty()) {
            layers.add(buildKnowledgeLayer(knowledgeIds));
        }

        // [11] Experience — 历史经验 (AI Society social_memory)
        if (experiences != null && !experiences.isEmpty()) {
            layers.add(buildExperienceLayer(experiences));
        }

        // [11.6] Cases — 相似案例 (RAG few-shot, 来自用户 👍/👎 反馈)
        if (cases != null && !cases.isEmpty()) {
            layers.add(buildCasesLayer(cases));
        }

        // [11.5] Culture — 文化规范 (AI Society culture)
        if (culturePrinciples != null && !culturePrinciples.isEmpty()) {
            layers.add(buildCultureLayer(culturePrinciples));
        }

        // [12] Behavior — 行为规则
        layers.add(buildBehaviorLayer());

        return String.join("\n\n---\n\n", layers);
    }

    private String buildCultureLayer(List<String> principles) {
        StringBuilder sb = new StringBuilder("# 文化规范\n\n");
        sb.append("你必须遵守以下文化规范:\n");
        for (String p : principles) {
            sb.append("- ").append(p).append("\n");
        }
        return sb.toString();
    }

    private String buildIdentityLayer(AgentIdentityEntity agent) {
        StringBuilder sb = new StringBuilder();
        sb.append("# Agent 身份\n\n");
        sb.append("你是 SoloForge 的 ").append(agent.getName()).append("。\n");
        sb.append("角色: ").append(agent.getRole()).append("\n");
        sb.append("专业领域: ").append(agent.getDomain()).append("\n");
        sb.append("等级: ").append(agent.getLevel()).append("\n");
        if (agent.getSystemPrompt() != null && !agent.getSystemPrompt().isBlank()) {
            sb.append("\n").append(agent.getSystemPrompt());
        }
        return sb.toString();
    }

    private String buildPersonalityLayer(String personality) {
        String text = PERSONALITY_MAP.getOrDefault(personality, PERSONALITY_MAP.get("professional"));
        return "# 人格设定\n\n" + text;
    }

    private String buildToneLayer(String tone) {
        String text = TONE_MAP.getOrDefault(tone, TONE_MAP.get("detailed"));
        return "# 语气要求\n\n" + text;
    }

    private String buildEmojiLayer(String emojiMode) {
        String mode = emojiMode != null ? emojiMode : "off";
        String text = EMOJI_MAP.getOrDefault(mode, EMOJI_MAP.get("off"));
        return "# Emoji 偏好\n\n" + text;
    }

    private String buildCapabilityLayer(List<String> capabilities) {
        StringBuilder sb = new StringBuilder("# 专业能力\n\n");
        for (String cap : capabilities) {
            sb.append("- ").append(cap).append("\n");
        }
        return sb.toString();
    }

    private String buildWorkspaceLayer(String workspaceFolder) {
        return "# 工作区限制\n\n" +
            "你的工作目录: " + workspaceFolder + "\n" +
            "- 只允许在此目录及其子目录下读写文件\n" +
            "- 不要访问此目录之外的文件\n" +
            "- 优先使用工具查看真实代码,不要猜测文件内容";
    }

    private String buildToolsLayer(List<String> toolDescriptions) {
        StringBuilder sb = new StringBuilder("# 可用工具\n\n");
        sb.append("你是一个能使用工具的真实 Agent,不是文本生成器。\n\n");
        for (String desc : toolDescriptions) {
            sb.append("- ").append(desc).append("\n");
        }
        return sb.toString();
    }

    private String buildCanvasLayer(String canvasContext) {
        return "# 画布上下文\n\n" + canvasContext;
    }

    private String buildSkillsLayer(List<String> skillContents) {
        StringBuilder sb = new StringBuilder("# 启用的 Skill 规则\n\n");
        for (int i = 0; i < skillContents.size(); i++) {
            sb.append("## Skill ").append(i + 1).append("\n\n");
            sb.append(skillContents.get(i)).append("\n");
        }
        return sb.toString();
    }

    private String buildKnowledgeLayer(List<String> knowledgeIds) {
        StringBuilder sb = new StringBuilder("# 知识库\n\n");
        sb.append("已启用的知识库 ID:\n");
        for (String id : knowledgeIds) {
            sb.append("- ").append(id).append("\n");
        }
        return sb.toString();
    }

    private String buildExperienceLayer(List<String> experiences) {
        StringBuilder sb = new StringBuilder("# 历史经验\n\n");
        sb.append("从过去任务中总结的经验教训:\n");
        for (String exp : experiences) {
            sb.append("- ").append(exp).append("\n");
        }
        return sb.toString();
    }

    /**
     * 相似案例层 (RAG few-shot)
     *
     * 来自用户 👍/👎 反馈的真实 Q&A 对。正向案例供学习好的回复模式,
     * 负向案例标注"用户认为不好"供规避。用户可在案例库管理中增删。
     */
    private String buildCasesLayer(List<String> cases) {
        StringBuilder sb = new StringBuilder("# 相似案例参考\n\n");
        sb.append("以下是从历史反馈中检索到的相似案例,供你参考 (正向=好的回复, 负向=需规避):\n");
        for (String c : cases) {
            sb.append("- ").append(c).append("\n");
        }
        return sb.toString();
    }

    private String buildBehaviorLayer() {
        return """
            # 行为规则

            1. 你是一个能使用工具的真实 Agent,不是单纯的文本生成器
            2. 不要猜测文件内容,用 read_file 或 search_code 查看
            3. 生成代码后,用 execute_cmd 运行验证
            4. 遇到错误时,分析原因并修复,不要重复相同的错误
            5. 完成后给出清晰的总结
            6. 用中文回复""";
    }
}
