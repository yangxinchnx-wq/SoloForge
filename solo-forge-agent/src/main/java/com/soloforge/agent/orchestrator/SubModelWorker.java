package com.soloforge.agent.orchestrator;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.executor.AgentExecutor;
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import reactor.core.publisher.Flux;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 副模型 Worker — 副模型调用 Java agent 的执行单元
 *
 * 三层架构: 主模型(编排) → 副模型(worker) → Java agent(执行)
 *
 * 主从关系:
 *   - 主模型 > 副模型 (主从级别)
 *   - 主模型和副模型都比 agent 高 (模型决定执行, agent 决定风格)
 *   - 副模型不覆盖前端选择的 agentId, 尊重用户选择
 *
 * 每个 SubModelWorker 代表一个副模型 worker:
 *   1. 优先使用前端选择的 agentId; 仅在前端未指定时让 LLM 自主选 agent
 *   2. 发 SSE agent 事件 {subModel, agentId, agentName, agentAvatar}
 *   3. 用自己 LLM 配置驱动选中的 agent 执行 (AgentExecutor.executeStream)
 *
 * 简单任务: 副模型轮询 (AtomicInteger 记录上次用到的副模型索引)
 * 复杂任务: 所有副模型并行, 每个跑一个 worker
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SubModelWorker {

    private final AgentSelector agentSelector;
    private final AgentExecutor agentExecutor;
    private final AgentIdentityRepository agentRepo;
    private final ObjectMapper objectMapper;

    private final AtomicInteger roundRobinCounter = new AtomicInteger(0);

    /**
     * 简单任务: 轮询选一个副模型, 走单 agent 流式执行
     * 无副模型时 fallback 到主模型
     */
    public Flux<String> executeSimpleWithRoundRobin(
            String message, ChatSettings settings,
            ChatRequest.LlmProvider mainProvider,
            List<ChatRequest.LlmProvider> subProviders,
            List<Map<String, Object>> history, Map<String, Object> fileContext,
            SseEmitter emitter) {

        ChatRequest.LlmProvider selected = pickRoundRobin(mainProvider, subProviders);
        return executeAsWorker(message, settings, selected, history, fileContext, emitter);
    }

    /**
     * 简单任务非流式版 (轮询选副模型 + 同步执行)
     * 用于 /api/chat/send 非流式接口
     */
    public String executeSimpleWithRoundRobinSync(
            String message, ChatSettings settings,
            ChatRequest.LlmProvider mainProvider,
            List<ChatRequest.LlmProvider> subProviders,
            List<Map<String, Object>> history, Map<String, Object> fileContext,
            SseEmitter emitter) {

        ChatRequest.LlmProvider selected = pickRoundRobin(mainProvider, subProviders);
        return executeAsWorkerSync(message, settings, selected, history, fileContext, emitter);
    }

    /**
     * 作为 worker 执行: 副模型选 agent + 驱动 agent (流式)
     * 用于简单任务轮询 / 复杂任务并行 worker
     *
     * agentId 决策优先级:
     *   1. 前端选择的 agentId (settings.getAgentId()) — 最高优先级, 不被副模型覆盖
     *   2. LLM 自主选择 — 仅在前端未指定时 fallback
     */
    public Flux<String> executeAsWorker(
            String message, ChatSettings settings,
            ChatRequest.LlmProvider subProvider,
            List<Map<String, Object>> history, Map<String, Object> fileContext,
            SseEmitter emitter) {

        return Flux.defer(() -> {
            try {
                // 1. 确定使用的 agentId (优先前端选择, 不覆盖)
                String frontendAgentId = settings.getAgentId();
                String agentId;
                if (frontendAgentId != null && !frontendAgentId.isBlank()) {
                    agentId = frontendAgentId;
                    log.info("SubModelWorker: 尊重前端选择的 agentId={}", agentId);
                } else {
                    // 仅在前端未指定时, 让 LLM 自主选择
                    agentId = agentSelector.selectAgent(message, subProvider);
                    log.info("SubModelWorker: 前端未指定 agentId, LLM 自主选择 agentId={}", agentId);
                }
                AgentIdentityEntity agent = agentRepo.findById(agentId)
                    .orElseThrow(() -> new RuntimeException("助理未找到: " + agentId));

                // 2. 发 SSE agent 事件 (前端流送区显示 "副模型 → 助理 → 任务")
                sendAgentEvent(emitter, subProvider.getModel(), agent);

                // 3. 用副模型配置驱动 agent 执行
                ChatSettings workerSettings = copySettings(settings, agentId);
                log.info("SubModelWorker[stream]: subModel={} agent={} task='{}'",
                    subProvider.getModel(), agentId,
                    message.length() > 60 ? message.substring(0, 60) + "..." : message);
                return agentExecutor.executeStream(message, workerSettings, subProvider, history, fileContext, emitter);
            } catch (Exception e) {
                log.error("SubModelWorker setup error: {}", e.getMessage(), e);
                return Flux.just("错误: " + e.getMessage());
            }
        });
    }

    /**
     * 非流式执行 (复杂任务并行汇总用)
     * 副模型选 agent + 驱动 agent 执行, 返回完整结果
     *
     * agentId 决策优先级同 executeAsWorker: 前端选择优先, 不覆盖
     */
    public String executeAsWorkerSync(
            String message, ChatSettings settings,
            ChatRequest.LlmProvider subProvider,
            List<Map<String, Object>> history, Map<String, Object> fileContext,
            SseEmitter emitter) {

        try {
            // 1. 确定使用的 agentId (优先前端选择, 不覆盖)
            String frontendAgentId = settings.getAgentId();
            String agentId;
            if (frontendAgentId != null && !frontendAgentId.isBlank()) {
                agentId = frontendAgentId;
            } else {
                agentId = agentSelector.selectAgent(message, subProvider);
            }
            AgentIdentityEntity agent = agentRepo.findById(agentId)
                .orElseThrow(() -> new RuntimeException("助理未找到: " + agentId));

            // 2. 发 SSE agent 事件
            sendAgentEvent(emitter, subProvider.getModel(), agent);

            // 3. 用副模型配置驱动 agent 执行 (非流式)
            ChatSettings workerSettings = copySettings(settings, agentId);
            log.info("SubModelWorker[sync]: subModel={} agent={} task='{}'",
                subProvider.getModel(), agentId,
                message.length() > 60 ? message.substring(0, 60) + "..." : message);
            return agentExecutor.execute(message, workerSettings, subProvider, history, fileContext);
        } catch (Exception e) {
            log.error("SubModelWorker sync error: {}", e.getMessage(), e);
            return "错误: " + e.getMessage();
        }
    }

    /**
     * 主模型直接执行 (无副模型时 fallback)
     * 发 SSE agent 事件 (主模型作为 driver)
     */
    public Flux<String> executeWithMainModel(
            String message, ChatSettings settings,
            ChatRequest.LlmProvider mainProvider,
            List<Map<String, Object>> history, Map<String, Object> fileContext,
            SseEmitter emitter) {

        return Flux.defer(() -> {
            try {
                String agentId = settings.getAgentId() != null ? settings.getAgentId() : "code_agent";
                AgentIdentityEntity agent = agentRepo.findById(agentId).orElse(null);
                if (agent != null) {
                    // 发 agent 事件, subModel 字段用主模型名
                    sendAgentEvent(emitter, mainProvider.getModel(), agent);
                }
                return agentExecutor.executeStream(message, settings, mainProvider, history, fileContext, emitter);
            } catch (Exception e) {
                log.error("Main model execution error: {}", e.getMessage(), e);
                return Flux.just("错误: " + e.getMessage());
            }
        });
    }

    /**
     * 轮询选副模型
     */
    private ChatRequest.LlmProvider pickRoundRobin(ChatRequest.LlmProvider mainProvider,
                                                    List<ChatRequest.LlmProvider> subProviders) {
        if (subProviders == null || subProviders.isEmpty()) {
            return mainProvider;
        }
        int idx = Math.floorMod(roundRobinCounter.getAndIncrement(), subProviders.size());
        ChatRequest.LlmProvider picked = subProviders.get(idx);
        log.info("RoundRobin selected subProvider[{}]: {}", idx, picked.getModel());
        return picked;
    }

    /**
     * 发送 SSE agent 事件
     * 携带 subModel 字段, 前端流送区显示 "副模型 → agent → 任务"
     */
    private void sendAgentEvent(SseEmitter emitter, String subModel, AgentIdentityEntity agent) {
        try {
            Map<String, Object> agentInfo = new HashMap<>();
            agentInfo.put("agentId", agent.getId());
            agentInfo.put("name", agent.getName());
            agentInfo.put("avatar", agent.getAvatar());
            agentInfo.put("role", agent.getRole());
            agentInfo.put("domain", agent.getDomain());
            agentInfo.put("subModel", subModel);
            String json = objectMapper.writeValueAsString(agentInfo);
            emitter.send(SseEmitter.event().name("agent").data(json).build());
        } catch (Exception e) {
            log.warn("Failed to send agent event: {}", e.getMessage());
        }
    }

    private ChatSettings copySettings(ChatSettings src, String agentId) {
        return ChatSettings.builder()
            .agentId(agentId)
            .personality(src.getPersonality())
            .tone(src.getTone())
            .emojiMode(src.getEmojiMode())
            .emojiEnabled(src.getEmojiEnabled())
            .emojiType(src.getEmojiType())
            .enabledSkills(src.getEnabledSkills())
            .enabledKnowledge(src.getEnabledKnowledge())
            .workspaceFolder(src.getWorkspaceFolder())
            .canvasId(src.getCanvasId())
            .chatSessionId(src.getChatSessionId())
            .requesterChatSessionId(src.getRequesterChatSessionId())
            .extraContext(src.getExtraContext())
            .build();
    }
}
