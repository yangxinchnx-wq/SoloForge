package com.soloforge.agent.persistence;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;

/**
 * Agent 训练历史 Repository
 */
@Slf4j
@Repository
@RequiredArgsConstructor
public class AgentTrainingHistoryRepository {

    private final JdbcTemplate jdbcTemplate;

    private static final RowMapper<AgentTrainingHistoryEntity> ROW_MAPPER = (rs, rowNum) -> {
        AgentTrainingHistoryEntity e = new AgentTrainingHistoryEntity();
        e.setId(rs.getString("id"));
        e.setAgentId(rs.getString("agent_id"));
        String trainedStr = rs.getString("trained_at");
        if (trainedStr != null) {
            try { e.setTrainedAt(LocalDateTime.parse(trainedStr.replace(" ", "T"))); }
            catch (Exception ignored) {}
        }
        e.setTriggerReason(rs.getString("trigger_reason"));
        e.setSampleCount(rs.getInt("sample_count"));
        e.setRewardBefore(rs.getDouble("reward_before"));
        e.setRewardAfter(rs.getDouble("reward_after"));
        e.setPromptVersionBefore(rs.getInt("prompt_version_before"));
        e.setPromptVersionAfter(rs.getInt("prompt_version_after"));
        e.setCheckpointPath(rs.getString("checkpoint_path"));
        e.setNotes(rs.getString("notes"));
        String createdStr = rs.getString("created_at");
        if (createdStr != null) {
            try { e.setCreatedAt(LocalDateTime.parse(createdStr.replace(" ", "T"))); }
            catch (Exception ignored) {}
        }
        return e;
    };

    public List<AgentTrainingHistoryEntity> findByAgentId(String agentId) {
        return jdbcTemplate.query(
            "SELECT * FROM agent_training_history WHERE agent_id = ? ORDER BY trained_at DESC LIMIT 50",
            ROW_MAPPER, agentId);
    }

    public void save(AgentTrainingHistoryEntity entity) {
        if (entity.getId() == null) {
            entity.setId("hist_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 12));
        }
        if (entity.getTrainedAt() == null) entity.setTrainedAt(LocalDateTime.now());
        if (entity.getCreatedAt() == null) entity.setCreatedAt(LocalDateTime.now());

        jdbcTemplate.update("""
            INSERT INTO agent_training_history
            (id, agent_id, trained_at, trigger_reason, sample_count,
             reward_before, reward_after, prompt_version_before, prompt_version_after,
             checkpoint_path, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            entity.getId(), entity.getAgentId(),
            entity.getTrainedAt().toString(), entity.getTriggerReason(),
            entity.getSampleCount(),
            entity.getRewardBefore(), entity.getRewardAfter(),
            entity.getPromptVersionBefore(), entity.getPromptVersionAfter(),
            entity.getCheckpointPath(), entity.getNotes(),
            entity.getCreatedAt().toString());
    }
}
