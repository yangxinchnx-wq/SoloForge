package com.soloforge.agent.controller;

import com.soloforge.agent.executor.MultiWorkerExecutionService;
import com.soloforge.agent.executor.WorkerConfig;
import com.soloforge.agent.pool.PoolManager;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * ChatExecuteController - starts dispatch requests.
 *
 * <p>Endpoint: POST /api/chat/execute
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>This endpoint only initiates the dispatch (non-blocking)</li>
 *   <li>All subsequent communication happens over TCP 8771</li>
 *   <li>Returns immediately with dispatchId, does not wait for completion</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/chat")
@RequiredArgsConstructor
public class ChatExecuteController {
    private static final Logger log = LoggerFactory.getLogger(ChatExecuteController.class);
    private final MultiWorkerExecutionService executionService;
    private final PoolManager poolManager;
    private final ExecutorService dispatchExecutor = Executors.newCachedThreadPool();

    @PostMapping("/execute")
    public ResponseEntity<Map<String, Object>> execute(@RequestBody Map<String, Object> body) {
        String dispatchId = (String) body.get("dispatchId");
        String chatId = (String) body.get("chatId");

        if (dispatchId == null || chatId == null) {
            return ResponseEntity.badRequest().body(Map.of(
                    "success", false,
                    "error", "dispatchId and chatId are required"
            ));
        }

        try {
            // Parse workers
            List<Map<String, Object>> workersData = (List<Map<String, Object>>) body.get("workers");
            List<WorkerConfig> workers = workersData.stream()
                    .map(this::parseWorker)
                    .toList();

            // Parse other fields
            String prompt = (String) body.get("prompt");
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> history = (List<Map<String, Object>>) body.getOrDefault("history", List.of());
            @SuppressWarnings("unchecked")
            Map<String, Object> settings = (Map<String, Object>) body.getOrDefault("settings", Map.of());
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> tools = (List<Map<String, Object>>) body.getOrDefault("tools", List.of());
            String permissionMode = (String) body.getOrDefault("permissionMode", "normal");

            // Execute dispatch asynchronously (non-blocking — returns immediately)
            // Events are streamed back to RACER via TCP 8771
            dispatchExecutor.submit(() -> {
                try {
                    executionService.executeDispatch(dispatchId, chatId, workers, prompt, history, settings, tools, permissionMode);
                } catch (Exception e) {
                    log.error("Dispatch failed: {}", dispatchId, e);
                }
            });

            return ResponseEntity.ok(Map.of(
                    "success", true,
                    "dispatchId", dispatchId,
                    "chatId", chatId,
                    "message", "Dispatch started"
            ));

        } catch (Exception e) {
            log.error("Failed to start dispatch: {}", dispatchId, e);
            return ResponseEntity.internalServerError().body(Map.of(
                    "success", false,
                    "error", e.getMessage()
            ));
        }
    }

    @GetMapping("/chat/pool/{chatId}/size")
    public ResponseEntity<Map<String, Object>> getPoolSize(@PathVariable String chatId) {
        int size = poolManager.size();
        return ResponseEntity.ok(Map.of(
                "chatId", chatId,
                "poolSize", size
        ));
    }

    private WorkerConfig parseWorker(Map<String, Object> data) {
        Map<String, Object> providerData = (Map<String, Object>) data.get("provider");
        WorkerConfig.ProviderConfig provider = new WorkerConfig.ProviderConfig(
                (String) providerData.get("name"),
                (String) providerData.get("baseUrl"),
                (String) providerData.get("apiKey"),
                (String) providerData.get("model")
        );

        return new WorkerConfig(
                ((Number) data.get("workerIdx")).intValue(),
                (String) data.get("agentId"),
                provider,
                ((Number) data.getOrDefault("maxRounds", 8)).intValue()
        );
    }
}
