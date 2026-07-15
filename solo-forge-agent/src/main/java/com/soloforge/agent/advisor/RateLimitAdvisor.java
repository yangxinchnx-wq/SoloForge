package com.soloforge.agent.advisor;

import com.soloforge.agent.llm.LlmRateLimiter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.stereotype.Component;

/**
 * Rate Limit Advisor  LLM API +429
 *
 * <p> Spring AI Advisor  LegalCheckAdvisor/CreditCheckAdvisor
 *  Advisor 
 *
 * <p>
 * <ul>
 *   <li>   acquire Semaphore  release</li>
 *   <li>RPM    waitForRpmSlot</li>
 *   <li>429    429/503/5xx  Retry-After </li>
 * </ul>
 *
 * <p>HIGHEST_PRECEDENCE + 2
 *   / LLM 
 */
@Component
public class RateLimitAdvisor implements CallAdvisor {
    private static final Logger log = LoggerFactory.getLogger(RateLimitAdvisor.class);
    private final LlmRateLimiter rateLimiter;

    public RateLimitAdvisor(LlmRateLimiter rateLimiter) {
        this.rateLimiter = rateLimiter;
    }

    @Override
    public int getOrder() { return HIGHEST_PRECEDENCE + 2; }
    @Override
    public String getName() { return "RateLimitAdvisor"; }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        String pKey = extractProviderKey(request);
        if (pKey == null) {
            return chain.nextCall(request);
        }

        int maxRetries = 3;
        Exception lastError = null;
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            rateLimiter.waitForRpmSlot(pKey);
            rateLimiter.acquire(pKey);
            try {
                ChatClientResponse response = chain.nextCall(request);
                rateLimiter.recordSuccess(pKey);
                return response;
            } catch (Exception e) {
                int statusCode = LlmRateLimiter.extractStatusCode(e);
                if (rateLimiter.shouldRetry(statusCode, attempt) && attempt < maxRetries) {
                    Long retryAfter = LlmRateLimiter.extractRetryAfter(e);
                    log.warn("RateLimitAdvisor: LLM call failed (HTTP {}), retrying #{}/{}", statusCode, attempt + 1, maxRetries);
                    rateLimiter.record429(pKey);
                    rateLimiter.waitBeforeRetry(retryAfter, attempt);
                    lastError = e;
                    continue;
                }
                throw e;
            } finally {
                rateLimiter.release(pKey);
            }
        }
        throw new RuntimeException("LLM retries exhausted", lastError);
    }

    private String extractProviderKey(ChatClientRequest request) {
        if (request == null || request.context() == null) return null;
        Object baseUrl = request.context().get("provider_base_url");
        Object model = request.context().get("provider_model");
        if (baseUrl == null) return null;
        return LlmRateLimiter.providerKey(baseUrl.toString(), model != null ? model.toString() : "unknown");
    }
}

