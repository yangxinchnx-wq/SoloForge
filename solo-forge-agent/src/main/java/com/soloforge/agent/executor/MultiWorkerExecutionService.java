package com.soloforge.agent.executor;

import com.soloforge.agent.advisor.*;
import com.soloforge.agent.config.DynamicChatModelResolver;
import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.pool.PoolManager;
import com.soloforge.agent.tools.RemoteToolExecutor;
import com.soloforge.agent.tools.SoloForgeTools;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.*;
import java.util.concurrent.*;
import java.util.stream.Collectors;

/**
 * Multi-worker parallel execution service.
 *
 * <p>Implementation notes:
 * <ul>
 *   <li>Launches N workers in parallel for a single dispatch</li>
 *   <li>Each worker runs its own Advisor chain + LLM calls</li>
 *   <li>Workers share the same MessagePool for context</li>
 *   <li>Reports progress via SSE (SseEmitter) directly to the HTTP client</li>
 *   <li>Handles worker stop/kill commands via WorkerStopRegistry</li>
 * </ul>
 *
 * <p>SSE event format (aligned with frontend aiBackend.ts):
 * <ul>
 *   <li>phase0_subtask / phase0_skip — task decomposition</li>
 *   <li>phase1_worker_start / text / phase1_worker_done / phase1_worker_error — worker execution</li>
 *   <li>phase3_deliver_start / phase3_deliver_done — delivery</li>
 *   <li>usage — token statistics</li>
 *   <li>done — stream completion</li>
 * </ul>
 */
@Component
public class MultiWorkerExecutionService {
    private static final Logger log = LoggerFactory.getLogger(MultiWorkerExecutionService.class);
    private static final int LLM_TIMEOUT_SECONDS = 120;

    private final ChatModel chatModel;
    private final SystemPromptAdvisor systemPromptAdvisor;
    private final PoolInjectAdvisor poolInjectAdvisor;
    private final RAGAdvisor ragAdvisor;
    private final PoolWriteAdvisor poolWriteAdvisor;
    private final SoloForgeTools soloForgeTools;
    private final RemoteToolExecutor remoteToolExecutor;
    private final PoolManager poolManager;
    private final WorkerStopRegistry workerStopRegistry;
    private final DynamicChatModelResolver chatModelResolver;
    private final com.soloforge.agent.tools.OpenAiStreamClient openAiStreamClient;

    public MultiWorkerExecutionService(ChatModel chatModel,
                                       SystemPromptAdvisor systemPromptAdvisor,
                                       PoolInjectAdvisor poolInjectAdvisor,
                                       RAGAdvisor ragAdvisor,
                                       PoolWriteAdvisor poolWriteAdvisor,
                                       SoloForgeTools soloForgeTools,
                                       RemoteToolExecutor remoteToolExecutor,
                                       PoolManager poolManager,
                                       WorkerStopRegistry workerStopRegistry,
                                       DynamicChatModelResolver chatModelResolver,
                                       com.soloforge.agent.tools.OpenAiStreamClient openAiStreamClient) {
        this.chatModel = chatModel;
        this.systemPromptAdvisor = systemPromptAdvisor;
        this.poolInjectAdvisor = poolInjectAdvisor;
        this.ragAdvisor = ragAdvisor;
        this.poolWriteAdvisor = poolWriteAdvisor;
        this.soloForgeTools = soloForgeTools;
        this.openAiStreamClient = openAiStreamClient;
        this.remoteToolExecutor = remoteToolExecutor;
        this.poolManager = poolManager;
        this.workerStopRegistry = workerStopRegistry;
        this.chatModelResolver = chatModelResolver;
    }

