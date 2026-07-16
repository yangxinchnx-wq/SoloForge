package com.soloforge.agent.advisor;

import com.soloforge.agent.pool.PoolManager;
import com.soloforge.agent.pool.PoolEntry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.stream.Collectors;

/**
 * PoolInjectAdvisor - injects context from other workers in the same dispatch.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Runs after SystemPromptAdvisor (higher order = later in chain)</li>
 *   <li>Injects last N messages from peer workers (excluding current worker)</li>
 *   <li>Injects RAG entries if available</li>
 *   <li>Keeps injection concise to preserve context window</li>
 * </ul>
 */
@Component
@Order(2)
public class PoolInjectAdvisor implements CallAdvisor, Ordered {
    private static final Logger log = LoggerFactory.getLogger(PoolInjectAdvisor.class);
    private static final int MAX_INJECTED_MESSAGES = 10;
    private final PoolManager poolManager;

    public PoolInjectAdvisor(PoolManager poolManager) {
        this.poolManager = poolManager;
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        String chatId = String.valueOf(request.context().getOrDefault("chatId", "unknown"));
        int workerIdx = Integer.parseInt(String.valueOf(request.context().getOrDefault("workerIdx", "-1")));
        if (workerIdx < 0) {
            return chain.nextCall(request);
        }

        String injectedContext = injectPoolContext(chatId, workerIdx);
        if (injectedContext.isEmpty()) {
            return chain.nextCall(request);
        }

        log.info("PoolInjectAdvisor: injecting context for worker {}", workerIdx);

        try {
            ChatClientRequest modifiedRequest = new org.springframework.ai.chat.client.ChatClientRequest(
                    new org.springframework.ai.chat.prompt.Prompt(
                            List.of(new org.springframework.ai.chat.messages.SystemMessage(injectedContext))
                    ),
                    request.context()
            );
            return chain.nextCall(modifiedRequest);
        } catch (Exception e) {
            log.error("PoolInjectAdvisor: failed to inject context", e);
            return chain.nextCall(request);
        }
    }

    @Override
    public int getOrder() {
        return 2;
    }

    @Override
    public String getName() {
        return "PoolInjectAdvisor";
    }

    public String injectPoolContext(String chatId, int workerIdx) {
        com.soloforge.agent.pool.MessagePool pool = poolManager.get(chatId);
        if (pool == null) {
            return "";
        }

        StringBuilder context = new StringBuilder();
        context.append("\n[Context from other workers]\n");

        // Get recent messages from other workers
        List<PoolEntry> peerEntries = pool.getEntries().stream()
                .filter(e -> e.workerIdx() != workerIdx)
                .sorted((a, b) -> Long.compare(b.timestamp(), a.timestamp()))
                .limit(MAX_INJECTED_MESSAGES)
                .toList();

        for (PoolEntry entry : peerEntries) {
            context.append(String.format("[Worker %d (%s)] %s: %s\n",
                    entry.workerIdx(), entry.agentId(), entry.type(), entry.content()));
        }

        // Inject RAG entries
        if (!pool.getRagEntries().isEmpty()) {
            context.append("\n[Similar cases from knowledge base]\n");
            for (PoolEntry ragEntry : pool.getRagEntries().values()) {
                context.append(ragEntry.content()).append("\n");
            }
        }

        return context.toString();
    }
}
