package com.soloforge.agent.training;

import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.persistence.AgentTrainingHistoryEntity;
import com.soloforge.agent.persistence.AgentTrainingHistoryRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 训练控制器 + 定时调度
 *
 * REST API:
 *   POST /api/training/optimize          — 手动触发优化 (可选 ?agentId=xxx)
 *   GET  /api/training/history/{agentId} — 查询训练历史
 *   GET  /api/training/tasks             — 查看标准任务集
 *   GET  /api/training/status            — 查询训练状态
 *
 * 定时调度:
 *   每天凌晨 2 点自动优化所有 Agent (可通过 soloforge.training.scheduler.enabled 关闭)
 */
@Slf4j
@RestController
@RequestMapping("/api/training")
@RequiredArgsConstructor
@ConditionalOnProperty(name = "soloforge.training.enabled", havingValue = "true", matchIfMissing = true)
public class TrainingController {

    private final PromptOptimizer optimizer;
    private final TrainingTaskLoader taskLoader;
    private final AgentTrainingHistoryRepository historyRepo;

    /** 异步训练线程池 (单线程, 避免并发训练干扰) */
    private final ExecutorService trainingExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "prompt-optimizer");
        t.setDaemon(true);
        return t;
    });

    /** 训练状态追踪 */
    private final Map<String, String> trainingStatus = new ConcurrentHashMap<>();

    /**
     * 手动触发 Prompt 优化
     *
     * Body: { agentId?: string, provider?: { baseUrl, apiKey, model } }
     *   - agentId: 可选, 指定优化单个 Agent; 不传则优化所有
     *   - provider: 可选, 用户选择的 LLM provider; 不传则使用默认训练 LLM
     */
    @SuppressWarnings("unchecked")
    @PostMapping("/optimize")
    public ResponseEntity<Map<String, Object>> optimize(@RequestBody(required = false) Map<String, Object> body) {
        String agentId = body != null ? (String) body.get("agentId") : null;

        // 解析可选的 provider
        ChatRequest.LlmProvider provider = null;
        if (body != null && body.containsKey("provider")) {
            Map<String, Object> p = (Map<String, Object>) body.get("provider");
            if (p != null && p.get("baseUrl") != null && p.get("apiKey") != null) {
                provider = ChatRequest.LlmProvider.builder()
                        .baseUrl((String) p.get("baseUrl"))
                        .apiKey((String) p.get("apiKey"))
                        .model((String) p.get("model"))
                        .build();
            }
        }

        String jobId = "train_" + System.currentTimeMillis();
        trainingStatus.put(jobId, "running");

        final String finalAgentId = agentId;
        final ChatRequest.LlmProvider finalProvider = provider;

        trainingExecutor.submit(() -> {
            try {
                List<OptimizeResult> results;
                if (finalAgentId != null && !finalAgentId.isBlank()) {
                    results = List.of(optimizer.optimizeAgent(finalAgentId, finalProvider));
                } else {
                    results = optimizer.optimizeAllAgents();
                }
                int adopted = (int) results.stream().filter(OptimizeResult::isAdopted).count();
                trainingStatus.put(jobId,
                        String.format("completed: %d/%d adopted", adopted, results.size()));
                log.info("Training job {} completed: {}/{} adopted", jobId, adopted, results.size());
            } catch (Exception e) {
                trainingStatus.put(jobId, "failed: " + e.getMessage());
                log.error("Training job {} failed", jobId, e);
            }
        });

        String providerInfo = provider != null
                ? String.format(" (LLM: %s)", provider.getModel())
                : " (默认 LLM)";
        return ResponseEntity.ok(Map.of(
                "jobId", jobId,
                "status", "queued",
                "message", agentId != null
                        ? "Agent " + agentId + " 优化已提交" + providerInfo
                        : "全量 Agent 优化已提交" + providerInfo
        ));
    }

    /**
     * 查询训练历史
     */
    @GetMapping("/history/{agentId}")
    public ResponseEntity<List<AgentTrainingHistoryEntity>> history(@PathVariable String agentId) {
        return ResponseEntity.ok(historyRepo.findByAgentId(agentId));
    }

    /**
     * 查看标准任务集
     */
    @GetMapping("/tasks")
    public ResponseEntity<Map<String, Object>> tasks(@RequestParam(required = false) String domain) {
        if (domain != null && !domain.isBlank()) {
            return ResponseEntity.ok(Map.of(
                    "domain", domain,
                    "count", taskLoader.getTasksByDomain(domain).size(),
                    "tasks", taskLoader.getTasksByDomain(domain)
            ));
        }
        return ResponseEntity.ok(Map.of(
                "domains", taskLoader.getDomains(),
                "totalCount", taskLoader.getTotalCount(),
                "allTasks", taskLoader.getAllTasks()
        ));
    }

    /**
     * 查询训练状态
     */
    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> status() {
        return ResponseEntity.ok(Map.of(
                "activeJobs", trainingStatus.entrySet().stream()
                        .filter(e -> e.getValue().equals("running"))
                        .map(Map.Entry::getKey)
                        .toList(),
                "recentJobs", trainingStatus,
                "schedulerEnabled", true
        ));
    }

    /**
     * 定时调度: 每天凌晨 2 点自动优化所有 Agent
     *
     * 可通过 application.yml 配置:
     *   soloforge.training.scheduler.enabled: false  — 关闭定时调度
     */
    @Scheduled(cron = "0 0 2 * * *")
    @ConditionalOnProperty(name = "soloforge.training.scheduler.enabled",
                           havingValue = "true", matchIfMissing = true)
    public void scheduledOptimize() {
        log.info("=== 定时训练调度触发: 开始全量 Agent Prompt 优化 ===");
        try {
            List<OptimizeResult> results = optimizer.optimizeAllAgents();
            int adopted = (int) results.stream().filter(OptimizeResult::isAdopted).count();
            log.info("=== 定时训练完成: {}/{} Agent prompt 优化采纳 ===", adopted, results.size());
        } catch (Exception e) {
            log.error("定时训练调度失败", e);
        }
    }
}
