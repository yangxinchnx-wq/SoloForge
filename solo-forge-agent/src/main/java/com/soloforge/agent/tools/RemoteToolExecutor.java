package com.soloforge.agent.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.soloforge.agent.transport.RacerTcpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Remote tool executor that forwards tool calls to RACER and awaits the result.
 *
 * <p>RACER acts as a pure relay (dumb pipe) - it receives the tool_execute from Java,
 * runs it via the appropriate backend (Obscura, Browser-Use, Windows-MCP), and
 * returns the raw result without any LLM processing.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Sends {@code tool_execute} message over TCP to RACER</li>
 *   <li>Registers a {@link CompletableFuture} keyed by {@code dispatchId + ":" + workerIdx}</li>
 *   <li>{@link com.soloforge.agent.transport.TcpMessageRouter#handleToolResult} completes
 *       the future when the matching {@code tool_result} arrives</li>
 *   <li>Single in-flight tool call per worker — a second call from the same worker
 *       before the first resolves will replace the pending future</li>
 * </ul>
 */
@Component
public class RemoteToolExecutor {
    private static final Logger log = LoggerFactory.getLogger(RemoteToolExecutor.class);

    /** Tool call wait timeout (seconds). Kept below the LLM timeout so a stalled
     *  tool call fails before the worker future times out. */
    public static final long TOOL_WAIT_SECONDS = 20;

    private final RacerTcpClient tcpClient;
    private final ObjectMapper objectMapper;

    /** Map of "dispatchId:workerIdx" -> pending future. */
    private final ConcurrentHashMap<String, CompletableFuture<String>> pending = new ConcurrentHashMap<>();

    public RemoteToolExecutor(RacerTcpClient tcpClient, ObjectMapper objectMapper) {
        this.tcpClient = tcpClient;
        this.objectMapper = objectMapper;
    }

    /**
     * Execute a remote tool via RACER and block until the result arrives.
     *
     * @param dispatchId the dispatch ID for correlation
     * @param workerIdx  the worker index
     * @param toolName   the tool name (e.g., {@code browser_devtools})
     * @param toolArgs   the tool arguments (will be JSON-serialised if not already)
     * @return the raw tool result from RACER, or an error string if execution failed
     */
    public String execute(String dispatchId, int workerIdx, String toolName, Object toolArgs) {
        String key = key(dispatchId, workerIdx);
        CompletableFuture<String> future = new CompletableFuture<>();
        pending.put(key, future);

        try {
            String argsJson = (toolArgs instanceof String s) ? s : objectMapper.writeValueAsString(toolArgs);
            String message = String.format(
                    "{\"type\":\"tool_execute\",\"dispatchId\":\"%s\",\"workerIdx\":%d,\"tool\":\"%s\",\"args\":%s}",
                    dispatchId, workerIdx, toolName, argsJson
            );

            log.info("Remote tool execution: tool={}, args={}, key={}", toolName, argsJson, key);
            tcpClient.send(message);
        } catch (Exception e) {
            pending.remove(key);
            log.error("Failed to send tool_execute for tool={}: {}", toolName, e.getMessage());
            return "ERROR: " + e.getMessage();
        }

        try {
            return future.get(TOOL_WAIT_SECONDS, TimeUnit.SECONDS);
        } catch (TimeoutException te) {
            log.warn("Tool execution timed out after {}s: tool={}, key={}", TOOL_WAIT_SECONDS, toolName, key);
            return "ERROR: Tool execution timed out";
        } catch (Exception e) {
            log.error("Tool execution failed: tool={}, key={}", toolName, key, e);
            return "ERROR: " + e.getMessage();
        } finally {
            pending.remove(key, future);
        }
    }

    /**
     * Called by {@link com.soloforge.agent.transport.TcpMessageRouter} when a
     * matching {@code tool_result} message arrives from RACER.
     */
    public void completeToolResult(String dispatchId, int workerIdx, String result, String error) {
        String key = key(dispatchId, workerIdx);
        CompletableFuture<String> future = pending.get(key);
        if (future == null) {
            log.warn("Received tool_result with no pending future: key={}", key);
            return;
        }
        if (error != null && !error.isBlank()) {
            future.complete("ERROR: " + error);
        } else {
            future.complete(result);
        }
        log.info("Completed pending tool future: key={}, hasError={}", key, error != null && !error.isBlank());
    }

    private static String key(String dispatchId, int workerIdx) {
        return dispatchId + ":" + workerIdx;
    }
}
