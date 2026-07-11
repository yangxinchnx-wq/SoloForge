package com.soloforge.agent.training;

import com.soloforge.agent.aisociety.EconomyClient;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import com.soloforge.agent.persistence.ExperienceCaseEntity;
import com.soloforge.agent.persistence.ExperienceCaseRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.*;

/**
 * 反馈控制器 — 用户 👍/👎 写入经验案例库 (RAG)
 *
 * 设计转变 (2026-07-08):
 *   旧方案: 累积 negative 反馈 → 触发 PromptOptimizer 自动改 prompt
 *   新方案: 每条反馈 + 完整上下文 (userMessage + response) 写入 experience_case 表
 *           Agent 调用时检索相似案例作 few-shot 参考
 *
 * 理由: 旧方案无法判定"哪些反馈有用", 自动改 prompt 不可控;
 *       新方案把"有用/没用"的判定权交给用户 (可在案例库 UI 增删)。
 *
 * 数据存储: experience_case 表 (与 social_memory 隔离, 语义清晰)
 */
@Slf4j
@RestController
@RequestMapping("/api/feedback")
@RequiredArgsConstructor
public class FeedbackController {

    private final ExperienceCaseRepository caseRepo;
    private final AgentIdentityRepository agentRepo;
    private final EconomyClient economyClient;

    // 反馈经济参数: 👍 奖励 / 👎 惩罚 (信用分)
    private static final double REWARD_AMOUNT = 200.0;
    private static final double PENALTY_AMOUNT = 100.0;

