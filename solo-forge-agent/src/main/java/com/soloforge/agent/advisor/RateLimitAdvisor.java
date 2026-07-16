package com.soloforge.agent.advisor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.ai.chat.metadata.ChatResponseMetadata;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * RateLimitAdvisor - shared quota pool with dynamic calibration.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Quota pool per provider+model, shared by all workers</li>
 *   <li>Data sources (priority high to low):
 *     <ol>
 *       <li>Runtime 429 dynamic calibration (most accurate)</li>
 *       <li>Probe detection from LLM response headers</li>
 *       <li>User manual entry (fallback)</li>
 *     </ol>
 *   </li>
 *   <li>429 received -> read Retry-After, dynamically lower limit for 60s</li>
 *   <li>Non-blocking to other workers</li>
 * </ul>
 */
@Component
@Order(6)
public class RateLimitAdvisor implements CallAdvisor, Ordered {
    private static final Logger log = LoggerFactory.getLogger(RateLimitAdvisor.class);
    private static final int DEFAULT_RPM = 60;
    private static final int DEFAULT_TPM = 100000;
    private static final int DEFAULT_CONCURRENT = 5;

    private final ChatModel defaultChatModel;
    private final Map<String, RateLimitPool> pools = new ConcurrentHashMap<>();

    public RateLimitAdvisor(ChatModel defaultChatModel) {
        this.defaultChatModel = defaultChatModel;
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        String provider = (String) request.context().getOrDefault("provider", "openai");
        String model = (String) request.context().getOrDefault("model", "gpt-4o");

        RateLimitPool pool = getOrCreatePool(provider, model, request);

        // Estimate tokens (simplified - in production use tokenizer)
        int estimatedTokens = estimateTokens(request.prompt());

        // Wait for slot if needed (non-blocking retry)
        int waitAttempts = 0;
        while (!pool.tryAcquire(estimatedTokens) && waitAttempts < 10) {
            try {
                Thread.sleep(1000); // wait 1s and retry
                waitAttempts++;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("Interrupted while waiting for rate limit slot", e);
            }
        }

        if (waitAttempts >= 10) {
            log.warn("Rate limit exhausted for {}/{}, returning error", provider, model);
            // Return error response
            throw new RuntimeException("Rate limit exhausted for " + provider + "/" + model);
        }

        try {
            // Proceed with the LLM call
            ChatClientResponse response = chain.nextCall(request);

            // Check for 429 in response
            if (response.chatResponse() != null) {
                handleResponse(provider, model, pool, response.chatResponse());
            }

            return response;
        } finally {
            // Release the slot
            pool.release(estimatedTokens);
        }
    }

    private RateLimitPool getOrCreatePool(String provider, String model, ChatClientRequest request) {
        return pools.computeIfAbsent(provider + "/" + model, key -> {
            // Priority 1: rateLimitProfile from request (frontend model config)
            Object rateLimitProfile = request.context().get("rateLimitProfile");
            if (rateLimitProfile instanceof Map<?, ?> profile) {
                try {
                    int rpm = toInt(profile.get("maxRpm"));
                    int tpm = toInt(profile.get("maxTpm"));
                    int concurrent = toInt(profile.get("maxConcurrent"));
                    log.info("Creating rate limit pool from profile: {}/{}, rpm={}, tpm={}, concurrent={}", provider, model, rpm, tpm, concurrent);
                    return new RateLimitPool(provider, model, rpm, tpm, concurrent);
                } catch (Exception e) {
                    log.warn("Failed to parse rateLimitProfile, using defaults", e);
                }
            }

            // Priority 2: Probe detection from LLM response headers
            // TODO: Implement HTTP client probe to extract rate limits from provider response headers
            // This requires custom HTTP client access since Spring AI abstracts the transport layer
            // For now, use defaults

            // Priority 3: Defaults
            log.info("Creating default rate limit pool: {}/{}, rpm={}, tpm={}, concurrent={}", provider, model, DEFAULT_RPM, DEFAULT_TPM, DEFAULT_CONCURRENT);
            return new RateLimitPool(provider, model, DEFAULT_RPM, DEFAULT_TPM, DEFAULT_CONCURRENT);
        });
    }

    private int toInt(Object value) {
        if (value instanceof Number n) {
            return n.intValue();
        }
        if (value instanceof String s) {
            try {
                return Integer.parseInt(s);
            } catch (NumberFormatException e) {
                return -1;
            }
        }
        return -1;
    }

    private void handleResponse(String provider, String model, RateLimitPool pool, ChatResponse response) {
        // Check metadata for rate limit info
        ChatResponseMetadata metadata = response.getMetadata();
        if (metadata != null && metadata.getRateLimit() != null) {
            pool.handle429(60L);
            log.warn("Rate limit hit for {}/{}, adjusted pool for {}s", provider, model, 60);
        }
    }

    private long extractRetryAfter(Map<String, Object> metadata) {
        // Try to get Retry-After from response headers (if available)
        Object retryAfter = metadata.get("retryAfter");
        if (retryAfter instanceof Number n) {
            return n.longValue();
        }
        if (retryAfter instanceof String s) {
            try {
                return Long.parseLong(s);
            } catch (NumberFormatException e) {
                // ignore
            }
        }
        return 60; // default 60 seconds
    }

    private int estimateTokens(Object prompt) {
        // Simplified token estimation: ~1 token per 4 characters
        if (prompt == null) return 0;
        String text = prompt.toString();
        return Math.max(1, text.length() / 4);
    }

    @Override
    public int getOrder() {
        return 6;
    }

    @Override
    public String getName() {
        return "RateLimitAdvisor";
    }
}
