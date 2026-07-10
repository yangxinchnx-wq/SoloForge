package com.soloforge.agent.persistence;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

/**
 * Agent 身份 Repository
 *
 * 直接用 JdbcTemplate 操作 AI Society 的 SQLite 数据库，
 * 避免 Spring Data JDBC 对 SQLite 的 dialect 限制。
 */
@Slf4j
@Repository
@RequiredArgsConstructor
public class AgentIdentityRepository {

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    private static final RowMapper<AgentIdentityEntity> ROW_MAPPER = (rs, rowNum) -> {
        AgentIdentityEntity e = new AgentIdentityEntity();
        e.setId(rs.getString("id"));
        e.setRole(rs.getString("role"));
        e.setModelBinding(rs.getString("model_binding"));
        e.setSystemPrompt(rs.getString("system_prompt"));
        e.setSystemPromptVersion(rs.getInt("system_prompt_version"));
        e.setCurrentCheckpointPath(rs.getString("current_checkpoint_path"));
        e.setCheckpointVersion(rs.getInt("checkpoint_version"));
        e.setTaskCount(rs.getInt("task_count"));
        e.setReputationId(rs.getString("reputation_id"));
        e.setStatus(rs.getString("status"));
        e.setName(rs.getString("name"));
        e.setAvatar(rs.getString("avatar"));
        e.setDomain(rs.getString("domain"));
        e.setCapabilities(rs.getString("capabilities"));
        e.setStrategy(rs.getString("strategy"));
        e.setLevel(rs.getString("level"));
        e.setTemperature(rs.getDouble("temperature"));
        e.setMaxRounds(rs.getInt("max_rounds"));
        e.setEnabled(rs.getInt("enabled"));
        String createdStr = rs.getString("created_at");
        if (createdStr != null) {
            try { e.setCreatedAt(LocalDateTime.parse(createdStr.replace(" ", "T"))); }
            catch (Exception ignored) {}
        }
        String updatedStr = rs.getString("updated_at");
        if (updatedStr != null) {
            try { e.setUpdatedAt(LocalDateTime.parse(updatedStr.replace(" ", "T"))); }
            catch (Exception ignored) {}
        }
        return e;
    };

    public Optional<AgentIdentityEntity> findById(String id) {
        List<AgentIdentityEntity> list = jdbcTemplate.query(
            "SELECT * FROM agent_identity WHERE id = ?",
            ROW_MAPPER, id);
        return list.isEmpty() ? Optional.empty() : Optional.of(list.get(0));
    }

    public List<AgentIdentityEntity> findAllEnabled() {
        return jdbcTemplate.query(
            "SELECT * FROM agent_identity WHERE enabled = 1 ORDER BY role, name",
            ROW_MAPPER);
    }

    public List<AgentIdentityEntity> findAll() {
        return jdbcTemplate.query(
            "SELECT * FROM agent_identity ORDER BY role, name",
            ROW_MAPPER);
    }

    public List<AgentIdentityEntity> findByRole(String role) {
        return jdbcTemplate.query(
            "SELECT * FROM agent_identity WHERE role = ? AND enabled = 1",
            ROW_MAPPER, role);
    }

    /**
     * 增加任务计数
     */
    public void incrementTaskCount(String agentId) {
        jdbcTemplate.update(
            "UPDATE agent_identity SET task_count = task_count + 1, updated_at = ? WHERE id = ?",
            LocalDateTime.now().toString(), agentId);
    }

    /**
     * 更新 System Prompt (由 PromptOptimizer 调用)
     */
    public void updateSystemPrompt(String agentId, String newPrompt, int newVersion) {
        jdbcTemplate.update(
            "UPDATE agent_identity SET system_prompt = ?, system_prompt_version = ?, updated_at = ? WHERE id = ?",
            newPrompt, newVersion, LocalDateTime.now().toString(), agentId);
        log.info("Agent {} system prompt updated to version {}", agentId, newVersion);
    }

    /**
     * 更新显示名称和头像 (由前端 AgentSettingsModal 调用)
     */
    public void updateProfile(String agentId, String name, String avatar) {
        jdbcTemplate.update(
            "UPDATE agent_identity SET name = ?, avatar = ?, updated_at = ? WHERE id = ?",
            name, avatar, LocalDateTime.now().toString(), agentId);
        log.info("Agent {} profile updated: name={}, avatar={}", agentId, name, avatar);
    }

    /**
     * 创建新 Agent
     */
    public void save(AgentIdentityEntity entity) {
        String now = LocalDateTime.now().toString();
        if (entity.getCreatedAt() == null) entity.setCreatedAt(LocalDateTime.now());
        if (entity.getUpdatedAt() == null) entity.setUpdatedAt(LocalDateTime.now());

        jdbcTemplate.update("""
            INSERT OR REPLACE INTO agent_identity
            (id, role, model_binding, system_prompt, system_prompt_version,
             current_checkpoint_path, checkpoint_version, task_count, reputation_id,
             status, name, avatar, domain, capabilities, strategy, level,
             temperature, max_rounds, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            entity.getId(), entity.getRole(), entity.getModelBinding(),
            entity.getSystemPrompt(),
            entity.getSystemPromptVersion() != null ? entity.getSystemPromptVersion() : 0,
            entity.getCurrentCheckpointPath(),
            entity.getCheckpointVersion() != null ? entity.getCheckpointVersion() : 0,
            entity.getTaskCount() != null ? entity.getTaskCount() : 0,
            entity.getReputationId(),
            entity.getStatus() != null ? entity.getStatus() : "active",
            entity.getName(), entity.getAvatar(), entity.getDomain(),
            entity.getCapabilities() != null ? entity.getCapabilities() : "[]",
            entity.getStrategy() != null ? entity.getStrategy() : "direct",
            entity.getLevel() != null ? entity.getLevel() : "senior",
            entity.getTemperature() != null ? entity.getTemperature() : 0.3,
            entity.getMaxRounds() != null ? entity.getMaxRounds() : 8,
            entity.getEnabled() != null ? entity.getEnabled() : 1,
            entity.getCreatedAt().toString(),
            entity.getUpdatedAt().toString());
    }

    /**
     * 解析 capabilities JSON 字符串为 List
     */
    public List<String> parseCapabilities(AgentIdentityEntity entity) {
        try {
            return objectMapper.readValue(
                entity.getCapabilities() != null ? entity.getCapabilities() : "[]",
                new TypeReference<List<String>>() {});
        } catch (Exception e) {
            log.warn("Failed to parse capabilities for agent {}: {}", entity.getId(), e.getMessage());
            return List.of();
        }
    }
}
