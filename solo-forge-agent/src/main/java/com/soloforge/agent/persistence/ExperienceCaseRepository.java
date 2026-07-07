package com.soloforge.agent.persistence;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import jakarta.annotation.PostConstruct;
import java.time.LocalDateTime;
import java.util.ArrayList;
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
    /** 检索时间窗口 (天), 只检索近 N 天的案例, 老案例不参与检索 */
    private static final int RETENTION_DAYS = 90;

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

            // FTS5 全文索引虚拟表 (检索 user_message + assistant_response)
            // 替代 LIKE 全表扫, 检索性能从 O(n) 降到 O(log n)
            jdbcTemplate.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS experience_case_fts
                USING fts5(
                    user_message,
                    assistant_response,
                    content='experience_case',
                    content_rowid='rowid'
                )
                """);

            // 触发器: INSERT 时同步写入 FTS
            jdbcTemplate.execute("""
                CREATE TRIGGER IF NOT EXISTS exp_case_ai AFTER INSERT ON experience_case BEGIN
                    INSERT INTO experience_case_fts(rowid, user_message, assistant_response)
                    VALUES (new.rowid, new.user_message, new.assistant_response);
                END
                """);
            // 触发器: DELETE 时同步删除 FTS
            jdbcTemplate.execute("""
                CREATE TRIGGER IF NOT EXISTS exp_case_ad AFTER DELETE ON experience_case BEGIN
                    INSERT INTO experience_case_fts(experience_case_fts, rowid, user_message, assistant_response)
                    VALUES ('delete', old.rowid, old.user_message, old.assistant_response);
                END
                """);

            // 启动时清理超容量的旧案例
            evictExcess();

            log.info("experience_case table ready (FTS5 enabled, max={} retention={}d)", MAX_CASES, RETENTION_DAYS);
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

    // ── RAG 检索 (供 CaseRetriever 使用) ──────────────────────────

    /**
     * FTS5 全文检索: 在 user_message + assistant_response 上 MATCH, 按 domain + 时间窗口过滤
     *
     * 性能: O(log n) (FTS5 倒排索引), 远优于 LIKE 的 O(n) 全表扫
     * 时间窗口: 只检索近 RETENTION_DAYS 天的案例, 老案例不参与
     *
     * @param query  当前用户消息 (检索 query, 会被转义为 FTS5 安全的 OR 查询)
     * @param domain Agent 领域 (可为 null, 不过滤)
     * @param limit  返回条数
     * @return 匹配的案例列表 (按 created_at 倒序)
     */
    public List<ExperienceCaseEntity> searchByKeyword(String query, String domain, int limit) {
        if (query == null || query.isBlank()) {
            return List.of();
        }
        String ftsQuery = toFtsQuery(query);
        if (ftsQuery == null) return List.of();

        String cutoff = LocalDateTime.now().minusDays(RETENTION_DAYS).toString();

        if (domain != null && !domain.isBlank()) {
            return jdbcTemplate.query("""
                SELECT e.* FROM experience_case e
                JOIN experience_case_fts f ON e.rowid = f.rowid
                WHERE e.included = 1
                  AND e.domain = ?
                  AND e.created_at >= ?
                  AND experience_case_fts MATCH ?
                ORDER BY e.created_at DESC LIMIT ?
                """,
                ROW_MAPPER, domain, cutoff, ftsQuery, limit);
        }
        return jdbcTemplate.query("""
            SELECT e.* FROM experience_case e
            JOIN experience_case_fts f ON e.rowid = f.rowid
            WHERE e.included = 1
              AND e.created_at >= ?
              AND experience_case_fts MATCH ?
            ORDER BY e.created_at DESC LIMIT ?
            """,
            ROW_MAPPER, cutoff, ftsQuery, limit);
    }

    /**
     * 把自然语言 query 转成 FTS5 安全的查询表达式
     *
     * FTS5 语法: 词1 OR 词2 OR 词3
     * 过滤掉特殊字符, 避免 FTS5 语法错误
     */
    private String toFtsQuery(String query) {
        // 按非字母数字汉字分割, 取前 5 个词, 用 OR 连接
        String[] words = query.split("[^\\p{L}\\p{N}]+");
        List<String> valid = new ArrayList<>();
        for (String w : words) {
            if (w.length() >= 2 && valid.size() < 5) {  // 过滤单字符, 最多 5 个词
                // 转义 FTS5 特殊字符 (用双引号包裹整个词)
                valid.add("\"" + w.replace("\"", "") + "\"");
            }
        }
        return valid.isEmpty() ? null : String.join(" OR ", valid);
    }

    /**
     * 取最近 N 条案例 (无关键词匹配时的 fallback) — 同样受时间窗口限制
     */
    public List<ExperienceCaseEntity> findRecent(String domain, int limit) {
        String cutoff = LocalDateTime.now().minusDays(RETENTION_DAYS).toString();
        if (domain != null && !domain.isBlank()) {
            return jdbcTemplate.query(
                "SELECT * FROM experience_case WHERE included = 1 AND domain = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?",
                ROW_MAPPER, domain, cutoff, limit);
        }
        return jdbcTemplate.query(
            "SELECT * FROM experience_case WHERE included = 1 AND created_at >= ? ORDER BY created_at DESC LIMIT ?",
            ROW_MAPPER, cutoff, limit);
    }
}
