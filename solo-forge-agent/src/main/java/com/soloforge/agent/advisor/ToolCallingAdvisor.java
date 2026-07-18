package com.soloforge.agent.advisor;

import com.soloforge.agent.pool.PoolManager;
import com.soloforge.agent.tools.RemoteToolExecutor;
import com.soloforge.agent.tools.SoloForgeTools;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.*;

@Component
@Order(4)
public class ToolCallingAdvisor implements CallAdvisor, Ordered {
    private static final Logger log = LoggerFactory.getLogger(ToolCallingAdvisor.class);
    private static final int MAX_TOOL_ITERATIONS = 5;
    private final PoolManager poolManager;
    private final SoloForgeTools soloForgeTools;
    private final RemoteToolExecutor remoteToolExecutor;

    public ToolCallingAdvisor(PoolManager poolManager, SoloForgeTools soloForgeTools, RemoteToolExecutor remoteToolExecutor) {
        this.poolManager = poolManager;
        this.soloForgeTools = soloForgeTools;
        this.remoteToolExecutor = remoteToolExecutor;
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        ChatClientRequest currentRequest = request;
        ChatClientResponse response = null;
        int iteration = 0;

        while (iteration < MAX_TOOL_ITERATIONS) {
            iteration++;
            response = chain.nextCall(currentRequest);

            ChatResponse chatResponse = response.chatResponse();
            if (chatResponse == null) {
                return response;
            }

            List<org.springframework.ai.chat.messages.AssistantMessage.ToolCall> toolCalls = extractToolCalls(chatResponse);
            if (toolCalls.isEmpty()) {
                return response;
            }

            log.info("ToolCallingAdvisor: iteration={}, toolCalls={}", iteration, toolCalls.size());

            List<org.springframework.ai.chat.messages.Message> followUpMessages = new ArrayList<>();
            if (currentRequest.prompt() != null) {
                followUpMessages.addAll(currentRequest.prompt().getInstructions());
            }

            boolean hasBlocked = false;
            for (org.springframework.ai.chat.messages.AssistantMessage.ToolCall toolCall : toolCalls) {
                String toolName = toolCall.name();
                Map<String, Object> args = parseArgs(toolCall.arguments());

                if (!isToolAllowed(toolName, currentRequest)) {
                    log.warn("Tool blocked by permission mode: tool={}", toolName);
                    followUpMessages.add(new org.springframework.ai.chat.messages.AssistantMessage(
                            "Tool '" + toolName + "' is not allowed in current permission mode."));
                    hasBlocked = true;
                    continue;
                }

                String result;
                if (isBuiltInTool(toolName)) {
                    result = executeBuiltInTool(toolName, args);
                } else {
                    String dispatchId = currentRequest.context().get("dispatchId").toString();
                    int workerIdx = Integer.parseInt(currentRequest.context().get("workerIdx").toString());
                    result = remoteToolExecutor.execute(dispatchId, workerIdx, toolName, toolCall.arguments());
                }

                followUpMessages.add(org.springframework.ai.chat.messages.ToolResponseMessage.builder()
                        .responses(List.of(new org.springframework.ai.chat.messages.ToolResponseMessage.ToolResponse(toolCall.id(), toolCall.name(), result)))
                        .build());
            }

            if (hasBlocked) {
                return response;
            }

            currentRequest = new org.springframework.ai.chat.client.ChatClientRequest(
                    new org.springframework.ai.chat.prompt.Prompt(followUpMessages), currentRequest.context());
        }

        return response == null ? chain.nextCall(request) : response;
    }

    private List<org.springframework.ai.chat.messages.AssistantMessage.ToolCall> extractToolCalls(ChatResponse response) {
        if (response.getResult() == null || response.getResult().getOutput() == null) {
            return Collections.emptyList();
        }
        org.springframework.ai.chat.messages.Message output = response.getResult().getOutput();
        if (output instanceof org.springframework.ai.chat.messages.AssistantMessage assistantMessage) {
            return assistantMessage.getToolCalls();
        }
        return Collections.emptyList();
    }

    private Map<String, Object> parseArgs(String json) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().readValue(json, Map.class);
        } catch (Exception e) {
            return Map.of("raw", json);
        }
    }

    private boolean isBuiltInTool(String toolName) {
        return Set.of("read_file", "write_file", "list_files", "search_code", "execute_cmd", "canvas_push_ui").contains(toolName);
    }

    private boolean isToolAllowed(String toolName, ChatClientRequest request) {
        String permissionMode = request.context().getOrDefault("permissionMode", "normal").toString();
        if ("ultimate".equals(permissionMode) || "expert".equals(permissionMode)) {
            return true;
        }
        // Canvas tool is only available in ultimate/expert mode
        if ("canvas_push_ui".equals(toolName)) {
            return false;
        }
        // normal / performance: allow all built-in tools
        Set<String> builtInTools = Set.of("read_file", "write_file", "list_files", "search_code", "execute_cmd");
        if (builtInTools.contains(toolName)) {
            return true;
        }
        // Remote/MCP tools allowed in normal/performance
        return "normal".equals(permissionMode) || "performance".equals(permissionMode);
    }

    private String executeBuiltInTool(String toolName, Map<String, Object> args) {
        try {
            return switch (toolName) {
                case "read_file" -> soloForgeTools.readFile(String.valueOf(args.getOrDefault("path", "")));
                case "write_file" -> soloForgeTools.writeFile(String.valueOf(args.getOrDefault("path", "")), String.valueOf(args.getOrDefault("content", "")));
                case "list_files" -> soloForgeTools.listFiles(String.valueOf(args.getOrDefault("dirPath", ".")));
                case "search_code" -> soloForgeTools.searchCode(String.valueOf(args.getOrDefault("pattern", "")), String.valueOf(args.getOrDefault("fileGlob", "")));
                case "execute_cmd" -> soloForgeTools.executeCmd(String.valueOf(args.getOrDefault("command", "")));
                case "canvas_push_ui" -> soloForgeTools.canvasPushUi(String.valueOf(args.getOrDefault("sessionId", "")), String.valueOf(args.getOrDefault("dslJson", "{}")), String.valueOf(args.getOrDefault("language", "zh")));
                default -> "ERROR: Unknown built-in tool: " + toolName;
            };
        } catch (Exception e) {
            log.error("Built-in tool execution failed: tool={}", toolName, e);
            return "ERROR: " + e.getMessage();
        }
    }

    @Override
    public int getOrder() {
        return 4;
    }

    @Override
    public String getName() {
        return "ToolCallingAdvisor";
    }
}
