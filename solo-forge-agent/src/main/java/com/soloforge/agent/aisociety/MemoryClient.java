package com.soloforge.agent.aisociety;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Memory Client (query AI Society memory/lessons tables)
 *
 * Provides lesson retrieval and memory storage for agents.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class MemoryClient {

    private final JdbcTemplate jdbcTemplate;

    /**
     * Get lessons for a domain
     */
    public List<String> getLessons(String domain) {
        try {
            return jdbcTemplate.queryForList(
                "SELECT lesson FROM memory WHERE domain = ? AND severity = 'lesson' ORDER BY created_at DESC LIMIT 5",
                String.class, domain);
        } catch (Exception e) {
            log.warn("MemoryClient.getLessons failed: {}", e.getMessage());
            return List.of();
        }
    }

    /**
     * Store a memory entry (stub for compatibility)
     */
    public void storeMemory(String agentId, String role, String content) {
        log.debug("storeMemory: agent={} role={} content_len={}", agentId, role, content != null ? content.length() : 0);
    }

    public void create(String event, String impact, String severity,
                       String domain, String agentId) {
        try {
            jdbcTemplate.update(
                "INSERT INTO memory (event, impact, severity, domain, agent_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
                event, impact, severity, domain, agentId);
        } catch (Exception e) {
            log.warn("MemoryClient.create failed: {}", e.getMessage());
        }
    }

    /** Create memory entry with list params (compatibility overload for AgentExecutor) */
    public void create(String event, String impact, String severity,
                       java.util.List<String> agentIds, java.util.List<String> notes, String domain) {
        try {
            String agentId = agentIds != null && !agentIds.isEmpty() ? agentIds.get(0) : "unknown";
            jdbcTemplate.update(
                "INSERT INTO memory (event, impact, severity, domain, agent_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
                event, impact, severity, domain, agentId);
        } catch (Exception e) {
            log.warn("MemoryClient.create failed: {}", e.getMessage());
        }
    }

    public int count() {
        try {
            Integer c = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM memory", Integer.class);
            return c != null ? c : 0;
        } catch (Exception e) {
            log.warn("MemoryClient.count failed: {}", e.getMessage());
            return 0;
        }
    }
}
