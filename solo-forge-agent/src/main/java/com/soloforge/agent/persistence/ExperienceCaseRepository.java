package com.soloforge.agent.persistence;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import jakarta.annotation.PostConstruct;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * 经验案例 Repository
 *
 * 用 JdbcTemplate 操作 experience_case 表 (SQLite),
 * 与 AgentIdentityRepository 风格一致。
 *
 * 启动时自动建表 (CREATE TABLE IF NOT EXISTS), 不依赖 Python 侧 migration。
 */
@Slf4j
@Repository
@RequiredArgsConstructor
public class ExperienceCaseRepository {

    private final JdbcTemplate jdbcTemplate;

    /** 案例库容量上限 (超过自动淘汰最老的, 防止无限膨胀) */
    private static final int MAX_CASES = 2000;
    private static final RowMapper<ExperienceCaseEntity> ROW_MAPPER = (rs, rowNum) -> {
        ExperienceCaseEntity e = new ExperienceCaseEntity();
        e.setId(rs.getString("id"));
        e.setUserMessage(rs.getString("user_message"));
        e.setAssistantResponse(rs.getString("assistant_response"));
        e.setFeedback(rs.getString("feedback"));
        e.setFeedbackComment(rs.getString("feedback_comment"));
        e.setChatId(rs.getString("chat_id"));
        e.setAgentId(rs.getString("agent_id"));
        e.setDomain(rs.getString("domain"));
        e.setIncluded(rs.getInt("included"));
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

    @PostConstruct
    public void initTable() {
        try {
            // 主表
            jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS experience_case (
                    id                  TEXT PRIMARY KEY,
                    user_message        TEXT NOT NULL,
                    assistant_response  TEXT NOT NULL,
                    feedback            TEXT,
                    feedback_comment    TEXT,
                    chat_id             TEXT,
                    agent_id            TEXT,
                    domain              TEXT,
                    included            INTEGER DEFAULT 1,
                    created_at          TEXT NOT NULL,
                    updated_at          TEXT NOT NULL
                )
                """);
            jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_exp_feedback ON experience_case(feedback)");
            jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_exp_agent ON experience_case(agent_id)");
            jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_exp_domain ON experience_case(domain)");
            jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_exp_included ON experience_case(included)");
            jdbcTemplate.execute("CREATE INDEX IF NOT EXISTS idx_exp_created ON experience_case(created_at)");

            // 启动时清理超容量的旧案例
            evictExcess();

            log.info("experience_case table ready (max={})", MAX_CASES);
        } catch (Exception e) {
            log.error("Failed to init experience_case table: {}", e.getMessage());
        }
    }

    /**
     * 容量上限淘汰: 超过 MAX_CASES 时删除最老的案例 (含 FTS 同步)
     */
    private void evictExcess() {
        try {
            Integer count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM experience_case", Integer.class);
            if (count != null && count > MAX_CASES) {
                int toDelete = count - MAX_CASES;
                jdbcTemplate.update("""
                    DELETE FROM experience_case WHERE id IN (
                        SELECT id FROM experience_case ORDER BY created_at ASC LIMIT ?
                    )
                    """, toDelete);
                log.info("Evicted {} old cases (count was {} > max {})", toDelete, count, MAX_CASES);
            }
        } catch (Exception e) {
            log.warn("evictExcess failed: {}", e.getMessage());
        }
    }

    /**
     * 保存案例 (INSERT) — 保存后自动清理超容量旧案例
     */
    public ExperienceCaseEntity save(ExperienceCaseEntity entity) {
        if (entity.getId() == null || entity.getId().isBlank()) {
            entity.setId("case_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12));
        }
        LocalDateTime now = LocalDateTime.now();
        if (entity.getCreatedAt() == null) entity.setCreatedAt(now);
        entity.setUpdatedAt(now);
        if (entity.getIncluded() == null) entity.setIncluded(1);

        jdbcTemplate.update("""
            INSERT INTO experience_case
            (id, user_message, assistant_response, feedback, feedback_comment,
             chat_id, agent_id, domain, included, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            entity.getId(), entity.getUserMessage(), entity.getAssistantResponse(),
            entity.getFeedback(), entity.getFeedbackComment(),
            entity.getChatId(), entity.getAgentId(), entity.getDomain(),
            entity.getIncluded(),
            entity.getCreatedAt().toString(),
            entity.getUpdatedAt().toString());

        // 容量上限淘汰 (触发器会同步清理 FTS)
        evictExcess();
        return entity;
    }

    public Optional<ExperienceCaseEntity> findById(String id) {
        List<ExperienceCaseEntity> list = jdbcTemplate.query(
            "SELECT * FROM experience_case WHERE id = ?", ROW_MAPPER, id);
        return list.isEmpty() ? Optional.empty() : Optional.of(list.get(0));
    }

    /**
     * 全量查询 (按时间倒序), 用于案例库管理 UI
     */
    public List<ExperienceCaseEntity> findAll(int limit, int offset) {
        return jdbcTemplate.query(
            "SELECT * FROM experience_case ORDER BY created_at DESC LIMIT ? OFFSET ?",
            ROW_MAPPER, limit, offset);
    }

    /**
     * 按 Agent 过滤
     */
    public List<ExperienceCaseEntity> findByAgentId(String agentId, int limit, int offset) {
        return jdbcTemplate.query(
            "SELECT * FROM experience_case WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
            ROW_MAPPER, agentId, limit, offset);
    }

    /**
     * 按反馈类型过滤 (positive / negative)
     */
    public List<ExperienceCaseEntity> findByFeedback(String feedback, int limit, int offset) {
        return jdbcTemplate.query(
            "SELECT * FROM experience_case WHERE feedback = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
            ROW_MAPPER, feedback, limit, offset);
    }

    /**
     * 模糊查找相似案例 (按 user_message / assistant_response 关键词匹配)
     * 简单实现: 把 query 拆成关键词, 在 user_message / assistant_response 上做 LIKE 查询。
     * 用于 RAGAdvisor 注入历史经验。
     */
    public List<String> findSimilarCases(String query) {
        if (query == null || query.isBlank()) return List.of();
        // 取前 5 个关键词 (长度 >= 2) 做 LIKE 匹配
        String[] tokens = query.toLowerCase().split("\\W+");
        List<String> keywords = new java.util.ArrayList<>();
        for (String t : tokens) {
            if (t.length() >= 2) keywords.add(t);
            if (keywords.size() >= 5) break;
        }
        if (keywords.isEmpty()) return List.of();

        // 查询存在的列: user_message + assistant_response (feedback 优先 positive)
        StringBuilder sql = new StringBuilder(
            "SELECT user_message, assistant_response, feedback FROM experience_case WHERE included = 1 AND (");
        List<Object> params = new java.util.ArrayList<>();
        for (int i = 0; i < keywords.size(); i++) {
            if (i > 0) sql.append(" OR ");
            String like = "%" + keywords.get(i) + "%";
            sql.append("(LOWER(COALESCE(user_message,'')) LIKE ? OR LOWER(COALESCE(assistant_response,'')) LIKE ?)");
            params.add(like); params.add(like);
        }
        sql.append(") ORDER BY CASE feedback WHEN 'positive' THEN 0 WHEN 'negative' THEN 1 ELSE 2 END, created_at DESC LIMIT 5");

        try {
            return jdbcTemplate.query(sql.toString(), (rs, rowNum) -> {
                StringBuilder sb = new StringBuilder();
                String userMsg = rs.getString("user_message");
                String assistantResp = rs.getString("assistant_response");
                String feedback = rs.getString("feedback");
                if (userMsg != null && !userMsg.isBlank()) {
                    sb.append("Q: ").append(userMsg, 0, Math.min(userMsg.length(), 200)).append("\n");
                }
                if (assistantResp != null && !assistantResp.isBlank()) {
                    sb.append("A: ").append(assistantResp, 0, Math.min(assistantResp.length(), 500)).append("\n");
                }
                if ("negative".equals(feedback)) {
                    sb.append("(注意: 此案例为负反馈, 仅供参考避免)\n");
                }
                return sb.toString();
            }, params.toArray());
        } catch (Exception e) {
            log.warn("findSimilarCases failed (table may not exist yet): {}", e.getMessage());
            return List.of();
        }
    }

    /**
     * 统计总数
     */
    public int count() {
        Integer c = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM experience_case", Integer.class);
        return c != null ? c : 0;
    }

    /**
     * 按反馈统计
     */
    public int countByFeedback(String feedback) {
        Integer c = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM experience_case WHERE feedback = ?", Integer.class, feedback);
        return c != null ? c : 0;
    }

    /**
     * 删除案例
     */
    public boolean deleteById(String id) {
        int rows = jdbcTemplate.update("DELETE FROM experience_case WHERE id = ?", id);
        return rows > 0;
    }

    /**
     * 设置是否纳入检索池 (用户在 UI 上标记"不参考此案例")
     */
    public void setIncluded(String id, int included) {
        jdbcTemplate.update(
            "UPDATE experience_case SET included = ?, updated_at = ? WHERE id = ?",
            included, LocalDateTime.now().toString(), id);
    }

}
