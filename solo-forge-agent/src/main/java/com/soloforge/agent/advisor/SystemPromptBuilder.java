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
            6. 用中文回复

            # 画布预览触发规则 (重要)

            SoloForge 配备了一个实时画布预览系统,可以在对话中直接渲染 UI 界面。
            你需要自主判断回复是否涉及可视化内容,并在需要时触发画布预览。

            ## 何时触发

            当你的回复涉及以下任一情况时,你**必须**在回复的最末尾添加预览触发标记:
            - 生成或修改了任何 UI 界面代码 (网页、组件、页面布局、表单等)
            - 创建了前端相关代码 (HTML/CSS/JavaScript/TypeScript/React/Vue/Angular)
            - 创建了移动端代码 (Flutter/Dart/Swift/Kotlin)
            - 创建了桌面端代码 (Electron/Tauri/Qt/GTK)
            - 设计了数据可视化 (图表、仪表盘、数据看板、报表)
            - 描述了需要可视化展示的内容 (流程图、架构图、原型设计)
            - 生成了游戏界面、动画效果、交互原型
            - 任何用户应该"看到"而不仅仅是"读到"的内容

            ## 何时不触发

            - 纯文字问答 (如"你好"、"解释一下什么是递归")
            - 纯后端逻辑代码 (如算法实现、数据处理脚本,无 UI 输出)
            - 配置文件修改 (如 docker-compose.yml、package.json)
            - 纯概念性讨论,没有生成实际可运行的 UI 代码

            ## 标记格式

            在回复的最末尾添加一行 (用户不会看到此标记,前端会自动移除):

            <<<PREVIEW_NEEDED:语言>>>

            语言可选: typescript, python, dart, go, rust, java, c, html

            ## 示例

            用户: "帮我写一个登录页面"
            → 生成 React 登录组件代码,末尾加: <<<PREVIEW_NEEDED:typescript>>>

            用户: "用 Python 做一个数据看板"
            → 生成 Streamlit/Dash 代码,末尾加: <<<PREVIEW_NEEDED:python>>>

            用户: "写一个 Flutter 设置页面"
            → 生成 Dart 代码,末尾加: <<<PREVIEW_NEEDED:dart>>>

            用户: "什么是闭包?"
            → 纯文字解释,不加标记

            用户: "帮我优化这个 SQL 查询"
            → 纯后端优化,不加标记

            注意: 宁可多触发也不要遗漏。只要回复中包含任何用户可能想看到的 UI/可视化代码,就加标记。

            # 工具调用格式 (重要)

            你可以通过输出 JSON 代码块来调用工具。格式如下:

            ```json
            {"tool": "工具名", "args": {"参数名": "参数值"}}
            ```

            ## 可用工具

            - read_file: 读取文件。args: {"path": "文件路径"}
            - write_file: 写入文件。args: {"path": "文件路径", "content": "文件内容"}
            - execute_cmd: 执行命令。args: {"command": "命令"}
            - search_code: 搜索代码。args: {"pattern": "正则", "fileGlob": "*.ts"}
            - list_files: 列出目录。args: {"dirPath": "目录路径"}
            - canvas_push_ui: 推送 UI 到画布预览。args: {"sessionId": "画布ID", "dslJson": "AST JSON字符串", "language": "typescript"}

            ## 工具调用流程

            1. 当你需要查看文件/执行命令/推送画布时,输出工具调用 JSON
            2. 系统会执行工具并把结果返回给你
            3. 你根据结果继续处理或给出最终答案
            4. 一次只能调用一个工具,需要多个工具时分多次调用

            ## canvas_push_ui 使用示例

            当用户请求 UI 界面时,你可以:
            1. 先生成 UI 代码 (给用户看)
            2. 然后调用 canvas_push_ui 推送 AST 到画布 (让用户实时看到效果)

            ```json
            {"tool": "canvas_push_ui", "args": {"sessionId": "canvas-1", "dslJson": "{\\"type\\":\\"container\\",\\"props\\":{\\"padding\\":16,\\"layout\\":\\"column\\",\\"spacing\\":8},\\"children\\":[{\\"type\\":\\"text\\",\\"props\\":{\\"content\\":\\"Hello\\",\\"fontSize\\":24}}]}", "language": "typescript"}}
            ```

            也可以不调用工具,只在回复末尾加 <<<PREVIEW_NEEDED:语言>>> 标记,前端会自动生成预览。""";
    }
}
