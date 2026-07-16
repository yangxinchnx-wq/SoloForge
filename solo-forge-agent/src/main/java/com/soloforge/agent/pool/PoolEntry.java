package com.soloforge.agent.pool;

import java.time.Instant;

/**
 * A single entry in the MessagePool.
 *
 * @param timestamp     creation time
 * @param workerIdx     which worker produced this entry
 * @param agentId       which agent
 * @param type          entry type
 * @param content       content text
 * @param toolName      tool name if this is a tool call/result
 * @param toolArgs      tool arguments (JSON string)
 */
public record PoolEntry(
        long timestamp,
        int workerIdx,
        String agentId,
        EntryType type,
        String content,
        String toolName,
        String toolArgs
) {
    public static PoolEntry of(int workerIdx, String agentId, EntryType type, String content) {
        return new PoolEntry(Instant.now().toEpochMilli(), workerIdx, agentId, type, content, null, null);
    }

    public static PoolEntry toolCall(int workerIdx, String agentId, String toolName, String toolArgs) {
        return new PoolEntry(Instant.now().toEpochMilli(), workerIdx, agentId, EntryType.TOOL_CALL, null, toolName, toolArgs);
    }

    public static PoolEntry toolResult(int workerIdx, String agentId, String content, String toolName, String toolArgs) {
        return new PoolEntry(Instant.now().toEpochMilli(), workerIdx, agentId, EntryType.TOOL_RESULT, content, toolName, toolArgs);
    }

    public static PoolEntry thinking(int workerIdx, String agentId, String content) {
        return new PoolEntry(Instant.now().toEpochMilli(), workerIdx, agentId, EntryType.THINKING, content, null, null);
    }

    public static PoolEntry output(int workerIdx, String agentId, String content) {
        return new PoolEntry(Instant.now().toEpochMilli(), workerIdx, agentId, EntryType.OUTPUT, content, null, null);
    }
}
