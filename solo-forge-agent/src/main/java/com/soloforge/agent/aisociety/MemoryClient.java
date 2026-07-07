package com.soloforge.agent.aisociety;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 社会记忆 Client (查询 AI Society social_memory 表)
 *
 * System Prompt 第 11 层 ExperienceAdvisor 调用此 Client,
 * 从历史记忆中提取经验教训注入 prompt。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class MemoryClient {

    private final JdbcTemplate jdbcTemplate;

    /**
     * 获取所有经验教训 (用于 System Prompt 第 11 层)
     */
    public List<String> getLessons(String domain) {
        try {
            String sql = domain != null
                ? "SELECT lessons FROM social_memory WHERE impact = 'positive' AND (domain = ? OR domain IS NULL) ORDER BY created_at DESC LIMIT 10"
                : "SELECT lessons FROM social_memory WHERE impact = 'positive' ORDER BY created_at DESC LIMIT 10";

            List<Map<String, Object>> rows = domain != null
                ? jdbcTemplate.queryForList(sql, domain)
                : jdbcTemplate.queryForList(sql);

            List<String> lessons = new ArrayList<>();
            for (Map<String, Object> row : rows) {
                String l = (String) row.get("lessons");
                if (l != null && !l.isBlank()) {
                    // lessons 是逗号分隔的字符串
                    for (String lesson : l.split(",")) {
                        String trimmed = lesson.trim();
                        if (!trimmed.isEmpty()) lessons.add(trimmed);
                    }
                }
            }
            return lessons;
        } catch (Exception e) {
            log.warn("MemoryClient.getLessons failed: {}", e.getMessage());
            return List.of();
        }
    }

    /**
     * 创建记忆 (任务完成后调用)
     */
    public void create(String event, String impact, String severity,
                       List<String> participants, List<String> lessons, String domain) {
        try {
            String id = "mem_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            String now = LocalDateTime.now().toString();
            jdbcTemplate.update("""
                INSERT INTO social_memory
                (id, event, impact, severity, participants, lessons, domain, outcome, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                id, event, impact, severity,
                String.join(",", participants),
                String.join(",", lessons),
                domain, null, now);
            log.info("Memory created: event={} impact={}", event, impact);
        } catch (Exception e) {
            log.error("MemoryClient.create failed: {}", e.getMessage());
        }
    }

    /**
     * 统计记忆总数
     */
    public int count() {
        try {
            return jdbcTemplate.queryForObject("SELECT COUNT(*) FROM social_memory", Integer.class);
        } catch (Exception e) {
            return 0;
        }
    }
}
