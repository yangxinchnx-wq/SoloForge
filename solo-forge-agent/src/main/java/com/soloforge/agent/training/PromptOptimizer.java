package com.soloforge.agent.training;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.llm.LlmGateway;
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import com.soloforge.agent.persistence.AgentTrainingHistoryEntity;
import com.soloforge.agent.persistence.AgentTrainingHistoryRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

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
    private final LlmGateway llmGateway;
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
        log.info("助理 {} new reward = {:.4} (threshold = {:.4})",
                agentId, rewardAfter, rewardBefore * (1 + improvementThreshold));

        // Step 4: 判断是否采纳
        boolean adopted = rewardAfter > rewardBefore * (1 + improvementThreshold);
        String notes;
        if (adopted) {
            int newVersion = currentVersion + 1;
            agentRepo.updateSystemPrompt(agentId, improvedPrompt, newVersion);
            notes = String.format("v%d→v%d, reward %.4f→%.4f (+%.1f%%), 采纳",
                    currentVersion, newVersion, rewardBefore, rewardAfter,
                    (rewardAfter - rewardBefore) / Math.max(rewardBefore, 0.001) * 100);
            recordHistory(agentId, currentVersion, newVersion, rewardBefore, rewardAfter,
                    tasks.size(), notes, true);
            log.info("助理 {} prompt 优化采纳: {}", agentId, notes);
        } else {
            notes = String.format("v%d (未变), reward %.4f→%.4f (%.1f%%), 未达阈值, 回滚",
                    currentVersion, rewardBefore, rewardAfter,
                    (rewardAfter - rewardBefore) / Math.max(rewardBefore, 0.001) * 100);
            recordHistory(agentId, currentVersion, currentVersion, rewardBefore, rewardAfter,
                    tasks.size(), notes, false);
            log.info("助理 {} prompt 优化未采纳: {}", agentId, notes);
        }

        return OptimizeResult.builder()
                .agentId(agentId)
                .adopted(adopted)
                .rewardBefore(rewardBefore)
                .rewardAfter(rewardAfter)
                .versionBefore(currentVersion)
                .versionAfter(adopted ? currentVersion + 1 : currentVersion)
                .sampleCount(tasks.size())
                .notes(notes)
                .build();
    }

    /**
     * 评估 prompt 质量: 用该 prompt 对每个任务生成回复, 计算 reward
     */
    private double evaluatePrompt(String systemPrompt, List<TrainingTask> tasks, AgentIdentityEntity agent) {
        double totalReward = 0.0;
        ChatRequest.LlmProvider provider = getTrainingProvider();

        for (TrainingTask task : tasks) {
            try {
                String response = llmGateway.chatCompletion(
                        systemPrompt, task.getInput(), null, provider, null);
                double reward = calculateReward(response, task);
                totalReward += reward * task.getWeight();
            } catch (Exception e) {
                log.warn("Task {} evaluation failed: {}", task.getId(), e.getMessage());
                totalReward += 0.0;  // 失败记 0 分
            }
        }
        return totalReward;
    }

    /**
     * 计算 reward
     *
     * reward = keywordHitRate * 0.5 + responseQuality * 0.3 + lengthAppropriateness * 0.2
     */
    private double calculateReward(String response, TrainingTask task) {
        if (response == null || response.isBlank()) return 0.0;

        // 1. keywordHitRate (0~1): 期望关键词命中率
        double keywordHitRate = 1.0;
        if (task.getExpectedKeywords() != null && task.getExpectedKeywords().length > 0) {
            int hits = 0;
            for (String kw : task.getExpectedKeywords()) {
                if (response.toLowerCase().contains(kw.toLowerCase())) hits++;
            }
            keywordHitRate = (double) hits / task.getExpectedKeywords().length;
        }

        // 2. responseQuality (0~1): 基于响应长度和结构
        double quality = 0.5;
        int len = response.length();
        if (len > 50 && len < 5000) {
            quality = 0.8;
            if (response.contains("```") || response.contains("**")) quality = 0.9;  // 有代码块/格式化
        } else if (len >= 10) {
            quality = 0.4;
        }

        // 3. lengthAppropriateness (0~1): 长度适中
        double lengthScore;
        if ("easy".equals(task.getDifficulty())) {
            lengthScore = len < 200 ? 1.0 : (len < 1000 ? 0.6 : 0.3);
        } else if ("medium".equals(task.getDifficulty())) {
            lengthScore = (len > 100 && len < 2000) ? 1.0 : 0.4;
        } else {  // hard
            lengthScore = (len > 200 && len < 4000) ? 1.0 : 0.4;
        }

        return keywordHitRate * 0.5 + quality * 0.3 + lengthScore * 0.2;
    }

    /**
     * 用 LLM 分析当前 prompt 弱点并生成改进版
     */
    private String generateImprovedPrompt(AgentIdentityEntity agent, String currentPrompt,
                                           List<TrainingTask> tasks, double baselineReward,
                                           ChatRequest.LlmProvider overrideProvider) {
        ChatRequest.LlmProvider provider = resolveProvider(overrideProvider);

        StringBuilder taskSummary = new StringBuilder();
        for (TrainingTask t : tasks) {
            taskSummary.append("- [").append(t.getDifficulty()).append("] ")
                    .append(t.getInput().substring(0, Math.min(80, t.getInput().length())))
                    .append("\n");
        }

        String analysisPrompt = """
                你是一个 Prompt 工程专家。请分析以下 AI Agent 的 System Prompt 弱点, 并生成改进版。

                ## Agent 信息
                - ID: %s
                - 名称: %s
                - 角色: %s
                - 领域: %s
                - 策略: %s
                - 当前版本: %d
                - Baseline Reward: %.4f

                ## 当前 System Prompt
                ```
                %s
                ```

                ## 该 Agent 需要处理的标准任务样本
                %s

                ## 要求
                1. 分析当前 prompt 在处理上述任务时可能存在的问题 (如: 缺少格式指引、工具使用说明不足、输出结构不清晰等)
                2. 生成一个改进版 System Prompt, 直接输出改进后的 prompt 内容, 不要包含任何解释说明
                3. 改进版 prompt 应该:
                   - 明确输出格式 (代码用 markdown 代码块, 文档用结构化标题)
                   - 针对 %s 领域的任务特点优化
                   - 保持简洁, 不要超过 500 字
                   - 包含工具使用指引 (如果适用)

                ## 直接输出改进后的 System Prompt (纯文本, 无包裹):
                """.formatted(
                agent.getId(), agent.getName(), agent.getRole(), agent.getDomain(),
                agent.getStrategy(), agent.getSystemPromptVersion(), baselineReward,
                currentPrompt, taskSummary.toString(), agent.getDomain()
        );

        try {
            String result = llmGateway.chatCompletion(
                    "你是 Prompt 工程专家, 擅长优化 AI Agent 的 System Prompt。",
                    analysisPrompt, null, provider, null);
            return result != null ? result.trim() : null;
        } catch (Exception e) {
            log.error("generateImprovedPrompt failed: {}", e.getMessage());
            return null;
        }
    }

    /**
     * 解析训练用 LLM provider: 优先使用用户指定的, 否则回退到配置文件默认值
     */
    private ChatRequest.LlmProvider resolveProvider(ChatRequest.LlmProvider override) {
        if (override != null && override.getBaseUrl() != null && !override.getBaseUrl().isBlank()
                && override.getApiKey() != null && !override.getApiKey().isBlank()) {
            log.info("Using user-specified LLM: {} / {}", override.getBaseUrl(), override.getModel());
            return override;
        }
        return getTrainingProvider();
    }

    private ChatRequest.LlmProvider getTrainingProvider() {
        return ChatRequest.LlmProvider.builder()
                .baseUrl(trainingLlmBaseUrl)
                .apiKey(trainingLlmApiKey)
                .model(trainingLlmModel)
                .build();
    }

    private void recordHistory(String agentId, int versionBefore, int versionAfter,
                                double rewardBefore, double rewardAfter,
                                int sampleCount, String notes, boolean adopted) {
        try {
            AgentTrainingHistoryEntity entity = new AgentTrainingHistoryEntity();
            entity.setAgentId(agentId);
            entity.setTrainedAt(LocalDateTime.now());
            entity.setTriggerReason("prompt_optimization");
            entity.setSampleCount(sampleCount);
            entity.setRewardBefore(rewardBefore);
            entity.setRewardAfter(rewardAfter);
            entity.setPromptVersionBefore(versionBefore);
            entity.setPromptVersionAfter(versionAfter);
            entity.setNotes((adopted ? "[采纳] " : "[回滚] ") + notes);
            historyRepo.save(entity);
        } catch (Exception e) {
            log.error("Failed to record training history: {}", e.getMessage());
        }
    }

    /**
     * 检查指定 Agent 是否正在训练中
     */
    public boolean isTraining(String agentId) {
        AtomicBoolean flag = runningFlags.get(agentId);
        return flag != null && flag.get();
    }
}
