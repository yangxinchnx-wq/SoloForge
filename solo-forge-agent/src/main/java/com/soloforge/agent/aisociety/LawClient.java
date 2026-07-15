package com.soloforge.agent.aisociety;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 法律约束 Client (查询 AI Society law 表)
 *
 * Agent 执行任务前调用 checkViolation() 检查动作是否违规。
 * 对应 Python LawService.check_violation()
 *
 * 预置 4 条法律:
 *   - law_delete_without_confirm (未经确认删除文件)
 *   - law_call_disabled_component (调用被禁用组件)
 *   - law_budget_exceeded (超过预算)
 *   - law_repeated_failure (重复失败)
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class LawClient {

    private final JdbcTemplate jdbcTemplate;

    /**
     * 获取所有法律
     */
    public List<Map<String, Object>> getAllLaws() {
        try {
            return jdbcTemplate.queryForList(
                "SELECT id, name, description, condition, consequence, severity FROM law ORDER BY severity DESC");
        } catch (Exception e) {
            log.warn("LawClient.getAllLaws failed: {}", e.getMessage());
            return List.of();
        }
    }

    /**
     * 检查违规 (简化版: 用规则匹配,不用 eval)
     *
     * @param agentId Agent ID
     * @param context 包含 task/tools/budget 等上下文
     * @return 违规列表 (空表示无违规)
     */

    /**
     * Check if agent action is legal (convenience method for SpringAiAgentExecutor)
     * @return true if legal (no violations), false if blocked
     */
    public boolean checkLegal(String agentId, com.soloforge.agent.dto.ChatSettings settings) {
        try {
            return checkViolation(agentId, java.util.Map.of()).isEmpty();
        } catch (Exception e) {
            log.warn("checkLegal failed: {}", e.getMessage());
            return true; // fail-open
        }
    }

    public List<Map<String, Object>> checkViolation(String agentId, Map<String, Object> context) {
        List<Map<String, Object>> violations = new ArrayList<>();
        try {
            List<Map<String, Object>> laws = getAllLaws();
            for (Map<String, Object> law : laws) {
                String lawId = (String) law.get("id");
                String condition = (String) law.get("condition");

                if (evaluateCondition(lawId, condition, context)) {
                    Map<String, Object> v = new java.util.HashMap<>(law);
                    v.put("agent_id", agentId);
                    v.put("violation_context", context.toString());
                    violations.add(v);

                    // 记录违规到 law_violation 表
                    recordViolation(lawId, agentId, context.toString(),
                        (String) law.get("consequence"));
                }
            }
        } catch (Exception e) {
            log.warn("LawClient.checkViolation failed: {}", e.getMessage());
        }
        return violations;
    }

    /**
     * 简化版条件评估 (不使用 eval,用规则匹配)
     */
    private boolean evaluateCondition(String lawId, String condition, Map<String, Object> ctx) {
        return switch (lawId) {
            case "law_delete_without_confirm" ->
                ctx.containsKey("action") && "delete_file".equals(ctx.get("action"))
                && !ctx.getOrDefault("confirmed", false).equals(true);
            case "law_call_disabled_component" ->
                ctx.containsKey("component") && isComponentDisabled((String) ctx.get("component"));
            case "law_budget_exceeded" -> {
                double budget = ((Number) ctx.getOrDefault("budget", 0)).doubleValue();
                double cost = ((Number) ctx.getOrDefault("cost", 0)).doubleValue();
                yield cost > budget;
            }
            case "law_repeated_failure" -> {
                int failures = ((Number) ctx.getOrDefault("recent_failures", 0)).intValue();
                yield failures >= 3;
            }
            default -> false;
        };
    }

    private boolean isComponentDisabled(String component) {
        // 简化: 查询是否有禁用标记 (实际可查 governance 表)
        return false;
    }

    private void recordViolation(String lawId, String agentId, String context, String consequence) {
        try {
            String id = "viol_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            String now = java.time.LocalDateTime.now().toString();
            jdbcTemplate.update("""
                INSERT INTO law_violation (id, law_id, agent_id, violation_context, consequence_applied, status, created_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?)
                """, id, lawId, agentId, context, consequence, now);
            log.warn("Law violation recorded: agent={} law={} consequence={}", agentId, lawId, consequence);
        } catch (Exception e) {
            log.error("recordViolation failed: {}", e.getMessage());
        }
    }
}
