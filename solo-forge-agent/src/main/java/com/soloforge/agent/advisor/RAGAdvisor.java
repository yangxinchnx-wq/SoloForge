package com.soloforge.agent.advisor;

import com.soloforge.agent.persistence.ExperienceCaseRepository;
import com.soloforge.agent.pool.PoolEntry;
import com.soloforge.agent.pool.PoolManager;
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

/**
 * RAGAdvisor - retrieves similar cases from experience_case table.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Queries experience_case table for similar historical cases</li>
 *   <li>Stores results in MessagePool.ragEntries so all workers can see them</li>
 *   <li>Only retrieves once per dispatch, shared across all workers</li>
 *   <li>Uses simple keyword matching for now (can upgrade to vector search later)</li>
 * </ul>
 */
@Component
@Order(3)
public class RAGAdvisor implements CallAdvisor, Ordered {
    private static final Logger log = LoggerFactory.getLogger(RAGAdvisor.class);
    private final ExperienceCaseRepository experienceCaseRepository;
    private final PoolManager poolManager;

    public RAGAdvisor(ExperienceCaseRepository experienceCaseRepository, PoolManager poolManager) {
        this.experienceCaseRepository = experienceCaseRepository;
        this.poolManager = poolManager;
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        log.debug("RAGAdvisor: retrieving similar cases");
        // Actual retrieval logic would be here
        return chain.nextCall(request);
    }

    @Override
    public int getOrder() {
        return 3;
    }

    @Override
    public String getName() {
        return "RAGAdvisor";
    }

    public void retrieveAndShare(String chatId, String userMessage) {
        // Retrieve similar cases from experience_case table
        // Non-fatal: if RAG fails, dispatch proceeds without RAG context
        List<String> similarCases;
        try {
            similarCases = experienceCaseRepository.findSimilarCases(userMessage);
        } catch (Exception e) {
            log.warn("RAG retrieval failed (non-fatal), proceeding without RAG context: {}", e.getMessage());
            return;
        }
        if (similarCases.isEmpty()) {
            log.info("No similar cases found for chatId={}", chatId);
            return;
        }

        // Store in MessagePool for all workers
        com.soloforge.agent.pool.MessagePool pool = poolManager.getOrCreate(chatId);
        int i = 0;
        for (String caseContent : similarCases) {
            PoolEntry entry = PoolEntry.of(-1, "rag", com.soloforge.agent.pool.EntryType.OUTPUT, caseContent);
            pool.putRagEntry("rag_" + i++, entry);
        }

        log.info("RAG retrieved {} similar cases for chatId={}", similarCases.size(), chatId);
    }
}
