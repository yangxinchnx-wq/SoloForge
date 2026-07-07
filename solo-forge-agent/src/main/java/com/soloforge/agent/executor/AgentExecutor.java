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

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
     * 执行单 Agent 任务
     */
    public String execute(String userMessage,
                          ChatSettings settings,
                          ChatRequest.LlmProvider provider) {
        // 1. 加载 Agent 配置
        AgentIdentityEntity agent = agentRepo.findById(settings.getAgentId())
            .orElseThrow(() -> new RuntimeException("Agent not found: " + settings.getAgentId()));

        if (agent.getEnabled() == null || agent.getEnabled() != 1) {
            throw new RuntimeException("Agent is disabled: " + settings.getAgentId());
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
            log.warn("Agent {} blocked by law: {}", agent.getId(), consequence);
            return "拒绝执行: 违反法律 - " + consequence;
        }

        // 3. 信用分检查
        economyClient.ensureAccount(agent.getId());
        if (!economyClient.checkBalance(agent.getId(), agent.getModelBinding())) {
            double credits = economyClient.getCredits(agent.getId());
            double cost = economyClient.getCost(agent.getModelBinding());
            return String.format("信用分不足: 当前 %.1f, 需要 %.1f", credits, cost);
        }

        // 4. 构建 System Prompt
        List<String> capabilities = agentRepo.parseCapabilities(agent);
        List<String> toolDescs = toolRegistry.getToolDescriptions();
        List<String> experiences = memoryClient.getLessons(agent.getDomain());
        List<String> cases = caseRetriever.retrieve(userMessage, agent.getDomain());
        List<String> culturePrinciples = cultureClient.getPrinciples();

        String systemPrompt = promptBuilder.build(
            agent, settings, capabilities, toolDescs,
            settings.getWorkspaceFolder(),
            null, // canvasContext
            List.of(), // skillContents (Phase 3 接入)
            settings.getEnabledKnowledge(),
            experiences,
            cases,
            culturePrinciples);

        // 5. 构建 Function Calling 工具 schema
        List<Map<String, Object>> tools = buildToolSchemas();

        // 6. Function Calling 循环
        List<Map<String, String>> history = new ArrayList<>();
        int maxRounds = agent.getMaxRounds() != null ? agent.getMaxRounds() : 8;

        String currentMessage = userMessage;
        String finalResponse = null;
        int toolCallCount = 0;
        int toolErrors = 0;
        List<Integer> actions = new ArrayList<>();

        for (int round = 0; round < maxRounds; round++) {
            log.info("Round {}: calling LLM", round + 1);

            String response = llmGateway.chatCompletion(
                systemPrompt, currentMessage, history, provider, tools);

            // 检查是否是 tool_call
            ToolCallResult toolCall = tryParseToolCall(response);
            if (toolCall != null) {
                toolCallCount++;
                int action = marlTrainingClient.actionFromToolName(toolCall.toolName);
                actions.add(action);
                log.info("Round {}: tool_call: {} action={}", round + 1, toolCall.toolName, action);

                // 执行工具
                String toolResult = toolRegistry.invoke(toolCall.toolName, toolCall.args);
                if (toolResult.startsWith("工具调用失败") || toolResult.contains("失败")) {
                    toolErrors++;
                }

                // 推送训练轨迹到 8765
                marlTrainingClient.pushTrace(agent.getId(),
                    buildObservation(agent, userMessage, round), action, 0.3);

                // 工具结果回灌
                history.add(Map.of("role", "assistant", "content", response));
                history.add(Map.of("role", "user", "content",
                    "工具 " + toolCall.toolName + " 返回:\n" + toolResult));

                currentMessage = "根据工具返回结果继续处理。如果信息足够,给出最终答案;如果还需要更多工具调用,继续调用。";
                finalResponse = response;
            } else {
                // 最终响应
                finalResponse = response;
                log.info("Round {}: final response ({} chars)", round + 1, response.length());
                break;
            }
        }

        // 7. 信用分扣费
        economyClient.spend(agent.getId(), agent.getModelBinding());

        // 8. 推送 reputation 增量
        double repDelta = reputationClient.computeDelta(finalResponse != null, toolErrors);
        reputationClient.pushIncrement(agent.getId(), repDelta, "task_completed");

        // 9. 记录治理合规
        boolean compliant = toolErrors == 0;
        governanceClient.recordCompliance(
            "inst_core_code_review", agent.getId(), compliant,
            "task_execution", "toolErrors=" + toolErrors);

        // 10. 创建社会记忆
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

        // 11. 任务计数 +1
        agentRepo.incrementTaskCount(agent.getId());

        return finalResponse != null ? finalResponse : "(Agent 达到最大循环次数,未给出最终答案)";
    }

    /**
     * 构建 10 维观测 (与 agent_env.py 对齐)
     */
    private double[] buildObservation(AgentIdentityEntity agent, String task, int round) {
        double[] obs = new double[10];
        // 任务特征 (4 维)
        obs[0] = Math.min(task.length() / 1000.0, 1.0); // task_complexity
        obs[1] = 0.5; // task_domain_match (简化)
        obs[2] = Math.min(task.split("\n").length / 100.0, 1.0); // task_code_lines
        obs[3] = task.contains("修改") || task.contains("创建") ? 1.0 : 0.0; // task_requires_tools
        // Agent 状态 (4 维)
        obs[4] = agentRepo.parseCapabilities(agent).size() / 5.0; // agent_skill_count
        obs[5] = 0.8; // agent_success_rate (简化)
        obs[6] = Math.min(round / 10.0, 1.0); // agent_current_round
        obs[7] = 0.1; // agent_tool_error_rate (简化)
        // 上下文 (2 维)
        obs[8] = task.contains("代码") ? 1.0 : 0.0; // context_has_existing_code
        obs[9] = 0.3; // context_file_count (简化)
        return obs;
    }

    private List<Map<String, Object>> buildToolSchemas() {
        List<Map<String, Object>> tools = new ArrayList<>();
        Map<String, Object> schemas = toolRegistry.getToolSchemas();
        List<String> names = toolRegistry.getToolNames();
        List<String> descs = toolRegistry.getToolDescriptions();

        for (int i = 0; i < names.size(); i++) {
            String toolName = names.get(i);
            Map<String, Object> tool = new LinkedHashMap<>();
            tool.put("type", "function");
            tool.put("function", Map.of(
                "name", toolName,
                "description", descs.get(i),
                "parameters", schemas.get(toolName)
            ));
            tools.add(tool);
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
}
