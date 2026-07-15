package com.soloforge.agent.tools;

import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.executor.SpringAiAgentExecutor;
import com.soloforge.agent.llm.LlmCommandCenter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Service;
import java.util.List;

/**
 * 副模型委托工具 — 主模型 LLM 通过函数调用把子任务委托给副模型
 *
 * <p>用法 (LLM 视角):
 * <pre>
 * 用户: "帮我用 React 写一个登录页面，并写一个 Python 后端 API"
 *
 * 主模型 LLM 思考: 这个任务可以分解
 *   1. 前端 (React) → 委托给副模型 DeepSeek-Coder
 *   2. 后端 (Python) → 委托给副模型 Qwen2.5
 *
 * 主模型 LLM 调用工具:
 *   delegateToSubModel("deepseek-coder", "用 React 写一个登录页面组件", null)
 *   delegateToSubModel("qwen2.5", "用 Python FastAPI 写一个登录后端 API", null)
 *
 * 主模型拿到两个结果后整合输出给用户
 * </pre>
 */
@Slf4j
@Service
public class DelegationTools {

    private final SpringAiAgentExecutor executor;
    private final LlmCommandCenter commandCenter;

    /**
     * ThreadLocal 存储当前请求的上下文 (ChatSettings + subProviders)
     * — 由 SpringAiAgentExecutor.execute() 在 LLM 调用前设置, 调用后清除
     * — DelegationTools 是 @Service 单例, 无法通过构造函数传请求级数据
     * — 用 ThreadLocal 让 @Tool 方法在函数调用时能拿到当前请求的副模型列表和设置
     */
    private static final ThreadLocal<DelegationContext> ctxHolder = new ThreadLocal<>();

    public DelegationTools(SpringAiAgentExecutor executor, LlmCommandCenter commandCenter) {
        this.executor = executor;
        this.commandCenter = commandCenter;
    }

