package com.soloforge.agent.aisociety;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * 制度 Client (查询 AI Society institution 表)
 *
 * 查询制度规则详情,为法律/治理提供上下文。
 *
 * 预置 3 条制度:
 *   - inst_core_code_review (CodeInstitution, HARD, priority=90)
 *   - inst_core_research (ResearchInstitution, SOFT, priority=70)
 *   - inst_core_security (SecurityInstitution, HARD, priority=95)
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class InstitutionClient {

    private final JdbcTemplate jdbcTemplate;

    /**
     * 获取所有制度
     */
    public List<Map<String, Object>> getAllInstitutions() {
        try {
            return jdbcTemplate.queryForList(
                "SELECT id, name, rules, scope, enforcement, priority FROM institution ORDER BY priority DESC");
        } catch (Exception e) {
            log.warn("InstitutionClient.getAllInstitutions failed: {}", e.getMessage());
            return List.of();
        }
    }

    /**
     * 获取制度规则列表
     */
    public List<String> getRules(String institutionId) {
        try {
            var rows = jdbcTemplate.queryForList(
                "SELECT rules FROM institution WHERE id = ?", institutionId);
            if (!rows.isEmpty()) {
                String rules = (String) rows.get(0).get("rules");
                if (rules != null) return List.of(rules.split(","));
            }
        } catch (Exception e) {
            log.warn("InstitutionClient.getRules failed: {}", e.getMessage());
        }
        return List.of();
    }
}
