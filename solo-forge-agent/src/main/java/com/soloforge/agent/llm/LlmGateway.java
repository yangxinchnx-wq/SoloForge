package com.soloforge.agent.llm;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.soloforge.agent.dto.ChatRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import reactor.core.publisher.Flux;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * LLM Gateway
 *
 * 动态多 provider 支持: 每次请求从 ChatRequest.provider 注入 baseUrl/apiKey/model,
 * 不依赖 application.yml 的静态配置。
 *
 * 支持 OpenAI 兼容协议 (OpenAI / Claude / DeepSeek / GLM / 通义千问等)
 *
 * 2026-07-08: 新增 chatCompletionStream() 真实流式调用, 返回 Flux<String> 增量文本
 */
@Slf4j
@Component
public class LlmGateway {

    private static final Duration TIMEOUT = Duration.ofSeconds(90);
    private final ObjectMapper objectMapper = new ObjectMapper();

    /**
     * 同步调用 LLM (非流式)
     * 如果带 tools 调用返回空内容, 自动去掉 tools 重试一次
     */
    public String chatCompletion(String systemPrompt,
                                  String userMessage,
                                  List<Map<String, String>> history,
                                  ChatRequest.LlmProvider provider,
                                  List<Map<String, Object>> tools) {
        return chatCompletion(systemPrompt, userMessage, history, provider, tools, 0.3);
    }

    /**
     * 同步调用 LLM (非流式, 指定 temperature)
     * temperature 由 agent 配置决定, 默认 0.3
     */
    public String chatCompletion(String systemPrompt,
                                  String userMessage,
                                  List<Map<String, String>> history,
                                  ChatRequest.LlmProvider provider,
                                  List<Map<String, Object>> tools,
                                  double temperature) {
        ChatRequest.LlmProvider resolved = resolveProvider(provider);
        log.info("LLM call: baseUrl={} model={} temperature={}", resolved.getBaseUrl(), resolved.getModel(), temperature);

        try {
            WebClient client = buildClient(resolved);
            Map<String, Object> body = buildRequestBody(systemPrompt, userMessage, history, resolved, tools, false, temperature);

            Map<String, Object> response = client.post()
                .uri("/chat/completions")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(Map.class)
                .timeout(TIMEOUT)
                .block();

            String content = extractContent(response);
            
            // 如果带 tools 调用返回空内容, 去掉 tools 重试
            if ((content == null || content.isBlank()) && tools != null && !tools.isEmpty()) {
                log.warn("LLM returned empty content with tools, retrying without tools...");
                Map<String, Object> bodyNoTools = buildRequestBody(systemPrompt, userMessage, history, resolved, null, false, temperature);
                response = client.post()
                    .uri("/chat/completions")
                    .bodyValue(bodyNoTools)
                    .retrieve()
                    .bodyToMono(Map.class)
                    .timeout(TIMEOUT)
                    .block();
                content = extractContent(response);
            }
            
            return content;
        } catch (Exception e) {
            log.error("LLM call failed: {}", e.getMessage());
            // 降级到 fallback 模型
            if (resolved.getFallbackModels() != null && resolved.getFallbackModels().length > 0) {
                log.info("Falling back to: {}", resolved.getFallbackModels()[0]);
                ChatRequest.LlmProvider fallback = ChatRequest.LlmProvider.builder()
                    .baseUrl(resolved.getBaseUrl())
                    .apiKey(resolved.getApiKey())
                    .model(resolved.getFallbackModels()[0])
                    .build();
                return chatCompletion(systemPrompt, userMessage, history, fallback, tools, temperature);
            }
            throw new RuntimeException("LLM 调用失败: " + formatLlmError(e, resolved), e);
        }
    }

    /**
     * 流式调用 LLM — 返回增量文本 Flux
     *
     * 每个 onNext 是一个 delta content 片段 (非完整响应)
     * Flux complete 表示流结束
     */
    public Flux<String> chatCompletionStream(String systemPrompt,
                                              String userMessage,
                                              List<Map<String, String>> history,
                                              ChatRequest.LlmProvider provider,
                                              List<Map<String, Object>> tools) {
        return chatCompletionStream(systemPrompt, userMessage, history, provider, tools, null, 0.3);
    }

