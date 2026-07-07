package com.soloforge.agent.controller;

import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.orchestrator.AgentOrchestrator;
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Chat Controller - 统一入口
 *
 * POST /api/chat/send  — 接收前端聊天请求,调用 AgentOrchestrator (复杂度分流)
 * GET  /api/agents     — 列出所有 Agent
 * GET  /api/agents/{id} — 获取 Agent 详情
 * GET  /health         — 健康检查
 */
@Slf4j
@RestController
@RequestMapping
@RequiredArgsConstructor
public class ChatController {

    private final AgentOrchestrator agentOrchestrator;
    private final AgentIdentityRepository agentRepo;

    /**
     * 统一聊天入口
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
                request.getProvider());

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

    /**
     * 获取 Agent 详情
     */
    @GetMapping("/api/agents/{id}")
    public ResponseEntity<Map<String, Object>> getAgent(@PathVariable String id) {
        return agentRepo.findById(id)
            .map(agent -> ResponseEntity.ok(toAgentDetail(agent)))
            .orElse(ResponseEntity.notFound().build());
    }

    /**
     * 健康检查
     */
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
