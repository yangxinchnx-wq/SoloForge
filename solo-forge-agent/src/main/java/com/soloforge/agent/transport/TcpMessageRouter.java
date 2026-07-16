package com.soloforge.agent.transport;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.soloforge.agent.executor.MultiWorkerExecutionService;
import com.soloforge.agent.executor.WorkerConfig;
import com.soloforge.agent.executor.WorkerStopRegistry;
import com.soloforge.agent.tools.RemoteToolExecutor;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Routes incoming TCP messages from RACER to the appropriate handlers.
 *
 * <p>Message types handled (RACER -> Java):
 * <ul>
 *   <li>{@code dispatch} — starts a multi-worker dispatch via {@link MultiWorkerExecutionService}</li>
 *   <li>{@code evaluate} — judge stop command; cancels the specified worker via {@link WorkerStopRegistry}</li>
 *   <li>{@code tool_result} — tool execution result from RACER, completes pending future in {@link RemoteToolExecutor}</li>
 *   <li>{@code ping} — handled directly by {@link TcpServer} (responds with pong)</li>
 * </ul>
 *
 * <p>Registers itself as the {@code onMessage} handler on {@link TcpServer} at construction time.
 */
@Component
public class TcpMessageRouter {
    private static final Logger log = LoggerFactory.getLogger(TcpMessageRouter.class);

    private final TcpServer tcpServer;
    private final MultiWorkerExecutionService executionService;
    private final RemoteToolExecutor remoteToolExecutor;
    private final WorkerStopRegistry workerStopRegistry;
    private final ObjectMapper objectMapper;
    private final ExecutorService dispatchExecutor = Executors.newCachedThreadPool();

