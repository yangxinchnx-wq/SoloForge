package com.soloforge.agent.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Remote tool executor — awaits tool results from the frontend via HTTP callback.
 *
 * <p>Previous implementation forwarded tool calls via TCP to RACER (Node.js).
 * With the TCP transport removed, this class now serves as a pending-future
 * registry: the SSE stream sends a {@code tool_started} event to the frontend,
 * and the frontend POSTs the result back to a Java endpoint which calls
 * {@link #completeToolResult}.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Registers a {@link CompletableFuture} keyed by {@code dispatchId + ":" + workerIdx}</li>
 *   <li>The HTTP callback endpoint calls {@link #completeToolResult} to resolve the future</li>
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

    private final ObjectMapper objectMapper;

    /** Map of "dispatchId:workerIdx" -> pending future. */
    private final ConcurrentHashMap<String, CompletableFuture<String>> pending = new ConcurrentHashMap<>();

    public RemoteToolExecutor(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /**
     * Execute a remote tool and block until the result arrives via HTTP callback.
     *
     * <p>The caller (MultiWorkerExecutionService) should emit a {@code tool_started}
     * SSE event before calling this method, so the frontend knows to execute
     * the tool and POST the result back.
     *
     * @param dispatchId the dispatch ID for correlation
     * @param workerIdx  the worker index
     * @param toolName   the tool name (e.g., {@code browser_devtools})
     * @param toolArgs   the tool arguments (will be JSON-serialised if not already)
     * @return the raw tool result, or an error string if execution failed
     */
    public String execute(String dispatchId, int workerIdx, String toolName, Object toolArgs) {
        String key = key(dispatchId, workerIdx);
        CompletableFuture<String> future = new CompletableFuture<>();
        pending.put(key, future);

        log.info("Remote tool execution pending: tool={}, key={}", toolName, key);

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
     * Called by the HTTP callback endpoint when a tool result arrives
     * from the frontend.
     *
     * @param dispatchId the dispatch ID for correlation
     * @param workerIdx  the worker index
     * @param result     the tool result (may be null if error)
     * @param error      error message (null if success)
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