    /**
     * 委托子任务给指定的副模型执行
     *
     * @param subModelName 副模型名称 (如 "deepseek-coder", "qwen2.5", "claude-3-5-sonnet")
     * @param task        要委托的具体任务描述
     * @param agentId     指定 agent ID (可选, null=使用前端选择的 agent)
     * @return 副模型的执行结果
     */
    @Tool(description = "将子任务委托给指定副模型执行。当需要并行处理多个不同领域子任务,或某子任务更适合特定模型时调用。返回副模型完整执行结果。")
    public String delegateToSubModel(
            @ToolParam(description = "副模型名称 (如 deepseek-coder, qwen2.5, gpt-4o)") String subModelName,
            @ToolParam(description = "要委托给副模型执行的具体任务描述") String task,
            @ToolParam(description = "指定 agent ID, 不指定则用当前 (可选)") String agentId
    ) {
        DelegationContext ctx = ctxHolder.get();
        if (ctx == null) {
            return "Error: no delegation context available";
        }
        if (ctx.subProviders == null || ctx.subProviders.isEmpty()) {
            return "Error: no sub-models configured. Ask user to configure sub-models in settings.";
        }

        // 1. 按名称查找副模型
        ChatRequest.LlmProvider selected = null;
        for (ChatRequest.LlmProvider sp : ctx.subProviders) {
            if (sp.getModel() != null && sp.getModel().toLowerCase().contains(subModelName.toLowerCase())) {
                selected = sp;
                break;
            }
        }
        if (selected == null) {
            // 模糊匹配
            for (ChatRequest.LlmProvider sp : ctx.subProviders) {
                String m = sp.getModel();
                if (m != null && subModelName.toLowerCase().contains(m.toLowerCase().split("-")[0])) {
                    selected = sp;
                    break;
                }
            }
        }
        if (selected == null) {
            String available = ctx.subProviders.stream()
                .map(ChatRequest.LlmProvider::getModel)
                .reduce((a, b) -> a + ", " + b).orElse("none");
            return "Error: sub-model '" + subModelName + "' not found. Available: " + available;
        }

        log.info("[Delegation] delegating to subModel={} task='{}' agent={}",
                selected.getModel(),
                task.length() > 80 ? task.substring(0, 80) + "..." : task,
                agentId != null ? agentId : "(current)");

        // 2. 构建 ChatSettings
        ChatSettings workerSettings = ChatSettings.builder()
            .agentId(agentId != null && !agentId.isBlank() ? agentId : ctx.settings.getAgentId())
            .personality(ctx.settings.getPersonality())
            .tone(ctx.settings.getTone())
            .emojiMode(ctx.settings.getEmojiMode())
            .enabledSkills(ctx.settings.getEnabledSkills())
            .enabledTools(ctx.settings.getEnabledTools())
            .enabledKnowledge(ctx.settings.getEnabledKnowledge())
            .workspaceFolder(ctx.settings.getWorkspaceFolder())
            .canvasId(ctx.settings.getCanvasId())
            .temperature(0.3)
            .build();

        // 3. 走指挥中心评估
        String pKey = LlmCommandCenter.providerKey(selected.getBaseUrl(), selected.getModel());
        LlmCommandCenter.LlmDecision decision = commandCenter.evaluate(
                selected.getBaseUrl(), selected.getModel(), selected.getRateLimitProfile());
        if (decision.action == LlmCommandCenter.LlmDecision.Action.REJECT) {
            return "Error: sub-model " + selected.getModel() + " is rate-limited: " + decision.reason;
        }
        if (decision.action == LlmCommandCenter.LlmDecision.Action.WAIT) {
            try { Thread.sleep(decision.waitMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }

        // 4. 执行副模型
        try {
            long t0 = System.currentTimeMillis();
            String result = executor.execute(task,
                    ChatRequest.builder().settings(workerSettings).provider(selected).build());
            long latency = System.currentTimeMillis() - t0;
            commandCenter.recordSuccess(pKey, latency);
            log.info("[Delegation] subModel={} done in {}ms, result={} chars",
                    selected.getModel(), latency, result.length());
            return result;
        } catch (Exception e) {
            int sc = LlmCommandCenter.extractStatusCode(e);
            commandCenter.recordFailure(pKey, sc);
            log.error("[Delegation] subModel={} failed: {}", selected.getModel(), e.getMessage());
            return "Error: sub-model " + selected.getModel() + " failed: " + e.getMessage();
        } finally {
            commandCenter.release(pKey);
        }
    }

    /**
     * 列出所有可用的副模型
     */
    @Tool(description = "列出当前可用的副模型列表。在委托任务前可先调用此工具查看有哪些副模型可用。")
    public String listSubModels() {
        DelegationContext ctx = ctxHolder.get();
        if (ctx == null || ctx.subProviders == null || ctx.subProviders.isEmpty()) {
            return "No sub-models configured.";
        }
        StringBuilder sb = new StringBuilder("Available sub-models:\n");
        for (ChatRequest.LlmProvider sp : ctx.subProviders) {
            sb.append("- ").append(sp.getModel());
            if (sp.getRateLimitProfile() != null && sp.getRateLimitProfile().getContextWindow() > 0) {
                sb.append(" (context=").append(sp.getRateLimitProfile().getContextWindow()).append(")");
            }
            sb.append("\n");
        }
        return sb.toString();
    }

    // ── ThreadLocal 上下文管理 ──

    public static void setContext(ChatSettings settings, List<ChatRequest.LlmProvider> subProviders) {
        ctxHolder.set(new DelegationContext(settings, subProviders));
    }

    public static void clearContext() {
        ctxHolder.remove();
    }

    public static boolean hasContext() {
        return ctxHolder.get() != null;
    }

    private static class DelegationContext {
        final ChatSettings settings;
        final List<ChatRequest.LlmProvider> subProviders;
        DelegationContext(ChatSettings s, List<ChatRequest.LlmProvider> sp) {
            this.settings = s;
            this.subProviders = sp;
        }
    }
}
