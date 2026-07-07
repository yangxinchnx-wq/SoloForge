package com.soloforge.agent.orchestrator;

import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.executor.AgentExecutor;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Agent 编排器 (复杂度分流 + 统一入口)
 *
 * 流程:
 *   1. TaskComplexityEvaluator 评估任务复杂度
 *   2. 简单任务 (complexity < 0.5) → 直连 AgentExecutor (单 Agent)
 *   3. 复杂任务 (complexity >= 0.5) → 按任务类型选择协作形态:
 *      - 包含"多解"关键词 → ParallelVoter (A 形态)
 *      - 包含"质量"关键词 → RoleDispatcher (B 形态)
 *      - 包含"选型"/"评审"关键词 → DebateLoop (C 形态)
 *      - 默认 → RoleDispatcher (B 形态,最通用)
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgentOrchestrator {

    private final TaskComplexityEvaluator complexityEvaluator;
    private final AgentExecutor agentExecutor;
    private final MultiAgentCoordinator multiAgentCoordinator;

    /**
     * 统一入口: 评估任务复杂度,分流到单 Agent 或多 Agent 协作
     */
    public String orchestrate(String message, ChatSettings settings, ChatRequest.LlmProvider provider) {
        log.info("AgentOrchestrator: agentId={} message='{}'",
            settings.getAgentId(),
            message.length() > 60 ? message.substring(0, 60) + "..." : message);

        // 1. 评估复杂度
        TaskComplexityEvaluator.EvaluationResult eval = complexityEvaluator.evaluate(message);

        // 2. 简单任务 → 直连单 Agent
        if (!eval.isComplex()) {
            log.info("Simple task (complexity={}), direct execution",
                String.format("%.2f", eval.complexity()));
            return agentExecutor.execute(message, settings, provider);
        }

        // 3. 复杂任务 → 选择协作形态
        log.info("Complex task (complexity={}, reasons={}), selecting collaboration mode",
            String.format("%.2f", eval.complexity()), eval.reasons());

        CollaborationMode mode = selectMode(message);
        log.info("Collaboration mode: {}", mode);

        return switch (mode) {
            case PARALLEL_VOTE -> multiAgentCoordinator.parallelVote(
                message,
                List.of("code_agent", "plan_agent", "debug_agent"),
                settings, provider);
            case ROLE_DISPATCH -> multiAgentCoordinator.roleDispatch(
                message, settings, provider);
            case DEBATE -> multiAgentCoordinator.debate(
                message,
                List.of("plan_agent", "debug_agent"),
                3, // maxRounds
                settings, provider);
        };
    }

    private CollaborationMode selectMode(String message) {
        String lower = message.toLowerCase();
        if (lower.contains("多种方案") || lower.contains("多个方案") || lower.contains("alternative")) {
            return CollaborationMode.PARALLEL_VOTE;
        }
        if (lower.contains("选型") || lower.contains("评审") || lower.contains("比较") || lower.contains("对比")) {
            return CollaborationMode.DEBATE;
        }
        // 默认: 角色分工
        return CollaborationMode.ROLE_DISPATCH;
    }

    enum CollaborationMode {
        PARALLEL_VOTE,   // A. 并行投票
        ROLE_DISPATCH,   // B. 角色分工
        DEBATE           // C. 对话辩论
    }
}
