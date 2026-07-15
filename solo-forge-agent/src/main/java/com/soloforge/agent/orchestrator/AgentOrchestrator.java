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
 * Agent Orchestrator (3-layer architecture: main model -> sub model -> Java agent)
 *
 * 2026-07-11 refactor: sub model orchestrates Java agent
 *   - Simple task (complexity < 0.5): sub model round-robin, single agent streaming
 *   - Complex task: all sub models parallel, each selects agent + drives execution, aggregate results
 *   - No sub model: main model directly drives agent (fallback)
 *
 * 3-layer architecture explanation:
 *   Main model (upper level, orchestration scheduling)
 *     -> parallel scheduling
 *   Sub model 1 / Sub model 2 / ... (worker, each autonomously selects agent)
 *     -> select + drive
 *   Java agent (execution unit, uses sub model LLM config)
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgentOrchestrator {

    private final TaskComplexityEvaluator complexityEvaluator;
    private final SubModelWorker subModelWorker;

    private final ExecutorService parallelExecutor = Executors.newFixedThreadPool(3);

    /**
     * Non-stream entry (backward compatible, /api/chat/send)
     * No sub model: run original logic, with sub model: run sub model orchestration
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
            // Simple task: sub model round-robin (no emitter, will be null)
            log.info("Simple task (complexity={}), subModel round-robin",
                String.format("%.2f", eval.complexity()));
            return subModelWorkerExecuteSync(message, settings, provider, subProviders, history, fileContext, null);
        }

        // Complex task: sub models parallel
        log.info("Complex task (complexity={}), subModels parallel",
            String.format("%.2f", eval.complexity()));
        return orchestrateComplexParallel(message, settings, provider, subProviders, history, fileContext, null);
    }

    /**
     * Stream entry - main model orchestrates, sub model drives agent
     *
     * Simple task: sub model round-robin, single agent real streaming
     * Complex task: sub models parallel (non-stream aggregate, wrapped as single element Flux)
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
            // Simple task: sub model round-robin, single agent streaming
            log.info("Simple task (complexity={}), subModel round-robin streaming",
                String.format("%.2f", eval.complexity()));
            return subModelWorker.executeSimpleWithRoundRobin(
                message, settings, provider, subProviders, history, fileContext, emitter);
        }

        // Complex task: sub models parallel, downgrade to non-stream aggregate
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
     * Complex task: all sub models parallel, each selects agent + executes, aggregate results.
     * Main model orchestrates: launch all sub model workers in parallel + select best result.
     */
    private String orchestrateComplexParallel(String message, ChatSettings settings,
                                               ChatRequest.LlmProvider mainProvider,
                                               List<ChatRequest.LlmProvider> subProviders,
                                               List<Map<String, Object>> history, Map<String, Object> fileContext,
                                               SseEmitter emitter) {
        if (subProviders == null || subProviders.isEmpty()) {
            // No sub model: main model directly drives agent
            log.info("No subProviders, fallback to main model single agent");
            try {
                return subModelWorker.executeAsWorkerSync(
                    message, settings, mainProvider, history, fileContext, emitter);
            } catch (Exception e) {
                log.error("Main model execution failed: {}", e.getMessage(), e);
                return "Error: " + e.getMessage();
            }
        }

        // Sub models parallel, each worker non-stream execution, aggregate
        log.info("Launching {} subModel workers in parallel", subProviders.size());
        List<CompletableFuture<String>> futures = subProviders.stream()
            .map(sp -> CompletableFuture.supplyAsync(() ->
                subModelWorker.executeAsWorkerSync(message, settings, sp, history, fileContext, emitter),
                parallelExecutor))
            .toList();

        List<String> results = futures.stream()
            .map(CompletableFuture::join)
            .toList();

        // Aggregate: select longest result (simplified, later can let main model evaluate)
        String best = selectBestResult(results);
        log.info("Complex parallel completed: {} workers, best result {} chars",
            results.size(), best.length());
        return best;
    }

    /**
     * Simple task non-stream execution (sub model round-robin)
     */
    private String subModelWorkerExecuteSync(String message, ChatSettings settings,
                                              ChatRequest.LlmProvider mainProvider,
                                              List<ChatRequest.LlmProvider> subProviders,
                                              List<Map<String, Object>> history, Map<String, Object> fileContext,
                                              SseEmitter emitter) {
        if (subProviders == null || subProviders.isEmpty()) {
            // No sub model: main model directly executes
            try {
                return subModelWorker.executeAsWorkerSync(
                    message, settings, mainProvider, history, fileContext, emitter);
            } catch (Exception e) {
                log.error("Main model sync execution failed: {}", e.getMessage(), e);
                return "Error: " + e.getMessage();
            }
        }
        // Has sub model: round-robin select one (reuse SubModelWorker's round-robin logic, but non-stream)
        // Simple task does not parallel, only select one sub model to execute
        return subModelWorker.executeSimpleWithRoundRobinSync(
            message, settings, mainProvider, subProviders, history, fileContext, emitter);
    }

    private String selectBestResult(List<String> results) {
        if (results == null || results.isEmpty()) return "(no result)";
        return results.stream()
            .max((a, b) -> Integer.compare(a.length(), b.length()))
            .orElse("(no result)");
    }
}
