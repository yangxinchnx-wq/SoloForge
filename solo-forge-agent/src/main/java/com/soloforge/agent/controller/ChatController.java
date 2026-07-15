package com.soloforge.agent.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
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
 * Chat Controller — Agent 管理 + 健康检查
 *
 * 聊天/流式端点已移除 (原 /api/chat/send, /api/chat/stream)。
 * 聊天路径由 RACER (Node.js) 独占处理，不再有 Java fallback。
 * RACER 不可用时直接报错，不降级。
 *
 * 保留的端点:
 *   GET    /api/agents          — 列出所有 Agent
 *   GET    /api/agents/{id}     — 获取 Agent 详情
 *   POST   /api/agents          — 新建 Agent
 *   PUT    /api/agents/{id}     — 更新 Agent 配置
 *   PATCH  /api/agents/{id}/status — 启用/禁用 Agent
 *   DELETE /api/agents/{id}     — 删除 Agent
 *   PUT    /api/agents/{id}/profile — 更新 Agent 名称/头像
 *   GET    /health              — 健康检查
 */
@Slf4j
@RestController
@RequestMapping
@RequiredArgsConstructor
public class ChatController {

    private final AgentIdentityRepository agentRepo;
    private final ObjectMapper objectMapper;

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
        health.put("role", "training-only");
        return ResponseEntity.ok(health);
    }

    private Map<String, Object> toAgentSummary(AgentIdentityEntity agent) {
        Map<String, Object> m = new HashMap<>();
        m.put("id", agent.getId());
        m.put("name", agent.getName());
        m.put("avatar", agent.getAvatar());
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

    /**
     * 更新 Agent 显示名称和头像 (前端 AgentSettingsModal 调用)
     */
    @PutMapping("/api/agents/{id}/profile")
    public ResponseEntity<Map<String, Object>> updateAgentProfile(
            @PathVariable String id,
            @RequestBody Map<String, String> body) {
        String name = body.get("name");
        String avatar = body.get("avatar");
        if (name == null || name.isBlank()) {
            return badRequest("name 不能为空");
        }
        try {
            agentRepo.updateProfile(id, name, avatar);
            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("agentId", id);
            result.put("name", name);
            result.put("avatar", avatar);
            return ResponseEntity.ok(result);
        } catch (Exception e) {
            log.error("Failed to update agent profile: {}", e.getMessage(), e);
            return ResponseEntity.internalServerError().body(Map.of("success", false, "error", e.getMessage()));
        }
    }

    /**
     * 新建 Agent
     */
    @PostMapping("/api/agents")
    public ResponseEntity<Map<String, Object>> createAgent(@RequestBody Map<String, Object> body) {
        String id = (String) body.get("id");
        String name = (String) body.get("name");
        if (id == null || id.isBlank()) return badRequest("id 不能为空");
        if (name == null || name.isBlank()) return badRequest("name 不能为空");

        String finalId = id.trim().toLowerCase().replaceAll("[^a-z0-9_\\-]", "_");

        if (agentRepo.findById(finalId).isPresent()) {
            return badRequest("Agent ID '" + finalId + "' 已存在");
        }

        try {
            AgentIdentityEntity entity = new AgentIdentityEntity();
            entity.setId(finalId);
            entity.setName(name);
            entity.setAvatar(getString(body, "avatar", "🤖"));
            entity.setRole(getString(body, "role", "EXECUTOR"));
            entity.setDomain(getString(body, "domain", "general"));
            entity.setModelBinding(getString(body, "modelBinding", "gpt-4o"));
            entity.setSystemPrompt(getString(body, "systemPrompt", "你是 SoloForge 的 AI Agent。"));
            entity.setCapabilities(getString(body, "capabilities", "[\"read\",\"write\",\"search\",\"analyze\"]"));
            entity.setStrategy(getString(body, "strategy", "direct"));
            entity.setLevel(getString(body, "level", "senior"));
            entity.setTemperature(getDouble(body, "temperature", 0.3));
            entity.setMaxRounds(getInt(body, "maxRounds", 8));
            entity.setEnabled(1);
            entity.setStatus("active");
            entity.setTaskCount(0);
            entity.setSystemPromptVersion(0);
            entity.setCheckpointVersion(0);

            agentRepo.save(entity);
            log.info("Created new agent: {} ({})", name, finalId);

            AgentIdentityEntity saved = agentRepo.findById(finalId).orElse(entity);
            return ResponseEntity.ok(toAgentDetail(saved));
        } catch (Exception e) {
            log.error("Failed to create agent: {}", e.getMessage(), e);
            return ResponseEntity.internalServerError().body(Map.of("success", false, "error", e.getMessage()));
        }
    }

    /**
     * 更新 Agent 完整配置
     */
    @PutMapping("/api/agents/{id}")
    public ResponseEntity<Map<String, Object>> updateAgent(
            @PathVariable String id,
            @RequestBody Map<String, Object> body) {
        return agentRepo.findById(id).map(existing -> {
            try {
                if (body.containsKey("name")) existing.setName((String) body.get("name"));
                if (body.containsKey("avatar")) existing.setAvatar((String) body.get("avatar"));
                if (body.containsKey("role")) existing.setRole((String) body.get("role"));
                if (body.containsKey("domain")) existing.setDomain((String) body.get("domain"));
                if (body.containsKey("modelBinding")) existing.setModelBinding((String) body.get("modelBinding"));
                if (body.containsKey("systemPrompt")) existing.setSystemPrompt((String) body.get("systemPrompt"));
                if (body.containsKey("capabilities")) {
                    Object caps = body.get("capabilities");
                    existing.setCapabilities(caps instanceof List ? new ObjectMapper().writeValueAsString(caps) : (String) caps);
                }
                if (body.containsKey("strategy")) existing.setStrategy((String) body.get("strategy"));
                if (body.containsKey("level")) existing.setLevel((String) body.get("level"));
                if (body.containsKey("temperature")) existing.setTemperature(getDouble(body, "temperature", existing.getTemperature()));
                if (body.containsKey("maxRounds")) existing.setMaxRounds(getInt(body, "maxRounds", existing.getMaxRounds()));

                agentRepo.save(existing);
                log.info("Updated agent: {}", id);
                return ResponseEntity.ok(toAgentDetail(existing));
            } catch (Exception e) {
                log.error("Failed to update agent: {}", e.getMessage(), e);
                return ResponseEntity.internalServerError().<Map<String, Object>>body(Map.of("success", false, "error", e.getMessage()));
            }
        }).orElse(ResponseEntity.notFound().build());
    }

    /**
     * 启用/禁用 Agent
     */
    @PatchMapping("/api/agents/{id}/status")
    public ResponseEntity<Map<String, Object>> toggleAgentStatus(
            @PathVariable String id,
            @RequestBody Map<String, Object> body) {
        return agentRepo.findById(id).<ResponseEntity<Map<String, Object>>>map(agent -> {
            Boolean enabled = (Boolean) body.get("enabled");
            if (enabled == null) return badRequest("enabled 不能为空");

            agentRepo.toggleEnabled(id, enabled ? 1 : 0);
            log.info("助理 {} {}", id, enabled ? "已启用" : "已禁用");
            return ResponseEntity.ok(Map.of("success", true, "agentId", id, "enabled", enabled));
        }).orElse(ResponseEntity.notFound().build());
    }

    /**
     * 删除 Agent
     */
    @DeleteMapping("/api/agents/{id}")
    public ResponseEntity<Map<String, Object>> deleteAgent(@PathVariable String id) {
        return agentRepo.findById(id).<ResponseEntity<Map<String, Object>>>map(agent -> {
            try {
                agentRepo.deleteById(id);
                log.info("Deleted agent: {}", id);
                return ResponseEntity.ok(Map.of("success", true, "agentId", id));
            } catch (Exception e) {
                log.error("Failed to delete agent: {}", e.getMessage(), e);
                return ResponseEntity.internalServerError().body(Map.<String, Object>of("success", false, "error", e.getMessage()));
            }
        }).orElse(ResponseEntity.notFound().build());
    }

    private String getString(Map<String, Object> body, String key, String defaultVal) {
        Object v = body.get(key);
        return v instanceof String s && !s.isBlank() ? s : defaultVal;
    }

    private Double getDouble(Map<String, Object> body, String key, Double defaultVal) {
        Object v = body.get(key);
        if (v instanceof Number n) return n.doubleValue();
        if (v instanceof String s) try { return Double.parseDouble(s); } catch (Exception e) { return defaultVal; }
        return defaultVal;
    }

    private Integer getInt(Map<String, Object> body, String key, Integer defaultVal) {
        Object v = body.get(key);
        if (v instanceof Number n) return n.intValue();
        if (v instanceof String s) try { return Integer.parseInt(s); } catch (Exception e) { return defaultVal; }
        return defaultVal;
    }

    private ResponseEntity<Map<String, Object>> badRequest(String message) {
        Map<String, Object> error = new HashMap<>();
        error.put("success", false);
        error.put("error", message);
        return ResponseEntity.badRequest().body(error);
    }
}
