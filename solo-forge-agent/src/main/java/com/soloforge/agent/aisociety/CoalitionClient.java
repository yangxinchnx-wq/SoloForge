package com.soloforge.agent.aisociety;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * 联盟 Client (查询 AI Society coalition 表)
 *
 * 多 Agent 协作时检查联盟约束。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class CoalitionClient {

    private final JdbcTemplate jdbcTemplate;

    /**
     * 获取 Agent 所在的活跃联盟
     */
    public List<Map<String, Object>> getMemberCoalitions(String agentId) {
        try {
            // members 字段是 JSON 数组,用 LIKE 简化匹配
            return jdbcTemplate.queryForList(
                "SELECT id, name, goal, leader, members, status FROM coalition " +
                "WHERE status IN ('forming', 'active') AND members LIKE ?",
                "%" + agentId + "%");
        } catch (Exception e) {
            log.warn("CoalitionClient.getMemberCoalitions failed: {}", e.getMessage());
            return List.of();
        }
    }

    /**
     * 获取所有活跃联盟
     */
    public List<Map<String, Object>> getActiveCoalitions() {
        try {
            return jdbcTemplate.queryForList(
                "SELECT id, name, goal, leader, status FROM coalition WHERE status IN ('forming', 'active')");
        } catch (Exception e) {
            log.warn("CoalitionClient.getActiveCoalitions failed: {}", e.getMessage());
            return List.of();
        }
    }

    /** Record a coalition action (stub for compatibility) */
    public void recordCoalitionAction(String agentId, String action) {
        log.debug("recordCoalitionAction: agent={} action={}", agentId, action);
    }
}
