package com.soloforge.agent.advisor;

import com.soloforge.agent.pool.PoolManager;
import org.slf4j.MDC;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.metadata.ChatResponseMetadata;
import org.springframework.ai.chat.metadata.Usage;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * AuditAdvisor — tracks token usage and logs audit info.
 *
 * <p>Tracks token usage and logs audit info. The SSE stream controller
 * (MultiWorkerExecutionService) reports aggregate usage via the SSE
 * "usage" event.
 */
@Component
@Order(7)
public class AuditAdvisor implements CallAdvisor, Ordered {
    private static final Logger log = LoggerFactory.getLogger(AuditAdvisor.class);
    private static final String MDC_DISPATCH_ID = "dispatchId";
    private static final String MDC_WORKER_IDX = "workerIdx";
    private final PoolManager poolManager;

    public AuditAdvisor(PoolManager poolManager) {
        this.poolManager = poolManager;
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        String dispatchId = String.valueOf(request.context().getOrDefault("dispatchId", "unknown"));
        int workerIdx = Integer.parseInt(String.valueOf(request.context().getOrDefault("workerIdx", "-1")));

        try {
            MDC.put(MDC_DISPATCH_ID, dispatchId);
            MDC.put(MDC_WORKER_IDX, String.valueOf(workerIdx));
            log.info("AuditAdvisor: tracking request promptLength={}", request.prompt() != null ? request.prompt().getInstructions().size() : 0);

            ChatClientResponse response = chain.nextCall(request);

            if (response.chatResponse() != null) {
                reportTokenUsage(dispatchId, workerIdx, response.chatResponse());
            }

            return response;
        } finally {
            MDC.remove(MDC_DISPATCH_ID);
            MDC.remove(MDC_WORKER_IDX);
        }
    }

    private void reportTokenUsage(String dispatchId, int workerIdx, ChatResponse response) {
        ChatResponseMetadata metadata = response.getMetadata();
        if (metadata == null || metadata.getUsage() == null) {
            return;
        }

        Usage usage = metadata.getUsage();
        long promptTokensNum = toLong(usage.getPromptTokens());
        long completionTokensNum = toLong(usage.getCompletionTokens());
        long totalTokensNum = toLong(usage.getTotalTokens());

        log.info("Token usage - dispatchId={}, workerIdx={}, prompt={}, completion={}, total={}",
                dispatchId, workerIdx, promptTokensNum, completionTokensNum, totalTokensNum);
    }

    private long toLong(Object value) {
        if (value instanceof Number n) {
            return n.longValue();
        }
        if (value instanceof String s) {
            try {
                return Long.parseLong(s);
            } catch (NumberFormatException e) {
                return 0L;
            }
        }
        return 0L;
    }

    @Override
    public int getOrder() {
        return 7;
    }

    @Override
    public String getName() {
        return "AuditAdvisor";
    }
}
