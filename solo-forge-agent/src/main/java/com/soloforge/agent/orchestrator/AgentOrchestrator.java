package com.soloforge.agent.orchestrator;

import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import reactor.core.publisher.Flux;
import reactor.core.scheduler.Schedulers;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Agent 编排器 (三层架构: 主模型 → 副模型 → Java agent)
 *
 * 2026-07-11 重构: 副模型调用 Java agent 架构
 *   - 简单任务 (complexity < 0.5): 副模型轮询, 单 agent 流式执行
 *   - 复杂任务: 所有副模型并行, 每个副模型自主选 agent + 驱动执行, 结果汇总
 *   - 无副模型: 主模型直接驱动 agent (fallback)
 *
 * 三层架构语义:
 *   主模型 (上级, 编排调度)
 *     ↓ 并行调度
 *   副模型1 / 副模型2 / ... (worker, 每个自主选 agent)
 *     ↓ 选择 + 驱动
 *   Java agent (执行单元, 用副模型 LLM 配置)
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgentOrchestrator {

    private final TaskComplexityEvaluator complexityEvaluator;
    private final SubModelWorker subModelWorker;

    private final ExecutorService parallelExecutor = Executors.newFixedThreadPool(8);

    /**
     * 非流式入口 (向后兼容, /api/chat/send 用)
     * 无副模型时走原逻辑, 有副模型时也走副模型架构
     */
    public String orchestrate(String message, ChatSettings settings, ChatRequest.LlmProvider provider,
                              List<ChatRequest.LlmProvider> subProviders,
                              List<Map<String, Object>> history, Map<String, Object> fileContext) {
        log.info("AgentOrchestrator: agentId={} message='{}' historySize={} subProviders={}",
            settings.getAgentId(),
            message.length() > 60 ? message.substring(0, 60) + "..." : message,
            history != null ? history.size() : 0,
            subProviders != null ? subProviders.size() : 0);

        TaskComplexityEvaluator.EvaluationResult eval = complexityEvaluator.evaluate(message);

        if (!eval.isComplex()) {
            // 简单任务: 副模型轮询 (无 emitter, 传 null)
            log.info("Simple task (complexity={}), subModel round-robin",
                String.format("%.2f", eval.complexity()));
            return subModelWorkerExecuteSync(message, settings, provider, subProviders, history, fileContext, null);
        }

        // 复杂任务: 副模型并行
        log.info("Complex task (complexity={}), subModels parallel",
            String.format("%.2f", eval.complexity()));
        return orchestrateComplexParallel(message, settings, provider, subProviders, history, fileContext, null);
    }

    /**
     * 流式入口 — 主模型编排, 副模型驱动 agent
     *
     * 简单任务: 副模型轮询, 单 agent 真实流式
     * 复杂任务: 副模型并行 (非流式汇总, 包装为单元素 Flux)
     */
    public Flux<String> orchestrateStream(String message, ChatSettings settings,
                                           ChatRequest.LlmProvider provider,
                                           List<ChatRequest.LlmProvider> subProviders,
                                           List<Map<String, Object>> history, Map<String, Object> fileContext,
                                           SseEmitter emitter) {
        log.info("AgentOrchestrator[stream]: agentId={} message='{}' historySize={} subProviders={}",
            settings.getAgentId(),
            message.length() > 60 ? message.substring(0, 60) + "..." : message,
            history != null ? history.size() : 0,
            subProviders != null ? subProviders.size() : 0);

        TaskComplexityEvaluator.EvaluationResult eval = complexityEvaluator.evaluate(message);

        if (!eval.isComplex()) {
            // 简单任务: 副模型轮询, 单 agent 流式
            log.info("Simple task (complexity={}), subModel round-robin streaming",
                String.format("%.2f", eval.complexity()));
            return subModelWorker.executeSimpleWithRoundRobin(
                message, settings, provider, subProviders, history, fileContext, emitter);
        }

        // 复杂任务: 副模型并行, 降级为非流式汇总
        log.info("Complex task (complexity={}), subModels parallel (non-stream aggregate)",
            String.format("%.2f", eval.complexity()));
        return Flux.defer(() -> {
            try {
                String result = orchestrateComplexParallel(
                    message, settings, provider, subProviders, history, fileContext, emitter);
                return Flux.just(result);
            } catch (Exception e) {
                return Flux.error(e);
            }
        }).subscribeOn(Schedulers.boundedElastic());
    }

    /**
     * 复杂任务: 所有副模型并行, 每个选 agent + 执行, 汇总结果
     * 主模型"编排"语义: 启动所有副模型 worker 并行 + 选最优结果
     */
    private String orchestrateComplexParallel(String message, ChatSettings settings,
                                               ChatRequest.LlmProvider mainProvider,
                                               List<ChatRequest.LlmProvider> subProviders,
                                               List<Map<String, Object>> history, Map<String, Object> fileContext,
                                               SseEmitter emitter) {
        if (subProviders == null || subProviders.isEmpty()) {
            // 无副模型: 主模型直接驱动 agent
            log.info("No subProviders, fallback to main model single agent");
            try {
                return subModelWorker.executeAsWorkerSync(
                    message, settings, mainProvider, history, fileContext, emitter);
            } catch (Exception e) {
                log.error("Main model execution failed: {}", e.getMessage(), e);
                return "错误: " + e.getMessage();
            }
        }

        // 副模型并行: 每个 worker 非流式执行, 汇总
        log.info("Launching {} subModel workers in parallel", subProviders.size());
        List<CompletableFuture<String>> futures = subProviders.stream()
            .map(sp -> CompletableFuture.supplyAsync(() ->
                subModelWorker.executeAsWorkerSync(message, settings, sp, history, fileContext, emitter),
                parallelExecutor))
            .toList();

        List<String> results = futures.stream()
            .map(CompletableFuture::join)
            .toList();

        // 汇总: 选最长结果 (简化版, 后续可让主模型评判)
        String best = selectBestResult(results);
        log.info("Complex parallel completed: {} workers, best result {} chars",
            results.size(), best.length());
        return best;
    }

    /**
     * 简单任务非流式执行 (副模型轮询)
     */
    private String subModelWorkerExecuteSync(String message, ChatSettings settings,
                                              ChatRequest.LlmProvider mainProvider,
                                              List<ChatRequest.LlmProvider> subProviders,
                                              List<Map<String, Object>> history, Map<String, Object> fileContext,
                                              SseEmitter emitter) {
        if (subProviders == null || subProviders.isEmpty()) {
            // 无副模型: 主模型直接执行
            try {
                return subModelWorker.executeAsWorkerSync(
                    message, settings, mainProvider, history, fileContext, emitter);
            } catch (Exception e) {
                log.error("Main model sync execution failed: {}", e.getMessage(), e);
                return "错误: " + e.getMessage();
            }
        }
        // 有副模型: 轮询选一个 (复用 SubModelWorker 的轮询逻辑, 但非流式)
        // 简单任务不并行, 只选一个副模型执行
        return subModelWorker.executeSimpleWithRoundRobinSync(
            message, settings, mainProvider, subProviders, history, fileContext, emitter);
    }

    private String selectBestResult(List<String> results) {
        if (results == null || results.isEmpty()) return "(无结果)";
        return results.stream()
            .max((a, b) -> Integer.compare(a.length(), b.length()))
            .orElse("(无结果)");
    }
}