    /**
     * ★ 流式调用 LLM (带 usage 回调)
     *
     * usageConsumer 在流式结束时被调用一次, 携带本轮 LLM 调用的 token 统计
     * (需要 provider 支持 stream_options.include_usage, OpenAI 兼容协议均支持)
     */
    public Flux<String> chatCompletionStream(String systemPrompt,
                                              String userMessage,
                                              List<Map<String, String>> history,
                                              ChatRequest.LlmProvider provider,
                                              List<Map<String, Object>> tools,
                                              Consumer<Usage> usageConsumer) {
        return chatCompletionStream(systemPrompt, userMessage, history, provider, tools, usageConsumer, 0.3);
    }

    /**
     * ★ 流式调用 LLM (带 usage 回调 + 指定 temperature)
     * temperature 由 agent 配置决定, 默认 0.3
     */
    public Flux<String> chatCompletionStream(String systemPrompt,
                                              String userMessage,
                                              List<Map<String, String>> history,
                                              ChatRequest.LlmProvider provider,
                                              List<Map<String, Object>> tools,
                                              Consumer<Usage> usageConsumer,
                                              double temperature) {
        ChatRequest.LlmProvider resolved = resolveProvider(provider);
        log.info("LLM stream call: baseUrl={} model={} temperature={}", resolved.getBaseUrl(), resolved.getModel(), temperature);

        WebClient client = buildClient(resolved);
        Map<String, Object> body = buildRequestBody(systemPrompt, userMessage, history, resolved, tools, true, temperature);

        // 累积原生 tool_calls 分片 (流式 mode 下 arguments 分片到达)
        StringBuilder toolCallName = new StringBuilder();
        StringBuilder toolCallArgs = new StringBuilder();
        boolean[] hasToolCall = {false};

        return client.post()
            .uri("/chat/completions")
            .bodyValue(body)
            .retrieve()
            .bodyToFlux(new ParameterizedTypeReference<ServerSentEvent<String>>() {})
            .map(ServerSentEvent::data)
            .filter(data -> data != null && !"[DONE]".equals(data))
            .mapNotNull(sseData -> {
                // 1. 先检查 delta.tool_calls (原生 function calling)
                try {
                    Map<String, Object> chunk = objectMapper.readValue(sseData, Map.class);
                    // ★ 检查 usage (流式最后一帧携带, 需 stream_options.include_usage=true)
                    if (usageConsumer != null && chunk.get("usage") != null) {
                        try {
                            Map<String, Object> u = (Map<String, Object>) chunk.get("usage");
                            // ★ 兼容 3 种 provider 的缓存命中字段:
                            //   OpenAI:    usage.prompt_tokens_details.cached_tokens
                            //   DeepSeek:  usage.prompt_cache_hit_tokens
                            //   Anthropic: usage.cache_read_input_tokens
                            int cached = 0;
                            Object ptd = u.get("prompt_tokens_details");
                            if (ptd instanceof Map) {
                                cached = toInt(((Map<String, Object>) ptd).get("cached_tokens"));
                            }
                            if (cached == 0) cached = toInt(u.get("prompt_cache_hit_tokens"));
                            if (cached == 0) cached = toInt(u.get("cache_read_input_tokens"));
                            Usage usage = new Usage(
                                toInt(u.get("prompt_tokens")),
                                toInt(u.get("completion_tokens")),
                                toInt(u.get("total_tokens")),
                                cached);
                            usageConsumer.accept(usage);
                        } catch (Exception ue) {
                            log.debug("Failed to parse usage: {}", ue.getMessage());
                        }
                    }
                    List<Map<String, Object>> choices = (List<Map<String, Object>>) chunk.get("choices");
                    if (choices != null && !choices.isEmpty()) {
                        Map<String, Object> delta = (Map<String, Object>) choices.get(0).get("delta");
                        if (delta != null) {
                            Object tcObj = delta.get("tool_calls");
                            if (tcObj != null) {
                                List<Map<String, Object>> tcs = (List<Map<String, Object>>) tcObj;
                                if (!tcs.isEmpty()) {
                                    Map<String, Object> tc = tcs.get(0);
                                    Map<String, Object> fn = (Map<String, Object>) tc.get("function");
                                    if (fn != null) {
                                        hasToolCall[0] = true;
                                        if (fn.get("name") != null) {
                                            toolCallName.setLength(0);
                                            toolCallName.append(fn.get("name"));
                                        }
                                        if (fn.get("arguments") != null) {
                                            toolCallArgs.append(fn.get("arguments"));
                                        }
                                    }
                                }
                                // 有 tool_calls 时, delta.content 通常为 null, 返回空占位
                                return null;
                            }
                        }
                    }
                } catch (Exception e) {
                    log.debug("Failed to parse SSE chunk for tool_calls: {}", e.getMessage());
                }
                // 2. 正常提取 delta content
                return extractDeltaContent(sseData);
            })
            .doOnComplete(() -> {
                if (hasToolCall[0] && toolCallName.length() > 0) {
                    log.info("Stream accumulated native tool_call: {} args_len={}",
                        toolCallName, toolCallArgs.length());
                }
            })
            .concatWith(Flux.defer(() -> {
                // 流结束后: 如果累积了原生 tool_calls, 注入 ```json 块让 tryParseToolCall 识别
                if (hasToolCall[0] && toolCallName.length() > 0) {
                    String argsStr = toolCallArgs.toString();
                    try {
                        Map<String, Object> args = objectMapper.readValue(argsStr, Map.class);
                        String toolJson = objectMapper.writeValueAsString(
                            Map.of("tool", toolCallName.toString(), "args", args));
                        return Flux.just("```json\n" + toolJson + "\n```");
                    } catch (Exception e) {
                        return Flux.just("```json\n{\"tool\":\"" + toolCallName + "\",\"args\":" + argsStr + "}\n```");
                    }
                }
                return Flux.empty();
            }))
            .doOnError(e -> log.error("LLM stream error: {}", e.getMessage()))
            .onErrorMap(e -> e instanceof WebClientResponseException
                ? new RuntimeException(formatLlmError(e, resolved), e)
                : e)
            .timeout(TIMEOUT);
    }

