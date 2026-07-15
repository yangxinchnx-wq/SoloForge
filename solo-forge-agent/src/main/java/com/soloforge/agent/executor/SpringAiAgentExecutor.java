package com.soloforge.agent.executor;

import com.soloforge.agent.advisor.SystemPromptBuilder;
import com.soloforge.agent.aisociety.*;
import com.soloforge.agent.config.DynamicChatModelResolver;
import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.llm.LlmRateLimiter;
import com.soloforge.agent.tools.SoloForgeTools;
import com.soloforge.agent.advisor.SoloForgeAdvisors.LegalCheckAdvisor;
import com.soloforge.agent.advisor.SoloForgeAdvisors.CreditCheckAdvisor;
import com.soloforge.agent.advisor.SoloForgeAdvisors.PostCallAdvisor;
import com.soloforge.agent.tools.SoloForgeTools;
import com.soloforge.agent.advisor.SoloForgeAdvisors.LegalCheckAdvisor;
import com.soloforge.agent.advisor.SoloForgeAdvisors.CreditCheckAdvisor;
import com.soloforge.agent.advisor.SoloForgeAdvisors.PostCallAdvisor;
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
 * Spring AI 2.0 Agent 鎵ц鍣?鈥?鏇夸唬鍘?AgentExecutor 鐨勬墜鍔?Function Calling 寰幆
 *
 * <p>鏍稿績鍙樺寲锛? * <ul>
 *   <li>鎵嬪姩 for 寰幆 (maxRounds=8) 鈫?{@code ToolCallingAdvisor} 鑷姩椹卞姩</li>
 *   <li>LlmGateway.chatCompletion() 鈫?{@link ChatClient#call()}</li>
 *   <li>ToolRegistry.invoke() switch 璺敱 鈫?@Tool 娉ㄨВ鑷姩娉ㄥ唽</li>
 * </ul>
 *
 * <p>淇濈暀涓嶅彉鐨勪笟鍔￠€昏緫锛堝崰鍘熶唬鐮?70%+锛夛細
 * <ul>
 *   <li>娉曞緥妫€鏌?(LawClient)</li>
 *   <li>淇＄敤鍒嗘鏌?(EconomyClient)</li>
 *   <li>SystemPromptBuilder 鏋勫缓</li>
 *   <li>鍚庣疆鍓綔鐢?(MARL 璁粌杞ㄨ抗 / 澹版湜鎺ㄩ€?</li>
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
    private final LlmRateLimiter rateLimiter;
    private final SoloForgeTools soloForgeTools;
    private final LegalCheckAdvisor legalCheckAdvisor;
    private final CreditCheckAdvisor creditCheckAdvisor;
    private final PostCallAdvisor postCallAdvisor;
    private final SoloForgeTools soloForgeTools;
    private final LegalCheckAdvisor legalCheckAdvisor;
    private final CreditCheckAdvisor creditCheckAdvisor;
    private final PostCallAdvisor postCallAdvisor;

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
            CaseRetriever caseRetriever, LlmRateLimiter rateLimiter,
            SoloForgeTools soloForgeTools, LegalCheckAdvisor legalCheckAdvisor,
            CreditCheckAdvisor creditCheckAdvisor, PostCallAdvisor postCallAdvisor) {
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

    public String execute(String userMessage, ChatRequest request) {
        String agentId = request.getSettings().getAgentId();
        ChatSettings settings = request.getSettings();
        ChatRequest.LlmProvider provider = request.getProvider();
        log.info("[SpringAiExec] agent={} provider={}", agentId, provider);
        AgentIdentityEntity agent = agentRepo.findById(agentId)
                .orElseThrow(() -> new IllegalArgumentException("Agent not found: " + agentId));
        if (!lawClient.checkLegal(agentId, settings)) {
            return "Blocked: legal compliance check failed";
        }
        if (!economyClient.checkCreditScore(agentId, settings)) {
            return "Blocked: credit score insufficient";
        }
        String systemPrompt = promptBuilder.build(agent, settings, null);
        ChatModel chatModel = modelResolver.resolve(provider);
        ChatClient chatClient = ChatClient.builder(chatModel)
                .defaultTools(soloForgeTools)
                .defaultAdvisors(legalCheckAdvisor, creditCheckAdvisor, rateLimitAdvisor, postCallAdvisor)
                .build();
        java.util.Map<String, Object> ctx = new java.util.HashMap<>();
        ctx.put("agent_id", agentId);
        ctx.put("provider_base_url", provider.getBaseUrl());
        ctx.put("provider_model", provider.getModel());
        String response = chatClient.prompt()
                .system(systemPrompt)
                .user(userMessage)
                .toolContext(ctx)
                .options(org.springframework.ai.chat.prompt.ChatOptions.builder()
                        .temperature(settings.getTemperature() != null ? settings.getTemperature() : 0.3)
                        .build())
                .call()
                .content();
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
        if (!lawClient.checkLegal(agentId, settings)) {
            return reactor.core.publisher.Flux.just("Blocked: legal compliance check failed");
        }
        if (!economyClient.checkCreditScore(agentId, settings)) {
            return reactor.core.publisher.Flux.just("Blocked: credit score insufficient");
        }
        String systemPrompt = promptBuilder.build(agent, settings, null);
        ChatModel chatModel = modelResolver.resolve(provider);
        ChatClient chatClient = ChatClient.builder(chatModel)
                .defaultTools(soloForgeTools)
                .defaultAdvisors(legalCheckAdvisor, creditCheckAdvisor, rateLimitAdvisor, postCallAdvisor)
                .build();
        java.util.Map<String, Object> ctx = new java.util.HashMap<>();
        ctx.put("agent_id", agentId);
        ctx.put("provider_base_url", provider.getBaseUrl());
        ctx.put("provider_model", provider.getModel());
        String pKey = LlmRateLimiter.providerKey(provider.getBaseUrl(), provider.getModel());
        rateLimiter.waitForRpmSlot(pKey);
        rateLimiter.acquire(pKey);
        reactor.core.publisher.Flux<ChatResponse> responseFlux = chatClient.prompt()
                .system(systemPrompt)
                .user(userMessage)
                .toolContext(ctx)
                .options(org.springframework.ai.chat.prompt.ChatOptions.builder()
                        .temperature(settings.getTemperature() != null ? settings.getTemperature() : 0.3)
                        .build())
                .stream()
                .chatResponse()
                .doOnTerminate(() -> rateLimiter.release(pKey))
                .doOnCancel(() -> rateLimiter.release(pKey))
                .doOnError(e -> {
                    rateLimiter.release(pKey);
                    int sc = LlmRateLimiter.extractStatusCode(e);
                    if (sc == 429 || sc == 503) rateLimiter.record429(pKey);
                });
        return new StreamingResponseAdapter().adapt(responseFlux);
    }

    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    // 鍚庣疆鍓綔鐢紙浠庡師 AgentExecutor 瀹屾暣淇濈暀锛?    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    private void postExecuteSideEffects(AgentIdentityEntity agent, String response, ChatSettings settings) {
        try {
            // 鎺ㄩ€?MARL 璁粌杞ㄨ抗
            marlTrainingClient.pushTrace(
                    agent.getId(),
                    buildObservation(agent, response),
                    extractAction(response),
                    0.3
            );

            // 鏇存柊澹版湜
            reputationClient.pushReputationSync(agent.getId(), Map.of(
                    "lastAction", extractAction(response),
                    "timestamp", System.currentTimeMillis()
            ));

            // 鎸佷箙鍖栬蹇?            memoryClient.storeMemory(agent.getId(), "user", response);

            // 鏂囧寲褰卞搷璇勪及
            cultureClient.evaluateCulturalImpact(agent.getId(), response);

            // 鑱旂洘褰卞搷
            coalitionClient.recordCoalitionAction(agent.getId(), extractAction(response));

            // 鍒跺害褰卞搷
            institutionClient.recordInstitutionalInteraction(agent.getId(), response);

            log.info("[SpringAiExec] post-execute side effects completed for agent={}", agent.getId());
        } catch (Exception e) {
            log.error("[SpringAiExec] post-execute side effects failed: {}", e.getMessage(), e);
        }
    }

    private String buildObservation(AgentIdentityEntity agent, String response) {
        return String.format("{\"agentId\":\"%s\",\"agentName\":\"%s\",\"responseLength\\":%d}",
                agent.getId(), agent.getName(), response.length());
    }

    private String extractAction(String response) {
        // 绠€鍗曞惎鍙戝紡鎻愬彇鍔ㄤ綔璇嶏紙涓庡師 AgentExecutor 淇濇寔涓€鑷达級
        if (response == null || response.isBlank()) return "unknown";
        String[] parts = response.split("[\\s銆傦紒锛焆", 3);
        return parts[0].length() > 20 ? parts[0].substring(0, 20) : parts[0];
    }
}



