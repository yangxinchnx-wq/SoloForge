package com.soloforge.agent.aisociety;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * 经济系统 Client (查询 AI Society economy 表)
 *
 * Agent 调用 LLM 前检查信用分是否足够,调用后扣费。
 * 对应 Python EconomyService
 *
 * 资源成本表 (RESOURCE_COSTS):
 *   claude_sonnet=50, claude_haiku=10, gpt4o=40, qwen=10, deepseek=5, local_model=2
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class EconomyClient {

    private final JdbcTemplate jdbcTemplate;

    private static final Map<String, Double> RESOURCE_COSTS = Map.of(
        "claude-sonnet", 50.0,
        "claude-haiku", 10.0,
        "gpt-4o", 40.0,
        "gpt-4o-mini", 10.0,
        "qwen", 10.0,
        "deepseek", 5.0,
        "local_model", 2.0,
        "glm-5.2", 8.0
    );

    /**
     * 获取或创建账户
     */
    public void ensureAccount(String agentId) {
        try {
            var rows = jdbcTemplate.queryForList(
                "SELECT id FROM economy WHERE agent_id = ?", agentId);
            if (rows.isEmpty()) {
                String id = "econ_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 12);
                String now = LocalDateTime.now().toString();
                jdbcTemplate.update("""
                    INSERT INTO economy (id, agent_id, credits, balance, spending, income, created_at, updated_at)
                    VALUES (?, ?, 1000.0, 0.0, '{}', '{}', ?, ?)
                    """, id, agentId, now, now);
                log.info("Economy account created: agent={}", agentId);
            }
        } catch (Exception e) {
            log.error("EconomyClient.ensureAccount failed: {}", e.getMessage());
        }
    }

    /**
     * 检查余额是否足够
     */
    public boolean checkBalance(String agentId, String modelBinding) {
        double cost = getCost(modelBinding);
        try {
            var rows = jdbcTemplate.queryForList(
                "SELECT credits FROM economy WHERE agent_id = ?", agentId);
            if (!rows.isEmpty()) {
                double credits = ((Number) rows.get(0).get("credits")).doubleValue();
                return credits >= cost;
            }
        } catch (Exception e) {
            log.warn("EconomyClient.checkBalance failed: {}", e.getMessage());
        }
        return true; // 查询失败时放行 (避免阻塞)
    }

    /**
     * 扣费
     */
    public void spend(String agentId, String modelBinding) {
        double cost = getCost(modelBinding);
        try {
            ensureAccount(agentId);
            String now = LocalDateTime.now().toString();
            jdbcTemplate.update(
                "UPDATE economy SET credits = credits - ?, updated_at = ? WHERE agent_id = ?",
                cost, now, agentId);

            // 记录交易
            String txId = "ctx_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            var econRows = jdbcTemplate.queryForList("SELECT id FROM economy WHERE agent_id = ?", agentId);
            if (!econRows.isEmpty()) {
                String econId = (String) econRows.get(0).get("id");
                jdbcTemplate.update("""
                    INSERT INTO credit_transaction (id, economy_id, amount, transaction_type, category, description, created_at)
                    VALUES (?, ?, ?, 'debit', 'llm_call', ?, ?)
                    """, txId, econId, cost, "LLM call: " + modelBinding, now);
            }
            log.debug("Economy spend: agent={} cost={} model={}", agentId, cost, modelBinding);
        } catch (Exception e) {
            log.error("EconomyClient.spend failed: {}", e.getMessage());
        }
    }

    /**
     * 奖励信用分
     */
    public void reward(String agentId, double amount, String category) {
        try {
            ensureAccount(agentId);
            String now = LocalDateTime.now().toString();
            jdbcTemplate.update(
                "UPDATE economy SET credits = credits + ?, updated_at = ? WHERE agent_id = ?",
                amount, now, agentId);

            String txId = "ctx_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            var econRows = jdbcTemplate.queryForList("SELECT id FROM economy WHERE agent_id = ?", agentId);
            if (!econRows.isEmpty()) {
                String econId = (String) econRows.get(0).get("id");
                jdbcTemplate.update("""
                    INSERT INTO credit_transaction (id, economy_id, amount, transaction_type, category, description, created_at)
                    VALUES (?, ?, ?, 'credit', ?, ?, ?)
                    """, txId, econId, amount, category, "Task reward", now);
            }
        } catch (Exception e) {
            log.error("EconomyClient.reward failed: {}", e.getMessage());
        }
    }

    /**
     * 获取模型调用成本
     */
    public double getCost(String modelBinding) {
        if (modelBinding == null) return 10.0;
        return RESOURCE_COSTS.entrySet().stream()
            .filter(e -> modelBinding.toLowerCase().contains(e.getKey()))
            .mapToDouble(Map.Entry::getValue)
            .findFirst()
            .orElse(10.0);
    }

    /**
     * 查询账户余额
     */
    public double getCredits(String agentId) {
        try {
            var rows = jdbcTemplate.queryForList(
                "SELECT credits FROM economy WHERE agent_id = ?", agentId);
            if (!rows.isEmpty()) {
                return ((Number) rows.get(0).get("credits")).doubleValue();
            }
        } catch (Exception e) {
            log.warn("EconomyClient.getCredits failed: {}", e.getMessage());
        }
        return 1000.0;
    }
}
