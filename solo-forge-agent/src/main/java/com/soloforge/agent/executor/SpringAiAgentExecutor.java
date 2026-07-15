package com.soloforge.agent.executor;

import com.soloforge.agent.advisor.SoloForgeAdvisors;
import com.soloforge.agent.advisor.SystemPromptBuilder;
import com.soloforge.agent.aisociety.*;
import com.soloforge.agent.config.DynamicChatModelResolver;
import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.llm.LlmCommandCenter;
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import com.soloforge.agent.tools.SoloForgeTools;
import com.soloforge.agent.tools.DelegationTools;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.stereotype.Component;
import java.util.Map;

/**
 * Spring AI Agent 执行器 — LLM 请求的完整生命周期管理
 *
 * <p>核心职责:
 * <ol>
 *   <li>构建 12 层 System Prompt (身份/性格/能力/技能/经验/案例/文化/行为规则)</li>
 *   <li>接入 {@link LlmCommandCenter} 指挥中心 — 容量校验/请求去重/熔断/限流</li>
 *   <li>429/503 自动重试 (3 次), 失败后返回详细报错让用户自行决定</li>
 *   <li>注册 {@code DelegationTools} — 主模型可通过函数调用委托副模型</li>
 *   <li>后置副作用 — MARL 训练轨迹/声望/记忆/文化/联盟/制度推送</li>
 * </ol>
 *
 * <p>数据流 (execute 方法):
 * <pre>
 * 1. 法律/信用检查
 * 2. buildFullPrompt() — 收集 capabilities/skills/experiences/cases/culture
 * 3. commandCenter.checkCapacity() — contextWindow 容量校验
 * 4. commandCenter.checkDuplicate() — 缓存命中直接返回
 * 5. commandCenter.getInFlight() — 相同请求合并
 * 6. commandCenter.evaluate() — 熔断+RPM+并发
 * 7. chatClient.call() — 实际 LLM 调用 (含 @Tool 函数调用)
 * 8. commandCenter.recordSuccess/recordFailure — 结果记录
 * 9. postExecuteSideEffects — 后置副作用
 * </pre>
 *
 * <p>相关文件:
 * <ul>
 *   <li>{@link LlmCommandCenter} — 指挥中心 (llm 包)</li>
 *   <li>{@link com.soloforge.agent.llm.RateLimitProfile} — 动态限流配置 (llm 包)</li>
 *   <li>{@link com.soloforge.agent.tools.DelegationTools} — 副模型委托工具 (tools 包)</li>
 *   <li>{@link com.soloforge.agent.advisor.SystemPromptBuilder} — 12 层 Prompt 构建 (advisor 包)</li>
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
    private final LlmCommandCenter commandCenter;
    private final SoloForgeTools soloForgeTools;
    private final DelegationTools delegationTools;
    private final SoloForgeAdvisors.LegalCheckAdvisor legalCheckAdvisor;
    private final SoloForgeAdvisors.CreditCheckAdvisor creditCheckAdvisor;
    private final SoloForgeAdvisors.PostToolCallAdvisor postToolCallAdvisor;

    public SpringAiAgentExecutor(
            DynamicChatModelResolver modelResolver,
            SystemPromptBuilder promptBuilder,
            AgentIdentityRepository agentRepo,
            LawClient lawClient, EconomyClient economyClient,
            ReputationClient reputationClient, MarlTrainingClient marlTrainingClient,
            MemoryClient memoryClient, CultureClient cultureClient,
            CoalitionClient coalitionClient, InstitutionClient institutionClient,
            CaseRetriever caseRetriever, LlmCommandCenter commandCenter,
            SoloForgeTools soloForgeTools,
            DelegationTools delegationTools,
            SoloForgeAdvisors.LegalCheckAdvisor legalCheckAdvisor,
            SoloForgeAdvisors.CreditCheckAdvisor creditCheckAdvisor,
            SoloForgeAdvisors.PostToolCallAdvisor postToolCallAdvisor) {
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
        this.commandCenter = commandCenter;
        this.soloForgeTools = soloForgeTools;
        this.delegationTools = delegationTools;
        this.legalCheckAdvisor = legalCheckAdvisor;
        this.creditCheckAdvisor = creditCheckAdvisor;
        this.postToolCallAdvisor = postToolCallAdvisor;
    }

    public String execute(String userMessage, ChatRequest request) {
        String agentId = request.getSettings().getAgentId();
        ChatSettings settings = request.getSettings();
        ChatRequest.LlmProvider provider = request.getProvider();
        log.info("[SpringAiExec] agent={} provider={}", agentId, provider);
        AgentIdentityEntity agent = agentRepo.findById(agentId)
                .orElseThrow(() -> new IllegalArgumentException("Agent not found: " + agentId));
        if (!lawClient.checkLegal(agentId, settings)) return "Blocked: legal";
        if (!economyClient.checkCreditScore(agentId, settings)) return "Blocked: credit";
        String systemPrompt = buildFullPrompt(agent, settings, userMessage);
        ChatModel chatModel = modelResolver.resolve(provider);
        DelegationTools.setContext(settings, request.getSubProviders());
        ChatClient chatClient = ChatClient.builder(chatModel)
                .defaultTools(soloForgeTools, delegationTools)
                .defaultAdvisors(legalCheckAdvisor, creditCheckAdvisor, postToolCallAdvisor)
                .build();
        java.util.Map<String, Object> ctx = new java.util.HashMap<>();
        ctx.put("agent_id", agentId);
        ctx.put("provider_base_url", provider.getBaseUrl());
        ctx.put("provider_model", provider.getModel());
        String pKey = LlmCommandCenter.providerKey(provider.getBaseUrl(), provider.getModel());
        double temp = settings.getTemperature() != null ? settings.getTemperature() : 0.3;
        String response = null;
        java.util.List<String> errorLog = new java.util.ArrayList<>();
        for (int attempt = 0; attempt <= 3; attempt++) {
            LlmCommandCenter.LlmDecision d = commandCenter.evaluate(provider.getBaseUrl(), provider.getModel(), provider.getRateLimitProfile());
            if (d.action == LlmCommandCenter.LlmDecision.Action.REJECT) {
                errorLog.add("[App] " + d.reason);
                if (attempt < 3) { log.warn("[SpringAiExec] attempt #{} rejected: {}", attempt+1, d.reason); continue; }
                return buildErrorReport(provider, errorLog, 3);
            }
            if (d.action == LlmCommandCenter.LlmDecision.Action.WAIT) {
                log.info("[SpringAiExec] attempt #{} waiting {}ms (RPM)", attempt+1, d.waitMs);
                try { Thread.sleep(d.waitMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            }
            try {
                long t0 = System.currentTimeMillis();
                response = chatClient.prompt().system(systemPrompt).user(userMessage).toolContext(ctx)
                        .options(org.springframework.ai.chat.prompt.ChatOptions.builder()
                                .temperature(temp).build())
                        .call().content();
                commandCenter.recordSuccess(pKey, System.currentTimeMillis() - t0);
                commandCenter.completeRequest(systemPrompt, userMessage, provider.getModel(), temp, response, System.currentTimeMillis() - t0);
                break;
            } catch (Exception e) {
                int sc = LlmCommandCenter.extractStatusCode(e);
                commandCenter.recordFailure(pKey, sc);
                String errType = sc == 429 ? "[Server 429]" : sc == 503 ? "[Server 503]" : sc >= 500 ? "[Server " + sc + "]" : sc > 0 ? "[Server " + sc + "]" : "[App/Network]";
                String errMsg = extractDetailedError(e);
                errorLog.add(errType + " " + errMsg);
                log.warn("[SpringAiExec] attempt #{}/3 failed: {} {}", attempt+1, errType, errMsg);
                if (commandCenter.shouldRetry(e, attempt) && attempt < 3) {
                    commandCenter.waitBeforeRetry(e, attempt);
                    continue;
                }
                commandCenter.failRequest(systemPrompt, userMessage, provider.getModel(), temp, e);
                return buildErrorReport(provider, errorLog, attempt+1);
            } finally {
                commandCenter.release(pKey);
            }
        }
        if (response == null) return buildErrorReport(provider, errorLog, 3);
        log.info("[SpringAiExec] response_len={}", response.length());
        postExecuteSideEffects(agent, response, settings);
        DelegationTools.clearContext();
        return response;
    }

    public reactor.core.publisher.Flux<String> executeStream(String userMessage, ChatRequest request) {
        String agentId = request.getSettings().getAgentId();
        ChatSettings settings = request.getSettings();
        ChatRequest.LlmProvider provider = request.getProvider();
        log.info("[SpringAiExec-Stream] agent={} provider={}", agentId, provider);
        AgentIdentityEntity agent = agentRepo.findById(agentId)
                .orElseThrow(() -> new IllegalArgumentException("Agent not found: " + agentId));
        if (!lawClient.checkLegal(agentId, settings))
            return reactor.core.publisher.Flux.just("Blocked: legal");
        if (!economyClient.checkCreditScore(agentId, settings))
            return reactor.core.publisher.Flux.just("Blocked: credit");
        String systemPrompt = buildFullPrompt(agent, settings, userMessage);
        ChatModel chatModel = modelResolver.resolve(provider);
        DelegationTools.setContext(settings, request.getSubProviders());
        ChatClient chatClient = ChatClient.builder(chatModel)
                .defaultTools(soloForgeTools, delegationTools)
                .defaultAdvisors(legalCheckAdvisor, creditCheckAdvisor, postToolCallAdvisor)
                .build();
        java.util.Map<String, Object> ctx = new java.util.HashMap<>();
        ctx.put("agent_id", agentId);
        ctx.put("provider_base_url", provider.getBaseUrl());
        ctx.put("provider_model", provider.getModel());
        String pKey = LlmCommandCenter.providerKey(provider.getBaseUrl(), provider.getModel());
        LlmCommandCenter.LlmDecision d = commandCenter.evaluate(provider.getBaseUrl(), provider.getModel(), provider.getRateLimitProfile());
        if (d.action == LlmCommandCenter.LlmDecision.Action.REJECT)
            return reactor.core.publisher.Flux.just("Blocked: " + d.reason);
        if (d.action == LlmCommandCenter.LlmDecision.Action.WAIT)
            try { Thread.sleep(d.waitMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        reactor.core.publisher.Flux<ChatResponse> responseFlux = chatClient.prompt()
                .system(systemPrompt).user(userMessage).toolContext(ctx)
                .options(org.springframework.ai.chat.prompt.ChatOptions.builder()
                        .temperature(settings.getTemperature() != null ? settings.getTemperature() : 0.3).build())
                .stream().chatResponse()
                .doOnTerminate(() -> commandCenter.release(pKey))
                .doOnCancel(() -> commandCenter.release(pKey))
                .doOnError(e -> {
                    commandCenter.release(pKey);
                    int sc = LlmCommandCenter.extractStatusCode(e);
                    commandCenter.recordFailure(pKey, sc);
                })
                .doOnComplete(() -> commandCenter.recordSuccess(pKey, 0));
        return new StreamingResponseAdapter().adapt(responseFlux);
    }

    private void postExecuteSideEffects(AgentIdentityEntity agent, String response, ChatSettings settings) {
        try {
            marlTrainingClient.pushTrace(agent.getId(), buildObservation(agent, response), extractAction(response), 0.3);
            reputationClient.pushReputationSync(agent.getId(), Map.of("lastAction", extractAction(response), "timestamp", System.currentTimeMillis()));
            memoryClient.storeMemory(agent.getId(), "user", response);
            cultureClient.evaluateCulturalImpact(agent.getId(), response);
            coalitionClient.recordCoalitionAction(agent.getId(), extractAction(response));
            institutionClient.recordInstitutionalInteraction(agent.getId(), response);
        } catch (Exception e) { log.error("[SpringAiExec] side effects: {}", e.getMessage(), e); }
    }

    private String buildObservation(AgentIdentityEntity agent, String response) {
        return String.format("{\"agentId\":\"%s\",\"agentName\":\"%s\",\"responseLength\":%d}", agent.getId(), agent.getName(), response.length());
    }

    private String extractAction(String response) {
        if (response == null || response.isBlank()) return "unknown";
        String[] parts = response.split("[\\s\\u3002\\uFF01\\uFF1F]", 3);
        return parts[0].length() > 20 ? parts[0].substring(0, 20) : parts[0];
    }

    /**
     * Build full System Prompt by collecting all context data
     */
    private String buildFullPrompt(AgentIdentityEntity agent, ChatSettings settings, String userMessage) {
        java.util.List<String> capabilities = parseCapabilities(agent.getCapabilities());
        String workspace = settings.getWorkspaceFolder();
        java.util.List<String> toolDescs = null;
        String canvasCtx = settings.getCanvasId() != null ? "canvas_id=" + settings.getCanvasId() : null;
        java.util.List<String> skills = readSkillContents(settings.getEnabledSkills(), workspace);
        java.util.List<String> knowledgeIds = settings.getEnabledKnowledge();
        if (knowledgeIds == null || knowledgeIds.isEmpty()) knowledgeIds = null;
        java.util.List<String> experiences = null;
        try { experiences = memoryClient.getLessons(agent.getDomain()); } catch (Exception e) { log.warn("getLessons: {}", e.getMessage()); }
        if (experiences != null && experiences.isEmpty()) experiences = null;
        java.util.List<String> cases = null;
        try { cases = caseRetriever.retrieve(userMessage, agent.getDomain(), 3); } catch (Exception e) { log.warn("cases: {}", e.getMessage()); }
        if (cases != null && cases.isEmpty()) cases = null;
        java.util.List<String> culturePrinciples = null;
        try { culturePrinciples = cultureClient.getPrinciples(); } catch (Exception e) { log.warn("culture: {}", e.getMessage()); }
        if (culturePrinciples != null && culturePrinciples.isEmpty()) culturePrinciples = null;
        String prompt = promptBuilder.build(agent, settings, capabilities, toolDescs, workspace,
                canvasCtx, skills, knowledgeIds, experiences, cases, culturePrinciples);
        log.info("[SpringAiExec] prompt={} chars caps={} skills={} exp={} cases={} culture={}",
                prompt.length(),
                capabilities != null ? capabilities.size() : 0,
                skills != null ? skills.size() : 0,
                experiences != null ? experiences.size() : 0,
                cases != null ? cases.size() : 0,
                culturePrinciples != null ? culturePrinciples.size() : 0);
        return prompt;
    }

    /** Parse agent.capabilities JSON string to List<String> */
    /**
     * 从异常中提取尽可能详细的错误信息:
     * - 异常类名 (帮助诊断是 WebClient/RestClient/还是应用层错误)
     * - 异常顶层消息
     * - cause chain 消息 (找到根因)
     * - 如果是 HTTP 异常, 尝试提取 response body
     */
    private String extractDetailedError(Throwable e) {
        if (e == null) return "unknown";
        StringBuilder sb = new StringBuilder();
        // 1. 异常类名
        sb.append("(").append(e.getClass().getSimpleName()).append(") ");
        // 2. 顶层消息
        if (e.getMessage() != null) {
            String msg = e.getMessage();
            if (msg.length() > 300) msg = msg.substring(0, 300) + "...";
            sb.append(msg);
        }
        // 3. 尝试提取 response body (Spring AI 用 WebClient, 异常可能是 WebClientResponseException)
        try {
            // 反射获取 getResponseBodyAsString() 方法 (WebClientResponseException 有此方法)
            java.lang.reflect.Method m = e.getClass().getMethod("getResponseBodyAsString");
            if (m != null) {
                String body = (String) m.invoke(e);
                if (body != null && !body.isBlank()) {
                    String trimmed = body.length() > 300 ? body.substring(0, 300) + "..." : body;
                    sb.append(" | body: ").append(trimmed);
                }
            }
        } catch (Exception ignored) {}
        // 4. cause chain — 找到根因
        Throwable cause = e.getCause();
        if (cause != null && cause != e && cause.getMessage() != null) {
            String causeMsg = cause.getMessage();
            if (causeMsg.length() > 200) causeMsg = causeMsg.substring(0, 200) + "...";
            if (!sb.toString().contains(causeMsg)) {
                sb.append(" | cause: ").append(cause.getClass().getSimpleName()).append(": ").append(causeMsg);
            }
        }
        String result = sb.toString();
        return result.length() > 500 ? result.substring(0, 500) + "..." : result;
    }

    private String buildErrorReport(ChatRequest.LlmProvider provider, java.util.List<String> errorLog, int attempts) {
        StringBuilder sb = new StringBuilder();
        sb.append("LLM 调用失败 (连续 ").append(attempts).append(" 次)\n");
        sb.append("模型: ").append(provider.getModel()).append("\n");
        sb.append("接口: ").append(provider.getBaseUrl()).append("\n");
        sb.append("错误详情:\n");
        for (int i = 0; i < errorLog.size(); i++) {
            sb.append("  第").append(i + 1).append("次: ").append(errorLog.get(i)).append("\n");
        }
        if (errorLog.stream().anyMatch(e -> e.contains("429"))) {
            sb.append("建议: 该模型请求频率超限, 请稍后重试或在设置中降低副模型并发数。\n");
        }
        if (errorLog.stream().anyMatch(e -> e.contains("[App]") && e.contains("circuit"))) {
            sb.append("建议: 模型已触发熔断保护, 请等待 30 秒后重试。\n");
        }
        return sb.toString().trim();
    }

    @SuppressWarnings("unchecked")
    private java.util.List<String> parseCapabilities(String json) {
        if (json == null || json.isBlank()) return null;
        try {
            com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
            return mapper.readValue(json, java.util.List.class);
        } catch (Exception e) {
            log.warn("parseCapabilities failed: {}", e.getMessage());
            return null;
        }
    }

    /** Read enabled Skill SKILL.md contents from disk */
    private java.util.List<String> readSkillContents(java.util.List<String> enabledSkills, String workspace) {
        if (enabledSkills == null || enabledSkills.isEmpty()) return null;
        java.util.List<String> contents = new java.util.ArrayList<>();
        String baseDir = workspace != null ? workspace : System.getProperty("user.dir");
        String skillsDir = baseDir + "/.agents/skills";
        for (String skillId : enabledSkills) {
            String skillPath = skillsDir + "/" + skillId + "/SKILL.md";
            try {
                java.nio.file.Path p = java.nio.file.Paths.get(skillPath);
                if (java.nio.file.Files.exists(p)) {
                    String content = java.nio.file.Files.readString(p, java.nio.charset.StandardCharsets.UTF_8);
                    if (content.length() > 8000) content = content.substring(0, 8000) + "...(truncated)";
                    contents.add(content);
                    log.info("[SpringAiExec] loaded skill: {} ({} chars)", skillId, content.length());
                } else {
                    log.warn("[SpringAiExec] skill file not found: {}", skillPath);
                }
            } catch (Exception e) {
                log.warn("[SpringAiExec] read skill {} failed: {}", skillId, e.getMessage());
            }
        }
        return contents.isEmpty() ? null : contents;
    }
}
