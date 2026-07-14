package com.soloforge.agent.executor;

import com.soloforge.agent.advisor.SystemPromptBuilder;
import com.soloforge.agent.aisociety.*;
import com.soloforge.agent.config.DynamicChatModelResolver;
import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.stereotype.Component;

/**
 * Spring AI 2.0 Agent 执行器 — 替代原 AgentExecutor 的手动 Function Calling 循环
 *
 * <p>核心变化：
 * <ul>
 *   <li>手动 for 循环 (maxRounds=8) → {@code ToolCallingAdvisor} 自动驱动</li>
 *   <li>LlmGateway.chatCompletion() → {@link ChatClient#call()}</li>
 *   <li>ToolRegistry.invoke() switch 路由 → @Tool 注解自动注册</li>
 * </ul>
 *
 * <p>保留不变的业务逻辑（占原代码 70%+）：
 * <ul>
 *   <li>法律检查 (LawClient)</li>
 *   <li>信用分检查 (EconomyClient)</li>
 *   <li>SystemPromptBuilder 构建</li>
 *   <li>后置副作用 (MARL 训练轨迹 / 声望推送)</li>
 * </ul>
 */
@Component
public class SpringAiAgentExecutor {

    private static final Logger log = LoggerFactory.getLogger(SpringAiAgentExecutor.class);

    private final DynamicChatModelResolver modelResolver;
    private final SystemPromptBuilder promptBuilder;
    private final AgentIdentityRepository agentRepo;
    private final LawClient lawClient;
    private final EconomyClient economyClient;
    private final ReputationClient reputationClient;
    private final MarlTrainingClient marlTrainingClient;
    private final MemoryClient memoryClient;
    private final CultureClient cultureClient;
    private final CoalitionClient coalitionClient;
    private final InstitutionClient institutionClient;
    private final CaseRetriever caseRetriever;

    public SpringAiAgentExecutor(
            DynamicChatModelResolver modelResolver,
            SystemPromptBuilder promptBuilder,
            AgentIdentityRepository agentRepo,
            LawClient lawClient,
            EconomyClient economyClient,
            ReputationClient reputationClient,
            MarlTrainingClient marlTrainingClient,
            MemoryClient memoryClient,
            CultureClient cultureClient,
            CoalitionClient coalitionClient,
            InstitutionClient institutionClient,
            CaseRetriever caseRetriever) {
        this.modelResolver = modelResolver;
        this.promptBuilder = promptBuilder;
        this.agentRepo = agentRepo;
        this.lawClient = lawClient;
        this.economyClient = economyClient;
        this.reputationClient = reputationClient;
        this.marlTrainingClient = marlTrainingClient;
        this.memoryClient = memoryClient;
        this.cultureClient = cultureClient;
        this.coalitionClient = coalitionClient;
        this.institutionClient = institutionClient;
        this.caseRetriever = caseRetriever;
    }

    /**
     * 执行 Agent 对话（非流式）
     *
     * <p>等效于原 {@code AgentExecutor.execute()}，但使用 Spring AI 2.0 ChatClient。
     */
    public String execute(String userMessage, ChatRequest request) {
        String agentId = request.getSettings().getAgentId();
        ChatSettings settings = request.getSettings();
        ChatRequest.LlmProvider provider = request.getProvider();

        log.info("[SpringAiExec] agent={} provider={}", agentId, provider);

        // ── Step 1: 加载 Agent 配置（保持不变） ──
        AgentIdentityEntity agent = agentRepo.findById(agentId)
                .orElseThrow(() -> new IllegalArgumentException("Agent not found: " + agentId));

        // ── Step 2: 法律检查（保持不变） ──
        if (!lawClient.checkLegal(agentId, settings)) {
            log.warn("[SpringAiExec] 法律检查未通过: agent={}", agentId);
            return "⚖️ 抱歉，该请求触发了法律合规限制。";
        }

        // ── Step 3: 信用分检查（保持不变） ──
        if (!economyClient.checkCreditScore(agentId, settings)) {
            log.warn("[SpringAiExec] 信用分不足: agent={}", agentId);
            return "💰 抱歉，该 Agent 当前信用分不足。";
        }

        // ── Step 4: 构建 System Prompt（保持不变，输出为字符串） ──
        String systemPrompt = promptBuilder.build(agent, settings, null);

        // ── Step 5-7: 动态解析 ChatModel + 执行（★ 核心变更） ──
        // 原 LlmGateway.chatCompletion() → ChatClient.call()
        // 原 for 循环 FC → ToolCallingAdvisor 自动驱动
        ChatModel chatModel = modelResolver.resolve(provider);

        ChatClient chatClient = ChatClient.builder(chatModel).build();

        String response = chatClient.prompt()
                .system(systemPrompt)
                .user(userMessage)
                .options(org.springframework.ai.chat.prompt.ChatOptions.builder()
                        .temperature(settings.getTemperature() != null ? settings.getTemperature() : 0.3f)
                        .build())
                .call()
                .content();

        log.info("[SpringAiExec] response_len={}", response.length());

        // ── Step 8: 后置副作用（保持不变） ──
        postExecuteSideEffects(agent, response, settings);

        return response;
    }