    /** ★ Token 使用统计 (cachedTokens: 缓存命中的 prompt token 数) */
    public record Usage(int promptTokens, int completionTokens, int totalTokens, int cachedTokens) {}

    private static int toInt(Object v) {
        if (v instanceof Number n) return n.intValue();
        if (v instanceof String s) { try { return Integer.parseInt(s); } catch (Exception e) { return 0; } }
        return 0;
    }

    /**
     * 从 SSE data 字段中提取 delta content
     *
     * ★ FIX 2026-07-12: reasoning_content 用 \u0001 前缀标记, ChatController 据此发送 'reasoning' 事件。
     * 前端收到 reasoning 事件后只在流送区显示, 不喂给 IncrementalCanvasPusher,
     * 避免思考过程中的 ``` 字符干扰代码块检测。
     */
    @SuppressWarnings("unchecked")
    private String extractDeltaContent(String sseData) {
        try {
            Map<String, Object> chunk = objectMapper.readValue(sseData, Map.class);
            List<Map<String, Object>> choices = (List<Map<String, Object>>) chunk.get("choices");
            if (choices == null || choices.isEmpty()) return null;
            Map<String, Object> delta = (Map<String, Object>) choices.get(0).get("delta");
            if (delta == null) return null;
            Object content = delta.get("content");
            if (content != null) return content.toString();
            // reasoning model: 用 \u0001 前缀标记 reasoning_content
            Object reasoning = delta.get("reasoning_content");
            if (reasoning != null) return "\u0001" + reasoning.toString();
            return null;
        } catch (Exception e) {
            log.debug("Failed to parse SSE chunk: {}", e.getMessage());
            return null;
        }
    }

