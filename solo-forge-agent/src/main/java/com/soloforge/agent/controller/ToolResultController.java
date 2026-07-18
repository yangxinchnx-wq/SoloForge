package com.soloforge.agent.controller;

import com.soloforge.agent.tools.RemoteToolExecutor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * Tool result callback controller.
 *
 * <p>The Java Agent sends {@code phase1_tool_start} SSE events when a remote/MCP
 * tool call is delegated to the frontend. The frontend executes the tool and
 * POSTs the result back to this endpoint, which resolves the pending future
 * in {@link RemoteToolExecutor}.
 *
 * <p>Endpoint: {@code POST /api/tool/result}
 */
@RestController
@RequestMapping("/api/tool")
public class ToolResultController {
    private static final Logger log = LoggerFactory.getLogger(ToolResultController.class);

    private final RemoteToolExecutor remoteToolExecutor;

    public ToolResultController(RemoteToolExecutor remoteToolExecutor) {
        this.remoteToolExecutor = remoteToolExecutor;
    }

    /**
     * Receive a tool execution result from the frontend.
     *
     * <p>Request body:
     * <pre>{@code
     * {
     *   "dispatchId": "dispatch-123",
     *   "workerIdx": 0,
     *   "result": "tool output...",
     *   "error": null  // non-null if the tool failed
     * }
     * }</pre>
     */
    @PostMapping("/result")
    public Map<String, Object> receiveToolResult(@RequestBody Map<String, Object> body) {
        String dispatchId = (String) body.get("dispatchId");
        int workerIdx = ((Number) body.getOrDefault("workerIdx", 0)).intValue();
        String result = (String) body.get("result");
        String error = (String) body.get("error");

        log.info("Received tool result: dispatchId={}, workerIdx={}, hasError={}",
                dispatchId, workerIdx, error != null && !error.isBlank());

        remoteToolExecutor.completeToolResult(dispatchId, workerIdx, result, error);

        return Map.of("ok", true);
    }
}