    /**
     * 执行 Agent 对话（流式）
     *
     * <p>等效于原 {@code AgentExecutor.executeStream()}。
     * 流式响应通过 {@link StreamingResponseAdapter} 处理 reasoning_content 的 \u0001 前缀标记。
     */
    public org.springframework.core.Flux<String> executeStream(String userMessage, ChatRequest request) {
        String agentId = request.getSettings().getAgentId();
        ChatSettings settings = request.getSettings();
        ChatRequest.LlmProvider provider = request.getProvider();

        log.info("[SpringAiExec-Stream] agent={} provider={}", agentId, provider);

        AgentIdentityEntity agent = agentRepo.findById(agentId)
                .orElseThrow(() -> new IllegalArgumentException("Agent not found: " + agentId));

        // 法律/信用检查（同非流式）
        if (!lawClient.checkLegal(agentId, settings)) {
            return org.springframework.core.Flux.just("⚖️ 抱歉，该请求触发了法律合规限制。");
        }
        if (!economyClient.checkCreditScore(agentId, settings)) {
            return org.springframework.core.Flux.just("💰 抱歉，该 Agent 当前信用分不足。");
        }

        String systemPrompt = promptBuilder.build(agent, settings, null);
        ChatModel chatModel = modelResolver.resolve(provider);

        ChatClient chatClient = ChatClient.builder(chatModel).build();

        // ★ 流式调用：返回 Flux<ChatResponse>
        org.springframework.core.Flux<ChatResponse> responseFlux = chatClient.prompt()
                .system(systemPrompt)
                .user(userMessage)
                .options(org.springframework.ai.chat.prompt.ChatOptions.builder()
                        .temperature(settings.getTemperature() != null ? settings.getTemperature() : 0.3f)
                        .build())
                .stream()
                .chatResponse();

        // ★ 通过 Adapter 处理 reasoning_content → \u0001 前缀
        return new StreamingResponseAdapter().adapt(responseFlux);
    }

    // ──────────────────────────────────────────────
    // 后置副作用（从原 AgentExecutor 完整保留）
    // ──────────────────────────────────────────────

    private void postExecuteSideEffects(AgentIdentityEntity agent, String response, ChatSettings settings) {
        try {
            // 推送 MARL 训练轨迹
            marlTrainingClient.pushTrace(
                    agent.getId(),
                    buildObservation(agent, response),
                    extractAction(response),
                    0.3
            );

            // 更新声望
            reputationClient.pushReputationSync(agent.getId(), Map.of(
                    "lastAction", extractAction(response),
                    "timestamp", System.currentTimeMillis()
            ));

            // 持久化记忆
            memoryClient.storeMemory(agent.getId(), "user", response);

            // 文化影响评估
            cultureClient.evaluateCulturalImpact(agent.getId(), response);

            // 联盟影响
            coalitionClient.recordCoalitionAction(agent.getId(), extractAction(response));

            // 制度影响
            institutionClient.recordInstitutionalInteraction(agent.getId(), response);

            log.info("[SpringAiExec] post-execute side effects completed for agent={}", agent.getId());
        } catch (Exception e) {
            log.error("[SpringAiExec] post-execute side effects failed: {}", e.getMessage(), e);
        }
    }

    private String buildObservation(AgentIdentityEntity agent, String response) {
        return String.format("{\"agentId\":\"%s\",\"agentName\":\"%s\",\"responseLength\":d}",
                agent.getId(), agent.getName(), response.length());
    }

    private String extractAction(String response) {
        // 简单启发式提取动作词（与原 AgentExecutor 保持一致）
        if (response == null || response.isBlank()) return "unknown";
        String[] parts = response.split("[\\s。！？]", 3);
        return parts[0].length() > 20 ? parts[0].substring(0, 20) : parts[0];
    }
}
