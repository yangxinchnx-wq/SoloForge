package com.soloforge.agent.controller;

import com.soloforge.agent.executor.MultiWorkerExecutionService;
import com.soloforge.agent.executor.WorkerConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.*;

/**
 * Chat Stream Controller — SSE 流式聊天端点
 *
 * <p>Endpoint: POST /api/chat/stream
 *
 * <p>Replaces the deleted TCP 8771 transport with direct SSE output.
 * The Node.js server proxies requests from /api/java-agent/api/chat/stream
 * to here (http://127.0.0.1:8770/api/chat/stream).
 *
 * <p>Event format (aligned with frontend aiBackend.ts executeJavaPath):
 * <pre>
 * event:phase
 * data:{"phase":"phase0_subtask","chatId":"...","subtasks":[...]}
 *
 * event:phase
 * data:{"phase":"phase1_worker_start","chatId":"...","workerIdx":0,"agentId":"..."}
 *
 * event:text
 * data:{"content":"Hello "}
 *
 * event:phase
 * data:{"phase":"phase1_worker_done","chatId":"...","workerIdx":0,"content":"..."}
 *
 * event:phase
 * data:{"phase":"phase3_deliver_done","chatId":"..."}
 *
 * event:usage
 * data:{"promptTokens":100,"completionTokens":50,"totalTokens":150}
 *
 * event:done
 * data:{"agentId":"code_agent"}
 * </pre>
 */
@RestController
@RequestMapping("/api/chat")
public class ChatStreamController {
    private static final Logger log = LoggerFactory.getLogger(ChatStreamController.class);

    private final MultiWorkerExecutionService executionService;
    private final java.util.concurrent.ExecutorService streamExecutor =
            java.util.concurrent.Executors.newCachedThreadPool();

    public ChatStreamController(MultiWorkerExecutionService executionService) {
        this.executionService = executionService;
    }

    @PostMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@RequestBody Map<String, Object> body) {
        // 5 分钟超时 (长任务需要足够时间)
        SseEmitter emitter = new SseEmitter(300_000L);

        String chatId = getString(body, "sessionId");
        if (chatId == null || chatId.isBlank()) {
            chatId = getString(body, "chatId");
        }
        if (chatId == null || chatId.isBlank()) {
            chatId = "chat-" + UUID.randomUUID();
        }

        String prompt = getString(body, "message");
        if (prompt == null) prompt = "";

        final String finalChatId = chatId;
        final String finalPrompt = prompt;
        final String dispatchId = "dispatch-" + UUID.randomUUID();

        log.info("SSE stream request: chatId={}, dispatchId={}, promptLen={}",
                finalChatId, dispatchId, prompt.length());

        emitter.onTimeout(() -> {
            log.warn("SSE emitter timed out: chatId={}, dispatchId={}", finalChatId, dispatchId);
            emitter.complete();
        });
        emitter.onError(ex -> {
            log.error("SSE emitter error: chatId={}, dispatchId={}", finalChatId, dispatchId, ex);
        });

        streamExecutor.submit(() -> {
            try {
                List<WorkerConfig> workers = buildWorkers(body);

                @SuppressWarnings("unchecked")
                List<Map<String, Object>> history =
                        (List<Map<String, Object>>) body.getOrDefault("history", List.of());
                @SuppressWarnings("unchecked")
                Map<String, Object> settings =
                        (Map<String, Object>) body.getOrDefault("settings", Map.of());
                // 工具 ID 列表从 settings.enabledTools 读取 (前端 buildJavaRequestBody 发送)
                @SuppressWarnings("unchecked")
                List<String> tools = (List<String>) settings.getOrDefault("enabledTools", List.of());
                String permissionMode = getString(body, "permissionMode");
                if (permissionMode == null) permissionMode = "normal";

                executionService.executeDispatch(
                        dispatchId, finalChatId, workers, finalPrompt,
                        history, settings, tools, permissionMode, emitter
                );
            } catch (Exception e) {
                log.error("Stream dispatch failed: dispatchId={}", dispatchId, e);
                try {
                    emitter.send(SseEmitter.event()
                            .name("error")
                            .data(Map.of("error", e.getMessage() != null ? e.getMessage() : "Unknown error")));
                    emitter.send(SseEmitter.event()
                            .name("done")
                            .data(Map.of()));
                    emitter.complete();
                } catch (Exception ignored) {
                    // emitter may already be completed
                }
            }
        });

        return emitter;
    }

    /**
     * Build worker configs from the request body.
     *
     * <p>Worker 0 = main provider (agentId from settings)
     * Worker 1..N = sub providers
     */
    @SuppressWarnings("unchecked")
    private List<WorkerConfig> buildWorkers(Map<String, Object> body) {
        List<WorkerConfig> workers = new ArrayList<>();
        Map<String, Object> settings =
                (Map<String, Object>) body.getOrDefault("settings", Map.of());
        String agentId = getString(settings, "agentId");
        if (agentId == null || agentId.isBlank()) agentId = "code_agent";

        // Worker 0: main provider
        Map<String, Object> provider = (Map<String, Object>) body.get("provider");
        if (provider != null && provider.get("baseUrl") != null) {
            WorkerConfig.ProviderConfig mainProvider = new WorkerConfig.ProviderConfig(
                    getString(provider, "name") != null ? getString(provider, "name") : "main",
                    getString(provider, "baseUrl"),
                    getString(provider, "apiKey"),
                    getString(provider, "model")
            );
            int maxRounds = getInt(settings, "maxRounds", 8);
            workers.add(new WorkerConfig(0, agentId, mainProvider, maxRounds));
        }

        // Workers 1..N: sub providers
        List<Map<String, Object>> subProviders =
                (List<Map<String, Object>>) body.getOrDefault("subProviders", List.of());
        for (int i = 0; i < subProviders.size(); i++) {
            Map<String, Object> sp = subProviders.get(i);
            if (sp.get("baseUrl") != null) {
                WorkerConfig.ProviderConfig subProvider = new WorkerConfig.ProviderConfig(
                        getString(sp, "name") != null ? getString(sp, "name") : "sub-" + i,
                        getString(sp, "baseUrl"),
                        getString(sp, "apiKey"),
                        getString(sp, "model")
                );
                // Sub-workers get fewer rounds (decreasing depth)
                int subMaxRounds = i == 0 ? 10 : i == 1 ? 6 : 4;
                workers.add(new WorkerConfig(i + 1, "sub_agent_" + i, subProvider, subMaxRounds));
            }
        }

        // Fallback: if no providers configured, create a default worker using Spring AI's default ChatModel
        if (workers.isEmpty()) {
            workers.add(new WorkerConfig(0, agentId,
                    new WorkerConfig.ProviderConfig("default", "", "", ""), 8));
        }

        return workers;
    }

    private static String getString(Map<String, Object> map, String key) {
        Object v = map.get(key);
        return v instanceof String s ? s : null;
    }

    private static int getInt(Map<String, Object> map, String key, int defaultVal) {
        Object v = map.get(key);
        if (v instanceof Number n) return n.intValue();
        if (v instanceof String s) {
            try { return Integer.parseInt(s); } catch (NumberFormatException e) { return defaultVal; }
        }
        return defaultVal;
    }
}
