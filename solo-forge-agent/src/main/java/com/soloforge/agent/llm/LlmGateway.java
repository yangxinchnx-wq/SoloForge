package com.soloforge.agent.llm;

/**
 * @deprecated Use {@link com.soloforge.agent.config.DynamicChatModelResolver} and
 *             {@link org.springframework.ai.chat.model.ChatModel} instead.
 *             Replaced by Spring AI 2.0 ChatClient in Path C migration (2026-07-15).
 *             This class will be removed in a future release. Retained for fallback reference.
 */
@Deprecated

import com.fasterxml.jackson.databind.ObjectMapper;
import com.soloforge.agent.dto.ChatRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.beans.factory.annotation.Autowired;
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
 * 鍔ㄦ€佸 provider 鏀寔: 姣忔璇锋眰浠?ChatRequest.provider 娉ㄥ叆 baseUrl/apiKey/model,
 * 涓嶄緷璧?application.yml 鐨勯潤鎬侀厤缃€?
 *
 * 鏀寔 OpenAI 鍏煎鍗忚 (OpenAI / Claude / DeepSeek / GLM / 閫氫箟鍗冮棶绛?
 *
 * 2026-07-08: 鏂板 chatCompletionStream() 鐪熷疄娴佸紡璋冪敤, 杩斿洖 Flux<String> 澧為噺鏂囨湰
 */
@Slf4j
@Component
public class LlmGateway {

    private static final Duration TIMEOUT = Duration.ofSeconds(90);
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Autowired
    private LlmRateLimiter rateLimiter;

    /**
     * 鍚屾璋冪敤 LLM (闈炴祦寮?
     * 濡傛灉甯?tools 璋冪敤杩斿洖绌哄唴瀹? 鑷姩鍘绘帀 tools 閲嶈瘯涓€娆?
     */
    public String chatCompletion(String systemPrompt,
                                  String userMessage,
                                  List<Map<String, String>> history,
                                  ChatRequest.LlmProvider provider,
                                  List<Map<String, Object>> tools) {
        return chatCompletion(systemPrompt, userMessage, history, provider, tools, 0.3);
    }

    /**
     * 鍚屾璋冪敤 LLM (闈炴祦寮? 鎸囧畾 temperature)
     * temperature 鐢?agent 閰嶇疆鍐冲畾, 榛樿 0.3
     */
    public String chatCompletion(String systemPrompt,
                                  String userMessage,
                                  List<Map<String, String>> history,
                                  ChatRequest.LlmProvider provider,
                                  List<Map<String, Object>> tools,
                                  double temperature) {
        ChatRequest.LlmProvider resolved = resolveProvider(provider);
        log.info("LLM call: baseUrl={} model={} temperature={}", resolved.getBaseUrl(), resolved.getModel(), temperature);

        String pKey = LlmRateLimiter.providerKey(resolved.getBaseUrl(), resolved.getModel());
        try {
            WebClient client = buildClient(resolved);
            Map<String, Object> body = buildRequestBody(systemPrompt, userMessage, history, resolved, tools, false, temperature);

            Map<String, Object> response = null;
            for (int attempt = 0; attempt <= 3; attempt++) {
                rateLimiter.waitForRpmSlot(pKey);
                rateLimiter.acquire(pKey);
                try {
                    response = client.post()
                        .uri("/chat/completions")
                        .bodyValue(body)
                        .retrieve()
                        .bodyToMono(Map.class)
                        .timeout(TIMEOUT)
                        .block();
                    rateLimiter.recordSuccess(pKey);
                    break;
                } catch (Exception inner) {
                    int sc = LlmRateLimiter.extractStatusCode(inner);
                    if (rateLimiter.shouldRetry(sc, attempt)) {
                        Long ra = LlmRateLimiter.extractRetryAfter(inner);
                        log.warn("LLM call failed (HTTP {}), retrying #{}/3", sc, attempt + 1);
                        rateLimiter.record429(pKey);
                        rateLimiter.waitBeforeRetry(ra, attempt);
                        continue;
                    }
                    throw inner;
                } finally {
                    rateLimiter.release(pKey);
                }
            }

            String content = extractContent(response);
            
            // 濡傛灉甯?tools 璋冪敤杩斿洖绌哄唴瀹? 鍘绘帀 tools 閲嶈瘯
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
            // 闄嶇骇鍒?fallback 妯″瀷
            if (resolved.getFallbackModels() != null && resolved.getFallbackModels().length > 0) {
                log.info("Falling back to: {}", resolved.getFallbackModels()[0]);
                ChatRequest.LlmProvider fallback = ChatRequest.LlmProvider.builder()
                    .baseUrl(resolved.getBaseUrl())
                    .apiKey(resolved.getApiKey())
                    .model(resolved.getFallbackModels()[0])
                    .build();
                return chatCompletion(systemPrompt, userMessage, history, fallback, tools, temperature);
            }
            throw new RuntimeException("LLM 璋冪敤澶辫触: " + formatLlmError(e, resolved), e);
        }
    }

    /**
     * 娴佸紡璋冪敤 LLM 鈥?杩斿洖澧為噺鏂囨湰 Flux
     *
     * 姣忎釜 onNext 鏄竴涓?delta content 鐗囨 (闈炲畬鏁村搷搴?
     * Flux complete 琛ㄧず娴佺粨鏉?
     */
    public Flux<String> chatCompletionStream(String systemPrompt,
                                              String userMessage,
                                              List<Map<String, String>> history,
                                              ChatRequest.LlmProvider provider,
                                              List<Map<String, Object>> tools) {
        return chatCompletionStream(systemPrompt, userMessage, history, provider, tools, null, 0.3);
    }

    /**
     * 鈽?娴佸紡璋冪敤 LLM (甯?usage 鍥炶皟)
     *
     * usageConsumer 鍦ㄦ祦寮忕粨鏉熸椂琚皟鐢ㄤ竴娆? 鎼哄甫鏈疆 LLM 璋冪敤鐨?token 缁熻
     * (闇€瑕?provider 鏀寔 stream_options.include_usage, OpenAI 鍏煎鍗忚鍧囨敮鎸?
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
     * 鈽?娴佸紡璋冪敤 LLM (甯?usage 鍥炶皟 + 鎸囧畾 temperature)
     * temperature 鐢?agent 閰嶇疆鍐冲畾, 榛樿 0.3
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

        // 绱Н鍘熺敓 tool_calls 鍒嗙墖 (娴佸紡 mode 涓?arguments 鍒嗙墖鍒拌揪)
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
                // 1. 鍏堟鏌?delta.tool_calls (鍘熺敓 function calling)
                try {
                    Map<String, Object> chunk = objectMapper.readValue(sseData, Map.class);
                    // 鈽?妫€鏌?usage (娴佸紡鏈€鍚庝竴甯ф惡甯? 闇€ stream_options.include_usage=true)
                    if (usageConsumer != null && chunk.get("usage") != null) {
                        try {
                            Map<String, Object> u = (Map<String, Object>) chunk.get("usage");
                            // 鈽?鍏煎 3 绉?provider 鐨勭紦瀛樺懡涓瓧娈?
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
                                // 鏈?tool_calls 鏃? delta.content 閫氬父涓?null, 杩斿洖绌哄崰浣?
                                return null;
                            }
                        }
                    }
                } catch (Exception e) {
                    log.debug("Failed to parse SSE chunk for tool_calls: {}", e.getMessage());
                }
                // 2. 姝ｅ父鎻愬彇 delta content
                return extractDeltaContent(sseData);
            })
            .doOnComplete(() -> {
                if (hasToolCall[0] && toolCallName.length() > 0) {
                    log.info("Stream accumulated native tool_call: {} args_len={}",
                        toolCallName, toolCallArgs.length());
                }
            })
            .concatWith(Flux.defer(() -> {
                // 娴佺粨鏉熷悗: 濡傛灉绱Н浜嗗師鐢?tool_calls, 娉ㄥ叆 ```json 鍧楄 tryParseToolCall 璇嗗埆
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

    /** 鈽?Token 浣跨敤缁熻 (cachedTokens: 缂撳瓨鍛戒腑鐨?prompt token 鏁? */
    public record Usage(int promptTokens, int completionTokens, int totalTokens, int cachedTokens) {}

    private static int toInt(Object v) {
        if (v instanceof Number n) return n.intValue();
        if (v instanceof String s) { try { return Integer.parseInt(s); } catch (Exception e) { return 0; } }
        return 0;
    }

    /**
     * 浠?SSE data 瀛楁涓彁鍙?delta content
     *
     * 鈽?FIX 2026-07-12: reasoning_content 鐢?\u0001 鍓嶇紑鏍囪, ChatController 鎹鍙戦€?'reasoning' 浜嬩欢銆?
     * 鍓嶇鏀跺埌 reasoning 浜嬩欢鍚庡彧鍦ㄦ祦閫佸尯鏄剧ず, 涓嶅杺缁?IncrementalCanvasPusher,
     * 閬垮厤鎬濊€冭繃绋嬩腑鐨?``` 瀛楃骞叉壈浠ｇ爜鍧楁娴嬨€?
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
            // reasoning model: 鐢?\u0001 鍓嶇紑鏍囪 reasoning_content
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

        // 鈽?娴佸紡鏃惰姹?usage 缁熻 (OpenAI 鍏煎鍗忚: stream_options.include_usage)
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
        if (response == null) return "(绌哄搷搴?";
        List<Map<String, Object>> choices = (List<Map<String, Object>>) response.get("choices");
        if (choices == null || choices.isEmpty()) {
            log.warn("LLM response has no choices: {}", response.keySet());
            return "(鏃?choices)";
        }
        Map<String, Object> message = (Map<String, Object>) choices.get(0).get("message");
        if (message == null) return "(鏃?message)";
        
        // 妫€鏌ュ師鐢?tool_calls (OpenAI Function Calling 鏍煎紡)
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
                        
                        // 杞崲涓?tryParseToolCall 鑳借瘑鍒殑 ```json 鏍煎紡
                        try {
                            Map<String, Object> args = objectMapper.readValue(argsStr, Map.class);
                            String toolJson = objectMapper.writeValueAsString(Map.of("tool", toolName, "args", args));
                            return "```json\n" + toolJson + "\n```";
                        } catch (Exception e) {
                            // arguments 涓嶆槸鍚堟硶 JSON, 鐩存帴鍖呰９
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
            // 鍙兘鏄?reasoning model, 妫€鏌?reasoning_content 瀛楁
            Object reasoning = message.get("reasoning_content");
            if (reasoning != null) return reasoning.toString();
            return "(鏃?content)";
        }
        String result = content.toString();
        if (result.isBlank()) {
            log.warn("LLM returned blank content. Message keys: {}", message.keySet());
        }
        return result;
    }

    /**
     * 瑙ｆ瀽 provider: 濡傛灉璇锋眰鏈彁渚? 杩斿洖閿欒鑰屼笉鏄粯璁よ繛 OpenAI
     * (OpenAI 鍦ㄩ儴鍒嗙綉缁滅幆澧冧笉鍙揪, 浼氬鑷?90s 瓒呮椂)
     */
    private ChatRequest.LlmProvider resolveProvider(ChatRequest.LlmProvider provider) {
        if (provider == null || provider.getBaseUrl() == null || provider.getBaseUrl().isBlank()) {
            throw new RuntimeException("鏈厤缃?LLM Provider: 璇峰湪鍓嶇銆岃缃?鈫?妯″瀷銆嶄腑閰嶇疆 baseUrl/apiKey/model 鍚庨噸璇?);
        }
        if (provider.getApiKey() == null || provider.getApiKey().isBlank()) {
            throw new RuntimeException("LLM Provider apiKey 涓虹┖: 璇峰湪鍓嶇銆岃缃?鈫?妯″瀷銆嶄腑閰嶇疆 API 瀵嗛挜");
        }
        if (provider.getModel() == null || provider.getModel().isBlank()) {
            throw new RuntimeException("LLM Provider model 涓虹┖: 璇峰湪鍓嶇銆岃缃?鈫?妯″瀷銆嶄腑閰嶇疆妯″瀷鍚嶇О");
        }
        return provider;
    }

    /**
     * 鏍煎紡鍖?LLM 閿欒: 灏?Spring WebClient 寮傚父杞负鍖呭惈 "HTTP {status}" 鍓嶇紑鐨勬爣鍑嗘牸寮?
     * 杩欐牱鍓嶇 classifyStreamError 鍙互姝ｇ‘鍖归厤閿欒绫诲瀷
     *
     * 杈撳嚭鏍煎紡: "HTTP {status} {statusText} 鈥?{bodyPreview} (baseUrl={baseUrl} model={model})"
     * 绀轰緥: "HTTP 404 Not Found 鈥?{\"error\":{\"message\":\"Model not found\"}} (baseUrl=https://api.openai.com/v1 model=gpt-4o)"
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
            return String.format("HTTP %d %s 鈥?%s (baseUrl=%s model=%s)",
                status, statusText, bodyPreview, baseUrl, model);
        }

        // 闈?HTTP 閿欒 (瓒呮椂銆佽繛鎺ユ嫆缁濈瓑)
        return String.format("HTTP 500 %s (baseUrl=%s model=%s)", e.getMessage(), baseUrl, model);
    }
}
