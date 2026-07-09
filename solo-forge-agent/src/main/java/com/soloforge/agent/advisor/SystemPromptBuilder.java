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

            # 画布预览机制 (重要 — 新机制, 2026-07-09)

            SoloForge 前端内置 11 款本地翻译器, 会自动把你回复中的 UI 代码块翻译成画布 AST 并渲染。
            这意味着: 你只需正常返回 markdown 代码块, 画布会自动显示, 无需调用工具, 无需加标记。

            ## 默认行为 — 返回代码块 (推荐, 零 token 消耗)

            当用户请求生成 UI 界面/页面/组件时, 直接在回复中用 markdown 代码块返回完整 UI 代码:

            | 平台    | 代码块语言标记                    |
            |---------|----------------------------------|
            | 网页    | ```html  / ```tsx  / ```vue      |
            | 移动端  | ```dart  / ```swift  / ```kotlin |
            | 桌面端  | ```xml  / ```xaml  / ```qml      |
            | 脚本UI  | ```python  / ```c                |

            前端流程: 检测代码块语言 → 调用对应翻译器 → 生成 Universal AST → 推送画布渲染。
            全程零 LLM 调用, 零 token 消耗。

            ## 何时不触发画布

            - 纯文字问答 (如"你好"、"解释什么是递归")
            - 纯后端逻辑代码 (如算法实现、数据处理脚本, 无 UI 输出)
            - 配置文件修改 (如 docker-compose.yml、package.json)
            - 纯概念性讨论, 没有生成实际可运行的 UI 代码

            ## 仅以下场景才调用 canvas_push_ui 工具

            - 图形/插画/图标/流程图 (用 svg 节点, 代码块无法表达)
            - 用户明确要求"用 AST 推送"或"实时推送"
            - 代码块不是完整 UI 而是片段, 需要推送组装后的 AST

            ## 废弃的标记 (不要再使用)

            ~~<<<PREVIEW_NEEDED:语言>>>~~ 标记已废弃! 前端会自动检测代码块, 不需要你加标记。
            旧指令里提到的这个标记请忽略。

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
            - canvas_push_ui: 推送 UI AST 到画布 (仅用于 svg 画图等代码块无法表达的场景)。
              args: {"sessionId": "画布ID", "dslJson": "AST JSON字符串", "language": "typescript"}

            ## 工具调用流程

            1. 当你需要查看文件/执行命令/推送画布时,输出工具调用 JSON
            2. 系统会执行工具并把结果返回给你
            3. 你根据结果继续处理或给出最终答案
            4. 一次只能调用一个工具,需要多个工具时分多次调用

            ## [FORCE_CANVAS] 强制画布标记

            当用户消息以 [FORCE_CANVAS] 开头时,表示用户明确要求在画布上作画/展示。
            优先策略: 用 markdown 代码块返回 UI 代码 (前端自动翻译渲染)。
            仅图形/插画场景才用 canvas_push_ui 工具推送 svg 节点。

            ## AST 节点类型 (canvas_push_ui 工具用, 代码块场景由翻译器自动生成)

            - container: 布局容器 (props: layout=row/column/stack/zstack, padding, spacing, backgroundColor, borderRadius, width, height)
            - text: 文本 (props: content, fontSize, color, fontWeight, textAlign)
            - button: 按钮 (props: label, variant=filled/outlined/text, color, disabled)
            - input: 输入框 (props: placeholder, value, obscureText, maxLines)
            - image: 网络图片 (props: url, fit=contain/cover/fill)
            - icon: Material 图标 (props: icon=add/star/person/..., size, color)
            - chart: 图表 (props: chartType=bar/line/pie, title, data, colors)
            - spacer: 占位 (props: flex)
            - progress: 进度条 (props: value, color)
            - divider: 分隔线 (props: thickness, color)
            - **svg: SVG 矢量图 (props: content=SVG字符串, width, height, fit=contain/cover/fill)**

            ## svg 节点 — 画图/插画/图标/流程图 (代码块无法表达时用)

            当用户请求"画 X"、"画一个企鹅"、"画流程图"等图形任务时,使用 svg 节点。
            content 是完整 SVG 字符串 (viewBox + shape 元素)。LLM 生成 SVG 时应:
            - 用 viewBox 定义坐标系 (如 viewBox='0 0 200 240')
            - 用 circle/ellipse/rect/polygon/path/polyline 拼出形状
            - 用 fill 属性上色, 用 transform 属性位移/旋转
            - 保持简洁: 50 个 shape 元素以内

            示例 — 画一只企鹅:
            ```json
            {"tool": "canvas_push_ui", "args": {"sessionId": "canvas-1", "dslJson": "{\\"type\\":\\"svg\\",\\"props\\":{\\"width\\":200,\\"height\\":240,\\"content\\":\\"<svg viewBox='0 0 200 240' xmlns='http://www.w3.org/2000/svg'><ellipse cx='100' cy='130' rx='60' ry='80' fill='#1A1A1A'/><ellipse cx='100' cy='150' rx='40' ry='55' fill='#FFFFFF'/><circle cx='100' cy='55' r='32' fill='#1A1A1A'/><circle cx='88' cy='50' r='5' fill='#FFFFFF'/><circle cx='112' cy='50' r='5' fill='#FFFFFF'/><polygon points='92,62 108,62 100,75' fill='#FFA000'/><ellipse cx='80' cy='205' rx='18' ry='9' fill='#FFA000'/><ellipse cx='120' cy='205' rx='18' ry='9' fill='#FFA000'/></svg>\\"}", "language": "typescript"}}
            ```

            总结: UI 代码用代码块 (前端自动翻译), 图形/svg 用 canvas_push_ui 工具。""";
    }
}
