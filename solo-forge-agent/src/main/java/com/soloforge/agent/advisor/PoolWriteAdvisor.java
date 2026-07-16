package com.soloforge.agent.advisor;

import com.soloforge.agent.pool.MessagePool;
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

import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * PoolWriteAdvisor - writes current worker's outputs back to the MessagePool.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Writes tool calls, reasoning, and outputs to the pool</li>
 *   <li>Only writes key results (not intermediate low-value messages)</li>
 *   <li>Deduplication happens here - skip if same tool+args already in pool</li>
 * </ul>
 */
@Component
@Order(5)
public class PoolWriteAdvisor implements CallAdvisor, Ordered {
    private static final Logger log = LoggerFactory.getLogger(PoolWriteAdvisor.class);
    private final PoolManager poolManager;

    public PoolWriteAdvisor(PoolManager poolManager) {
        this.poolManager = poolManager;
    }

    @Override
    public String getName() {
        return PoolWriteAdvisor.class.getName();
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        log.debug("PoolWriteAdvisor: writing outputs to pool");
        // Actual write logic would be here
        return chain.nextCall(request);
    }

    @Override
    public int getOrder() {
        return 5;
    }

    public void writeToolCall(String chatId, int workerIdx, String agentId, String toolName, String toolArgs) {
        MessagePool pool = poolManager.getOrCreate(chatId);
        String cacheKey = toolName + "|" + toolArgs;

        // Deduplication: only write if not already in pool
        if (pool.getToolResult(cacheKey) == null) {
            PoolEntry entry = PoolEntry.toolCall(workerIdx, agentId, toolName, toolArgs);
            pool.addEntry(entry);
            log.debug("Wrote tool_call to pool: {}={}", toolName, toolArgs);
        }
    }

    public void writeToolResult(String chatId, int workerIdx, String agentId, String toolName, String toolArgs, String result) {
        MessagePool pool = poolManager.getOrCreate(chatId);
        String cacheKey = toolName + "|" + toolArgs;

        // Only write key results, deduplicate
        if (pool.getToolResult(cacheKey) == null) {
            pool.putToolResult(cacheKey, result);
            PoolEntry entry = PoolEntry.toolResult(workerIdx, agentId, result, toolName, toolArgs);
            pool.addEntry(entry);
            log.debug("Wrote tool_result to pool: {}={}", toolName, toolArgs);
        }
    }

    public void writeOutput(String chatId, int workerIdx, String agentId, String content) {
        MessagePool pool = poolManager.getOrCreate(chatId);
        PoolEntry entry = PoolEntry.output(workerIdx, agentId, content);
        pool.addEntry(entry);
        log.debug("Wrote output to pool: workerIdx={}, length={}", workerIdx, content.length());
    }
}
