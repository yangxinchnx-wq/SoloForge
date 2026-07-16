package com.soloforge.agent.executor;

import com.soloforge.agent.advisor.*;
import com.soloforge.agent.config.DynamicChatModelResolver;
import com.soloforge.agent.dto.ChatRequest;
import com.soloforge.agent.pool.PoolManager;
import com.soloforge.agent.tools.RemoteToolExecutor;
import com.soloforge.agent.tools.SoloForgeTools;
import com.soloforge.agent.transport.RacerTcpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

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
 *   <li>Reports progress via TCP to RACER</li>
 *   <li>Handles worker stop/kill commands from RACER</li>
 * </ul>
 */
@Component
public class MultiWorkerExecutionService {
    private static final Logger log = LoggerFactory.getLogger(MultiWorkerExecutionService.class);
    private static final int LLM_TIMEOUT_SECONDS = 40;
    private static final int TOOL_TIMEOUT_SECONDS = 20;

    private final ChatModel chatModel;
    private final SystemPromptAdvisor systemPromptAdvisor;
    private final ContextEnrichmentAdvisor contextEnrichmentAdvisor;
    private final PoolInjectAdvisor poolInjectAdvisor;
    private final RAGAdvisor ragAdvisor;
    private final ConsistencyCheckAdvisor consistencyCheckAdvisor;
    private final ToolCallingAdvisor toolCallingAdvisor;
    private final PoolWriteAdvisor poolWriteAdvisor;
    private final RateLimitAdvisor rateLimitAdvisor;
    private final AuditAdvisor auditAdvisor;
    private final OutputProcessAdvisor outputProcessAdvisor;
    private final SoloForgeTools soloForgeTools;
    private final RemoteToolExecutor remoteToolExecutor;
    private final PoolManager poolManager;
    private final RacerTcpClient tcpClient;
    private final WorkerStopRegistry workerStopRegistry;
    private final DynamicChatModelResolver chatModelResolver;
    private final com.soloforge.agent.tools.OpenAiStreamClient openAiStreamClient;

    public MultiWorkerExecutionService(ChatModel chatModel,
                                       SystemPromptAdvisor systemPromptAdvisor,
                                       ContextEnrichmentAdvisor contextEnrichmentAdvisor,
                                       PoolInjectAdvisor poolInjectAdvisor,
                                       RAGAdvisor ragAdvisor,
                                       ConsistencyCheckAdvisor consistencyCheckAdvisor,
                                       ToolCallingAdvisor toolCallingAdvisor,
                                       PoolWriteAdvisor poolWriteAdvisor,
                                       RateLimitAdvisor rateLimitAdvisor,
                                       AuditAdvisor auditAdvisor,
                                       OutputProcessAdvisor outputProcessAdvisor,
                                       SoloForgeTools soloForgeTools,
                                       RemoteToolExecutor remoteToolExecutor,
                                       PoolManager poolManager,
                                       RacerTcpClient tcpClient,
                                       WorkerStopRegistry workerStopRegistry,
                                       DynamicChatModelResolver chatModelResolver,
                                       com.soloforge.agent.tools.OpenAiStreamClient openAiStreamClient) {
        this.chatModel = chatModel;
        this.systemPromptAdvisor = systemPromptAdvisor;
        this.contextEnrichmentAdvisor = contextEnrichmentAdvisor;
        this.poolInjectAdvisor = poolInjectAdvisor;
        this.ragAdvisor = ragAdvisor;
        this.consistencyCheckAdvisor = consistencyCheckAdvisor;
        this.toolCallingAdvisor = toolCallingAdvisor;
        this.poolWriteAdvisor = poolWriteAdvisor;
        this.rateLimitAdvisor = rateLimitAdvisor;
        this.auditAdvisor = auditAdvisor;
        this.outputProcessAdvisor = outputProcessAdvisor;
        this.soloForgeTools = soloForgeTools;
        this.openAiStreamClient = openAiStreamClient;
        this.remoteToolExecutor = remoteToolExecutor;
        this.poolManager = poolManager;
        this.tcpClient = tcpClient;
        this.workerStopRegistry = workerStopRegistry;
        this.chatModelResolver = chatModelResolver;
    }

