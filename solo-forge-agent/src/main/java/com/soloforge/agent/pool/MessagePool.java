package com.soloforge.agent.pool;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Per-conversation message pool.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Pure in-memory ConcurrentHashMap, no external storage</li>
 *   <li>Isolated by chatId, no cross-conversation leakage</li>
 *   <li>Unbounded capacity; deduplication happens at Advisor level</li>
 *   <li>toolResults cache key = toolName + toolArgs hash</li>
 * </ul>
 */
public class MessagePool {
    private final String conversationId;
    private final long createdAt;
    private final ConcurrentLinkedQueue<PoolEntry> entries = new ConcurrentLinkedQueue<>();
    private final ConcurrentHashMap<String, String> toolResults = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Integer, WorkerState> workerStates = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, PoolEntry> ragEntries = new ConcurrentHashMap<>();

    public MessagePool(String conversationId) {
        this.conversationId = conversationId;
        this.createdAt = System.currentTimeMillis();
    }

    public String getConversationId() { return conversationId; }
    public long getCreatedAt() { return createdAt; }

    public synchronized void addEntry(PoolEntry entry) {
        entries.add(entry);
    }

    public ConcurrentLinkedQueue<PoolEntry> getEntries() { return entries; }

    public String getToolResult(String key) { return toolResults.get(key); }
    public void putToolResult(String key, String result) { toolResults.put(key, result); }

    public WorkerState getWorkerState(int workerIdx) {
        return workerStates.computeIfAbsent(workerIdx, k -> new WorkerState());
    }
    public ConcurrentHashMap<Integer, WorkerState> getWorkerStates() { return workerStates; }

    public PoolEntry getRagEntry(String key) { return ragEntries.get(key); }
    public void putRagEntry(String key, PoolEntry entry) { ragEntries.put(key, entry); }
    public ConcurrentHashMap<String, PoolEntry> getRagEntries() { return ragEntries; }
}
