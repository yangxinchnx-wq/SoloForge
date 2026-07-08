package com.soloforge.agent.orchestrator;

import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.executor.AgentExecutor;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

import java.util.List;
import java.util.Map;

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
 *
 * 2026-07-08: 新增 orchestrateStream() — 流式版本
 *   简单任务: 直连 AgentExecutor.executeStream() (真实流式)
 *   复杂任务: 降级为非流式, 包装为单元素 Flux (保证功能可用)
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgentOrchestrator {

    private final TaskComplexityEvaluator complexityEvaluator;
    private final AgentExecutor agentExecutor;
    private final MultiAgentCoordinator multiAgentCoordinator;

    /**
     * 统一入口: 评估任务复杂度,分流到单 Agent 或多 Agent 协作 (非流式)
     */
    public String orchestrate(String message, ChatSettings settings, ChatRequest.LlmProvider provider,
                              List<Map<String, Object>> history, Map<String, Object> fileContext) {
        log.info("AgentOrchestrator: agentId={} message='{}' historySize={}",
            settings.getAgentId(),
            message.length() > 60 ? message.substring(0, 60) + "..." : message,
            history != null ? history.size() : 0);

        TaskComplexityEvaluator.EvaluationResult eval = complexityEvaluator.evaluate(message);

        if (!eval.isComplex()) {
            log.info("Simple task (complexity={}), direct execution",
                String.format("%.2f", eval.complexity()));
            return agentExecutor.execute(message, settings, provider, history, fileContext);
        }

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
                3,
                settings, provider);
        };
    }

    /**
     * 流式入口: 简单任务真实流式, 复杂任务降级为单元素 Flux
     */
    public Flux<String> orchestrateStream(String message, ChatSettings settings, ChatRequest.LlmProvider provider,
                                           List<Map<String, Object>> history, Map<String, Object> fileContext) {
        log.info("AgentOrchestrator[stream]: agentId={} message='{}' historySize={}",
            settings.getAgentId(),
            message.length() > 60 ? message.substring(0, 60) + "..." : message,
            history != null ? history.size() : 0);

        TaskComplexityEvaluator.EvaluationResult eval = complexityEvaluator.evaluate(message);

        if (!eval.isComplex()) {
            log.info("Simple task (complexity={}), streaming execution",
                String.format("%.2f", eval.complexity()));
            return agentExecutor.executeStream(message, settings, provider, history, fileContext);
        }

        // 复杂任务: 降级为非流式, 包装为单元素 Flux
        log.info("Complex task (complexity={}), falling back to non-stream",
            String.format("%.2f", eval.complexity()));
        return Flux.defer(() -> {
            try {
                String result = orchestrate(message, settings, provider, history, fileContext);
                return Flux.just(result);
            } catch (Exception e) {
                return Flux.error(e);
            }
        }).subscribeOn(reactor.core.scheduler.Schedulers.boundedElastic());
    }

    private CollaborationMode selectMode(String message) {
        String lower = message.toLowerCase();
        if (lower.contains("多种方案") || lower.contains("多个方案") || lower.contains("alternative")) {
            return CollaborationMode.PARALLEL_VOTE;
        }
        if (lower.contains("选型") || lower.contains("评审") || lower.contains("比较") || lower.contains("对比")) {
            return CollaborationMode.DEBATE;
        }
        return CollaborationMode.ROLE_DISPATCH;
    }

    enum CollaborationMode {
        PARALLEL_VOTE,
        ROLE_DISPATCH,
        DEBATE
    }
}