    public void executeDispatch(String dispatchId, String chatId, List<WorkerConfig> workers,
                                String prompt, List<Map<String, Object>> history,
                                Map<String, Object> settings, List<String> tools,
                                String permissionMode, SseEmitter emitter) {
        log.info("Starting dispatch: dispatchId={}, chatId={}, workers={}", dispatchId, chatId, workers.size());

        // ── Phase 0: Task decomposition ──
        if (workers.size() > 1) {
            // Multi-model: emit phase0_subtask with subtask list
            List<Map<String, Object>> subtasks = new ArrayList<>();
            for (WorkerConfig w : workers) {
                subtasks.add(Map.of(
                        "workerIdx", w.workerIdx(),
                        "modelName", w.provider().model() != null ? w.provider().model() : "unknown",
                        "agentId", w.agentId() != null ? w.agentId() : "agent-" + w.workerIdx(),
                        "taskDesc", "Worker " + w.workerIdx()
                ));
            }
            sendSsePhase(emitter, "phase0_subtask", chatId, Map.of("subtasks", subtasks));
        } else {
            // Single model: emit phase0_skip (direct inference mode)
            sendSsePhase(emitter, "phase0_skip", chatId, Map.of());
        }

        // RAG: retrieve once, share in pool (non-fatal)
        try {
            ragAdvisor.retrieveAndShare(chatId, prompt);
        } catch (Exception e) {
            log.warn("RAG retrieveAndShare threw (non-fatal): {}", e.getMessage());
        }

        // Execute workers in parallel
        ExecutorService executor = Executors.newFixedThreadPool(Math.min(workers.size(), 4));
        List<Future<?>> futures = new ArrayList<>();
        // Track token usage across all workers
        final AtomicTotalUsage totalUsage = new AtomicTotalUsage();

        try {
            for (WorkerConfig worker : workers) {
                Future<?> future = executor.submit(() ->
                        executeWorker(dispatchId, chatId, worker, prompt, history, settings, tools, permissionMode, emitter, totalUsage)
                );
                futures.add(future);
                workerStopRegistry.register(dispatchId, worker.workerIdx(), future);
            }

            // Wait for all workers to complete
            for (int i = 0; i < futures.size(); i++) {
                WorkerConfig worker = workers.get(i);
                int workerIdx = worker.workerIdx();
                Future<?> future = futures.get(i);
                try {
                    future.get(LLM_TIMEOUT_SECONDS + 10, TimeUnit.SECONDS);
                } catch (TimeoutException e) {
                    log.error("Worker {} (idx={}) timed out, cancelling", i, workerIdx, e);
                    future.cancel(true);
                    try {
                        poolManager.get(chatId).getWorkerState(workerIdx).setStatus("TIMEOUT");
                    } catch (Exception inner) {
                        log.warn("Failed to mark worker {} as TIMEOUT: {}", workerIdx, inner.getMessage());
                    }
                    sendSsePhase(emitter, "phase1_worker_error", chatId, Map.of(
                            "workerIdx", workerIdx, "error", "TIMEOUT"));
                } catch (Exception e) {
                    log.error("Worker {} (idx={}) failed", i, workerIdx, e);
                    try {
                        poolManager.get(chatId).getWorkerState(workerIdx).setStatus("FAILED");
                    } catch (Exception inner) {
                        log.warn("Failed to mark worker {} as FAILED: {}", workerIdx, inner.getMessage());
                    }
                    if (!(e.getCause() instanceof Exception)) {
                        sendSsePhase(emitter, "phase1_worker_error", chatId, Map.of(
                                "workerIdx", workerIdx, "error", e.getMessage()));
                    }
                }
            }

            // ── Phase 3: Delivery ──
            sendSsePhase(emitter, "phase3_deliver_start", chatId, Map.of());

            // Collect best output from pool (worker 0 is primary)
            String bestOutput = "";
            try {
                var pool = poolManager.get(chatId);
                for (WorkerConfig w : workers) {
                    String output = pool.getWorkerState(w.workerIdx()).getLastOutput();
                    if (output != null && !output.isEmpty()) {
                        bestOutput = output;
                        break;
                    }
                }
            } catch (Exception e) {
                log.warn("Failed to collect best output: {}", e.getMessage());
            }

            // If no output collected from pool, use first worker's output directly
            if (bestOutput.isEmpty()) {
                log.warn("No output collected from pool, dispatching without delivery content");
            }

            sendSsePhase(emitter, "phase3_deliver_done", chatId, Map.of(
                    "content", bestOutput));

            // ── Usage event ──
            if (totalUsage.promptTokens > 0 || totalUsage.completionTokens > 0) {
                sendSseEvent(emitter, "usage", Map.of(
                        "promptTokens", totalUsage.promptTokens,
                        "completionTokens", totalUsage.completionTokens,
                        "totalTokens", totalUsage.totalTokens
                ));
            }

            // ── Done event ──
            String primaryAgentId = workers.get(0).agentId();
            sendSseEvent(emitter, "done", Map.of("agentId", primaryAgentId));

            log.info("Dispatch completed: dispatchId={}", dispatchId);
        } finally {
            workerStopRegistry.cleanup(dispatchId);
            executor.shutdownNow();
            try {
                if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                    log.warn("Dispatch executor did not terminate cleanly: dispatchId={}", dispatchId);
                }
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            }
            // Complete the SSE emitter
            try {
                emitter.complete();
            } catch (Exception e) {
                log.debug("Emitter already completed: {}", e.getMessage());
            }
        }
    }

    private void executeWorker(String dispatchId, String chatId, WorkerConfig worker,
                               String prompt, List<Map<String, Object>> history,
                               Map<String, Object> settings, List<String> tools,
                               String permissionMode, SseEmitter emitter, AtomicTotalUsage totalUsage) {
        int workerIdx = worker.workerIdx();
        String agentId = worker.agentId();
        log.info("Starting worker: dispatchId={}, workerIdx={}, agentId={}", dispatchId, workerIdx, agentId);

        // Initialize worker state
        com.soloforge.agent.pool.MessagePool pool = poolManager.getOrCreate(chatId);
        pool.getWorkerState(workerIdx).setStatus("RUNNING");

        // ── Phase 1: Worker start ──
        sendSsePhase(emitter, "phase1_worker_start", chatId, Map.of(
                "workerIdx", workerIdx,
                "agentId", agentId,
                "modelName", worker.provider().model() != null ? worker.provider().model() : "unknown"
        ));

        try {
            // Build system prompt
            Map<String, Object> context = new HashMap<>();
            context.put("identity", agentId);
            context.put("personality", settings.getOrDefault("personality", "You are a helpful assistant."));
            context.put("tone", settings.getOrDefault("tone", "professional"));
            context.put("emojiMode", settings.getOrDefault("emojiMode", false));
            context.put("capabilities", settings.getOrDefault("capabilities", List.of("read", "write", "search")));
            String workspaceFolder = (String) settings.get("workspaceFolder");
            if (workspaceFolder == null || workspaceFolder.isBlank()) workspaceFolder = ".";
            context.put("workspaceFolder", workspaceFolder);
            context.put("toolsDescription", buildToolsDescription(tools, permissionMode));
            // 前端 buildJavaRequestBody 发送 enabledSkills/enabledKnowledge
            context.put("activeSkills", settings.getOrDefault("enabledSkills", settings.getOrDefault("activeSkills", List.of())));
            context.put("activeKnowledge", settings.getOrDefault("enabledKnowledge", settings.getOrDefault("activeKnowledge", List.of())));
            context.put("permissionMode", permissionMode);
            context.put("canvasContext", settings.getOrDefault("canvasContext", ""));
            context.put("provider", worker.provider().name());
            context.put("model", worker.provider().model());

            String systemPrompt = systemPromptAdvisor.buildSystemPrompt(context);

            // Build message list
            List<Message> messages = new ArrayList<>();
            messages.add(new SystemMessage(systemPrompt));

            // Add history (前端发送 {sender, content} 格式)
            if (history != null) {
                for (Map<String, Object> turn : history) {
                    // 兼容 sender (前端) 和 role (旧格式) 两种字段名
                    String role = (String) turn.get("sender");
                    if (role == null) role = (String) turn.get("role");
                    String content = (String) turn.get("content");
                    if (content == null) content = (String) turn.get("text");
                    if (content == null) continue;
                    if ("user".equals(role)) {
                        messages.add(new UserMessage(content));
                    } else if ("assistant".equals(role)) {
                        messages.add(new org.springframework.ai.chat.messages.AssistantMessage(content));
                    }
                }
            }

            // Add current prompt
            messages.add(new UserMessage(prompt));

            // Inject pool context from other workers
            String poolContext = poolInjectAdvisor.injectPoolContext(chatId, workerIdx);
            if (!poolContext.isEmpty()) {
                messages.add(new UserMessage(poolContext));
            }

            // Create prompt
            Prompt springPrompt = new Prompt(messages);

            // Resolve dynamic ChatModel based on worker.provider
            ChatModel effectiveChatModel = chatModel;
            String providerName = worker.provider().name();
            String providerBaseUrl = worker.provider().baseUrl();
            String providerApiKey = worker.provider().apiKey();
            String providerModel = worker.provider().model();
            if (providerBaseUrl != null && !providerBaseUrl.isEmpty()
                    && providerApiKey != null && !providerApiKey.isEmpty()
                    && providerModel != null && !providerModel.isEmpty()) {
                try {
                    ChatRequest.LlmProvider llmProvider = new ChatRequest.LlmProvider();
                    llmProvider.setName(providerName);
                    llmProvider.setBaseUrl(providerBaseUrl);
                    llmProvider.setApiKey(providerApiKey);
                    llmProvider.setModel(providerModel);
                    effectiveChatModel = chatModelResolver.resolve(llmProvider);
                    log.info("Worker {} using dynamic ChatModel: provider={} baseUrl={} model={}",
                            workerIdx, providerName, providerBaseUrl, providerModel);
                } catch (Exception e) {
                    log.warn("Failed to resolve dynamic ChatModel for worker {}, falling back to default: {}",
                            workerIdx, e.getMessage());
                }
            }

            // Call LLM
            String providerNameLower = providerName == null ? "" : providerName.toLowerCase();
            boolean isAnthropic = providerNameLower.contains("anthropic") || providerNameLower.contains("claude");
            boolean hasOpenAiConfig = providerBaseUrl != null && !providerBaseUrl.isEmpty()
                    && providerApiKey != null && !providerApiKey.isEmpty()
                    && providerModel != null && !providerModel.isEmpty();

            String output;
            if (!isAnthropic && hasOpenAiConfig) {
                // OpenAI-compatible streaming via OpenAiStreamClient (with tool-calling loop)
                List<Map<String, Object>> openaiMessages = new ArrayList<>();
                openaiMessages.add(Map.of("role", "system", "content", systemPrompt));
                if (history != null) {
                    for (Map<String, Object> turn : history) {
                        String role = (String) turn.get("sender");
                        if (role == null) role = (String) turn.get("role");
                        String content = (String) turn.get("content");
                        if (content == null) content = (String) turn.get("text");
                        if ("user".equals(role) || "assistant".equals(role)) {
                            openaiMessages.add(Map.of("role", role, "content", content == null ? "" : content));
                        }
                    }
                }
                openaiMessages.add(Map.of("role", "user", "content", prompt));
                if (!poolContext.isEmpty()) {
                    openaiMessages.add(Map.of("role", "user", "content", poolContext));
                }

                // Build OpenAI tool schemas for allowed tools
                List<Map<String, Object>> toolSchemas = buildOpenAiToolSchemas(tools, permissionMode);

                log.info("Worker {} using OpenAiStreamClient: provider={} model={} tools={}",
                        workerIdx, providerName, providerModel, toolSchemas.size());

                // Tool-calling loop: up to MAX_TOOL_ROUNDS iterations
                output = "";
                int toolRounds = 0;
                while (true) {
                    com.soloforge.agent.tools.OpenAiStreamClient.StreamResult sr = openAiStreamClient.streamChat(
                            providerBaseUrl, providerApiKey, providerModel,
                            openaiMessages, toolSchemas, 0.3, null,
                            delta -> sendSseText(emitter, delta)
                    );
                    output += sr.fullContent();
                    log.info("Worker {} stream done: finishReason={}, outputLen={}, toolCalls={}",
                            workerIdx, sr.finishReason(), output.length(), sr.toolCalls().size());

                    // If no tool calls, we're done
                    if (sr.toolCalls().isEmpty() || !"tool_calls".equals(sr.finishReason())) {
                        break;
                    }

                    toolRounds++;
                    if (toolRounds > 5) {
                        log.warn("Worker {} reached max tool rounds (5), stopping", workerIdx);
                        break;
                    }

                    // Add assistant message with tool calls to the conversation
                    List<Map<String, Object>> toolCallMsgs = new ArrayList<>();
                    for (var tc : sr.toolCalls()) {
                        toolCallMsgs.add(Map.of(
                                "id", tc.id(),
                                "type", "function",
                                "function", Map.of(
                                        "name", tc.name(),
                                        "arguments", tc.arguments()
                                )
                        ));
                    }
                    Map<String, Object> assistantMsg = new LinkedHashMap<>();
                    assistantMsg.put("role", "assistant");
                    assistantMsg.put("content", sr.fullContent() != null ? sr.fullContent() : "");
                    assistantMsg.put("tool_calls", toolCallMsgs);
                    openaiMessages.add(assistantMsg);

                    // Execute each tool call and add results to conversation
                    for (var tc : sr.toolCalls()) {
                        // Emit tool_started SSE event
                        sendSsePhase(emitter, "phase1_tool_start", chatId, Map.of(
                                "workerIdx", workerIdx,
                                "toolName", tc.name(),
                                "toolArgs", tc.arguments()
                        ));

                        String toolResult = executeToolCall(tc.name(), tc.arguments(), dispatchId, workerIdx, settings);
                        log.info("Worker {} tool result: tool={}, resultLen={}", workerIdx, tc.name(),
                                toolResult != null ? toolResult.length() : 0);

                        // Add tool result message to conversation
                        openaiMessages.add(Map.of(
                                "role", "tool",
                                "tool_call_id", tc.id(),
                                "content", toolResult != null ? toolResult : "(no result)"
                        ));

                        // Emit tool_done SSE event
                        sendSsePhase(emitter, "phase1_tool_done", chatId, Map.of(
                                "workerIdx", workerIdx,
                                "toolName", tc.name(),
                                "result", toolResult != null ? toolResult.substring(0, Math.min(toolResult.length(), 500)) : ""
                        ));
                    }
                    // Loop continues: LLM will be called again with tool results
                }
            } else {
                // Anthropic or fallback: use Spring AI non-streaming call()
                log.info("Worker {} using Spring AI call(): provider={}", workerIdx, providerName);
                ChatResponse response = effectiveChatModel.call(springPrompt);
                if (Thread.currentThread().isInterrupted()) {
                    throw new RuntimeException("Interrupted");
                }
                output = "";
                if (response.getResult() != null && response.getResult().getOutput() != null) {
                    output = response.getResult().getOutput().getText();
                }
                if (output == null) output = "";
                if (!output.isEmpty()) {
                    sendSseText(emitter, output);
                }
                // Track usage from response metadata
                if (response.getMetadata() != null && response.getMetadata().getUsage() != null) {
                    var usage = response.getMetadata().getUsage();
                    long pt = toLong(usage.getPromptTokens());
                    long ct = toLong(usage.getCompletionTokens());
                    totalUsage.add(pt, ct);
                }
            }

            // Report progress
            pool.getWorkerState(workerIdx).setProgress(100);
            pool.getWorkerState(workerIdx).setStatus("DONE");
            pool.getWorkerState(workerIdx).setLastOutput(output);

            // Write to pool
            poolWriteAdvisor.writeOutput(chatId, workerIdx, agentId, output);

            // ── Phase 1: Worker done ──
            sendSsePhase(emitter, "phase1_worker_done", chatId, Map.of(
                    "workerIdx", workerIdx,
                    "content", output
            ));

            log.info("Worker {} completed: dispatchId={}, outputLength={}", workerIdx, dispatchId, output.length());

        } catch (Exception e) {
            if (Thread.currentThread().isInterrupted()) {
                log.info("Worker {} stopped by judge command: dispatchId={}", workerIdx, dispatchId);
                pool.getWorkerState(workerIdx).setStatus("STOPPED");
                sendSsePhase(emitter, "phase1_worker_error", chatId, Map.of(
                        "workerIdx", workerIdx, "error", "STOPPED"));
            } else {
                log.error("Worker {} error", workerIdx, e);
                pool.getWorkerState(workerIdx).setStatus("FAILED");
                sendSsePhase(emitter, "phase1_worker_error", chatId, Map.of(
                        "workerIdx", workerIdx, "error", e.getMessage() != null ? e.getMessage() : "Unknown error"));
            }
        }
    }

    private String buildToolsDescription(List<String> tools, String permissionMode) {
        if (tools == null || tools.isEmpty()) {
            return "No tools available.";
        }

        StringBuilder desc = new StringBuilder("Available tools:\n");

        for (String toolId : tools) {
            if (!isToolAllowed(toolId, permissionMode)) {
                continue;
            }

            desc.append("- ").append(toolId).append("\n");
        }

        return desc.toString();
    }

    private boolean isToolAllowed(String toolId, String permissionMode) {
        if ("ultimate".equals(permissionMode) || "expert".equals(permissionMode)) {
            return true;
        }

        // Canvas tool is only available in ultimate/expert mode
        if ("canvas_push_ui".equals(toolId)) {
            return "ultimate".equals(permissionMode) || "expert".equals(permissionMode);
        }

        // normal / performance: allow all built-in tools (read_file, write_file,
        // execute_cmd, list_files, search_code) — they are essential for the agent
        // to actually do work. Remote/MCP tools are also allowed in performance.
        Set<String> builtInTools = Set.of(
                "read_file", "write_file", "list_files", "search_code", "execute_cmd"
        );
        if (builtInTools.contains(toolId)) {
            return true;
        }

        // For remote/MCP tools, allow in normal and performance modes
        // (they were already filtered by the frontend before being sent)
        return "normal".equals(permissionMode) || "performance".equals(permissionMode);
    }

    /**
     * Build OpenAI-compatible tool schemas from the enabled tools list.
     * Only includes tools that are allowed by the permission mode.
     */
    private List<Map<String, Object>> buildOpenAiToolSchemas(List<String> tools, String permissionMode) {
        if (tools == null || tools.isEmpty()) {
            return List.of();
        }

        List<Map<String, Object>> schemas = new ArrayList<>();
        for (String toolId : tools) {
            if (!isToolAllowed(toolId, permissionMode)) {
                continue;
            }
            Map<String, Object> schema = buildSingleToolSchema(toolId);
            if (schema != null) {
                schemas.add(schema);
            }
        }
        return schemas;
    }

    /**
     * Build a single tool schema in OpenAI function-calling format.
     */
    private Map<String, Object> buildSingleToolSchema(String toolId) {
        return switch (toolId) {
            case "read_file" -> Map.of(
                    "type", "function",
                    "function", Map.of(
                            "name", "read_file",
                            "description", "Read the content of a file at the given path.",
                            "parameters", Map.of(
                                    "type", "object",
                                    "properties", Map.of(
                                            "path", Map.of("type", "string", "description", "Absolute or relative file path")
                                    ),
                                    "required", List.of("path")
                            )
                    )
            );
            case "write_file" -> Map.of(
                    "type", "function",
                    "function", Map.of(
                            "name", "write_file",
                            "description", "Write content to a file at the given path. Creates parent directories if needed.",
                            "parameters", Map.of(
                                    "type", "object",
                                    "properties", Map.of(
                                            "path", Map.of("type", "string", "description", "Absolute or relative file path"),
                                            "content", Map.of("type", "string", "description", "Content to write")
                                    ),
                                    "required", List.of("path", "content")
                            )
                    )
            );
            case "list_files" -> Map.of(
                    "type", "function",
                    "function", Map.of(
                            "name", "list_files",
                            "description", "List files and directories in the given path.",
                            "parameters", Map.of(
                                    "type", "object",
                                    "properties", Map.of(
                                            "dirPath", Map.of("type", "string", "description", "Directory path to list")
                                    ),
                                    "required", List.of("dirPath")
                            )
                    )
            );
            case "search_code" -> Map.of(
                    "type", "function",
                    "function", Map.of(
                            "name", "search_code",
                            "description", "Search for a text pattern in files under the current directory.",
                            "parameters", Map.of(
                                    "type", "object",
                                    "properties", Map.of(
                                            "pattern", Map.of("type", "string", "description", "Text pattern to search"),
                                            "fileGlob", Map.of("type", "string", "description", "Optional file name glob filter (e.g. *.java)")
                                    ),
                                    "required", List.of("pattern")
                            )
                    )
            );
            case "execute_cmd" -> Map.of(
                    "type", "function",
                    "function", Map.of(
                            "name", "execute_cmd",
                            "description", "Execute a shell command and return stdout+stderr.",
                            "parameters", Map.of(
                                    "type", "object",
                                    "properties", Map.of(
                                            "command", Map.of("type", "string", "description", "Shell command to execute")
                                    ),
                                    "required", List.of("command")
                            )
                    )
            );
            case "canvas_push_ui" -> Map.of(
                    "type", "function",
                    "function", Map.of(
                            "name", "canvas_push_ui",
                            "description", "Push a UI component (DSL) to the frontend canvas for live preview.",
                            "parameters", Map.of(
                                    "type", "object",
                                    "properties", Map.of(
                                            "sessionId", Map.of("type", "string", "description", "Canvas session ID"),
                                            "dslJson", Map.of("type", "string", "description", "UI DSL as JSON string"),
                                            "language", Map.of("type", "string", "description", "Target language (html/react/vue/flutter)")
                                    ),
                                    "required", List.of("sessionId", "dslJson", "language")
                            )
                    )
            );
            // Remote/MCP tools: generic schema (frontend provides the actual implementation)
            default -> Map.of(
                    "type", "function",
                    "function", Map.of(
                            "name", toolId,
                            "description", "Remote tool: " + toolId,
                            "parameters", Map.of(
                                    "type", "object",
                                    "properties", Map.of()
                            )
                    )
            );
        };
    }

    /**
     * Execute a single tool call.
     * Built-in tools are executed directly via SoloForgeTools.
     * Remote/MCP tools are delegated to RemoteToolExecutor (frontend callback).
     */
    private String executeToolCall(String toolName, String argumentsJson,
                                    String dispatchId, int workerIdx,
                                    Map<String, Object> settings) {
        try {
            com.fasterxml.jackson.databind.JsonNode args =
                    new com.fasterxml.jackson.databind.ObjectMapper().readTree(argumentsJson);

            // Determine workspace folder for relative paths
            String workspaceFolder = (String) settings.get("workspaceFolder");
            if (workspaceFolder == null || workspaceFolder.isBlank()) workspaceFolder = ".";

            return switch (toolName) {
                case "read_file" -> {
                    String path = resolvePath(args.path("path").asText(), workspaceFolder);
                    yield soloForgeTools.readFile(path);
                }
                case "write_file" -> {
                    String path = resolvePath(args.path("path").asText(), workspaceFolder);
                    String content = args.path("content").asText();
                    yield soloForgeTools.writeFile(path, content);
                }
                case "list_files" -> {
                    String dirPath = resolvePath(args.path("dirPath").asText(), workspaceFolder);
                    yield soloForgeTools.listFiles(dirPath);
                }
                case "search_code" -> {
                    String pattern = args.path("pattern").asText();
                    String fileGlob = args.has("fileGlob") ? args.path("fileGlob").asText() : null;
                    yield soloForgeTools.searchCode(pattern, fileGlob);
                }
                case "execute_cmd" -> {
                    String command = args.path("command").asText();
                    yield soloForgeTools.executeCmd(command);
                }
                case "canvas_push_ui" -> {
                    String sessionId = args.path("sessionId").asText();
                    String dslJson = args.path("dslJson").asText();
                    String language = args.path("language").asText("html");
                    yield soloForgeTools.canvasPushUi(sessionId, dslJson, language);
                }
                // Remote/MCP tool: delegate to RemoteToolExecutor (frontend callback)
                default -> {
                    log.info("Executing remote tool: name={}, dispatchId={}, workerIdx={}", toolName, dispatchId, workerIdx);
                    yield remoteToolExecutor.execute(dispatchId, workerIdx, toolName, argumentsJson);
                }
            };
        } catch (Exception e) {
            log.error("Tool execution failed: tool={}, error={}", toolName, e.getMessage(), e);
            return "ERROR: " + e.getMessage();
        }
    }

    /** Resolve a path relative to the workspace folder if not absolute. */
    private String resolvePath(String path, String workspaceFolder) {
        if (path == null || path.isEmpty()) return path;
        java.nio.file.Path p = java.nio.file.Path.of(path);
        if (p.isAbsolute()) return path;
        return java.nio.file.Path.of(workspaceFolder).resolve(path).toString();
    }

    // ==================== SSE Event Helpers ====================

    /**
     * Send a phase event via SSE.
     * Format: event:phase\ndata:{"phase":"phase1_worker_start","chatId":"...","workerIdx":0,...}
     */
    private void sendSsePhase(SseEmitter emitter, String phase, String chatId, Map<String, Object> extra) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("phase", phase);
        data.put("chatId", chatId);
        data.putAll(extra);
        sendSseEvent(emitter, "phase", data);
    }

    /**
     * Send a text delta event via SSE.
     * Format: event:text\ndata:{"content":"Hello "}
     */
    private void sendSseText(SseEmitter emitter, String text) {
        if (text == null || text.isEmpty()) return;
        sendSseEvent(emitter, "text", Map.of("content", text));
    }

    /**
     * Send a generic SSE event.
     */
    private void sendSseEvent(SseEmitter emitter, String eventName, Object data) {
        try {
            emitter.send(SseEmitter.event()
                    .name(eventName)
                    .data(data));
        } catch (Exception e) {
            log.debug("Failed to send SSE event '{}': {}", eventName, e.getMessage());
        }
    }

    private long toLong(Object value) {
        if (value instanceof Number n) return n.longValue();
        if (value instanceof String s) {
            try { return Long.parseLong(s); } catch (NumberFormatException e) { return 0L; }
        }
        return 0L;
    }

    // ==================== Atomic token usage accumulator ====================

    private static class AtomicTotalUsage {
        private long promptTokens = 0;
        private long completionTokens = 0;
        private long totalTokens = 0;

        synchronized void add(long prompt, long completion) {
            this.promptTokens += prompt;
            this.completionTokens += completion;
            this.totalTokens += prompt + completion;
        }
    }
}
