package com.soloforge.agent.aisociety;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * 治理合规 Client (查询 AI Society governance 表)
 *
 * Agent 执行任务后调用 recordCompliance() 记录合规性。
 * 对应 Python GovernanceService.record_compliance()
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class GovernanceClient {

    private final JdbcTemplate jdbcTemplate;

    /**
     * 记录合规检查
     */
    public void recordCompliance(String governanceId, String agentId, boolean compliant, String action, String notes) {
        try {
            String id = "grec_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            String now = LocalDateTime.now().toString();
            jdbcTemplate.update("""
                INSERT INTO governance_record (id, governance_id, agent_id, compliant, action_taken, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """, id, governanceId, agentId, compliant ? 1 : 0, action, notes, now);

            // 不合规时 governance.violations +1
            if (!compliant) {
                jdbcTemplate.update(
                    "UPDATE governance SET violations = violations + 1, last_review = ? WHERE id = ?",
                    now, governanceId);
            }
            log.info("Governance recorded: agent={} compliant={} action={}", agentId, compliant, action);
        } catch (Exception e) {
            log.error("GovernanceClient.recordCompliance failed: {}", e.getMessage());
        }
    }

    /**
     * 获取所有治理记录
     */
    public List<Map<String, Object>> getAllGovernance() {
        try {
            return jdbcTemplate.queryForList(
                "SELECT g.id, g.institution_id, g.owner, g.effectiveness, g.violations, g.last_review " +
                "FROM governance g ORDER BY g.violations DESC");
        } catch (Exception e) {
            log.warn("GovernanceClient.getAllGovernance failed: {}", e.getMessage());
            return List.of();
        }
    }

    /**
     * 更新治理效果
     */
    public void updateEffectiveness(String governanceId, double effectiveness) {
        double clamped = Math.max(0.0, Math.min(1.0, effectiveness));
        jdbcTemplate.update(
            "UPDATE governance SET effectiveness = ?, updated_at = ? WHERE id = ?",
            clamped, LocalDateTime.now().toString(), governanceId);
    }
}
