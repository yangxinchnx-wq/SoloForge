package com.soloforge.agent.training;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.config.DynamicChatModelResolver; // ★ Path C: 替代 LlmGateway
import com.soloforge.agent.llm.LlmGateway; // @Deprecated — 保留 fallback 引用
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import com.soloforge.agent.persistence.AgentTrainingHistoryEntity;
import com.soloforge.agent.persistence.AgentTrainingHistoryRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import org.springframework.ai.chat.client.ChatClient; // ★ Path C: Spring AI ChatClient

import com.soloforge.agent.training.TrainingTask;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PromptOptimizer — 离线 Prompt 优化器
 *
 * 流程 (对单个 Agent):
 *   1. 加载 Agent 当前 system_prompt (version N)
 *   2. 加载该 Agent domain 的标准任务集
 *   3. 用当前 prompt 跑一遍所有任务 → 计算 baseline reward
 *   4. 用 LLM 分析当前 prompt 弱点 (基于 baseline 执行结果)
 *   5. 用 LLM 生成改进版 prompt (version N+1)
 *   6. 用新 prompt 跑一遍所有任务 → 计算 new reward
 *   7. 如果 new_reward > baseline_reward * (1 + threshold), 更新 DB + 记录训练历史
 *   8. 如果未改善, 回滚 (不更新 DB), 记录失败原因
 *
 * reward 计算公式:
 *   reward = (keywordHitRate * 0.5 + responseQuality * 0.3 + lengthAppropriateness * 0.2) * weight
 *
 * 线程安全: optimizeAgent 可并发调用不同 agentId, 同一 agentId 有 AtomicBoolean 防重入。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PromptOptimizer {

    private final AgentIdentityRepository agentRepo;
    private final AgentTrainingHistoryRepository historyRepo;
    private final TrainingTaskLoader taskLoader;
    private final LlmGateway llmGateway; // @Deprecated — 保留 fallback
    private final DynamicChatModelResolver modelResolver; // ★ Path C: 新执行器
    private final ObjectMapper objectMapper;

    /** 优化阈值: new reward 必须超过 baseline 的 (1 + IMPROVEMENT_THRESHOLD) 倍才采纳 */
    @Value("${soloforge.training.improvement-threshold:0.05}")
    private double improvementThreshold;

    /** 训练用 LLM provider (从系统属性读取, 与运行时 provider 分离) */
    @Value("${soloforge.training.llm.base-url:https://api.openai.com}")
    private String trainingLlmBaseUrl;
    @Value("${soloforge.training.llm.api-key:placeholder}")
    private String trainingLlmApiKey;
    @Value("${soloforge.training.llm.model:gpt-4o-mini}")
    private String trainingLlmModel;

    /** 正在训练中的 Agent 防重入 */
    private final Map<String, AtomicBoolean> runningFlags = new ConcurrentHashMap<>();

    /**
     * 优化单个 Agent 的 system prompt (使用默认训练 LLM)
     *
     * @return 训练结果 (含 rewardBefore/rewardAfter/是否采纳)
     */
    public OptimizeResult optimizeAgent(String agentId) {
        return optimizeAgent(agentId, null);
    }

    /**
     * 优化单个 Agent 的 system prompt (可指定训练用 LLM)
     *
     * @param agentId  Agent ID
     * @param provider 可选, 用户选择的 LLM provider; 为 null 时使用默认训练 LLM
     * @return 训练结果
     */
    public OptimizeResult optimizeAgent(String agentId, ChatRequest.LlmProvider provider) {
        // 防重入
        AtomicBoolean flag = runningFlags.computeIfAbsent(agentId, k -> new AtomicBoolean(false));
        if (!flag.compareAndSet(false, true)) {
            log.warn("助理 {} 正在优化中, 跳过", agentId);
            return OptimizeResult.skipped(agentId, "正在训练中, 跳过");
        }

        try {
            return doOptimize(agentId, provider);
        } finally {
            flag.set(false);
        }
    }

    /**
     * 优化所有启用的 Agent
     */
    public List<OptimizeResult> optimizeAllAgents() {
        List<AgentIdentityEntity> agents = agentRepo.findAllEnabled();
        List<OptimizeResult> results = new ArrayList<>();
        log.info("PromptOptimizer: 开始批量优化 {} 个助理", agents.size());
        for (AgentIdentityEntity agent : agents) {
            try {
                results.add(optimizeAgent(agent.getId()));
            } catch (Exception e) {
                log.error("Failed to optimize agent {}: {}", agent.getId(), e.getMessage());
                results.add(OptimizeResult.failed(agent.getId(), e.getMessage()));
            }
        }
        int improved = (int) results.stream().filter(OptimizeResult::isAdopted).count();
        log.info("PromptOptimizer: 批量优化完成, {}/{} 改进成功", improved, results.size());
        return results;
    }

    @SuppressWarnings("unchecked")
    private OptimizeResult doOptimize(String agentId, ChatRequest.LlmProvider overrideProvider) {
        Optional<AgentIdentityEntity> opt = agentRepo.findById(agentId);
        if (opt.isEmpty()) {
            return OptimizeResult.failed(agentId, "助理不存在");
        }
        AgentIdentityEntity agent = opt.get();
        String currentPrompt = agent.getSystemPrompt() != null ? agent.getSystemPrompt() : "";
        int currentVersion = agent.getSystemPromptVersion() != null ? agent.getSystemPromptVersion() : 0;

        List<TrainingTask> tasks = taskLoader.getTasksByDomain(agent.getDomain());
        if (tasks.isEmpty()) {
            log.warn("助理 {} domain={} 无标准任务, 跳过", agentId, agent.getDomain());
            return OptimizeResult.skipped(agentId, "domain=" + agent.getDomain() + " 无标准任务");
        }

        log.info("=== PromptOptimizer: 助理 {} (v{}, domain={}, {} tasks) ===",
                agentId, currentVersion, agent.getDomain(), tasks.size());

        // Step 1: 用当前 prompt 跑 baseline
        double rewardBefore = evaluatePrompt(currentPrompt, tasks, agent);
        log.info("助理 {} baseline reward = {:.4}", agentId, rewardBefore);

        // Step 2: 用 LLM 分析弱点 + 生成改进版 prompt
        String improvedPrompt = generateImprovedPrompt(agent, currentPrompt, tasks, rewardBefore, overrideProvider);
        if (improvedPrompt == null || improvedPrompt.isBlank()) {
            recordHistory(agentId, currentVersion, currentVersion, rewardBefore, 0.0,
                    tasks.size(), "LLM 生成改进 prompt 失败", false);
            return OptimizeResult.failed(agentId, "LLM 生成改进 prompt 失败");
        }

        // Step 3: 用新 prompt 跑评估
        double rewardAfter = evaluatePrompt(improvedPrompt, tasks, agent);
        log.info("助理 {} improved reward = {:.4} (baseline={:.4})", agentId, rewardAfter, rewardBefore);

        boolean adopted = rewardAfter > rewardBefore * (1.0 + improvementThreshold);

        if (adopted) {
            int newVersion = currentVersion + 1;
            agent.setSystemPrompt(improvedPrompt);
            agent.setSystemPromptVersion(newVersion);
            agent.setLastTrainingTime(LocalDateTime.now());
            agentRepo.save(agent);
            recordHistory(agentId, currentVersion, newVersion, rewardBefore, rewardAfter,
                    tasks.size(), "已采纳", true);
            log.info("助理 {} ✅ 采纳 v{} → v{} ({:.4} → {:.4}, +{:.1f}%)",
                    agentId, currentVersion, newVersion, rewardBefore, rewardAfter,
                    (rewardAfter - rewardBefore) / rewardBefore * 100);
        } else {
            recordHistory(agentId, currentVersion, currentVersion, rewardBefore, rewardAfter,
                    tasks.size(), String.format("未改善 (%.4 < %.4*%.2f)", rewardAfter, rewardBefore, 1+improvementThreshold),
                    false);
            log.info("助理 {} ❌ 未采纳 v{} ({:.4} → {:.4}, 需 +%.1f%%)",
                    agentId, currentVersion, rewardBefore, rewardAfter, improvementThreshold * 100);
        }

        return OptimizeResult.builder()
                .agentId(agentId).adopted(adopted)
                .rewardBefore(rewardBefore).rewardAfter(rewardAfter)
                .versionBefore(currentVersion).versionAfter(adopted ? currentVersion + 1 : currentVersion)
                .sampleCount(tasks.size())
                .status(adopted ? "success" : "failed")
                .notes(adopted ? "Adopted" : "Not improved")
                .build();
    }

    /**
     * 评估单个 prompt 在任务集上的 reward
     */
    double evaluatePrompt(String prompt, List<TrainingTask> tasks, AgentIdentityEntity agent) {
        if (tasks.isEmpty()) return 0.0;

        double totalReward = 0.0;
        int weightSum = 0;

        for (TrainingTask task : tasks) {
            double r = evaluateSingleTask(prompt, task, agent);
            totalReward += r * task.getWeight();
            weightSum += task.getWeight();
        }

        return weightSum > 0 ? totalReward / weightSum : 0.0;
    }

    /**
     * 单任务评估: 发送 prompt + task 输入给 LLM, 按 keyword/quality/length 打分
     */
    @SuppressWarnings("unchecked")
    double evaluateSingleTask(String prompt, TrainingTask task, AgentIdentityEntity agent) {
        try {
            StringBuilder fullPrompt = new StringBuilder();
            fullPrompt.append("[System Prompt]\n").append(prompt).append("\n\n");
            fullPrompt.append("[Task]\n").append(task.getInput()).append("\n\n");
            fullPrompt.append("[Expected Keywords]").append(String.join(", ", java.util.Arrays.asList(task.getExpectedKeywords()))).append("\n");
            fullPrompt.append("请根据以上 system prompt 完成任务。");

            // ★ Path C: 使用 DynamicChatModelResolver + ChatClient
            try {
                ChatClient chatClient = ChatClient.create(modelResolver.resolve(
                        ChatRequest.LlmProvider.builder().name("OPENAI").build())); // 训练模块固定用 OpenAI
                String response = chatClient.prompt()
                        .system(prompt)
                        .user(task.getInput())
                        .call()
                        .content();

                // 打分逻辑
                double keywordHit = 0.0;
                if (task.getExpectedKeywords() != null && task.getExpectedKeywords().length > 0) {
                    String[] kwList = task.getExpectedKeywords();
                    int hit = 0;
                    for (String kw : kwList) {
                        if (response.toLowerCase().contains(kw.toLowerCase().trim())) hit++;
                    }
                    keywordHit = (double) hit / kwList.length;
                }

                double qualityScore = Math.min(1.0, response.length() / 200.0); // 简单启发式
                double lengthScore = response.length() >= 20 && response.length() <= 2000 ? 1.0 :
                        (response.length() < 20 ? response.length() / 20.0 : 2000.0 / response.length());

                return (keywordHit * 0.5 + qualityScore * 0.3 + lengthScore * 0.2);

            } catch (Exception e) {
                log.debug("PromptOptimizer: ChatClient evaluation failed: {}", e.getMessage());
                return 0.0;
            }

        } catch (Exception e) {
            log.error("评估失败: task={} error={}", task.getId(), e.getMessage());
            return 0.0;
        }
    }

    /**
     * 用 LLM 分析当前 prompt 弱点并生成改进版
     */
    @SuppressWarnings("unchecked")
    String generateImprovedPrompt(AgentIdentityEntity agent, String currentPrompt,
                                  List<TrainingTask> tasks, double baselineReward,
                                  ChatRequest.LlmProvider overrideProvider) {
        try {
            StringBuilder analysisPrompt = new StringBuilder();
            analysisPrompt.append("你是一个 Prompt Engineering 专家。以下是一个 AI 助理的当前 system prompt 和它在标准任务集上的表现。\n\n");
            analysisPrompt.append("[当前 System Prompt]\n").append(currentPrompt).append("\n\n");
            analysisPrompt.append("[Baseline Reward]").append(baselineReward).append("\n\n");
            analysisPrompt.append("[任务集样例]\n");
            int count = 0;
            for (TrainingTask t : tasks) {
                if (count++ >= 3) { analysisPrompt.append("... 共 ").append(tasks.size()).append(" 个任务\n"); break; }
                analysisPrompt.append("- ").append(t.getInput()).append(" (keywords: ").append(String.join(", ", java.util.Arrays.asList(t.getExpectedKeywords()))).append(")\n");
            }
            analysisPrompt.append("\n请分析当前 prompt 的弱点，然后输出一个改进版的完整 system prompt。只输出改进后的 prompt 内容，不要解释。");

            // ★ Path C: 使用 DynamicChatModelResolver
            ChatClient chatClient = ChatClient.create(modelResolver.resolve(
                    overrideProvider != null ? overrideProvider : ChatRequest.LlmProvider.builder().name("OPENAI").build()));
            String improved = chatClient.prompt()
                    .user(analysisPrompt.toString())
                    .call()
                    .content();

            // 清理可能的 markdown code fence
            if (improved.startsWith("```")) {
                improved = improved.substring(improved.indexOf('\n') + 1);
                if (improved.endsWith("```")) improved = improved.substring(0, improved.length() - 3).trim();
            }

            return improved;

        } catch (Exception e) {
            log.warn("PromptOptimizer: ChatClient generation failed: {}", e.getMessage());
            return null;
        }
    }

    void recordHistory(String agentId, int fromVersion, int toVersion,
                       double rewardBefore, double rewardAfter,
                       int taskCount, String comment, boolean adopted) {
        try {
            AgentTrainingHistoryEntity history = new AgentTrainingHistoryEntity();
            history.setAgentId(agentId);
            history.setFromVersion(fromVersion);
            history.setToVersion(toVersion);
            history.setRewardBefore(rewardBefore);
            history.setRewardAfter(rewardAfter);
            history.setTaskCount(taskCount);
            history.setComment(comment);
            history.setAdopted(adopted);
            history.setCreatedAt(LocalDateTime.now());
            historyRepo.save(history);
        } catch (Exception e) {
            log.error("记录训练历史失败: agentId={} error={}", agentId, e.getMessage());
        }
    }

    // ========== DTOs ==========
}

