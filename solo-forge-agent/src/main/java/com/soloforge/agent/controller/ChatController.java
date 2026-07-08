package com.soloforge.agent.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.orchestrator.AgentOrchestrator;
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import reactor.core.publisher.Flux;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Chat Controller - 统一入口
 *
 * POST /api/chat/send   — 非流式聊天 (向后兼容)
 * POST /api/chat/stream — SSE 流式聊天 (2026-07-08 新增, 真实流式)
 * GET  /api/agents      — 列出所有 Agent
 * GET  /api/agents/{id} — 获取 Agent 详情
 * GET  /health          — 健康检查
 */
@Slf4j
@RestController
@RequestMapping
@RequiredArgsConstructor
public class ChatController {

    private final AgentOrchestrator agentOrchestrator;
    private final AgentIdentityRepository agentRepo;
    private final ObjectMapper objectMapper;

    /**
     * 非流式聊天 (向后兼容)
     */
    @PostMapping("/api/chat/send")
    public ResponseEntity<Map<String, Object>> sendMessage(@RequestBody ChatRequest request) {
        log.info("POST /api/chat/send sessionId={} agentId={}",
            request.getSessionId(),
            request.getSettings() != null ? request.getSettings().getAgentId() : "default");

        try {
            if (request.getMessage() == null || request.getMessage().isBlank()) {
                return badRequest("消息内容不能为空");
            }
            if (request.getSettings() == null) {
                request.setSettings(new com.soloforge.agent.dto.ChatSettings());
            }

            String result = agentOrchestrator.orchestrate(
                request.getMessage(),
                request.getSettings(),
                request.getProvider(),
                request.getHistory(),
                request.getFileContext());

            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("content", result);
            response.put("sessionId", request.getSessionId());
            response.put("agentId", request.getSettings().getAgentId());

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Chat send failed: {}", e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(error);
        }
    }

    /**
     * SSE 流式聊天 — 真实流式输出 LLM 增量文本
     *
     * SSE 事件格式:
     *   event: text\ndata: {"content":"增量文本片段"}\n\n
     *   event: done\ndata: {}\n\n
     *   event: error\ndata: {"error":"错误信息"}\n\n
     */
    @PostMapping(value = "/api/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter sendMessageStream(@RequestBody ChatRequest request) {
        // 120s 超时, LLM 流式调用可能需要较长时间
        SseEmitter emitter = new SseEmitter(120_000L);

        log.info("POST /api/chat/stream sessionId={} agentId={}",
            request.getSessionId(),
            request.getSettings() != null ? request.getSettings().getAgentId() : "default");

        try {
            if (request.getMessage() == null || request.getMessage().isBlank()) {
                sendSseEvent(emitter, "error", Map.of("error", "消息内容不能为空"));
                emitter.complete();
                return emitter;
            }
            if (request.getSettings() == null) {
                request.setSettings(new com.soloforge.agent.dto.ChatSettings());
            }

            Flux<String> textFlux = agentOrchestrator.orchestrateStream(
                request.getMessage(),
                request.getSettings(),
                request.getProvider(),
                request.getHistory(),
                request.getFileContext());

            textFlux.subscribe(
                chunk -> {
                    try {
                        sendSseEvent(emitter, "text", Map.of("content", chunk));
                    } catch (Exception e) {
                        log.warn("SSE send chunk failed: {}", e.getMessage());
                    }
                },
                error -> {
                    log.error("Stream error: {}", error.getMessage());
                    try {
                        sendSseEvent(emitter, "error", Map.of("error", error.getMessage()));
                    } catch (Exception ignored) {}
                    emitter.complete();
                },
                () -> {
                    try {
                        sendSseEvent(emitter, "done", Map.of(
                            "sessionId", request.getSessionId() != null ? request.getSessionId() : "",
                            "agentId", request.getSettings().getAgentId()
                        ));
                    } catch (Exception ignored) {}
                    emitter.complete();
                }
            );

        } catch (Exception e) {
            log.error("Stream setup failed: {}", e.getMessage(), e);
            try {
                sendSseEvent(emitter, "error", Map.of("error", e.getMessage()));
            } catch (Exception ignored) {}
            emitter.complete();
        }

        return emitter;
    }

    /**
     * 发送 SSE 事件 (JSON 序列化)
     */
    private void sendSseEvent(SseEmitter emitter, String eventName, Map<String, Object> data) throws Exception {
        String json = objectMapper.writeValueAsString(data);
        emitter.send(SseEmitter.event()
            .name(eventName)
            .data(json)
            .build());
    }

    /**
     * 列出所有启用的 Agent
     */
    @GetMapping("/api/agents")
    public ResponseEntity<List<Map<String, Object>>> listAgents() {
        List<AgentIdentityEntity> agents = agentRepo.findAllEnabled();
        List<Map<String, Object>> result = agents.stream()
            .map(this::toAgentSummary)
            .collect(Collectors.toList());
        return ResponseEntity.ok(result);
    }

    @GetMapping("/api/agents/{id}")
    public ResponseEntity<Map<String, Object>> getAgent(@PathVariable String id) {
        return agentRepo.findById(id)
            .map(agent -> ResponseEntity.ok(toAgentDetail(agent)))
            .orElse(ResponseEntity.notFound().build());
    }

    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> health() {
        Map<String, Object> health = new HashMap<>();
        health.put("status", "UP");
        health.put("service", "solo-forge-agent");
        health.put("version", "1.0.0");
        health.put("port", 8770);
        return ResponseEntity.ok(health);
    }

    private Map<String, Object> toAgentSummary(AgentIdentityEntity agent) {
        Map<String, Object> m = new HashMap<>();
        m.put("id", agent.getId());
        m.put("name", agent.getName());
        m.put("role", agent.getRole());
        m.put("domain", agent.getDomain());
        m.put("level", agent.getLevel());
        m.put("strategy", agent.getStrategy());
        m.put("taskCount", agent.getTaskCount());
        return m;
    }

    private Map<String, Object> toAgentDetail(AgentIdentityEntity agent) {
        Map<String, Object> m = toAgentSummary(agent);
        m.put("systemPrompt", agent.getSystemPrompt());
        m.put("systemPromptVersion", agent.getSystemPromptVersion());
        m.put("modelBinding", agent.getModelBinding());
        m.put("capabilities", agentRepo.parseCapabilities(agent));
        m.put("temperature", agent.getTemperature());
        m.put("maxRounds", agent.getMaxRounds());
        m.put("status", agent.getStatus());
        m.put("enabled", agent.getEnabled());
        return m;
    }

    private ResponseEntity<Map<String, Object>> badRequest(String message) {
        Map<String, Object> error = new HashMap<>();
        error.put("success", false);
        error.put("error", message);
        return ResponseEntity.badRequest().body(error);
    }
}