    /**
     * 提交反馈 — 写入经验案例
     *
     * @param request { agentId, positive, message, response, chatId, comment }
     */
    @PostMapping
    public ResponseEntity<Map<String, Object>> submitFeedback(@RequestBody FeedbackRequest request) {
        if (request.getAgentId() == null || request.getAgentId().isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "agentId is required"));
        }

        log.info("Feedback received: agent={} positive={} chatId={}",
                request.getAgentId(), request.isPositive(), request.getChatId());

        // 查 Agent domain (用于按域检索)
        String domain = agentRepo.findById(request.getAgentId())
                .map(a -> a.getDomain())
                .orElse(null);

        // 写入经验案例表
        ExperienceCaseEntity entity = new ExperienceCaseEntity();
        entity.setUserMessage(request.getMessage() != null ? request.getMessage() : "");
        entity.setAssistantResponse(request.getResponse() != null ? request.getResponse() : "");
        entity.setFeedback(request.isPositive() ? "positive" : "negative");
        entity.setFeedbackComment(request.getComment());
        entity.setChatId(request.getChatId());
        entity.setAgentId(request.getAgentId());
        entity.setDomain(domain);
        entity.setIncluded(1); // 默认纳入检索池, 用户可在 UI 上排除

        ExperienceCaseEntity saved = caseRepo.save(entity);

        // ── 经济系统联动: 👍 加钱 / 👎 扣钱 ──────────────────────────
        // 做得好 → 信用分增加, 做得差 → 信用分扣减
        // 这样 Agent 做得越好钱越多, 做得差则可能因余额不足被拦截
        String agentId = request.getAgentId();
        double creditsBefore = economyClient.getCredits(agentId);
        if (request.isPositive()) {
            economyClient.reward(agentId, REWARD_AMOUNT, "feedback_positive");
            log.info("Feedback 👍 reward: agent={} +{} credits ({} → {})",
                    agentId, REWARD_AMOUNT, creditsBefore, creditsBefore + REWARD_AMOUNT);
        } else {
            economyClient.penalty(agentId, PENALTY_AMOUNT, "feedback_negative");
            log.info("Feedback 👎 penalty: agent={} -{} credits ({} → {})",
                    agentId, PENALTY_AMOUNT, creditsBefore, creditsBefore - PENALTY_AMOUNT);
        }
        double creditsAfter = economyClient.getCredits(agentId);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("acknowledged", true);
        result.put("caseId", saved.getId());
        result.put("agentId", request.getAgentId());
        result.put("positive", request.isPositive());
        result.put("trainingTriggered", false); // 兼容前端字段, 新方案不再自动训练
        result.put("creditsBefore", creditsBefore);
        result.put("creditsAfter", creditsAfter);
        result.put("rewardAmount", request.isPositive() ? REWARD_AMOUNT : -PENALTY_AMOUNT);
        result.put("message", request.isPositive()
                ? String.format("正向反馈! 信用分 +%.0f (当前: %.0f)", REWARD_AMOUNT, creditsAfter)
                : String.format("负向反馈, 信用分 -%.0f (当前: %.0f)", PENALTY_AMOUNT, creditsAfter));

        return ResponseEntity.ok(result);
    }

    /**
     * 查询某个 Agent 的案例统计
     */
    @GetMapping("/status/{agentId}")
    public ResponseEntity<Map<String, Object>> status(@PathVariable String agentId) {
        int positive = caseRepo.countByFeedback("positive");
        int negative = caseRepo.countByFeedback("negative");
        return ResponseEntity.ok(Map.of(
                "agentId", agentId,
                "positiveCount", positive,
                "negativeCount", negative,
                "total", positive + negative
        ));
    }

    /**
     * 查询所有反馈统计
     */
    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> allStatus() {
        int positive = caseRepo.countByFeedback("positive");
        int negative = caseRepo.countByFeedback("negative");
        int total = caseRepo.count();
        return ResponseEntity.ok(Map.of(
                "positiveCount", positive,
                "negativeCount", negative,
                "total", total
        ));
    }

    // ── 案例库管理 CRUD (供前端 CaseLibraryTab 使用) ────────────────

    /**
     * 查询案例列表 (支持按 agentId / feedback 过滤 + 分页)
     */
    @GetMapping("/cases")
    public ResponseEntity<Map<String, Object>> listCases(
            @RequestParam(required = false) String agentId,
            @RequestParam(required = false) String feedback,
            @RequestParam(defaultValue = "50") int limit,
            @RequestParam(defaultValue = "0") int offset) {
        List<ExperienceCaseEntity> cases;
        if (agentId != null && !agentId.isBlank()) {
            cases = caseRepo.findByAgentId(agentId, limit, offset);
        } else if (feedback != null && !feedback.isBlank()) {
            cases = caseRepo.findByFeedback(feedback, limit, offset);
        } else {
            cases = caseRepo.findAll(limit, offset);
        }

        List<Map<String, Object>> items = new ArrayList<>();
        for (ExperienceCaseEntity c : cases) {
            items.add(caseToMap(c));
        }

        return ResponseEntity.ok(Map.of(
                "cases", items,
                "total", caseRepo.count(),
                "limit", limit,
                "offset", offset
        ));
    }

    /**
     * 删除案例
     */
    @DeleteMapping("/cases/{id}")
    public ResponseEntity<Map<String, Object>> deleteCase(@PathVariable String id) {
        boolean deleted = caseRepo.deleteById(id);
        return ResponseEntity.ok(Map.of("deleted", deleted, "id", id));
    }

    /**
     * 切换案例是否纳入检索池
     */
    @PostMapping("/cases/{id}/included")
    public ResponseEntity<Map<String, Object>> setIncluded(
            @PathVariable String id, @RequestParam int included) {
        caseRepo.setIncluded(id, included);
        return ResponseEntity.ok(Map.of("id", id, "included", included));
    }

    private Map<String, Object> caseToMap(ExperienceCaseEntity c) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", c.getId());
        m.put("userMessage", c.getUserMessage());
        m.put("assistantResponse", c.getAssistantResponse());
        m.put("feedback", c.getFeedback());
        m.put("feedbackComment", c.getFeedbackComment());
        m.put("chatId", c.getChatId());
        m.put("agentId", c.getAgentId());
        m.put("domain", c.getDomain());
        m.put("included", c.getIncluded());
        m.put("createdAt", c.getCreatedAt() != null ? c.getCreatedAt().toString() : null);
        return m;
    }
}
