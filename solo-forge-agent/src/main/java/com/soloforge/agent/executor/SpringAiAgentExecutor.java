package com.soloforge.agent.executor;

import com.soloforge.agent.advisor.SystemPromptBuilder;
import com.soloforge.agent.aisociety.*;
import com.soloforge.agent.config.DynamicChatModelResolver;
import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.llm.LlmCommandCenter;
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import com.soloforge.agent.advisor.SoloForgeAdvisors;
import com.soloforge.agent.tools.SoloForgeTools;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.stereotype.Component;
import java.util.Map;

/** Spring AI Agent executor — powered by LlmCommandCenter */
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
        double temp = settings.getTemperature() != null ? settings.getTemperature() : 0.3;
        // ══ 容量校验 ══
        String capErr = commandCenter.checkCapacity(systemPrompt, userMessage, provider.getRateLimitProfile());
        if (capErr != null) return "Capacity error: " + capErr;
        // ══ 请求去重: 缓存命中? ══
        LlmCommandCenter.CacheEntry cached = commandCenter.checkDuplicate(systemPrompt, userMessage, provider.getModel(), temp);
        if (cached != null) {
            log.info("[SpringAiExec] CACHE HIT");
            return cached.response;
        }
        // ══ 请求去重: 相同请求正在飞行? 等它 ══
        var existing = commandCenter.getInFlight(systemPrompt, userMessage, provider.getModel(), temp);
        if (existing != null) {
            log.info("[SpringAiExec] COALESCE");
            try { return existing.get().response; } catch (Exception e) { log.warn("coalesce failed"); }
        }
        commandCenter.registerInFlight(systemPrompt, userMessage, provider.getModel(), temp);
        ChatModel chatModel = modelResolver.resolve(provider);
        ChatClient chatClient = ChatClient.builder(chatModel).defaultTools(soloForgeTools).build();
        java.util.Map<String, Object> ctx = new java.util.HashMap<>();
        ctx.put("agent_id", agentId);
        String pKey = LlmCommandCenter.providerKey(provider.getBaseUrl(), provider.getModel());
        String response = null;
        for (int attempt = 0; attempt <= 3; attempt++) {
            LlmCommandCenter.LlmDecision d = commandCenter.evaluate(provider.getBaseUrl(), provider.getModel(), provider.getRateLimitProfile());
            if (d.action == LlmCommandCenter.LlmDecision.Action.REJECT) throw new RuntimeException(d.reason);
            if (d.action == LlmCommandCenter.LlmDecision.Action.WAIT) try { Thread.sleep(d.waitMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            try {
                long t0 = System.currentTimeMillis();
                response = chatClient.prompt().system(systemPrompt).user(userMessage).toolContext(ctx)
                        .options(org.springframework.ai.chat.prompt.ChatOptions.builder().temperature(temp).build())
                        .call().content();
                long latency = System.currentTimeMillis() - t0;
                commandCenter.recordSuccess(pKey, latency);
                commandCenter.completeRequest(systemPrompt, userMessage, provider.getModel(), temp, response, latency);
                break;
            } catch (Exception e) {
                commandCenter.recordFailure(pKey, LlmCommandCenter.extractStatusCode(e));
                if (commandCenter.shouldRetry(e, attempt) && attempt < 3) { commandCenter.waitBeforeRetry(e, attempt); continue; }
                commandCenter.failRequest(systemPrompt, userMessage, provider.getModel(), temp, e);
                throw e;
            } finally { commandCenter.release(pKey); }
        }
        if (response == null) throw new RuntimeException("LLM exhausted");
        log.info("[SpringAiExec] response_len={}", response.length());
        postExecuteSideEffects(agent, response, settings);
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
        double temp = settings.getTemperature() != null ? settings.getTemperature() : 0.3;
        String pKey = LlmCommandCenter.providerKey(provider.getBaseUrl(), provider.getModel());
        LlmCommandCenter.LlmDecision d = commandCenter.evaluate(provider.getBaseUrl(), provider.getModel(), provider.getRateLimitProfile());
        if (d.action == LlmCommandCenter.LlmDecision.Action.REJECT) return reactor.core.publisher.Flux.just("Blocked: " + d.reason);
        if (d.action == LlmCommandCenter.LlmDecision.Action.WAIT) try { Thread.sleep(d.waitMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        ChatModel chatModel = modelResolver.resolve(provider);
        ChatClient chatClient = ChatClient.builder(chatModel).defaultTools(soloForgeTools).build();
        java.util.Map<String, Object> ctx = new java.util.HashMap<>();
        ctx.put("agent_id", agentId);
        reactor.core.publisher.Flux<ChatResponse> responseFlux = chatClient.prompt()
                .system(systemPrompt).user(userMessage).toolContext(ctx)
                .options(org.springframework.ai.chat.prompt.ChatOptions.builder().temperature(temp).build())
                .stream().chatResponse()
                .doOnTerminate(() -> commandCenter.release(pKey))
                .doOnCancel(() -> commandCenter.release(pKey))
                .doOnError(e -> { commandCenter.release(pKey); commandCenter.recordFailure(pKey, LlmCommandCenter.extractStatusCode(e)); })
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
}

    /**
     * 收集所有上下文数据，构建完整的 12 层 System Prompt
     */
    private String buildFullPrompt(AgentIdentityEntity agent, ChatSettings settings, String userMessage) {
        List<String> capabilities = parseCapabilities(agent.getCapabilities());
        String workspace = settings.getWorkspaceFolder();
        List<String> toolDescs = null;
        String canvasCtx = settings.getCanvasId() != null ? "canvas_id=" + settings.getCanvasId() : null;
        List<String> skills = readSkillContents(settings.getEnabledSkills(), workspace);
        List<String> knowledgeIds = settings.getEnabledKnowledge();
        if (knowledgeIds == null || knowledgeIds.isEmpty()) knowledgeIds = null;
        List<String> experiences = null;
        try { experiences = memoryClient.getLessons(agent.getDomain()); } catch (Exception e) { log.warn("getLessons: {}", e.getMessage()); }
        if (experiences != null && experiences.isEmpty()) experiences = null;
        List<String> cases = null;
        try { cases = caseRetriever.retrieve(userMessage, agent.getDomain(), 3); } catch (Exception e) { log.warn("cases: {}", e.getMessage()); }
        if (cases != null && cases.isEmpty()) cases = null;
        List<String> culturePrinciples = null;
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

    /** 解析 agent.capabilities JSON 字符串 → List<String> */
    @SuppressWarnings("unchecked")
    private List<String> parseCapabilities(String json) {
        if (json == null || json.isBlank()) return null;
        try {
            com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
            return mapper.readValue(json, List.class);
        } catch (Exception e) {
            log.warn("parseCapabilities failed: {}", e.getMessage());
            return null;
        }
    }

    /** 从磁盘读取启用的 Skill SKILL.md 内容 */
    private List<String> readSkillContents(List<String> enabledSkills, String workspace) {
        if (enabledSkills == null || enabledSkills.isEmpty()) return null;
        List<String> contents = new java.util.ArrayList<>();
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
}
