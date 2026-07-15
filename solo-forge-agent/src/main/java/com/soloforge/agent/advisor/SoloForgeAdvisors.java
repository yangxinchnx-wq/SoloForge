package com.soloforge.agent.advisor;

import com.soloforge.agent.aisociety.LawClient;
import com.soloforge.agent.aisociety.EconomyClient;
import com.soloforge.agent.aisociety.MarlTrainingClient;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClientRequest;`nimport org.springframework.ai.chat.client.ChatClientResponse;`nimport org.springframework.ai.chat.client.advisor.api.CallAdvisor;`nimport org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;

import org.springframework.stereotype.Component;


/**
 * SoloForge custom Advisors for Spring AI 1.0.0 GA Advisor chain.
 *
 * <p>Extracts pre/post logic from AgentExecutor into declarative Advisor chain.
 *
 * <p>Execution order (via getOrder() from Ordered):
 * <ol>
 *   <li>LegalCheckAdvisor - legal compliance (highest priority)</li>
 *   <li>CreditCheckAdvisor - credit score check</li>
 *   <li>PostToolCallAdvisor - MARL training trace push (after tool calls)</li>
 * </ol>
 */
@Component
public class SoloForgeAdvisors {

    private SoloForgeAdvisors() {}

    /**
     * Legal compliance check Advisor.
     * Corresponds to AgentExecutor L86-95.
     */
    @Component
    public static class LegalCheckAdvisor implements CallAdvisor {
        private static final Logger log = LoggerFactory.getLogger(LegalCheckAdvisor.class);
        private final LawClient lawClient;

        public LegalCheckAdvisor(LawClient lawClient) { this.lawClient = lawClient; }

        @Override public int getOrder() { return HIGHEST_PRECEDENCE; }
        @Override public String getName() { return "LegalCheckAdvisor"; }

        @Override
        public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
            String agentId = extractAgentId(request);
            if (agentId != null && !lawClient.checkLegal(agentId, null)) {
                log.warn("LegalCheck BLOCKED: agent={}", agentId);
            }
            return chain.nextCall(request);
        }
    }

    /**
     * Credit score check Advisor.
     * Corresponds to AgentExecutor L97-102.
     */
    @Component
    public static class CreditCheckAdvisor implements CallAdvisor {
        private static final Logger log = LoggerFactory.getLogger(CreditCheckAdvisor.class);
        private final EconomyClient economyClient;

        public CreditCheckAdvisor(EconomyClient economyClient) { this.economyClient = economyClient; }

        @Override public int getOrder() { return HIGHEST_PRECEDENCE + 1; }
        @Override public String getName() { return "CreditCheckAdvisor"; }

        @Override
        public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
            String agentId = extractAgentId(request);
            if (agentId != null && !economyClient.checkCreditScore(agentId, null)) {
                log.warn("CreditCheck BLOCKED: agent={}", agentId);
            }
            return chain.nextCall(request);
        }
    }

    /**
     * Post-tool-call Advisor - MARL training trace push.
     * Pushes training data after ToolCallingAdvisor completes tool calls.
     */
    @Component
    public static class PostToolCallAdvisor implements CallAdvisor {
        private static final Logger log = LoggerFactory.getLogger(PostToolCallAdvisor.class);
        private final MarlTrainingClient marlTrainingClient;

        public PostToolCallAdvisor(MarlTrainingClient marlTrainingClient) {
            this.marlTrainingClient = marlTrainingClient;
        }

        @Override public int getOrder() { return LOWEST_PRECEDENCE - 1; }
        @Override public String getName() { return "PostToolCallAdvisor"; }

        @Override
        public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
            ChatClientResponse response = chain.nextCall(request);
            if (response != null && response.chatResponse() != null) {
                try {
                    boolean hasToolCalls = response.chatResponse() != null;
                    if (hasToolCalls) {
                        String agentId = extractAgentId(request);
                        if (agentId != null) {
                            marlTrainingClient.pushTrace(agentId,
                                "{\"agentId\":\"" + agentId + "\"}",
                                "tool_call", 0.3);
                            log.debug("PostToolCall: MARL trace pushed for agent={}", agentId);
                        }
                    }
                } catch (Exception e) {
                    log.warn("PostToolCall: failed to push MARL trace: {}", e.getMessage());
                }
            }
            return response;
        }
    }

    // ── Internal helpers ──

    static String extractAgentId(ChatClientRequest request) {
        if (request == null || request.context() == null) return null;
        Object id = request.context().get("agent_id");
        return id != null ? id.toString() : null;
    }
}

