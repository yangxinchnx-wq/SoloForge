package com.soloforge.agent.aisociety;

import com.soloforge.agent.persistence.ExperienceCaseEntity;
import com.soloforge.agent.persistence.ExperienceCaseRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * 案例检索器 (RAG)
 *
 * 根据当前用户消息检索历史经验案例, 作为 few-shot 参考注入 System Prompt。
 *
 * 检索策略 (简单可控, 无需 embedding):
 *   1. 关键词匹配: 在 user_message 字段上做 LIKE, 按 domain 过滤
 *   2. Fallback: 无命中时取最近 N 条 (按 domain 过滤)
 *
 * 格式化输出: 每条案例格式为 "用户问: ... → 助手答: ... (正向/负向)"
 * 正向案例供 Agent 学习好的回复模式, 负向案例标注"用户认为不好"供规避。
 *
 * 用户可在案例库管理 UI 中删除没用的案例或标记 included=0 排除检索。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class CaseRetriever {

    private final ExperienceCaseRepository caseRepo;

    /** 默认检索条数 */
    private static final int DEFAULT_LIMIT = 5;
    /** 案例文本截断长度 (避免 prompt 膨胀) */
    private static final int MAX_TEXT_LEN = 300;

    /**
     * 检索相似案例并格式化为 few-shot 字符串列表
     *
     * @param query  当前用户消息
     * @param domain Agent 领域 (可为 null)
     * @return 格式化的案例字符串列表 (可能为空)
     */
    public List<String> retrieve(String query, String domain) {
        return retrieve(query, domain, DEFAULT_LIMIT);
    }

    public List<String> retrieve(String query, String domain, int limit) {
        List<ExperienceCaseEntity> cases = new ArrayList<>();

        // 1. 关键词检索
        if (query != null && !query.isBlank()) {
            cases = caseRepo.searchByKeyword(query, domain, limit);
        }

        // 2. Fallback: 无命中时取最近 N 条
        if (cases.isEmpty()) {
            log.debug("No keyword match, falling back to recent cases (domain={})", domain);
            cases = caseRepo.findRecent(domain, limit);
        }

        if (cases.isEmpty()) {
            return List.of();
        }

        // 3. 格式化
        List<String> formatted = new ArrayList<>();
        for (ExperienceCaseEntity c : cases) {
            formatted.add(formatCase(c));
        }

        log.info("CaseRetriever: query='{}' domain={} → {} cases retrieved",
                query != null && query.length() > 40 ? query.substring(0, 40) + "..." : query,
                domain, formatted.size());
        return formatted;
    }

    private String formatCase(ExperienceCaseEntity c) {
        String userMsg = truncate(c.getUserMessage(), MAX_TEXT_LEN);
        String response = truncate(c.getAssistantResponse(), MAX_TEXT_LEN);
        String feedback = "positive".equals(c.getFeedback()) ? "正向" : "负向";

        StringBuilder sb = new StringBuilder();
        sb.append("[").append(feedback).append("案例] ");
        sb.append("用户问: ").append(userMsg);
        sb.append(" → 助手答: ").append(response);
        if ("negative".equals(c.getFeedback())) {
            sb.append(" (用户认为此回复不好, 注意规避类似问题)");
        }
        return sb.toString();
    }

    private String truncate(String text, int maxLen) {
        if (text == null) return "";
        if (text.length() <= maxLen) return text;
        return text.substring(0, maxLen) + "...";
    }
}