    public void executeDispatch(String dispatchId, String chatId, List<WorkerConfig> workers,
                                String prompt, List<Map<String, Object>> history,
                                Map<String, Object> settings, List<Map<String, Object>> tools,
                                String permissionMode) {
        log.info("Starting dispatch: dispatchId={}, chatId={}, workers={}", dispatchId, chatId, workers.size());

        // RAG: retrieve once, share in pool (non-fatal, fire-and-forget on a separate thread
        // so a slow DB doesn't delay dispatch start)
        try {
            ragAdvisor.retrieveAndShare(chatId, prompt);
        } catch (Exception e) {
            log.warn("RAG retrieveAndShare threw (non-fatal): {}", e.getMessage());
        }

        // Execute workers in parallel
        ExecutorService executor = Executors.newFixedThreadPool(Math.min(workers.size(), 4));
        List<Future<?>> futures = new ArrayList<>();

        try {
            for (WorkerConfig worker : workers) {
                Future<?> future = executor.submit(() ->
                        executeWorker(dispatchId, chatId, worker, prompt, history, settings, tools, permissionMode)
                );
                futures.add(future);
                workerStopRegistry.register(dispatchId, worker.workerIdx(), future);
            }

            // Wait for all workers to complete; use the worker's real workerIdx for any
            // timeout/failure event (not the list index `i`).
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
                    sendWorkerFailed(dispatchId, workerIdx, "TIMEOUT");
                } catch (Exception e) {
                    log.error("Worker {} (idx={}) failed", i, workerIdx, e);
                    try {
                        poolManager.get(chatId).getWorkerState(workerIdx).setStatus("FAILED");
                    } catch (Exception inner) {
                        log.warn("Failed to mark worker {} as FAILED: {}", workerIdx, inner.getMessage());
                    }
                    // executeWorker already sent worker_failed on its own exception path;
                    // only send here if the future itself threw (rare).
                    if (!(e.getCause() instanceof Exception)) {
                        sendWorkerFailed(dispatchId, workerIdx, e.getMessage());
                    }
                }
            }

