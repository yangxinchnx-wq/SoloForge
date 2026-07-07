package com.soloforge.agent.orchestrator;

import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.executor.AgentExecutor;
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 多 Agent 协作编排器 (3 种形态)
 *
 * A. ParallelVoter  — 并行投票 (多 Agent 独立求解, 选最佳)
 * B. RoleDispatcher — 角色分工 (Planner→Executor→Reviewer)
 * C. DebateLoop     — 对话辩论 (多轮辩论后达成共识)
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class MultiAgentCoordinator {

    private final AgentExecutor agentExecutor;
    private final AgentIdentityRepository agentRepo;

    private final ExecutorService parallelExecutor = Executors.newFixedThreadPool(4);

    /**
     * A. 并行投票
     *
     * 多个 Agent 独立处理同一任务,选最优结果。
     * 适用于: 代码生成、方案设计等"多解"问题
     */
    public String parallelVote(String task, List<String> agentIds,
                               ChatSettings settings, ChatRequest.LlmProvider provider) {
        log.info("ParallelVoter: agents={} task='{}'", agentIds,
            task.length() > 60 ? task.substring(0, 60) + "..." : task);

        // 并行执行
        List<CompletableFuture<String>> futures = agentIds.stream()
            .map(agentId -> CompletableFuture.supplyAsync(() -> {
                ChatSettings agentSettings = copySettings(settings, agentId);
                return agentExecutor.execute(task, agentSettings, provider);
            }, parallelExecutor))
            .toList();

        // 收集结果
        List<String> results = futures.stream()
            .map(CompletableFuture::join)
            .toList();

        // 选最优 (简化版: 选最长的,实际应让 LLM 评判)
        String best = selectBestResult(results);
        log.info("ParallelVoter completed: {} agents, best result {} chars",
            results.size(), best.length());
        return best;
    }

    /**
     * B. 角色分工
     *
     * Planner 拆解 → Executor 执行 → Reviewer 审查
     * 适用于: 复杂任务、需要质量保证的场景
     */
    public String roleDispatch(String task, ChatSettings settings, ChatRequest.LlmProvider provider) {
        log.info("RoleDispatcher: task='{}'",
            task.length() > 60 ? task.substring(0, 60) + "..." : task);

        // 1. Planner 拆解
        ChatSettings plannerSettings = copySettings(settings, "plan_agent");
        String plan = agentExecutor.execute(
            "请拆解以下任务,给出明确的步骤:\n" + task, plannerSettings, provider);
        log.info("Planner output: {} chars", plan.length());

        // 2. Executor 执行
        ChatSettings executorSettings = copySettings(settings, "code_agent");
        String execution = agentExecutor.execute(
            "按照以下计划执行任务:\n" + plan + "\n\n原始任务: " + task,
            executorSettings, provider);
        log.info("Executor output: {} chars", execution.length());

        // 3. Reviewer 审查
        ChatSettings reviewerSettings = copySettings(settings, "debug_agent");
        String review = agentExecutor.execute(
            "审查以下执行结果,指出问题:\n\n计划:\n" + plan + "\n\n执行结果:\n" + execution,
            reviewerSettings, provider);
        log.info("Reviewer output: {} chars", review.length());

        // 4. 如果审查发现问题,重新执行 (简化版: 直接返回综合结果)
        if (review.contains("问题") || review.contains("错误")) {
            ChatSettings reexecSettings = copySettings(settings, "code_agent");
            String reexec = agentExecutor.execute(
                "根据审查意见修复:\n\n执行结果:\n" + execution + "\n\n审查意见:\n" + review,
                reexecSettings, provider);
            return "## 计划\n" + plan + "\n\n## 执行(修复后)\n" + reexec + "\n\n## 审查\n" + review;
        }

        return "## 计划\n" + plan + "\n\n## 执行\n" + execution + "\n\n## 审查\n" + review;
    }

    /**
     * C. 对话辩论
     *
     * 多个 Agent 多轮辩论,最终达成共识。
     * 适用于: 技术选型、方案评审等"多观点"问题
     */
    public String debate(String task, List<String> agentIds, int maxRounds,
                         ChatSettings settings, ChatRequest.LlmProvider provider) {
        log.info("DebateLoop: agents={} rounds={} task='{}'", agentIds, maxRounds,
            task.length() > 60 ? task.substring(0, 60) + "..." : task);

        List<String> positions = new ArrayList<>();

        for (int round = 0; round < maxRounds; round++) {
            log.info("Debate round {}", round + 1);
            for (String agentId : agentIds) {
                ChatSettings agentSettings = copySettings(settings, agentId);
                String prompt = round == 0
                    ? task
                    : "任务: " + task + "\n\n其他 Agent 的观点:\n" + String.join("\n---\n", positions)
                        + "\n\n请给出你的观点,可以赞同或反驳其他 Agent。";
                String position = agentExecutor.execute(prompt, agentSettings, provider);
                positions.add("[" + agentId + "] " + position);
            }

            // 检查共识 (简化版: 第 2 轮后如果观点趋同则结束)
            if (round >= 1 && checkConsensus(positions)) {
                log.info("Consensus reached at round {}", round + 1);
                break;
            }
        }

        // 仲裁 (选最后一个观点作为最终答案)
        String verdict = positions.get(positions.size() - 1);
        log.info("Debate completed: {} positions, verdict {} chars", positions.size(), verdict.length());
        return "## 辩论过程\n" + String.join("\n\n", positions) + "\n\n## 最终结论\n" + verdict;
    }

    private boolean checkConsensus(List<String> positions) {
        // 简化版: 如果最近 2 个观点都包含"同意"或"赞同",认为达成共识
        if (positions.size() < 2) return false;
        String last = positions.get(positions.size() - 1).toLowerCase();
        String prev = positions.get(positions.size() - 2).toLowerCase();
        return (last.contains("同意") || last.contains("赞同"))
            && (prev.contains("同意") || prev.contains("赞同"));
    }

    private String selectBestResult(List<String> results) {
        // 简化版: 选最长的 (实际应让 LLM 评判)
        return results.stream()
            .max((a, b) -> Integer.compare(a.length(), b.length()))
            .orElse("(无结果)");
    }

    private ChatSettings copySettings(ChatSettings original, String agentId) {
        return ChatSettings.builder()
            .personality(original.getPersonality())
            .tone(original.getTone())
            .emojiMode(original.getEmojiMode())
            .emojiEnabled(original.getEmojiEnabled())
            .emojiType(original.getEmojiType())
            .enabledSkills(original.getEnabledSkills())
            .enabledKnowledge(original.getEnabledKnowledge())
            .agentId(agentId)
            .workspaceFolder(original.getWorkspaceFolder())
            .canvasId(original.getCanvasId())
            .chatSessionId(original.getChatSessionId())
            .requesterChatSessionId(original.getRequesterChatSessionId())
            .extraContext(original.getExtraContext())
            .build();
    }
}
