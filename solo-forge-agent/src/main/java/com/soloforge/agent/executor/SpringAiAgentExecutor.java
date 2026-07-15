package com.soloforge.agent.executor;

import com.soloforge.agent.advisor.SystemPromptBuilder;
import com.soloforge.agent.aisociety.*;
import com.soloforge.agent.config.DynamicChatModelResolver;
import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.llm.LlmCommandCenter;
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
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

    public SpringAiAgentExecutor(
            DynamicChatModelResolver modelResolver,
            SystemPromptBuilder promptBuilder,
            AgentIdentityRepository agentRepo,
            LawClient lawClient, EconomyClient economyClient,
            ReputationClient reputationClient, MarlTrainingClient marlTrainingClient,
            MemoryClient memoryClient, CultureClient cultureClient,
            CoalitionClient coalitionClient, InstitutionClient institutionClient,
            CaseRetriever caseRetriever, LlmCommandCenter commandCenter,
            SoloForgeTools soloForgeTools) {
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
        String systemPrompt = promptBuilder.build(agent, settings, null);
        ChatModel chatModel = modelResolver.resolve(provider);
        ChatClient chatClient = ChatClient.builder(chatModel).defaultTools(soloForgeTools).build();
        java.util.Map<String, Object> ctx = new java.util.HashMap<>();
        ctx.put("agent_id", agentId);
        ctx.put("provider_base_url", provider.getBaseUrl());
        ctx.put("provider_model", provider.getModel());
        String pKey = LlmCommandCenter.providerKey(provider.getBaseUrl(), provider.getModel());
        String response = null;
        for (int attempt = 0; attempt <= 3; attempt++) {
            LlmCommandCenter.LlmDecision d = commandCenter.evaluate(provider.getBaseUrl(), provider.getModel(), provider.getRateLimitProfile());
            if (d.action == LlmCommandCenter.LlmDecision.Action.REJECT)
                throw new RuntimeException("CommandCenter rejected: " + d.reason);
            if (d.action == LlmCommandCenter.LlmDecision.Action.WAIT)
                try { Thread.sleep(d.waitMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            try {
                long t0 = System.currentTimeMillis();
                response = chatClient.prompt().system(systemPrompt).user(userMessage).toolContext(ctx)
                        .options(org.springframework.ai.chat.prompt.ChatOptions.builder()
                                .temperature(settings.getTemperature() != null ? settings.getTemperature() : 0.3).build())
                        .call().content();
                commandCenter.recordSuccess(pKey, System.currentTimeMillis() - t0);
                break;
            } catch (Exception e) {
                int sc = LlmCommandCenter.extractStatusCode(e);
                commandCenter.recordFailure(pKey, sc);
                if (commandCenter.shouldRetry(e, attempt) && attempt < 3) {
                    commandCenter.waitBeforeRetry(e, attempt);
                    continue;
                }
                throw e;
            } finally {
                commandCenter.release(pKey);
            }
        }
        if (response == null) throw new RuntimeException("LLM call exhausted");
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
        String systemPrompt = promptBuilder.build(agent, settings, null);
        ChatModel chatModel = modelResolver.resolve(provider);
        ChatClient chatClient = ChatClient.builder(chatModel).defaultTools(soloForgeTools).build();
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
            log.info("[SpringAiExec] side effects done for agent={}", agent.getId());
        } catch (Exception e) {
            log.error("[SpringAiExec] side effects failed: {}", e.getMessage(), e);
        }
    }

    private String buildObservation(AgentIdentityEntity agent, String response) {
        return String.format("{\"agentId\":\"%s\",\"agentName\":\"%s\",\"responseLength\":%d}",
                agent.getId(), agent.getName(), response.length());
    }

    private String extractAction(String response) {
        if (response == null || response.isBlank()) return "unknown";
        String[] parts = response.split("[\\s\\u3002\\uFF01\\uFF1F]", 3);
        return parts[0].length() > 20 ? parts[0].substring(0, 20) : parts[0];
    }
}