    public TcpMessageRouter(TcpServer tcpServer,
                             MultiWorkerExecutionService executionService,
                             RemoteToolExecutor remoteToolExecutor,
                             WorkerStopRegistry workerStopRegistry,
                             ObjectMapper objectMapper) {
        this.tcpServer = tcpServer;
        this.executionService = executionService;
        this.remoteToolExecutor = remoteToolExecutor;
        this.workerStopRegistry = workerStopRegistry;
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    public void init() {
        tcpServer.setOnMessage(this::handleMessage);
        log.info("TcpMessageRouter registered as TCP onMessage handler");
    }

    @PreDestroy
    public void destroy() {
        dispatchExecutor.shutdown();
        try {
            if (!dispatchExecutor.awaitTermination(2, TimeUnit.SECONDS)) {
                dispatchExecutor.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @SuppressWarnings("unchecked")
    private void handleMessage(String line) {
        try {
            Map<String, Object> msg = objectMapper.readValue(line, Map.class);
            String type = (String) msg.get("type");

            if (type == null) {
                log.warn("Received message without 'type' field: {}", line);
                return;
            }

            switch (type) {
                case "dispatch" -> handleDispatch(msg);
                case "evaluate" -> handleEvaluate(msg);
                case "tool_result" -> handleToolResult(msg);
                default -> log.warn("Unknown message type '{}': {}", type, line);
            }
        } catch (Exception e) {
            log.error("Failed to handle TCP message: {}", line, e);
        }
    }

    /**
     * Handle a dispatch message by starting a multi-worker execution.
     * Runs asynchronously to avoid blocking the TCP reader thread.
     */
    @SuppressWarnings("unchecked")
    private void handleDispatch(Map<String, Object> msg) {
        String dispatchId = (String) msg.get("dispatchId");
        String chatId = (String) msg.get("chatId");
        String prompt = (String) msg.get("prompt");

        if (dispatchId == null || chatId == null) {
            log.warn("Dispatch message missing dispatchId or chatId: {}", msg);
            return;
        }

        List<Map<String, Object>> workersData = (List<Map<String, Object>>) msg.getOrDefault("workers", List.of());
        List<WorkerConfig> workers = new ArrayList<>();
        for (Map<String, Object> wd : workersData) {
            workers.add(parseWorker(wd));
        }

        List<Map<String, Object>> history = (List<Map<String, Object>>) msg.getOrDefault("history", List.of());
        Map<String, Object> settings = (Map<String, Object>) msg.getOrDefault("settings", Map.of());
        List<Map<String, Object>> tools = (List<Map<String, Object>>) msg.getOrDefault("tools", List.of());
        String permissionMode = (String) msg.getOrDefault("permissionMode", "normal");

        log.info("TCP dispatch received: dispatchId={}, chatId={}, workers={}", dispatchId, chatId, workers.size());

        // Run dispatch asynchronously (executeDispatch blocks until all workers complete)
        dispatchExecutor.submit(() -> {
            try {
                executionService.executeDispatch(dispatchId, chatId, workers, prompt, history, settings, tools, permissionMode);
            } catch (Exception e) {
                log.error("Dispatch execution failed: dispatchId={}", dispatchId, e);
            }
        });
    }

    @SuppressWarnings("unchecked")
    private void handleEvaluate(Map<String, Object> msg) {
        String dispatchId = (String) msg.get("dispatchId");
        String action = (String) msg.getOrDefault("action", "");
        Object workerIdxRaw = msg.get("workerIdx");
        int workerIdx = (workerIdxRaw instanceof Number n) ? n.intValue() : -1;
        String reason = (String) msg.get("reason");

        log.info("TCP evaluate received: dispatchId={}, action={}, workerIdx={}, reason={}",
                dispatchId, action, workerIdx, reason);

        if ("stop".equalsIgnoreCase(action) || "STOP".equalsIgnoreCase(action)) {
            boolean cancelled = workerStopRegistry.cancel(dispatchId, workerIdx);
            if (cancelled) {
                log.info("Worker stop executed: dispatchId={}, workerIdx={}", dispatchId, workerIdx);
            } else {
                log.warn("Worker stop failed (no running worker): dispatchId={}, workerIdx={}",
                        dispatchId, workerIdx);
            }
        } else {
            log.debug("Evaluate action '{}' is not 'stop', ignoring", action);
        }
    }

    /**
     * Handle a {@code tool_result} message from RACER by completing the matching
     * pending future in {@link RemoteToolExecutor}.
     *
     * <p>This closes the tool_call → tool_result loop: a Java worker that is blocked
     * in {@link RemoteToolExecutor#execute} unblocks and continues with the result.
     */
    private void handleToolResult(Map<String, Object> msg) {
        String dispatchId = (String) msg.get("dispatchId");
        Object workerIdxRaw = msg.get("workerIdx");
        int workerIdx = (workerIdxRaw instanceof Number n) ? n.intValue() : -1;
        String result = (String) msg.get("result");
        String error = (String) msg.get("error");

        if (dispatchId == null || workerIdx < 0) {
            log.warn("tool_result missing dispatchId or workerIdx: {}", msg);
            return;
        }

        log.info("TCP tool_result received: dispatchId={}, workerIdx={}, hasError={}",
                dispatchId, workerIdx, error != null);
        remoteToolExecutor.completeToolResult(dispatchId, workerIdx, result, error);
    }

    @SuppressWarnings("unchecked")
    private WorkerConfig parseWorker(Map<String, Object> data) {
        Map<String, Object> providerData = (Map<String, Object>) data.get("provider");
        WorkerConfig.ProviderConfig provider = new WorkerConfig.ProviderConfig(
            (String) providerData.get("name"),
            (String) providerData.get("baseUrl"),
            (String) providerData.get("apiKey"),
            (String) providerData.get("model")
        );
        int workerIdx = data.get("workerIdx") instanceof Number n ? n.intValue() : 0;
        int maxRounds = data.getOrDefault("maxRounds", 8) instanceof Number n ? n.intValue() : 8;
        return new WorkerConfig(workerIdx, (String) data.get("agentId"), provider, maxRounds);
    }
}