    private WebClient buildClient(ChatRequest.LlmProvider provider) {
        return WebClient.builder()
            .baseUrl(provider.getBaseUrl())
            .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + provider.getApiKey())
            .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
            .build();
    }

    private Map<String, Object> buildRequestBody(String systemPrompt,
                                                   String userMessage,
                                                   List<Map<String, String>> history,
                                                   ChatRequest.LlmProvider provider,
                                                   List<Map<String, Object>> tools,
                                                   boolean stream,
                                                   double temperature) {
        List<Map<String, String>> messages = new ArrayList<>();

        // System prompt
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            messages.add(Map.of("role", "system", "content", systemPrompt));
        }

        // History
        if (history != null) {
            messages.addAll(history);
        }

        // User message
        messages.add(Map.of("role", "user", "content", userMessage));

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", provider.getModel());
        body.put("messages", messages);
        body.put("stream", stream);
        body.put("temperature", temperature);

        // ★ 流式时请求 usage 统计 (OpenAI 兼容协议: stream_options.include_usage)
        if (stream) {
            body.put("stream_options", Map.of("include_usage", true));
        }

        if (tools != null && !tools.isEmpty()) {
            body.put("tools", tools);
            body.put("tool_choice", "auto");
        }

        return body;
    }

    @SuppressWarnings("unchecked")
    private String extractContent(Map<String, Object> response) {
        if (response == null) return "(空响应)";
        List<Map<String, Object>> choices = (List<Map<String, Object>>) response.get("choices");
        if (choices == null || choices.isEmpty()) {
            log.warn("LLM response has no choices: {}", response.keySet());
            return "(无 choices)";
        }
        Map<String, Object> message = (Map<String, Object>) choices.get(0).get("message");
        if (message == null) return "(无 message)";
        
        // 检查原生 tool_calls (OpenAI Function Calling 格式)
        Object toolCallsObj = message.get("tool_calls");
        if (toolCallsObj != null) {
            try {
                List<Map<String, Object>> toolCalls = (List<Map<String, Object>>) toolCallsObj;
                if (!toolCalls.isEmpty()) {
                    Map<String, Object> tc = toolCalls.get(0);
                    Map<String, Object> function = (Map<String, Object>) tc.get("function");
                    if (function != null) {
                        String toolName = (String) function.get("name");
                        String argsStr = (String) function.get("arguments");
                        log.info("LLM native tool_call: {} args={}", toolName, argsStr);
                        
                        // 转换为 tryParseToolCall 能识别的 ```json 格式
                        try {
                            Map<String, Object> args = objectMapper.readValue(argsStr, Map.class);
                            String toolJson = objectMapper.writeValueAsString(Map.of("tool", toolName, "args", args));
                            return "```json\n" + toolJson + "\n```";
                        } catch (Exception e) {
                            // arguments 不是合法 JSON, 直接包裹
                            return "```json\n{\"tool\":\"" + toolName + "\",\"args\":" + argsStr + "}\n```";
                        }
                    }
                }
            } catch (Exception e) {
                log.warn("Failed to parse native tool_calls: {}", e.getMessage());
            }
        }
        
        Object content = message.get("content");
        if (content == null) {
            // 可能是 reasoning model, 检查 reasoning_content 字段
            Object reasoning = message.get("reasoning_content");
            if (reasoning != null) return reasoning.toString();
            return "(无 content)";
        }
        String result = content.toString();
        if (result.isBlank()) {
            log.warn("LLM returned blank content. Message keys: {}", message.keySet());
        }
        return result;
    }

    /**
     * 解析 provider: 如果请求未提供, 返回错误而不是默认连 OpenAI
     * (OpenAI 在部分网络环境不可达, 会导致 90s 超时)
     */
    private ChatRequest.LlmProvider resolveProvider(ChatRequest.LlmProvider provider) {
        if (provider == null || provider.getBaseUrl() == null || provider.getBaseUrl().isBlank()) {
            throw new RuntimeException("未配置 LLM Provider: 请在前端「设置 → 模型」中配置 baseUrl/apiKey/model 后重试");
        }
        if (provider.getApiKey() == null || provider.getApiKey().isBlank()) {
            throw new RuntimeException("LLM Provider apiKey 为空: 请在前端「设置 → 模型」中配置 API 密钥");
        }
        if (provider.getModel() == null || provider.getModel().isBlank()) {
            throw new RuntimeException("LLM Provider model 为空: 请在前端「设置 → 模型」中配置模型名称");
        }
        return provider;
    }

    /**
     * 格式化 LLM 错误: 将 Spring WebClient 异常转为包含 "HTTP {status}" 前缀的标准格式
     * 这样前端 classifyStreamError 可以正确匹配错误类型
     *
     * 输出格式: "HTTP {status} {statusText} — {bodyPreview} (baseUrl={baseUrl} model={model})"
     * 示例: "HTTP 404 Not Found — {\"error\":{\"message\":\"Model not found\"}} (baseUrl=https://api.openai.com/v1 model=gpt-4o)"
     */
    private String formatLlmError(Throwable e, ChatRequest.LlmProvider provider) {
        String baseUrl = provider.getBaseUrl();
        String model = provider.getModel();

        if (e instanceof WebClientResponseException wcre) {
            int status = wcre.getStatusCode().value();
            String statusText = wcre.getStatusText();
            String bodyPreview = "";
            try {
                String body = new String(wcre.getResponseBodyAsByteArray());
                bodyPreview = body.length() > 200 ? body.substring(0, 200) : body;
            } catch (Exception ignored) {}
            return String.format("HTTP %d %s — %s (baseUrl=%s model=%s)",
                status, statusText, bodyPreview, baseUrl, model);
        }

        // 非 HTTP 错误 (超时、连接拒绝等)
        return String.format("HTTP 500 %s (baseUrl=%s model=%s)", e.getMessage(), baseUrl, model);
    }
}