            sendDispatchDone(dispatchId);
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
        }
    }

    private void executeWorker(String dispatchId, String chatId, WorkerConfig worker,
                               String prompt, List<Map<String, Object>> history,
                               Map<String, Object> settings, List<Map<String, Object>> tools,
                               String permissionMode) {
        int workerIdx = worker.workerIdx();
        String agentId = worker.agentId();
        log.info("Starting worker: dispatchId={}, workerIdx={}, agentId={}", dispatchId, workerIdx, agentId);

        // Initialize worker state
        com.soloforge.agent.pool.MessagePool pool = poolManager.getOrCreate(chatId);
        pool.getWorkerState(workerIdx).setStatus("RUNNING");
        sendWorkerStarted(dispatchId, workerIdx, agentId);

        try {
            // Build system prompt
            Map<String, Object> context = new HashMap<>();
            context.put("identity", agentId);
            context.put("personality", settings.getOrDefault("personality", "You are a helpful assistant."));
            context.put("tone", settings.getOrDefault("tone", "professional"));
            context.put("emojiMode", settings.getOrDefault("emojiMode", false));
            context.put("capabilities", settings.getOrDefault("capabilities", List.of("read", "write", "search")));
            context.put("workspaceFolder", settings.getOrDefault("workspaceFolder", "."));
            context.put("toolsDescription", buildToolsDescription(tools, permissionMode));
            context.put("activeSkills", settings.getOrDefault("activeSkills", List.of()));
            context.put("activeKnowledge", settings.getOrDefault("activeKnowledge", List.of()));
            context.put("permissionMode", permissionMode);
            context.put("canvasContext", settings.getOrDefault("canvasContext", ""));
            context.put("provider", worker.provider().name());
            context.put("model", worker.provider().model());

            String systemPrompt = systemPromptAdvisor.buildSystemPrompt(context);

            // Build message list
            List<Message> messages = new ArrayList<>();
            messages.add(new SystemMessage(systemPrompt));

            // Add history
            if (history != null) {
                for (Map<String, Object> turn : history) {
                    String role = (String) turn.get("role");
                    String content = (String) turn.get("content");
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

            // 根据 worker.provider 动态解析 ChatModel (支持多 provider 路由)
            // 如果 worker.provider 没有完整配置 (baseUrl/apiKey/model), 回退到默认 chatModel
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

            // Call LLM.
            // OpenAI-compatible providers (MiMo / DeepSeek / GLM / Qwen / Moonshot / real OpenAI)
            // go through OpenAiStreamClient which directly parses the SSE stream and only
            // extracts the standard `delta.content` field — this avoids Spring AI's stream()
            // hanging on providers that put reasoning tokens in the non-standard
            // `delta.reasoning_content` field (where `delta.content` is null during reasoning).
            // Anthropic Claude uses Spring AI call() (non-streaming) since its SSE format differs.
            String providerNameLower = providerName == null ? "" : providerName.toLowerCase();
            boolean isAnthropic = providerNameLower.contains("anthropic") || providerNameLower.contains("claude");
            boolean hasOpenAiConfig = providerBaseUrl != null && !providerBaseUrl.isEmpty()
                    && providerApiKey != null && !providerApiKey.isEmpty()
                    && providerModel != null && !providerModel.isEmpty();

            String output;
            if (!isAnthropic && hasOpenAiConfig) {
                // Build messages list for OpenAI format
                List<Map<String, Object>> openaiMessages = new ArrayList<>();
                openaiMessages.add(Map.of("role", "system", "content", systemPrompt));
                if (history != null) {
                    for (Map<String, Object> turn : history) {
                        String role = (String) turn.get("role");
                        String content = (String) turn.get("content");
                        if ("user".equals(role) || "assistant".equals(role)) {
                            openaiMessages.add(Map.of("role", role, "content", content == null ? "" : content));
                        }
                    }
                }
                openaiMessages.add(Map.of("role", "user", "content", prompt));
                if (!poolContext.isEmpty()) {
                    openaiMessages.add(Map.of("role", "user", "content", poolContext));
                }

                log.info("Worker {} using OpenAiStreamClient: provider={} model={}", workerIdx, providerName, providerModel);
                com.soloforge.agent.tools.OpenAiStreamClient.StreamResult sr = openAiStreamClient.streamChat(
                        providerBaseUrl, providerApiKey, providerModel,
                        openaiMessages, null, 0.3, null,
                        delta -> sendWorkerChunk(dispatchId, workerIdx, delta)
                );
                output = sr.fullContent();
                log.info("Worker {} stream done: finishReason={}, outputLen={}", workerIdx, sr.finishReason(), output.length());
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
                    sendWorkerChunk(dispatchId, workerIdx, output);
                }
            }

            // Report progress
            pool.getWorkerState(workerIdx).setProgress(100);
            pool.getWorkerState(workerIdx).setStatus("DONE");
            pool.getWorkerState(workerIdx).setLastOutput(output);

            // Write to pool
            poolWriteAdvisor.writeOutput(chatId, workerIdx, agentId, output);

            // Send events
            sendWorkerDone(dispatchId, workerIdx, output);

            log.info("Worker {} completed: dispatchId={}, outputLength={}", workerIdx, dispatchId, output.length());

        } catch (Exception e) {
            if (Thread.currentThread().isInterrupted()) {
                log.info("Worker {} stopped by judge command: dispatchId={}", workerIdx, dispatchId);
                pool.getWorkerState(workerIdx).setStatus("STOPPED");
                sendWorkerFailed(dispatchId, workerIdx, "STOPPED");
            } else {
                log.error("Worker {} error", workerIdx, e);
                pool.getWorkerState(workerIdx).setStatus("FAILED");
                sendWorkerFailed(dispatchId, workerIdx, e.getMessage());
            }
        }
    }

    private String buildToolsDescription(List<Map<String, Object>> tools, String permissionMode) {
        if (tools == null || tools.isEmpty()) {
            return "No tools available.";
        }

        StringBuilder desc = new StringBuilder("Available tools:\n");

        for (Map<String, Object> tool : tools) {
            String id = (String) tool.get("id");
            String description = (String) tool.get("description");

            // Permission mode filtering
            if (!isToolAllowed(id, permissionMode)) {
                continue;
            }

            desc.append("- ").append(id).append(": ").append(description).append("\n");
        }

        return desc.toString();
    }

    private boolean isToolAllowed(String toolId, String permissionMode) {
        // Tool safety based on permission mode (document §17.4)
        if ("ultimate".equals(permissionMode)) {
            return true; // no restrictions
        }

        // Blacklist for all modes except ultimate
        Set<String> blacklist = Set.of(
                "execute_cmd", // dangerous commands filtered at execution time
                "write_file"   // potentially dangerous
        );

        if ("normal".equals(permissionMode)) {
            // Only read-only tools allowed by default
            Set<String> normalAllowed = Set.of(
                    "read_file", "list_files", "search_code"
            );
            if (!normalAllowed.contains(toolId)) {
                return false;
            }
        }

        // All modes: filter blacklisted tools
        return !blacklist.contains(toolId) || isConfirmed(toolId);
    }

    private boolean isConfirmed(String toolId) {
        // In production, this would check a confirmation queue
        // For now, return false - tools need explicit approval
        return false;
    }

    private void sendWorkerStarted(String dispatchId, int workerIdx, String agentId) {
        String msg = String.format(
                "{\"type\":\"worker_started\",\"dispatchId\":\"%s\",\"workerIdx\":%d,\"agentId\":\"%s\"}",
                dispatchId, workerIdx, escapeJson(agentId)
        );
        tcpClient.send(msg);
    }

    private void sendWorkerChunk(String dispatchId, int workerIdx, String content) {
        String msg = String.format(
                "{\"type\":\"worker_chunk\",\"dispatchId\":\"%s\",\"workerIdx\":%d,\"content\":\"%s\"}",
                dispatchId, workerIdx, escapeJson(content)
        );
        tcpClient.send(msg);
    }

    private void sendWorkerDone(String dispatchId, int workerIdx, String output) {
        String msg = String.format(
                "{\"type\":\"worker_done\",\"dispatchId\":\"%s\",\"workerIdx\":%d,\"output\":\"%s\"}",
                dispatchId, workerIdx, escapeJson(output)
        );
        tcpClient.send(msg);
    }

    private void sendWorkerFailed(String dispatchId, int workerIdx, String error) {
        String msg = String.format(
                "{\"type\":\"worker_failed\",\"dispatchId\":\"%s\",\"workerIdx\":%d,\"error\":\"%s\"}",
                dispatchId, workerIdx, escapeJson(error)
        );
        tcpClient.send(msg);
    }

    private void sendDispatchDone(String dispatchId) {
        String msg = String.format(
                "{\"type\":\"dispatch_done\",\"dispatchId\":\"%s\"}",
                dispatchId
        );
        tcpClient.send(msg);
    }

    private String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "");
    }
}
