package com.soloforge.agent.aisociety;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * 文化规范 Client (查询 AI Society culture 表)
 *
 * System Prompt 注入文化规范,影响 Agent 行为。
 *
 * 预置 4 条文化:
 *   - cult_review_priority (Review优先, target 0.95)
 *   - cult_evidence_first (证据优先, target 0.90)
 *   - cult_dont_guess (不要猜, target 0.85)
 *   - cult_recoverable_first (可恢复优先, target 0.95)
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class CultureClient {

    private final JdbcTemplate jdbcTemplate;

    /**
     * 获取所有文化规范
     */
    public List<Map<String, Object>> getAllCultures() {
        try {
            return jdbcTemplate.queryForList(
                "SELECT id, principle, adoption_rate, target_rate, description FROM culture ORDER BY target_rate DESC");
        } catch (Exception e) {
            log.warn("CultureClient.getAllCultures failed: {}", e.getMessage());
            return List.of();
        }
    }

    /**
     * 获取文化原则列表 (用于 System Prompt 注入)
     */
    public List<String> getPrinciples() {
        return getAllCultures().stream()
            .map(c -> (String) c.get("principle"))
            .filter(p -> p != null && !p.isBlank())
            .toList();
    }

    /** Evaluate cultural impact of an agent response (stub for compatibility) */
    public void evaluateCulturalImpact(String agentId, String response) {
        log.debug("evaluateCulturalImpact: agent={} response_len={}", agentId, response != null ? response.length() : 0);
    }
}
