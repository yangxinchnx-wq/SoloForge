package com.soloforge.agent.orchestrator;

import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.llm.LlmGateway;
import com.soloforge.agent.persistence.AgentIdentityEntity;
import com.soloforge.agent.persistence.AgentIdentityRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.stream.Collectors;

/**
 * Agent 选择器 — 副模型自主选择 agent
 *
 * 副模型用自己 LLM 配置调 LLM, 从可用 agent 列表里选一个最适合任务的 agent。
 * 实现"副模型调用 Java agent"架构中"副模型自主选择 agent"的逻辑。
 *
 * 动态适配: 未来 agent 增多时无需改代码, LLM 会从数据库查到的 agent 列表里选。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgentSelector {

    private final LlmGateway llmGateway;
    private final AgentIdentityRepository agentRepo;

    /**
     * 用副模型配置调 LLM 选 agent
     *
     * @param task 任务描述
     * @param subProvider 副模型 LLM 配置 (用它的 baseUrl/apiKey/model 调用)
     * @return 选中的 agentId
     */
    public String selectAgent(String task, ChatRequest.LlmProvider subProvider) {
        List<AgentIdentityEntity> agents = agentRepo.findAllEnabled();
        if (agents.isEmpty()) {
            log.warn("No enabled agents found, fallback to code_agent");
            return "code_agent";
        }
        if (agents.size() == 1) {
            return agents.get(0).getId();
        }

        String agentList = agents.stream()
            .map(a -> String.format("- id=%s | name=%s | domain=%s | capabilities=%s",
                a.getId(),
                a.getName() != null ? a.getName() : a.getId(),
                a.getDomain() != null ? a.getDomain() : "通用",
                String.join(", ", agentRepo.parseCapabilities(a))))
            .collect(Collectors.joining("\n"));

        String systemPrompt = "你是一个任务分配器。根据用户任务,从下列 agent 列表里选一个最适合的 agent。\n" +
            "只返回 agent 的 id (一行字符串),不要返回任何其他内容、不要加引号或解释。\n\n" +
            "可用 agent 列表:\n" + agentList;

        try {
            String result = llmGateway.chatCompletion(systemPrompt, task, List.of(), subProvider, null);
            if (result == null || result.isBlank()) {
                log.warn("Agent selector returned empty, fallback to first agent");
                return agents.get(0).getId();
            }
            String agentId = result.trim().replaceAll("[\"'`\\n\\r]", "").trim();

            // 精确匹配
            for (AgentIdentityEntity a : agents) {
                if (a.getId().equals(agentId) || a.getId().equalsIgnoreCase(agentId)) {
                    log.info("SubProvider {} selected agent: {}", subProvider.getModel(), a.getId());
                    return a.getId();
                }
            }
            // 宽松匹配: id 包含在返回值里
            for (AgentIdentityEntity a : agents) {
                if (agentId.contains(a.getId())) {
                    log.info("SubProvider {} selected agent (loose match): {}", subProvider.getModel(), a.getId());
                    return a.getId();
                }
            }
            log.warn("Agent selector returned unknown id '{}', fallback to first agent", agentId);
            return agents.get(0).getId();
        } catch (Exception e) {
            log.warn("Agent selector LLM call failed: {}, fallback to first agent", e.getMessage());
            return agents.get(0).getId();
        }
    }
}
