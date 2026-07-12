package com.soloforge.agent.executor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.soloforge.agent.advisor.SystemPromptBuilder;
import com.soloforge.agent.aisociety.*;
import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.dto.ChatSettings;
import com.soloforge.agent.llm.LlmGateway;
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import com.soloforge.agent.tools.ToolRegistry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import reactor.core.publisher.Flux;
import reactor.core.publisher.FluxSink;
import reactor.core.scheduler.Schedulers;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Agent 执行器 (单 Agent + Function Calling 循环 + AI Society 约束)
 *
 * 流程:
 *   1. 从 agent_identity 表加载 Agent 配置
 *   2. 法律检查 (查 law 表, 违规则拒绝)
 *   3. 信用分检查 (查 economy 表, 不足则拒绝)
 *   4. SystemPromptBuilder 构建 12 层 prompt (含文化规范 + 历史经验)
 *   5. 调 LLM, tool_call 则执行工具, 结果回灌, 再调 LLM
 *   6. 信用分扣费
 *   7. 推送 reputation 增量到 8766
 *   8. 推送训练轨迹到 8765
 *   9. 记录治理合规到 governance 表
 *  10. 创建社会记忆到 social_memory 表
 *  11. 任务计数 +1
 *
 * 2026-07-08: 新增 executeStream() — 真实流式输出 LLM 增量文本
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgentExecutor {

    private final AgentIdentityRepository agentRepo;
    private final SystemPromptBuilder promptBuilder;
    private final LlmGateway llmGateway;
    private final ToolRegistry toolRegistry;
    private final ObjectMapper objectMapper;

    // AI Society Clients
    private final LawClient lawClient;
    private final GovernanceClient governanceClient;
    private final ReputationClient reputationClient;
    private final EconomyClient economyClient;
    private final MemoryClient memoryClient;
    private final CultureClient cultureClient;
    private final MarlTrainingClient marlTrainingClient;
    private final CaseRetriever caseRetriever;

    /**
     * 执行单 Agent 任务 (非流式, 向后兼容)
     */
    public String execute(String userMessage,
                          ChatSettings settings,
                          ChatRequest.LlmProvider provider,
                          List<Map<String, Object>> requestHistory,
                          Map<String, Object> fileContext) {
        // 1. 加载 Agent 配置
        AgentIdentityEntity agent = agentRepo.findById(settings.getAgentId())
            .orElseThrow(() -> new RuntimeException("助理未找到: " + settings.getAgentId()));

        if (agent.getEnabled() == null || agent.getEnabled() != 1) {
            throw new RuntimeException("助理已禁用: " + settings.getAgentId());
        }

        log.info("AgentExecutor: agent={} taskCount={} message='{}'",
            agent.getId(), agent.getTaskCount(),
            userMessage.length() > 80 ? userMessage.substring(0, 80) + "..." : userMessage);

        // 2. 法律检查
        Map<String, Object> lawContext = Map.of(
            "task", userMessage,
            "agent_id", agent.getId()
        );
        List<Map<String, Object>> violations = lawClient.checkViolation(agent.getId(), lawContext);
        if (!violations.isEmpty()) {
            String consequence = (String) violations.get(0).get("consequence");
            log.warn("助理 {} 被法律阻止: {}", agent.getId(), consequence);
            return "拒绝执行: 违反法律 - " + consequence;
        }

        // 3. 信用分检查
        economyClient.ensureAccount(agent.getId());
if (!economyClient.checkBalance(agent.getId(), agent.getModelBinding())) {
double credits = economyClient.getCredits(agent.getId());
return String.format("信用分耗尽: 当前 %.1f, 请通过 👍 反馈恢复", credits);
}

        // 4. 构建 System Prompt
        List<String> capabilities = agentRepo.parseCapabilities(agent);
        List<String> toolDescs = toolRegistry.getToolDescriptions();
        // ★ 2026-07-11: 经验只来自用户 👍/👎 反馈 (experience_case 表),
        //   不再注入 social_memory 自动生成的流水账记忆
        List<String> cases = caseRetriever.retrieve(userMessage, agent.getDomain());
        List<String> culturePrinciples = cultureClient.getPrinciples();

        String canvasCtx = buildCanvasContext(settings);

        String systemPrompt = promptBuilder.build(
            agent, settings, capabilities, toolDescs,
            settings.getWorkspaceFolder(),
            canvasCtx,
            List.of(), // skillContents (Phase 3 接入)
            settings.getEnabledKnowledge(),
            List.of(), // experiences — 不再注入自动记忆, 只靠 👍/👎 案例库
            cases,
            culturePrinciples);

        // 5. 构建 Function Calling 工具 schema (核心工具按 capabilities 过滤 + 扩展工具按 enabledTools 合并)
        List<Map<String, Object>> tools = buildToolSchemas(capabilities, settings.getEnabledTools());

        // 6. Function Calling 循环
        List<Map<String, String>> history = convertHistory(requestHistory);
        
        if (fileContext != null && fileContext.get("name") != null) {
            String fileName = String.valueOf(fileContext.get("name"));
            String fileContent = String.valueOf(fileContext.get("content"));
            history.add(Map.of("role", "user", "content", 
                "[File: " + fileName + "]\n```\n" + fileContent + "\n```"));
        }
        
        int maxRounds = agent.getMaxRounds() != null ? agent.getMaxRounds() : 8;
        double temperature = agent.getTemperature() != null ? agent.getTemperature() : 0.3;

        String currentMessage = userMessage;
        String finalResponse = null;
        int toolCallCount = 0;
        int toolErrors = 0;
        List<Integer> actions = new ArrayList<>();

        for (int round = 0; round < maxRounds; round++) {
            log.info("Round {}: calling LLM", round + 1);

            String response = llmGateway.chatCompletion(
                systemPrompt, currentMessage, history, provider, tools, temperature);

            ToolCallResult toolCall = tryParseToolCall(response);
            if (toolCall != null) {
                toolCallCount++;
                int action = marlTrainingClient.actionFromToolName(toolCall.toolName);
                actions.add(action);
                log.info("Round {}: tool_call: {} action={}", round + 1, toolCall.toolName, action);

                String toolResult = toolRegistry.invoke(toolCall.toolName, toolCall.args);
                if (toolResult.startsWith("工具调用失败") || toolResult.contains("失败")) {
                    toolErrors++;
                }

                marlTrainingClient.pushTrace(agent.getId(),
                    buildObservation(agent, userMessage, round), action, 0.3);

                history.add(Map.of("role", "assistant", "content", response));
                history.add(Map.of("role", "user", "content",
                    "工具 " + toolCall.toolName + " 返回:\n" + toolResult));

                currentMessage = "根据工具返回结果继续处理。如果信息足够,给出最终答案;如果还需要更多工具调用,继续调用。";
                finalResponse = response;
            } else {
                finalResponse = response;
                log.info("Round {}: final response ({} chars)", round + 1, response.length());
                break;
            }
        }

        postExecuteSideEffects(agent, finalResponse, userMessage, toolCallCount, toolErrors);

        return finalResponse != null ? finalResponse : "(助理达到最大循环次数,未给出最终答案)";
    }

    /**
     * 流式执行 — 返回增量文本 Flux
     *
     * 每个 onNext 是一个 LLM delta 文本片段
     * Function Calling 循环: 每轮流式输出, 同时缓冲; 流结束后检查 tool_call
     * 前端可以看到逐字流式效果
     */
    public Flux<String> executeStream(String userMessage,
                                       ChatSettings settings,
                                       ChatRequest.LlmProvider provider,
                                       List<Map<String, Object>> requestHistory,
                                       Map<String, Object> fileContext) {
        return executeStream(userMessage, settings, provider, requestHistory, fileContext, null);
    }

    /**
     * ★ 流式执行 (带 SseEmitter, 用于发送 usage 事件)
     */
    public Flux<String> executeStream(String userMessage,
                                       ChatSettings settings,
                                       ChatRequest.LlmProvider provider,
                                       List<Map<String, Object>> requestHistory,
                                       Map<String, Object> fileContext,
                                       SseEmitter emitter) {
        return Flux.<String>create(sink -> {
            try {
                // 1. 加载 Agent 配置
                AgentIdentityEntity agent = agentRepo.findById(settings.getAgentId())
                    .orElseThrow(() -> new RuntimeException("助理未找到: " + settings.getAgentId()));

                if (agent.getEnabled() == null || agent.getEnabled() != 1) {
                    throw new RuntimeException("助理已禁用: " + settings.getAgentId());
                }

                log.info("AgentExecutor[stream]: agent={} message='{}'",
                    agent.getId(),
                    userMessage.length() > 80 ? userMessage.substring(0, 80) + "..." : userMessage);

                // 2. 法律检查
                Map<String, Object> lawContext = Map.of("task", userMessage, "agent_id", agent.getId());
                List<Map<String, Object>> violations = lawClient.checkViolation(agent.getId(), lawContext);
                if (!violations.isEmpty()) {
                    String consequence = (String) violations.get(0).get("consequence");
                    sink.next("拒绝执行: 违反法律 - " + consequence);
                    sink.complete();
                    return;
                }

                // 3. 信用分检查
                economyClient.ensureAccount(agent.getId());
if (!economyClient.checkBalance(agent.getId(), agent.getModelBinding())) {
double credits = economyClient.getCredits(agent.getId());
sink.next(String.format("信用分耗尽: 当前 %.1f, 请通过 👍 反馈恢复", credits));
sink.complete();
return;
}

                // 4. 构建 System Prompt
                List<String> capabilities = agentRepo.parseCapabilities(agent);
                List<String> toolDescs = toolRegistry.getToolDescriptions();
                // ★ 2026-07-11: 经验只来自用户 👍/👎 反馈 (experience_case 表)
                List<String> cases = caseRetriever.retrieve(userMessage, agent.getDomain());
                List<String> culturePrinciples = cultureClient.getPrinciples();

                String canvasCtx = buildCanvasContext(settings);

                // ★ 2026-07-13: 从 Node.js 后端动态加载技能内容 (SKILL.md), 注入系统提示第 9 层
                List<String> skillContents = toolRegistry.getSkillContents(settings.getEnabledSkills());

                String systemPrompt = promptBuilder.build(
                    agent, settings, capabilities, toolDescs,
                    settings.getWorkspaceFolder(),
                    canvasCtx, skillContents, settings.getEnabledKnowledge(),
                    List.of(), // experiences — 不再注入自动记忆
                    cases, culturePrinciples);

                // 5. 工具 schema (核心工具按 capabilities 过滤 + 扩展工具按 enabledTools 合并)
                List<Map<String, Object>> tools = buildToolSchemas(capabilities, settings.getEnabledTools());

                // 6. 准备历史
                List<Map<String, String>> history = convertHistory(requestHistory);
                if (fileContext != null && fileContext.get("name") != null) {
                    String fileName = String.valueOf(fileContext.get("name"));
                    String fileContent = String.valueOf(fileContext.get("content"));
                    history.add(Map.of("role", "user", "content",
                        "[File: " + fileName + "]\n```\n" + fileContent + "\n```"));
                }

                int maxRounds = agent.getMaxRounds() != null ? agent.getMaxRounds() : 8;
                double temperature = agent.getTemperature() != null ? agent.getTemperature() : 0.3;

                // ★ Token 累加器: 累加多轮 LLM 调用的 usage
                int[] usageAcc = {0, 0, 0, 0}; // prompt, completion, total, cached

                // 7. 启动流式 Function Calling 循环
                String chatId = settings.getChatSessionId();
                streamRound(sink, systemPrompt, userMessage, history, provider, tools,
                    0, maxRounds, agent, userMessage, usageAcc, emitter, temperature, chatId);

            } catch (Exception e) {
                log.error("executeStream setup error: {}", e.getMessage(), e);
                sink.next("错误: " + e.getMessage());
                sink.complete();
            }
        }).subscribeOn(Schedulers.boundedElastic());
    }

    /**
     * 流式执行单轮 LLM 调用 — 递归处理 Function Calling 循环
     *
     * 2026-07-13: 工具调用前后发送 SSE 事件 (tool_started / tool_completed),
     * 让前端流送区能实时显示工具调用过程, 避免用户看到"断流"或"调用显示不出来"
     */
    private void streamRound(FluxSink<String> sink,
                              String systemPrompt,
                              String currentMessage,
                              List<Map<String, String>> history,
                              ChatRequest.LlmProvider provider,
                              List<Map<String, Object>> tools,
                              int round,
                              int maxRounds,
                              AgentIdentityEntity agent,
                              String originalUserMessage,
                              int[] usageAcc,
                              SseEmitter emitter,
                              double temperature,
                              String chatId) {

        if (round >= maxRounds) {
            sendUsageEvent(emitter, usageAcc);
            sink.next("(助理达到最大循环次数,未给出最终答案)");
            sink.complete();
            return;
        }

        log.info("Round {}: streaming LLM", round + 1);
        StringBuilder buffer = new StringBuilder();

        llmGateway.chatCompletionStream(systemPrompt, currentMessage, history, provider, tools, usage -> {
            // ★ 累加本轮 usage
            usageAcc[0] += usage.promptTokens();
            usageAcc[1] += usage.completionTokens();
            usageAcc[2] += usage.totalTokens();
            usageAcc[3] += usage.cachedTokens();
        }, temperature)
            .publishOn(Schedulers.boundedElastic())
            .subscribe(
                chunk -> {
                    buffer.append(chunk);
                    sink.next(chunk);
                },
                error -> {
                    log.error("Round {} stream error: {}", round + 1, error.getMessage());
                    sink.error(error);
                },
                () -> {
                    // 流结束, 检查是否是 tool_call
                    String response = buffer.toString();
                    ToolCallResult toolCall = tryParseToolCall(response);

                    if (toolCall != null) {
                        log.info("Round {}: tool_call: {}", round + 1, toolCall.toolName);

                        int action = marlTrainingClient.actionFromToolName(toolCall.toolName);
                        marlTrainingClient.pushTrace(agent.getId(),
                            buildObservation(agent, originalUserMessage, round), action, 0.3);

                        // ★ 发送 tool_started SSE 事件 — 让前端流送区显示工具调用开始
                        String toolCallId = UUID.randomUUID().toString();
                        long toolStartMs = System.currentTimeMillis();
                        sendToolStartedEvent(emitter, chatId, toolCallId, toolCall.toolName, toolCall.args);

                        String toolResult = toolRegistry.invoke(toolCall.toolName, toolCall.args);
                        boolean toolError = toolResult.startsWith("工具调用失败") || toolResult.contains("失败");

                        // ★ 发送 tool_completed SSE 事件 — 让前端流送区显示工具调用结束
                        long toolDurationMs = System.currentTimeMillis() - toolStartMs;
                        sendToolCompletedEvent(emitter, chatId, toolCallId, !toolError, toolDurationMs);

                        history.add(Map.of("role", "assistant", "content", response));
                        history.add(Map.of("role", "user", "content",
                            "工具 " + toolCall.toolName + " 返回:\n" + toolResult));

                        // 继续下一轮
                        streamRound(sink, systemPrompt,
                            "根据工具返回结果继续处理。如果信息足够,给出最终答案;如果还需要更多工具调用,继续调用。",
                            history, provider, tools, round + 1, maxRounds,
                            agent, originalUserMessage, usageAcc, emitter, temperature, chatId);
                    } else {
                        // 最终响应, 执行 side effects
                        log.info("Round {}: final response ({} chars)", round + 1, response.length());
                        int toolCallCount = round;
                        int toolErrors = 0;
                        postExecuteSideEffects(agent, response, originalUserMessage, toolCallCount, toolErrors);
                        // ★ 发送累加的 usage 事件
                        sendUsageEvent(emitter, usageAcc);
                        sink.complete();
                    }
                }
            );
    }

    /**
     * ★ 发送 usage SSE 事件 (如 emitter 可用)
     * 格式: event: usage\ndata: {"promptTokens":123,"completionTokens":456,"totalTokens":579,"cachedTokens":80}
     */
    private void sendUsageEvent(SseEmitter emitter, int[] usageAcc) {
        if (emitter == null) return;
        if (usageAcc[2] == 0) return; // 无 token 数据则不发
        try {
            Map<String, Object> usageData = new LinkedHashMap<>();
            usageData.put("promptTokens", usageAcc[0]);
            usageData.put("completionTokens", usageAcc[1]);
            usageData.put("totalTokens", usageAcc[2]);
            if (usageAcc[3] > 0) {
                usageData.put("cachedTokens", usageAcc[3]);
            }
            String json = objectMapper.writeValueAsString(usageData);
            emitter.send(SseEmitter.event().name("usage").data(json).build());
            log.info("Usage sent: prompt={} completion={} total={} cached={}", usageAcc[0], usageAcc[1], usageAcc[2], usageAcc[3]);
        } catch (Exception e) {
            log.debug("Failed to send usage event: {}", e.getMessage());
        }
    }

    /**
     * ★ 发送 tool_started SSE 事件 — 通知前端工具调用开始
     * 格式: event: tool_started\ndata: {"chatId":"...","toolCallId":"...","tool":"read_file","command":"...","ts":123}
     *
     * 前端 sseBackend.ts 会将此事件路由到 terminalLogStore, 在流送区显示工具调用过程
     */
    private void sendToolStartedEvent(SseEmitter emitter, String chatId, String toolCallId,
                                       String toolName, Map<String, Object> args) {
        if (emitter == null) return;
        try {
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("chatId", chatId != null ? chatId : "");
            data.put("toolCallId", toolCallId);
            data.put("tool", toolName);
            // command 字段: 对 execute_cmd / win_powershell 等命令类工具, 提取命令文本便于前端展示
            if (args != null) {
                Object cmd = args.get("command");
                if (cmd == null) cmd = args.get("script");
                if (cmd == null) cmd = args.get("path");
                if (cmd != null) data.put("command", String.valueOf(cmd));
            }
            data.put("ts", System.currentTimeMillis());
            String json = objectMapper.writeValueAsString(data);
            emitter.send(SseEmitter.event().name("tool_started").data(json).build());
            log.info("tool_started sent: tool={} toolCallId={}", toolName, toolCallId);
        } catch (Exception e) {
            log.debug("Failed to send tool_started event: {}", e.getMessage());
        }
    }

    /**
     * ★ 发送 tool_completed SSE 事件 — 通知前端工具调用结束
     * 格式: event: tool_completed\ndata: {"chatId":"...","toolCallId":"...","success":true,"durationMs":123,"ts":123}
     */
    private void sendToolCompletedEvent(SseEmitter emitter, String chatId, String toolCallId,
                                         boolean success, long durationMs) {
        if (emitter == null) return;
        try {
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("chatId", chatId != null ? chatId : "");
            data.put("toolCallId", toolCallId);
            data.put("success", success);
            data.put("durationMs", durationMs);
            data.put("ts", System.currentTimeMillis());
            String json = objectMapper.writeValueAsString(data);
            emitter.send(SseEmitter.event().name("tool_completed").data(json).build());
            log.info("tool_completed sent: toolCallId={} success={} durationMs={}", toolCallId, success, durationMs);
        } catch (Exception e) {
            log.debug("Failed to send tool_completed event: {}", e.getMessage());
        }
    }

    /**
     * 执行后 side effects: 信用分扣费 + reputation 推送 + 治理记录 + 社会记忆 + 任务计数
     */
    private void postExecuteSideEffects(AgentIdentityEntity agent, String finalResponse,
                                         String userMessage, int toolCallCount, int toolErrors) {
        try {
            // 信用分扣费
            economyClient.spend(agent.getId(), agent.getModelBinding());

            // reputation 推送
            double repDelta = reputationClient.computeDelta(finalResponse != null, toolErrors);
            reputationClient.pushIncrement(agent.getId(), repDelta, "task_completed");

            // 治理合规
            boolean compliant = toolErrors == 0;
            governanceClient.recordCompliance(
                "inst_core_code_review", agent.getId(), compliant,
                "task_execution", "toolErrors=" + toolErrors);

            // 社会记忆
            if (toolCallCount > 0) {
                String impact = toolErrors == 0 ? "positive" : "negative";
                memoryClient.create(
                    "task_completed_" + agent.getId(),
                    impact,
                    toolErrors > 2 ? "high" : "medium",
                    List.of(agent.getId()),
                    List.of("调用 " + toolCallCount + " 次工具, " + toolErrors + " 次错误"),
                    agent.getDomain());
            }

            // 任务计数
            agentRepo.incrementTaskCount(agent.getId());
        } catch (Exception e) {
            log.warn("Side effects error (non-blocking): {}", e.getMessage());
        }
    }

    private double[] buildObservation(AgentIdentityEntity agent, String task, int round) {
        double[] obs = new double[10];
        obs[0] = Math.min(task.length() / 1000.0, 1.0);
        obs[1] = 0.5;
        obs[2] = Math.min(task.split("\n").length / 100.0, 1.0);
        obs[3] = task.contains("修改") || task.contains("创建") ? 1.0 : 0.0;
        obs[4] = agentRepo.parseCapabilities(agent).size() / 5.0;
        obs[5] = 0.8;
        obs[6] = Math.min(round / 10.0, 1.0);
        obs[7] = 0.1;
        obs[8] = task.contains("代码") ? 1.0 : 0.0;
        obs[9] = 0.3;
        return obs;
    }

    private List<Map<String, Object>> buildToolSchemas() {
        return buildToolSchemas(null, null);
    }

    /**
     * 根据能力 + 启用的扩展工具构建工具 schema
     *
     * capabilities 为 null 时返回全部核心工具 (向后兼容)
     * capabilities 非空时只返回能力对应的核心工具
     * enabledTools 非空时额外合并从 Node.js 后端拉取的扩展工具 schema
     *
     * 核心工具能力到工具的映射:
     *   read    → read_file, list_files, search_code
     *   write   → write_file
     *   search  → search_code, list_files
     *   execute → execute_cmd
     *   analyze → (无工具, 仅 prompt 提示)
     *   canvas_push_ui 始终可用 (画布推送是通用能力)
     *
     * 2026-07-13: 新增 enabledTools 参数 — 扩展工具 schema 从 Node.js 后端动态拉取并合并
     */
    private List<Map<String, Object>> buildToolSchemas(List<String> capabilities, List<String> enabledTools) {
        List<Map<String, Object>> tools = new ArrayList<>();
        Map<String, Object> schemas = toolRegistry.getToolSchemas();
        List<String> names = toolRegistry.getToolNames();
        List<String> descs = toolRegistry.getToolDescriptions();

        // 能力 → 工具名映射
        Map<String, List<String>> capabilityToTools = Map.of(
            "read",    List.of("read_file", "list_files", "search_code"),
            "write",   List.of("write_file"),
            "search",  List.of("search_code", "list_files"),
            "execute", List.of("execute_cmd")
        );

        // 收集允许的工具名
        java.util.Set<String> allowedTools = new java.util.HashSet<>();
        allowedTools.add("canvas_push_ui"); // 画布工具始终可用

        if (capabilities != null && !capabilities.isEmpty()) {
            for (String cap : capabilities) {
                List<String> mapped = capabilityToTools.get(cap);
                if (mapped != null) {
                    allowedTools.addAll(mapped);
                }
            }
        } else {
            // 无 capabilities 限制时, 全部核心工具可用
            allowedTools.addAll(names);
        }

        // 构建核心工具 schema (本地硬编码)
        for (int i = 0; i < names.size(); i++) {
            String toolName = names.get(i);
            if (!allowedTools.contains(toolName)) {
                continue;
            }
            Map<String, Object> tool = new LinkedHashMap<>();
            tool.put("type", "function");
            tool.put("function", Map.of(
                "name", toolName,
                "description", descs.get(i),
                "parameters", schemas.get(toolName)
            ));
            tools.add(tool);
        }

        // 合并扩展工具 schema (从 Node.js 后端动态拉取)
        // 扩展工具 (browser_*/bu_*/win_* 等) 不受 capabilities 限制, 由前端 enabledTools 决定
        if (enabledTools != null && !enabledTools.isEmpty()) {
            List<Map<String, Object>> extendedSchemas = toolRegistry.getExtendedToolSchemas(enabledTools);
            if (!extendedSchemas.isEmpty()) {
                tools.addAll(extendedSchemas);
                log.info("buildToolSchemas: 合并 {} 个扩展工具 (核心 {} 个, 总计 {} 个)",
                    extendedSchemas.size(), tools.size() - extendedSchemas.size(), tools.size());
            }
        }

        return tools;
    }

    private ToolCallResult tryParseToolCall(String response) {
        if (response == null || !response.contains("```json")) {
            return null;
        }
        try {
            int start = response.indexOf("```json");
            int end = response.indexOf("```", start + 7);
            if (start < 0 || end < 0) return null;

            String json = response.substring(start + 7, end).trim();
            Map<String, Object> parsed = objectMapper.readValue(json, Map.class);

            String toolName = (String) parsed.get("tool");
            if (toolName == null) return null;

            @SuppressWarnings("unchecked")
            Map<String, Object> args = (Map<String, Object>) parsed.get("args");
            if (args == null) args = Map.of();

            return new ToolCallResult(toolName, args);
        } catch (Exception e) {
            return null;
        }
    }

    private record ToolCallResult(String toolName, Map<String, Object> args) {}

    @SuppressWarnings("unchecked")
    private List<Map<String, String>> convertHistory(List<Map<String, Object>> requestHistory) {
        List<Map<String, String>> result = new ArrayList<>();
        if (requestHistory == null || requestHistory.isEmpty()) {
            return result;
        }
        for (Map<String, Object> h : requestHistory) {
            String sender = String.valueOf(h.getOrDefault("sender", "user"));
            String content = String.valueOf(h.getOrDefault("content", ""));
            if (content.isBlank()) continue;
            String role = "assistant".equals(sender) ? "assistant" : "user";
            result.add(Map.of("role", role, "content", content));
        }
        log.info("Converted history: {} entries from frontend", result.size());
        return result;
    }

    /**
     * 构建画布上下文 — 让 Agent 知道画布存在、当前 session ID、以及可以调用 canvas_push_ui 工具
     */
    private String buildCanvasContext(ChatSettings settings) {
        StringBuilder sb = new StringBuilder();
        sb.append("SoloForge 配备了实时画布预览系统,可以在对话中直接渲染 UI 界面。\n\n");
        sb.append("## 画布能力\n");
        sb.append("- 画布是一个实时渲染引擎,支持 Universal AST (语言无关的 UI 描述协议)\n");
        sb.append("- 当你生成 UI 代码时,可以同时用 canvas_push_ui 工具将 AST 推送到画布实时预览\n");
        sb.append("- 画布支持: 容器/文本/按钮/输入框/图片/列表/进度条/分隔线/卡片等组件\n\n");

        // 画布 session ID
        String canvasId = settings.getCanvasId();
        String chatSessionId = settings.getChatSessionId();
        if (canvasId != null && !canvasId.isBlank()) {
            sb.append("## 当前画布\n");
            sb.append("canvasId: ").append(canvasId).append("\n");
            sb.append("调用 canvas_push_ui 时, sessionId 填 \"").append(canvasId).append("\"\n\n");
        } else if (chatSessionId != null && !chatSessionId.isBlank()) {
            // 降级: 从 chatSessionId 派生 canvasId
            String derivedId = "canvas-" + chatSessionId;
            sb.append("## 当前画布\n");
            sb.append("canvasId (自动派生): ").append(derivedId).append("\n");
            sb.append("调用 canvas_push_ui 时, sessionId 填 \"").append(derivedId).append("\"\n\n");
        } else {
            sb.append("## 当前画布\n");
            sb.append("canvasId: canvas-default\n");
            sb.append("调用 canvas_push_ui 时, sessionId 填 \"canvas-default\"\n\n");
        }

        sb.append("## Universal AST 格式\n");
        sb.append("AST 是一个 JSON 树,根节点结构:\n");
        sb.append("```json\n");
        sb.append("{\"type\":\"container\",\"props\":{\"padding\":16,\"layout\":\"column\",\"spacing\":8,\"backgroundColor\":\"#FFFFFF\"},");
        sb.append("\"children\":[\n");
        sb.append("  {\"type\":\"text\",\"props\":{\"content\":\"标题\",\"fontSize\":24,\"fontWeight\":\"bold\"}},\n");
        sb.append("  {\"type\":\"button\",\"props\":{\"label\":\"点击\",\"variant\":\"filled\",\"color\":\"#3B82F6\"}},\n");
        sb.append("  {\"type\":\"input\",\"props\":{\"placeholder\":\"输入...\",\"borderColor\":\"#E5E7EB\"}}\n");
        sb.append("]}\n");
        sb.append("```\n\n");
        sb.append("支持组件类型: container, text, button, input, image, list, progress, divider, card\n\n");
        sb.append("## 何时使用画布 (重要 — 新机制)\n");
        sb.append("SoloForge 前端内置 11 款本地翻译器, 会自动把你回复中的 UI 代码块翻译成画布 AST 并渲染。\n\n");
        sb.append("### 默认行为 — 返回代码块 (推荐, 零 token)\n");
        sb.append("用户请求 UI 界面/页面/组件时, 直接在回复中用 markdown 代码块返回完整 UI 代码:\n");
        sb.append("- 网页:    ```html  / ```tsx  / ```vue\n");
        sb.append("- 移动端:  ```dart  / ```swift  / ```kotlin\n");
        sb.append("- 桌面端:  ```xml  / ```xaml  / ```qml\n");
        sb.append("- 脚本UI:  ```python  / ```c\n\n");
        sb.append("前端自动检测代码块语言 → 调用对应翻译器 → 推送画布。无需调用工具, 无需加标记。\n\n");
        sb.append("### 仅以下场景才调用 canvas_push_ui 工具\n");
        sb.append("- 图形/插画/图标/流程图 (用 svg 节点, 代码块无法表达)\n");
        sb.append("- 用户明确要求\"用 AST 推送\"或\"实时推送\"\n");
        sb.append("- 不要加 <<<PREVIEW_NEEDED>>> 标记 (已废弃, 前端自动检测代码块)\n");

        return sb.toString();
    }
}
