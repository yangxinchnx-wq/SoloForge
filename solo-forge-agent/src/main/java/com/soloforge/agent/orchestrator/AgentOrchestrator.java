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
 * Agent 缂栨帓鍣?(涓夊眰鏋舵瀯: 涓绘ā鍨?鈫?鍓ā鍨?鈫?Java agent)
 *
 * 2026-07-11 閲嶆瀯: 鍓ā鍨嬭皟鐢?Java agent 鏋舵瀯
 *   - 绠€鍗曚换鍔?(complexity < 0.5): 鍓ā鍨嬭疆璇? 鍗?agent 娴佸紡鎵ц
 *   - 澶嶆潅浠诲姟: 鎵€鏈夊壇妯″瀷骞惰, 姣忎釜鍓ā鍨嬭嚜涓婚€?agent + 椹卞姩鎵ц, 缁撴灉姹囨€? *   - 鏃犲壇妯″瀷: 涓绘ā鍨嬬洿鎺ラ┍鍔?agent (fallback)
 *
 * 涓夊眰鏋舵瀯璇箟:
 *   涓绘ā鍨?(涓婄骇, 缂栨帓璋冨害)
 *     鈫?骞惰璋冨害
 *   鍓ā鍨? / 鍓ā鍨? / ... (worker, 姣忎釜鑷富閫?agent)
 *     鈫?閫夋嫨 + 椹卞姩
 *   Java agent (鎵ц鍗曞厓, 鐢ㄥ壇妯″瀷 LLM 閰嶇疆)
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgentOrchestrator {

    private final TaskComplexityEvaluator complexityEvaluator;
    private final SubModelWorker subModelWorker;

    private final ExecutorService parallelExecutor = Executors.newFixedThreadPool(3);

    /**
     * 闈炴祦寮忓叆鍙?(鍚戝悗鍏煎, /api/chat/send 鐢?
     * 鏃犲壇妯″瀷鏃惰蛋鍘熼€昏緫, 鏈夊壇妯″瀷鏃朵篃璧板壇妯″瀷鏋舵瀯
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
            // 绠€鍗曚换鍔? 鍓ā鍨嬭疆璇?(鏃?emitter, 浼?null)
            log.info("Simple task (complexity={}), subModel round-robin",
                String.format("%.2f", eval.complexity()));
            return subModelWorkerExecuteSync(message, settings, provider, subProviders, history, fileContext, null);
        }

        // 澶嶆潅浠诲姟: 鍓ā鍨嬪苟琛?        log.info("Complex task (complexity={}), subModels parallel",
            String.format("%.2f", eval.complexity()));
        return orchestrateComplexParallel(message, settings, provider, subProviders, history, fileContext, null);
    }

    /**
     * 娴佸紡鍏ュ彛 鈥?涓绘ā鍨嬬紪鎺? 鍓ā鍨嬮┍鍔?agent
     *
     * 绠€鍗曚换鍔? 鍓ā鍨嬭疆璇? 鍗?agent 鐪熷疄娴佸紡
     * 澶嶆潅浠诲姟: 鍓ā鍨嬪苟琛?(闈炴祦寮忔眹鎬? 鍖呰涓哄崟鍏冪礌 Flux)
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
            // 绠€鍗曚换鍔? 鍓ā鍨嬭疆璇? 鍗?agent 娴佸紡
            log.info("Simple task (complexity={}), subModel round-robin streaming",
                String.format("%.2f", eval.complexity()));
            return subModelWorker.executeSimpleWithRoundRobin(
                message, settings, provider, subProviders, history, fileContext, emitter);
        }

        // 澶嶆潅浠诲姟: 鍓ā鍨嬪苟琛? 闄嶇骇涓洪潪娴佸紡姹囨€?        log.info("Complex task (complexity={}), subModels parallel (non-stream aggregate)",
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
     * 澶嶆潅浠诲姟: 鎵€鏈夊壇妯″瀷骞惰, 姣忎釜閫?agent + 鎵ц, 姹囨€荤粨鏋?     * 涓绘ā鍨?缂栨帓"璇箟: 鍚姩鎵€鏈夊壇妯″瀷 worker 骞惰 + 閫夋渶浼樼粨鏋?     */
    private String orchestrateComplexParallel(String message, ChatSettings settings,
                                               ChatRequest.LlmProvider mainProvider,
                                               List<ChatRequest.LlmProvider> subProviders,
                                               List<Map<String, Object>> history, Map<String, Object> fileContext,
                                               SseEmitter emitter) {
        if (subProviders == null || subProviders.isEmpty()) {
            // 鏃犲壇妯″瀷: 涓绘ā鍨嬬洿鎺ラ┍鍔?agent
            log.info("No subProviders, fallback to main model single agent");
            try {
                return subModelWorker.executeAsWorkerSync(
                    message, settings, mainProvider, history, fileContext, emitter);
            } catch (Exception e) {
                log.error("Main model execution failed: {}", e.getMessage(), e);
                return "閿欒: " + e.getMessage();
            }
        }

        // 鍓ā鍨嬪苟琛? 姣忎釜 worker 闈炴祦寮忔墽琛? 姹囨€?        log.info("Launching {} subModel workers in parallel", subProviders.size());
        List<CompletableFuture<String>> futures = subProviders.stream()
            .map(sp -> CompletableFuture.supplyAsync(() ->
                subModelWorker.executeAsWorkerSync(message, settings, sp, history, fileContext, emitter),
                parallelExecutor))
            .toList();

        List<String> results = futures.stream()
            .map(CompletableFuture::join)
            .toList();

        // 姹囨€? 閫夋渶闀跨粨鏋?(绠€鍖栫増, 鍚庣画鍙涓绘ā鍨嬭瘎鍒?
        String best = selectBestResult(results);
        log.info("Complex parallel completed: {} workers, best result {} chars",
            results.size(), best.length());
        return best;
    }

    /**
     * 绠€鍗曚换鍔￠潪娴佸紡鎵ц (鍓ā鍨嬭疆璇?
     */
    private String subModelWorkerExecuteSync(String message, ChatSettings settings,
                                              ChatRequest.LlmProvider mainProvider,
                                              List<ChatRequest.LlmProvider> subProviders,
                                              List<Map<String, Object>> history, Map<String, Object> fileContext,
                                              SseEmitter emitter) {
        if (subProviders == null || subProviders.isEmpty()) {
            // 鏃犲壇妯″瀷: 涓绘ā鍨嬬洿鎺ユ墽琛?            try {
                return subModelWorker.executeAsWorkerSync(
                    message, settings, mainProvider, history, fileContext, emitter);
            } catch (Exception e) {
                log.error("Main model sync execution failed: {}", e.getMessage(), e);
                return "閿欒: " + e.getMessage();
            }
        }
        // 鏈夊壇妯″瀷: 杞閫変竴涓?(澶嶇敤 SubModelWorker 鐨勮疆璇㈤€昏緫, 浣嗛潪娴佸紡)
        // 绠€鍗曚换鍔′笉骞惰, 鍙€変竴涓壇妯″瀷鎵ц
        return subModelWorker.executeSimpleWithRoundRobinSync(
            message, settings, mainProvider, subProviders, history, fileContext, emitter);
    }

    private String selectBestResult(List<String> results) {
        if (results == null || results.isEmpty()) return "(鏃犵粨鏋?";
        return results.stream()
            .max((a, b) -> Integer.compare(a.length(), b.length()))
            .orElse("(鏃犵粨鏋?");
    }
}
